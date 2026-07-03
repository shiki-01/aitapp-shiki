// Worker(BFF)の接続先。実運用URLは `AITAPP_WORKER_BASE_URL` / `AITAPP_APP_ORIGIN`
// をビルド時の環境変数として渡す（`.env.example` 参照）。未設定時はローカル開発値。

const DEFAULT_WORKER_BASE_URL: &str = "http://localhost:8787";
const DEFAULT_APP_ORIGIN: &str = "http://localhost:5173";

pub fn worker_base_url() -> &'static str {
    option_env!("AITAPP_WORKER_BASE_URL").unwrap_or(DEFAULT_WORKER_BASE_URL)
}

// Workerの状態変更系エンドポイント(login/logout)はOriginチェックを行うため、
// ブラウザではない本クライアントも一致するOriginヘッダを自ら付与する。
pub fn app_origin() -> &'static str {
    option_env!("AITAPP_APP_ORIGIN").unwrap_or(DEFAULT_APP_ORIGIN)
}
