// LCAM の SSO ログインを WebView で通し、アプリキーを Worker に登録する。
//
// LCAM は Entra ID の SAML SSO + MFA で、Worker は自動ログインできない。ここでは
// ユーザー端末の WebView（OS 管理のプロファイル）で SSO を通す。SP 経路（https://lcam.aitech.ac.jp/portalv2/sp）
// は、SSO 完了時に lamyapp:// カスタムスキーム URL に遷移する。この URL を傍受してキーを抽出し、
// Worker の POST /api/lcam/session に appKey として送ると、Worker が資格情報に交換して保存する。
// キーは使い捨てで短命（傍受したらすぐ送るべき）。
//
// 流れ:
//   1. LCAM 側の Cookie を消してから https://lcam.aitech.ac.jp/portalv2/sp を開く（毎回 SSO を通し直す）
//   2. SP ログイン画面の `excludeSubmit()` を実行 → smartPhoneLogin/sso → Entra へ
//   3. Entra のセッションが生きていれば番号入力なしで戻ってくる。止まる場合は、許可されていれば
//      ウィンドウを表示してユーザーに操作してもらう（MFA の自動化・回避はしない）
//   4. SSO 完了時に lamyapp:// URL に遷移する → これを傍受してキーを抽出し Worker に登録
//      またはログイン後ページ着地（key 無し）→ エラーで失敗
//
// 注意: LCAM は単一セッションのため、ここでログインすると他の端末・ブラウザ・公式アプリの
// LCAM セッションは切れる。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands;
use crate::state::SessionState;

pub const LABEL: &str = "lcam-login";
const LOGIN_URL: &str = "https://lcam.aitech.ac.jp/portalv2/sp";
const LCAM_HOST: &str = "lcam.aitech.ac.jp";

/// 表示しない状態で SSO が完了しない場合に「対話が要る」と判断するまでの時間。
const SILENT_LIMIT: Duration = Duration::from_secs(20);
/// 全体のタイムアウト（ユーザーが MFA を通す時間を含む）。
const TOTAL_TIMEOUT: Duration = Duration::from_secs(300);

/// SP 経路に進むため、全プラットフォームでモバイル UA を使う。
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/// 同時に 1 回だけ実行するためのフラグ。
#[derive(Default)]
pub struct ConnectState(pub AtomicBool);

#[derive(Debug, PartialEq)]
pub enum Stage {
    /// LCAM の SP ログイン画面（/portalv2/sp）。
    LcamLogin,
    /// Microsoft（Entra）側の画面。
    Microsoft,
    /// LCAM のログイン後ページ（SSO 完了後のページ、またはホーム等）。
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
        // LCAM は URL のパスに `;jsessionid=…` を付けることがあるため、その部分は除いて判定する。
        let p = url.path();
        let p = p.split(';').next().unwrap_or(p);
        // SP ログイン画面。
        if p == "/portalv2/sp" || p == "/portalv2/sp/" {
            return Stage::LcamLogin;
        }
        if p.starts_with("/mellon/") {
            return Stage::Other; // SAML の中継
        }
        if p.starts_with("/portalv2/login/") {
            // ログイン系の画面のうち、SSO 完了後の着地だけをログイン後とみなす。
            // smartPhoneLogin/sso は本新方式では使われない（lamyapp:// で先に傍受される）。
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

/// LCAM ドメインの Cookie を消す（毎回 SSO を通し直すため。Microsoft 側は消さない）。
fn clear_lcam_cookies(window: &WebviewWindow, url: &Url) {
    let mut cookies = window.cookies_for_url(url.clone()).unwrap_or_default();
    // macOS/iOS の cookies_for_url は domain の完全一致で絞るため、取れなければ全件から自前で絞る。
    if !cookies.iter().any(|c| c.name().eq_ignore_ascii_case("jsessionid")) {
        cookies = window
            .cookies()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| domain_is_lcam(c.domain()))
            .collect();
    }
    for c in cookies {
        let _ = window.delete_cookie(c);
    }
}

/// SSO を通してアプリキーを取得し、Worker に登録する。
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

    // ページロードと lamyapp:// スキーム傍受を同じチャネルで受け取るため、Event 列挙型を使う。
    enum Event {
        Page(Url),
        AppKey(String),
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Event>();

    // ページロード検知
    let tx_page = tx.clone();
    let on_page_load = move |_window: WebviewWindow, payload: PageLoadPayload<'_>| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = tx_page.send(Event::Page(payload.url().clone()));
        }
    };

    // lamyapp:// スキーム傍受
    let tx_nav = tx.clone();
    let on_navigation = move |url: &Url| -> bool {
        if url.scheme() == "lamyapp" {
            // キーはログに出さない。スキーム名のみを診断ログに出す。
            eprintln!("[lcam_connect] navigation intercepted: scheme=lamyapp");
            let _ = tx_nav.send(Event::AppKey(url.to_string()));
            false // 遷移を止める
        } else {
            true // 通常の遷移を続ける
        }
    };

    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("LCAM ログイン")
        .on_page_load(on_page_load)
        .on_navigation(on_navigation)
        .user_agent(MOBILE_UA);
    #[cfg(desktop)]
    let builder = builder.inner_size(480.0, 760.0).visible(start_visible);
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
    let app_key = loop {
        match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            Ok(Some(event)) => match event {
                Event::Page(url) => match {
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
                        // key が得られないままログイン後ページに着地：失敗と判定
                        return Err(err(502, "no_app_key", "LCAM のアプリキーが取得できませんでした"));
                    }
                    Stage::Microsoft | Stage::Other => {}
                },
                Event::AppKey(key) => {
                    // キーを取得したら終了
                    break key;
                }
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

    // Worker に登録。appKey は傍受した lamyapp:// URL 全体。
    eprintln!("[lcam_connect] appKey received, registering to worker");
    commands::api_request(
        app.clone(),
        app.state::<SessionState>(),
        "/api/lcam/session".to_string(),
        "POST".to_string(),
        Some(json!({ "appKey": app_key })),
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
    fn classify_sp_login_screen() {
        // SP ログイン画面（新方式）。
        assert_eq!(classify(&u("https://lcam.aitech.ac.jp/portalv2/sp")), Stage::LcamLogin);
        assert_eq!(classify(&u("https://lcam.aitech.ac.jp/portalv2/sp/")), Stage::LcamLogin);
        // パスに付く jsessionid はログイン画面の判定に影響しない。
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/portalv2/sp;jsessionid=abc.poap1")),
            Stage::LcamLogin
        );
    }

    #[test]
    fn classify_microsoft() {
        assert_eq!(
            classify(&u("https://login.microsoftonline.com/x/saml2?SAMLRequest=a")),
            Stage::Microsoft
        );
        assert_eq!(classify(&u("https://login.microsoftonline.com/kmsi")), Stage::Microsoft);
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

    #[test]
    fn classify_other() {
        assert_eq!(
            classify(&u("https://lcam.aitech.ac.jp/mellon/postResponse")),
            Stage::Other
        );
        assert_eq!(classify(&u("https://example.com/")), Stage::Other);
    }
}
