// Worker(BFF)への直接HTTPクライアント。webviewのfetchを経由しないため、
// Tauriの独自オリジンとWorkerドメインが別サイト扱いになる
// SameSite=Strict cookie問題を回避できる(ここはブラウザではないので
// 通常のCookieヘッダを自分で付け外しすればよい)。

use crate::config::{app_origin, worker_base_url};
use reqwest::header::{COOKIE, SET_COOKIE};
use serde_json::Value;

pub struct LoginOutcome {
    pub session_cookie: String,
    pub body: Value,
}

pub struct DownloadOutcome {
    pub bytes: Vec<u8>,
    pub content_disposition: Option<String>,
}

pub struct UpstreamClient {
    client: reqwest::Client,
}

impl UpstreamClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    pub async fn login(&self, id: &str, password: &str) -> Result<LoginOutcome, String> {
        let url = format!("{}/api/auth/login", worker_base_url());
        let res = self
            .client
            .post(&url)
            .header("Origin", app_origin())
            .json(&serde_json::json!({ "id": id, "password": password }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = res.status();
        let cookie = res
            .headers()
            .get(SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.split(';').next())
            .map(|s| s.trim().to_string());
        let body: Value = res.json().await.unwrap_or(Value::Null);

        if !status.is_success() {
            return Err(error_json(status.as_u16(), &body));
        }
        let session_cookie = cookie.ok_or_else(|| "missing session cookie".to_string())?;
        Ok(LoginOutcome {
            session_cookie,
            body,
        })
    }

    pub async fn logout(&self, cookie: &str) {
        let url = format!("{}/api/auth/logout", worker_base_url());
        let _ = self
            .client
            .post(&url)
            .header("Origin", app_origin())
            .header(COOKIE, cookie)
            .send()
            .await;
    }

    pub async fn me(&self, cookie: &str) -> Result<Value, String> {
        self.request("/api/auth/me", "GET", None, cookie).await
    }

    pub async fn request(
        &self,
        path: &str,
        method: &str,
        body: Option<Value>,
        cookie: &str,
    ) -> Result<Value, String> {
        let url = format!("{}{}", worker_base_url(), path);
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = self
            .client
            .request(m, &url)
            .header(COOKIE, cookie)
            .header("Origin", app_origin());
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(error_json(status.as_u16(), &body));
        }
        Ok(body)
    }

    pub async fn download(&self, path: &str, cookie: &str) -> Result<DownloadOutcome, String> {
        let url = format!("{}{}", worker_base_url(), path);
        let res = self
            .client
            .get(&url)
            .header(COOKIE, cookie)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if !status.is_success() {
            return Err(error_json(status.as_u16(), &Value::Null));
        }
        let content_disposition = res
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok(DownloadOutcome {
            bytes,
            content_disposition,
        })
    }
}

// フロントに投げるエラーはJSON文字列にして、statusを見て401判定できるようにする。
fn error_json(status: u16, body: &Value) -> String {
    serde_json::json!({
        "status": status,
        "code": body.get("error").and_then(|v| v.as_str()),
        "message": body
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| body.get("error").and_then(|v| v.as_str()))
            .unwrap_or("upstream error"),
    })
    .to_string()
}

pub fn is_unauthorized(err: &str) -> bool {
    serde_json::from_str::<Value>(err)
        .ok()
        .and_then(|v| v.get("status").and_then(|s| s.as_u64()))
        == Some(401)
}
