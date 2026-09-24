// LCAM の自動再接続（オプトイン）。
//
// LCAM は、Worker が保存済みのアプリ用資格情報（MIGRATION_NOTES §15）で自動的に再ログインする。
// そのため `GET /api/lcam/session` の `registered` は、資格情報がある限り true で、通常この処理は動かない。
// 動くのは、資格情報が未登録、または LCAM に拒否されて破棄された（424）ときだけ。この設定をオンにすると、
// アプリが起動している間、Worker の LCAM が未登録なら WebView で SSO を通し直して `lamyapp://` の key を
// 取得し、Worker に登録する（lcam_login::connect）。
//
// 既定はオフ。LCAM は単一セッションなので、接続するとブラウザ等で開いている LCAM が切れる。
// 対話（番号入力など）が要る場合は、ウィンドウを勝手に出さず、6 時間は自動実行を止める。

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::commands;
use crate::lcam_login;
use crate::state::SessionState;
use crate::upstream::UpstreamClient;

const CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
const RETRY_COOLDOWN: Duration = Duration::from_secs(30 * 60);
const INTERACTION_BACKOFF: Duration = Duration::from_secs(6 * 60 * 60);

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("lcam_auto.txt"))
}

pub fn enabled(app: &AppHandle) -> bool {
    file_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

pub fn set_enabled(app: &AppHandle, on: bool) -> Result<(), String> {
    fs::write(file_path(app)?, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}

fn is_interaction_required(err: &str) -> bool {
    serde_json::from_str::<Value>(err)
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(|c| c == "interaction_required"))
        .unwrap_or(false)
}

/// バックグラウンドで定期的に確認し、必要なら自動で再接続する。
pub async fn run_loop(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut last_attempt: Option<Instant> = None;
    let mut blocked_until: Option<Instant> = None;
    loop {
        if enabled(&app) && should_attempt(&app, last_attempt, blocked_until).await {
            last_attempt = Some(Instant::now());
            // 自動実行では、対話が要ってもウィンドウを勝手に表示しない。
            if let Err(e) = lcam_login::connect(&app, false, false).await {
                eprintln!("[lcam_auto] connect failed: {}", e);
                if is_interaction_required(&e) {
                    blocked_until = Some(Instant::now() + INTERACTION_BACKOFF);
                }
            } else {
                eprintln!("[lcam_auto] connect ok");
            }
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

async fn should_attempt(
    app: &AppHandle,
    last_attempt: Option<Instant>,
    blocked_until: Option<Instant>,
) -> bool {
    let now = Instant::now();
    if last_attempt.is_some_and(|t| now.duration_since(t) < RETRY_COOLDOWN) {
        return false;
    }
    if blocked_until.is_some_and(|t| now < t) {
        return false;
    }
    // Worker にログイン済みで、LCAM が未登録/失効のときだけ。登録状況の取得は LCAM へアクセスしない。
    let Ok(cookie) = commands::current_cookie(app, &app.state::<SessionState>()) else {
        return false;
    };
    match UpstreamClient::new().request("/api/lcam/session", "GET", None, &cookie).await {
        Ok(v) => v.get("registered").and_then(|r| r.as_bool()) == Some(false),
        Err(_) => false,
    }
}
