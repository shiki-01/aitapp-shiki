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
    let outcome = client.login(&id, &password).await?;
    keychain::save_credential(&id, &password)?;
    keychain::save_session(&id, &outcome.session_cookie)?;
    last_uid::save(&app, &id)?;
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

// ---- 起動時に呼ぶ。保存済みsession cookieを検証し、失効していれば保存済み
//      credentialで無言再ログインする。どちらも無ければ未ログイン扱い。 ----
#[tauri::command]
pub async fn restore_session(
    app: AppHandle,
    state: State<'_, SessionState>,
) -> Result<Option<String>, String> {
    let Some(uid) = last_uid::load(&app) else {
        return Ok(None);
    };
    let client = UpstreamClient::new();

    if let Some(cookie) = keychain::load_session(&uid) {
        if client.me(&cookie).await.is_ok() {
            *state.0.lock().unwrap() = Some(CurrentSession {
                uid: uid.clone(),
                cookie,
            });
            return Ok(Some(uid));
        }
    }

    if let Some(cred) = keychain::load_credential(&uid) {
        if let Ok(outcome) = client.login(&cred.id, &cred.password).await {
            keychain::save_session(&uid, &outcome.session_cookie)?;
            *state.0.lock().unwrap() = Some(CurrentSession {
                uid: uid.clone(),
                cookie: outcome.session_cookie,
            });
            return Ok(Some(uid));
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
            let uid = {
                let guard = state.0.lock().unwrap();
                guard.as_ref().map(|s| s.uid.clone())
            }
            .or_else(|| last_uid::load(&app))
            .ok_or(e.clone())?;
            let cred = keychain::load_credential(&uid).ok_or(e.clone())?;
            let outcome = client
                .login(&cred.id, &cred.password)
                .await
                .map_err(|_| e.clone())?;
            keychain::save_session(&uid, &outcome.session_cookie)?;
            *state.0.lock().unwrap() = Some(CurrentSession {
                uid,
                cookie: outcome.session_cookie.clone(),
            });
            client
                .request(&path, &method, body, &outcome.session_cookie)
                .await
        }
        Err(e) => Err(e),
    }
}

// ---- /api/file/:id 相当。バイト列を一時ファイルへ書き出し、パスだけ返す。
//      呼び出し元(フロント)はtauri-plugin-openerでOS既定アプリに開かせる。 ----
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
    let outcome = client.download(&path, &cookie).await?;

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

fn current_cookie(app: &AppHandle, state: &State<'_, SessionState>) -> Result<String, String> {
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
