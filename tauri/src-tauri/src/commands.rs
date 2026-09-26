use serde_json::Value;
use tauri::{AppHandle, State};

use crate::keychain;
use crate::last_uid;
use crate::state::{CurrentSession, SessionState};
use crate::upstream::{is_unauthorized, UpstreamClient};

// ---- POST /api/auth/login 相当。credentialとsession cookieの両方を
//      OSキーチェーンへ保存する(永続ログインの起点)。 ----
#[tauri::command]
pub async fn login(
    app: AppHandle,
    state: State<'_, SessionState>,
    id: String,
    password: String,
) -> Result<Value, String> {
    let client = UpstreamClient::new();
    let outcome = client.login(&id, &password).await.map_err(|e| {
        eprintln!("[login] client.login failed: {}", e);
        e
    })?;
    eprintln!("[login] client.login ok");
    keychain::save_credential(&id, &password).map_err(|e| {
        eprintln!("[login] keychain::save_credential failed: {}", e);
        e
    })?;
    keychain::save_session(&id, &outcome.session_cookie).map_err(|e| {
        eprintln!("[login] keychain::save_session failed: {}", e);
        e
    })?;
    last_uid::save(&app, &id).map_err(|e| {
        eprintln!("[login] last_uid::save failed: {}", e);
        e
    })?;
    eprintln!("[login] all steps ok, uid={}", id);
    *state.0.lock().unwrap() = Some(CurrentSession {
        uid: id,
        cookie: outcome.session_cookie,
    });
    Ok(outcome.body)
}

// ---- POST /api/auth/logout 相当。キーチェーンのcredential/session両方を破棄する。 ----
#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, SessionState>) -> Result<(), String> {
    let uid = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|s| s.uid.clone())
    }
    .or_else(|| last_uid::load(&app));

    if let Some(uid) = uid {
        if let Some(cookie) = keychain::load_session(&uid) {
            UpstreamClient::new().logout(&cookie).await;
        }
        keychain::delete_credential(&uid);
        keychain::delete_session(&uid);
    }
    last_uid::clear(&app);
    *state.0.lock().unwrap() = None;
    Ok(())
}

// 保存済みcredentialで再ログインし、session state(メモリ+keyring)を更新した上で
// 新しいsession cookieを返す。restore_session / api_request / download_file の
// 「失効していたら保存済みcredentialで無言再ログイン」を共通化したもの。
async fn relogin_with_credential(
    state: &State<'_, SessionState>,
    client: &UpstreamClient,
    uid: &str,
) -> Result<String, String> {
    let cred = keychain::load_credential(uid).ok_or_else(unauthorized_json)?;
    let outcome = client
        .login(&cred.id, &cred.password)
        .await
        .map_err(|_| unauthorized_json())?;
    keychain::save_session(uid, &outcome.session_cookie)?;
    *state.0.lock().unwrap() = Some(CurrentSession {
        uid: uid.to_string(),
        cookie: outcome.session_cookie.clone(),
    });
    Ok(outcome.session_cookie)
}

fn current_uid(app: &AppHandle, state: &State<'_, SessionState>) -> Option<String> {
    state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.uid.clone())
        .or_else(|| last_uid::load(app))
}

// ---- 起動時に呼ぶ。保存済みsession cookieを検証し、失効していれば保存済み
//      credentialで無言再ログインする。どちらも無ければ未ログイン扱い。 ----
#[tauri::command]
pub async fn restore_session(
    app: AppHandle,
    state: State<'_, SessionState>,
) -> Result<Option<String>, String> {
    let Some(uid) = last_uid::load(&app) else {
        eprintln!("[restore_session] last_uid missing");
        return Ok(None);
    };
    eprintln!("[restore_session] uid={}", uid);
    let client = UpstreamClient::new();

    match keychain::load_session(&uid) {
        Some(cookie) => {
            eprintln!("[restore_session] keychain session found, len={}", cookie.len());
            match client.me(&cookie).await {
                Ok(_) => {
                    eprintln!("[restore_session] client.me() ok");
                    *state.0.lock().unwrap() = Some(CurrentSession {
                        uid: uid.clone(),
                        cookie,
                    });
                    return Ok(Some(uid));
                }
                Err(e) => {
                    eprintln!("[restore_session] client.me() failed: {}", e);
                }
            }
        }
        None => {
            eprintln!("[restore_session] keychain session missing");
        }
    }

    match relogin_with_credential(&state, &client, &uid).await {
        Ok(_) => {
            eprintln!("[restore_session] relogin_with_credential ok");
            return Ok(Some(uid));
        }
        Err(e) => {
            eprintln!("[restore_session] relogin_with_credential failed: {}", e);
        }
    }
    Ok(None)
}

// ---- BFF APIの汎用中継。401を検知したら保存済みcredentialで1回だけ
//      再ログインしリトライする(Worker側の透過再ログインと同じ「1回まで」方針)。 ----
#[tauri::command]
pub async fn api_request(
    app: AppHandle,
    state: State<'_, SessionState>,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let client = UpstreamClient::new();
    let cookie = current_cookie(&app, &state)?;

    match client.request(&path, &method, body.clone(), &cookie).await {
        Ok(v) => Ok(v),
        Err(e) if is_unauthorized(&e) => {
            let uid = current_uid(&app, &state).ok_or(e.clone())?;
            let cookie = relogin_with_credential(&state, &client, &uid)
                .await
                .map_err(|_| e.clone())?;
            client.request(&path, &method, body, &cookie).await
        }
        Err(e) => Err(e),
    }
}

// ---- /api/file/:id 相当。バイト列を一時ファイルへ書き出し、パスだけ返す。
//      呼び出し元(フロント)はopenInBrowserコマンドで既定ブラウザに開かせる。
//      api_requestと同じく、401なら1回だけ再ログインしてリトライする。 ----
#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    state: State<'_, SessionState>,
    path: String,
    filename: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;

    let client = UpstreamClient::new();
    let cookie = current_cookie(&app, &state)?;
    let outcome = match client.download(&path, &cookie).await {
        Ok(o) => o,
        Err(e) if is_unauthorized(&e) => {
            let uid = current_uid(&app, &state).ok_or(e.clone())?;
            let cookie = relogin_with_credential(&state, &client, &uid)
                .await
                .map_err(|_| e.clone())?;
            client.download(&path, &cookie).await?
        }
        Err(e) => return Err(e),
    };

    let name = filename
        .or_else(|| {
            outcome
                .content_disposition
                .as_deref()
                .and_then(extract_filename)
        })
        .unwrap_or_else(|| "download".to_string());

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_path = dir.join(sanitize_filename(&name));
    std::fs::write(&file_path, outcome.bytes).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

// ---- ローカルファイルを127.0.0.1の一時HTTPサーバで配信し、既定ブラウザで開く。
//      pathはapp_cache_dir()/downloads配下である必要がある（セキュリティ検証済み）。 ----
#[tauri::command]
pub async fn open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    use std::path::PathBuf;

    // pathをcanonicalizeする
    let file_path = PathBuf::from(&path);
    let canonical_path = file_path.canonicalize().map_err(|e| e.to_string())?;

    // 許可ディレクトリ(app_cache_dir()/downloads)を取得して canonicalize
    let downloads_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    let canonical_downloads = downloads_dir.canonicalize().map_err(|e| e.to_string())?;

    // pathがdownloadsディレクトリの配下かチェック
    if !canonical_path.starts_with(&canonical_downloads) {
        return Err("file is not in downloads directory".to_string());
    }

    // HTTPサーバでファイルを配信
    let url = crate::browser_open::serve_file_once(canonical_path)
        .await
        .map_err(|e| format!("failed to start server: {}", e))?;

    // 既定ブラウザで開く
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("failed to open browser: {}", e))
}

pub(crate) fn current_cookie(app: &AppHandle, state: &State<'_, SessionState>) -> Result<String, String> {
    if let Some(s) = state.0.lock().unwrap().as_ref() {
        return Ok(s.cookie.clone());
    }
    let uid = last_uid::load(app).ok_or_else(unauthorized_json)?;
    keychain::load_session(&uid).ok_or_else(unauthorized_json)
}

fn unauthorized_json() -> String {
    serde_json::json!({ "status": 401, "code": "unauthorized", "message": "not logged in" })
        .to_string()
}

// Content-Dispositionの filename="..." / filename*=UTF-8''... を素朴に取り出す。
fn extract_filename(content_disposition: &str) -> Option<String> {
    for part in content_disposition.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("filename*=UTF-8''") {
            return urlencoding_decode(v);
        }
        if let Some(v) = part.strip_prefix("filename=") {
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

fn urlencoding_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect()
}

// ---- LCAM 接続（WebView で SSO を通し、Cookie を Worker に登録する）。手動の「接続」ボタン用。
//      ウィンドウを最初から表示し、番号入力などの対話が要ればそのまま操作してもらう。 ----
#[tauri::command]
pub async fn lcam_connect(app: AppHandle) -> Result<Value, String> {
    crate::lcam_login::connect(&app, true, true).await
}

#[tauri::command]
pub fn lcam_auto_get(app: AppHandle) -> bool {
    crate::lcam_auto::enabled(&app)
}

#[tauri::command]
pub fn lcam_auto_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::lcam_auto::set_enabled(&app, enabled)
}
