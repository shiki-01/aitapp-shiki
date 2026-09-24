// LCAM の SSO ログインを WebView で通し、得た Cookie を Worker に登録する。
//
// LCAM は Entra ID の SAML SSO + MFA で、Worker は自動ログインできない。ここでは
// ユーザー端末の WebView（OS 管理のプロファイル）で SSO を通す。Microsoft のセッション
// （「サインインの状態を維持」）は WebView 内にだけ残り、Worker には一切送らない。
// Worker へ送るのは LCAM の JSESSIONID（と任意で LiveApps-Cookie / mellon*）だけで、
// 既存の POST /api/lcam/session が有効性を確認して保存する。
//
// 流れ（MIGRATION_NOTES §14.9）:
//   1. LCAM 側の Cookie を消してから https://lcam.aitech.ac.jp/portalv2/ を開く
//      （毎回、SSO を通し直す。Microsoft 側の Cookie は消さない）
//   2. PC ログイン画面の「ログイン」ボタン相当 `excludeSubmit()` を実行 → preLogin →
//      initLogin/sso → mellon → Entra
//   3. Entra のセッションが生きていれば番号入力なしで戻ってくる（ユーザー実測）。
//      止まる（番号入力・kmsi 等）場合は、許可されていればウィンドウを表示してユーザーに操作してもらう
//      （MFA の自動化・回避はしない）
//   4. LCAM のログイン後ページに着地したら Cookie を読み、Worker に登録して WebView を閉じる
//
// 注意: LCAM は単一セッションのため、ここでログインすると他の端末・ブラウザ・公式アプリの
// LCAM セッションは切れる。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::webview::{Cookie, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands;
use crate::state::SessionState;

pub const LABEL: &str = "lcam-login";
const LOGIN_URL: &str = "https://lcam.aitech.ac.jp/portalv2/";
const LCAM_HOST: &str = "lcam.aitech.ac.jp";

/// 表示しない状態で SSO が完了しない場合に「対話が要る」と判断するまでの時間。
const SILENT_LIMIT: Duration = Duration::from_secs(20);
/// 全体のタイムアウト（ユーザーが MFA を通す時間を含む）。
const TOTAL_TIMEOUT: Duration = Duration::from_secs(300);

/// スマホの UA だと LCAM が SP 画面（/portalv2/sp。SSO の終端が lamyapp:// でアプリ連携になる）へ
/// 回す可能性があるため、モバイルのログイン用 WebView には PC ブラウザの UA を付ける。
#[cfg(mobile)]
const DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// 同時に 1 回だけ実行するためのフラグ。
#[derive(Default)]
pub struct ConnectState(pub AtomicBool);

#[derive(Debug, PartialEq)]
pub enum Stage {
    /// LCAM の PC ログイン画面（/portalv2/）。
    LcamLogin,
    /// Microsoft（Entra）側の画面。
    Microsoft,
    /// LCAM のログイン後ページ（initLogin/sso の着地、またはホーム等）。
    LcamAuthed,
    Other,
}

fn is_microsoft(host: &str) -> bool {
    host == "login.microsoftonline.com"
        || host == "login.microsoft.com"
        || host == "login.live.com"
        || host == "sts.windows.net"
        || host.ends_with(".microsoftonline.com")
}

pub fn classify(url: &Url) -> Stage {
    let host = url.host_str().unwrap_or("");
    if host == LCAM_HOST {
        let p = url.path();
        if p == "/portalv2" || p == "/portalv2/" {
            return Stage::LcamLogin;
        }
        if p.starts_with("/mellon/") {
            return Stage::Other; // SAML の中継
        }
        if p.starts_with("/portalv2/login/") {
            // ログイン系の画面のうち、SSO 完了後の着地だけをログイン後とみなす。
            return if p.trim_end_matches('/').ends_with("/initLogin/sso") {
                Stage::LcamAuthed
            } else {
                Stage::Other
            };
        }
        if p.starts_with("/portalv2/") {
            return Stage::LcamAuthed;
        }
        return Stage::Other;
    }
    if is_microsoft(host) {
        return Stage::Microsoft;
    }
    Stage::Other
}

fn domain_is_lcam(domain: Option<&str>) -> bool {
    match domain {
        // Android の cookies_for_url は name=value だけを返し domain が無い（URL で絞り込み済み）。
        None => true,
        Some(d) => {
            let d = d.trim_start_matches('.');
            d == LCAM_HOST || d.ends_with(".lcam.aitech.ac.jp")
        }
    }
}

/// WebView の Cookie から、Worker に登録する Cookie 文字列を作る。
/// JSESSIONID が無ければ None。LiveApps-Cookie と mellon* は、あれば付ける。
/// Microsoft 側など、LCAM 以外の Cookie は含めない。
pub fn build_cookie_header(cookies: &[Cookie<'_>]) -> Option<String> {
    let mut jsession: Option<String> = None;
    let mut liveapps: Option<String> = None;
    let mut extra: Vec<String> = Vec::new();
    for c in cookies {
        if !domain_is_lcam(c.domain()) {
            continue;
        }
        let pair = format!("{}={}", c.name(), c.value());
        let lower = c.name().to_ascii_lowercase();
        if lower == "jsessionid" {
            jsession = Some(pair);
        } else if lower == "liveapps-cookie" {
            liveapps = Some(pair);
        } else if lower.starts_with("mellon") && extra.len() < 4 {
            extra.push(pair);
        }
    }
    let mut parts = vec![jsession?];
    parts.extend(liveapps);
    parts.extend(extra);
    Some(parts.join("; "))
}

fn err(status: u16, code: &str, message: &str) -> String {
    json!({ "status": status, "code": code, "message": message }).to_string()
}

/// 実行中フラグを必ず戻す。
struct BusyGuard(AppHandle);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.state::<ConnectState>().0.store(false, Ordering::SeqCst);
    }
}

/// WebView を必ず閉じる。
struct WindowGuard(WebviewWindow);
impl Drop for WindowGuard {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}

fn lcam_cookies(window: &WebviewWindow, url: &Url) -> Vec<Cookie<'static>> {
    // macOS/iOS の cookies_for_url は domain の完全一致で絞るため、取れなければ全件から自前で絞る。
    let mut found = window.cookies_for_url(url.clone()).unwrap_or_default();
    if !found.iter().any(|c| c.name().eq_ignore_ascii_case("jsessionid")) {
        found = window
            .cookies()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| domain_is_lcam(c.domain()))
            .collect();
    }
    found
}

/// LCAM ドメインの Cookie を消す（毎回 SSO を通し直すため。Microsoft 側は消さない）。
fn clear_lcam_cookies(window: &WebviewWindow, url: &Url) {
    for c in lcam_cookies(window, url) {
        let _ = window.delete_cookie(c);
    }
}

/// SSO を通して Cookie を取得し、Worker に登録する。
/// - `start_visible`: 最初からウィンドウを表示する（手動の「接続」ボタン）。
/// - `allow_show`: 対話が要るときにウィンドウを表示してよいか（自動実行では false）。
pub async fn connect(app: &AppHandle, start_visible: bool, allow_show: bool) -> Result<Value, String> {
    if app.state::<ConnectState>().0.swap(true, Ordering::SeqCst) {
        return Err(err(409, "busy", "LCAM への接続処理がすでに実行中です"));
    }
    let _busy = BusyGuard(app.clone());

    // 前回の残りがあれば閉じる。
    if let Some(old) = app.get_webview_window(LABEL) {
        let _ = old.destroy();
    }

    let login_url: Url = LOGIN_URL.parse().map_err(|_| err(500, "internal", "invalid url"))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Url>();
    let tx_in_window = tx.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("LCAM ログイン")
        .on_page_load(move |_w, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = tx_in_window.send(payload.url().clone());
            }
        });
    #[cfg(desktop)]
    let builder = builder.inner_size(480.0, 760.0).visible(start_visible);
    #[cfg(mobile)]
    let builder = builder.user_agent(DESKTOP_UA);
    let window = builder
        .build()
        .map_err(|e| err(500, "window", &e.to_string()))?;
    // ウィンドウ側だけが送信側を持つ状態にする（ウィンドウが閉じたら rx が終わる）。
    drop(tx);
    let window = WindowGuard(window);

    clear_lcam_cookies(&window.0, &login_url);
    window
        .0
        .navigate(login_url.clone())
        .map_err(|e| err(500, "navigate", &e.to_string()))?;

    let start = Instant::now();
    let mut shown = start_visible;
    let mut submitted = false;
    let header = loop {
        match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            Ok(Some(url)) => match {
                let stage = classify(&url);
                // 診断用。クエリ（SAMLRequest 等）は出さず、ホストとパスだけ。
                eprintln!(
                    "[lcam_connect] {:>5.1}s page={}{} stage={:?}",
                    start.elapsed().as_secs_f32(),
                    url.host_str().unwrap_or(""),
                    url.path(),
                    stage
                );
                stage
            } {
                Stage::LcamLogin => {
                    if !submitted {
                        submitted = true;
                        window
                            .0
                            .eval("excludeSubmit()")
                            .map_err(|e| err(500, "eval", &e.to_string()))?;
                    } else {
                        // 送信後にログイン画面へ戻された: 自動では進めない（対話が要る）。
                        show_or_fail(&window.0, &mut shown, allow_show)?;
                    }
                }
                Stage::LcamAuthed => {
                    if let Some(h) = build_cookie_header(&lcam_cookies(&window.0, &login_url)) {
                        break h;
                    }
                }
                Stage::Microsoft | Stage::Other => {}
            },
            // ウィンドウが閉じられた（ユーザーが閉じた）。
            Ok(None) => return Err(err(499, "cancelled", "LCAM ログインが中止されました")),
            Err(_) => {}
        }
        if !shown && start.elapsed() > SILENT_LIMIT {
            show_or_fail(&window.0, &mut shown, allow_show)?;
        }
        if start.elapsed() > TOTAL_TIMEOUT {
            return Err(err(408, "timeout", "LCAM ログインがタイムアウトしました"));
        }
    };

    // Worker に登録（Worker が LCAM へ 1 回アクセスして有効性を確認してから保存する）。
    eprintln!("[lcam_connect] cookies read, registering to worker");
    commands::api_request(
        app.clone(),
        app.state::<SessionState>(),
        "/api/lcam/session".to_string(),
        "POST".to_string(),
        Some(json!({ "cookies": header })),
    )
    .await
}

/// 対話が要る状況でウィンドウを表示する。許可されていなければ interaction_required で失敗させる。
fn show_or_fail(window: &WebviewWindow, shown: &mut bool, allow_show: bool) -> Result<(), String> {
    if *shown {
        return Ok(());
    }
    if !allow_show {
        return Err(err(
            409,
            "interaction_required",
            "LCAM のログインに操作（番号入力など）が必要です。「LCAM に接続」から手動で実行してください",
        ));
    }
    let _ = window.show();
    let _ = window.set_focus();
    *shown = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn classify_lcam_and_microsoft() {
        assert_eq!(classify(&u("https://lcam.aitech.ac.jp/portalv2/")), Stage::LcamLogin);
        assert_eq!(classify(&u("https://lcam.aitech.ac.jp/portalv2")), Stage::LcamLogin);
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/mellon/postResponse")),
            Stage::Other
        );
        assert_eq!(
            classify(&u("https://login.microsoftonline.com/x/saml2?SAMLRequest=a")),
            Stage::Microsoft
        );
        assert_eq!(classify(&u("https://login.microsoftonline.com/kmsi")), Stage::Microsoft);
        assert_eq!(classify(&u("https://example.com/")), Stage::Other);
    }

    #[test]
    fn classify_authed_landing() {
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/portalv2/login/login/initLogin/sso")),
            Stage::LcamAuthed
        );
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/portalv2/common/generalPurpose/")),
            Stage::LcamAuthed
        );
        // ログイン系のエラー画面などは着地とみなさない。
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/portalv2/login/login/initLogin")),
            Stage::Other
        );
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/portalv2/login/login/initLogin/sso?x=1")),
            Stage::LcamAuthed
        );
    }

    fn cookie(name: &str, value: &str, domain: Option<&str>) -> Cookie<'static> {
        let mut b = Cookie::build((name.to_string(), value.to_string()));
        if let Some(d) = domain {
            b = b.domain(d.to_string());
        }
        b.build()
    }

    #[test]
    fn cookie_header_only_lcam_cookies() {
        let cookies = vec![
            cookie("JSESSIONID", "abc", Some("lcam.aitech.ac.jp")),
            cookie("LiveApps-Cookie", "2026", Some("lcam.aitech.ac.jp")),
            cookie("mellon-cookie", "m", Some("lcam.aitech.ac.jp")),
            cookie("ESTSAUTHPERSISTENT", "secret", Some("login.microsoftonline.com")),
            cookie("JSESSIONID", "other-site", Some("example.com")),
        ];
        assert_eq!(
            build_cookie_header(&cookies).as_deref(),
            Some("JSESSIONID=abc; LiveApps-Cookie=2026; mellon-cookie=m")
        );
    }

    #[test]
    fn cookie_header_jsessionid_only_and_missing() {
        let only = vec![cookie("JSESSIONID", "abc", Some(".lcam.aitech.ac.jp"))];
        assert_eq!(build_cookie_header(&only).as_deref(), Some("JSESSIONID=abc"));
        // domain が無い（Android）場合は URL で絞り込み済みとみなす。
        let android = vec![cookie("JSESSIONID", "abc", None)];
        assert_eq!(build_cookie_header(&android).as_deref(), Some("JSESSIONID=abc"));
        let none = vec![cookie("LiveApps-Cookie", "1", Some("lcam.aitech.ac.jp"))];
        assert_eq!(build_cookie_header(&none), None);
        assert_eq!(build_cookie_header(&[]), None);
    }
}
