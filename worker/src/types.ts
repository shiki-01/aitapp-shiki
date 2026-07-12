// Worker 全体で共有する型定義。

export interface Env {
  /** ユーザー状態を保持する KV namespace（1 ユーザー 1 key）。 */
  USER_KV: KVNamespace;
  /** credential 暗号化鍵（AES-GCM）。wrangler secret put CRED_KEY。 */
  CRED_KEY: string;
  /** session cookie 署名鍵（HMAC-SHA256）。wrangler secret put SESSION_SECRET。 */
  SESSION_SECRET: string;
  /** フロントのオリジン（CORS / Origin チェック）。 */
  APP_ORIGIN?: string;
  /** /api/schedule の reload ループ回数。 */
  SCHEDULE_WEEKS?: string;
  /** ローカル開発時に Moodle 接続先を強制的に上書きする（`.dev.vars` 専用、本番では未設定）。 */
  MOODLE_ORIGIN_OVERRIDE?: string;
}

/** AES-GCM 暗号文（base64）。 */
export interface Encrypted {
  iv: string;
  ciphertext: string;
}

/** LCAM 上流セッション Cookie。 */
export interface LcamCookies {
  jsessionid: string;
  liveApps: string;
}

/**
 * KV に格納するユーザー状態。要件 §6 のとおり 1 key に集約し、
 * 1 read で全状態を取得する。credential 部分は暗号文のみ。
 */
export interface UserState {
  /** LCAM 上流 Cookie。未ログイン/未取得なら null。 */
  lcamCookies: LcamCookies | null;
  /** Moodle token（長命・password 非依存）。 */
  moodleToken: string | null;
  /** 認証情報（AES-GCM 暗号文）。 */
  credential: Encrypted;
}

/** 復号後の認証情報（メモリ上でのみ保持し永続化しない）。 */
export interface Credential {
  id: string;
  password: string;
  /** Moodle 接続先ホスト名。未設定（空文字）なら Moodle 系機能は使わない。 */
  moodleOrigin: string;
}
