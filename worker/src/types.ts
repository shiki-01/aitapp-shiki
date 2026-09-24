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
  /**
   * フロント静的配信（web/build）の Workers Static Assets binding。
   * wrangler.toml の [assets] で設定。ローカルで web/ を vite dev で分離起動する
   * 構成では未バインドでもよい（その場合フロント配信は 404）。
   */
  ASSETS?: Fetcher;
  /**
   * フロント静的配信の Basic 認証（"user:pass" 形式）。未設定なら認証なしで配信。
   * 目的は公開 URL の覗き見防止のみ。/api は session cookie、/mcp は MCP_TOKEN と
   * それぞれ独自の認証を持つため対象外（Tauri/MCP クライアントを壊さない）。
   */
  WEB_BASIC_AUTH?: string;
  /** （廃止）/api/schedule は未対応になったため未使用。MIGRATION_NOTES §14。 */
  SCHEDULE_WEEKS?: string;
  /** ローカル開発時に Moodle 接続先を強制的に上書きする（`.dev.vars` 専用、本番では未設定）。 */
  MOODLE_ORIGIN_OVERRIDE?: string;
  /**
   * LCAM 中継 relay の URL（例 https://relay.shiki-01.com）。
   * LCAM の WAF は Cloudflare の egress IP を拒否するため（MIGRATION_NOTES §13.1）、
   * 本番では LCAM 宛リクエストのみ非 Cloudflare の relay 経由にする。
   * 未設定なら LCAM へ直接 fetch する（ローカル `wrangler dev` は未設定で直続。§13.4）。
   */
  LCAM_RELAY_URL?: string;
  /** LCAM relay の Bearer トークン。wrangler secret put LCAM_RELAY_TOKEN。LCAM_RELAY_URL とセットで有効。 */
  LCAM_RELAY_TOKEN?: string;
  /**
   * 不可逆/取り消しにくい書き込み操作（クイズ受験開始・確定、課題の下書き保存・
   * ファイル添付・最終提出、アンケート提出）の out-of-band 確認秘密。
   * これは worker 側の権威ある検証値であり、MCP ホストが人間保有の秘密
   * （stdio 実行は env `AITAPP_CONFIRM_SECRET`、`/mcp` 実行はこの `CONFIRM_SECRET` 自身）
   * から注入した値と一致したときだけ実行を許可する。モデルに見えるツール引数ではないため、
   * LLM が選んだ（あるいは上流データのプロンプトインジェクションが指示した）任意文字列では
   * 通らない。未設定なら該当書き込みは fail-closed で拒否する。
   * `wrangler secret put CONFIRM_SECRET`（十分に長いランダム値。例 openssl rand -hex 32）。
   */
  CONFIRM_SECRET?: string;

  // ---- /mcp（Streamable HTTP MCP サーバー）用。全て未設定なら /mcp は無効（404）。 ----
  /** /mcp の認証トークン（Bearer ヘッダ / /mcp/:token の両方で使う）。wrangler secret put MCP_TOKEN。URL パスに使える文字のみで生成する。 */
  MCP_TOKEN?: string;
  /** /mcp が使う大学ポータルのログインID。wrangler secret put AITAPP_ID。 */
  AITAPP_ID?: string;
  /** /mcp が使う大学ポータルのパスワード。wrangler secret put AITAPP_PASSWORD。 */
  AITAPP_PASSWORD?: string;
  /** /mcp が使う Moodle 接続先ホスト名（例 cms.aitech.ac.jp）。未設定なら Moodle 系ツール無効。 */
  AITAPP_MOODLE_ORIGIN?: string;
  /** Moodle 専用資格情報（LCAM とアカウントが別の場合のみ。両方揃ったときだけ使う）。 */
  AITAPP_MOODLE_ID?: string;
  AITAPP_MOODLE_PASSWORD?: string;
}

/** AES-GCM 暗号文（base64）。 */
export interface Encrypted {
  iv: string;
  ciphertext: string;
}

/**
 * LCAM 上流セッション Cookie。値はいずれも `NAME=value` 形式（Cookie ヘッダにそのまま連結する）。
 * ユーザーがブラウザで SSO（MFA）ログインして取得し、Worker に登録したもの。
 */
export interface LcamCookies {
  jsessionid: string;
  liveApps: string;
  /**
   * 追加で必要な Cookie（mod_auth_mellon の `mellon*` のみ許可。要否は実測で確認中）。
   * Microsoft（Entra）側の Cookie は受け付けない。
   */
  extra?: string[];
}

/**
 * LCAM セッションの寿命を自然な利用から測るための記録（ms epoch）。
 * 寿命は [lastOkAt - registeredAt, expiredAt - registeredAt] の範囲に入る。
 */
export interface LcamSessionMeta {
  registeredAt: number;
  /** 最後にデータ取得へ成功した時刻（KV write 節約のため間引いて更新する）。 */
  lastOkAt?: number;
  /** 失効を検知した時刻。設定されていれば lcamCookies は null に落としてある。 */
  expiredAt?: number;
}

/**
 * KV に格納するユーザー状態。要件 §6 のとおり 1 key に集約し、
 * 1 read で全状態を取得する。credential 部分は暗号文のみ。
 */
export interface UserState {
  /** LCAM 上流 Cookie。未登録/失効検知後は null。 */
  lcamCookies: LcamCookies | null;
  /** LCAM セッションの登録・失効の記録。旧 state には存在しないため optional。 */
  lcamSession?: LcamSessionMeta | null;
  /** Moodle token（長命・password 非依存）。 */
  moodleToken: string | null;
  /** 認証情報（AES-GCM 暗号文）。 */
  credential: Encrypted;
  /**
   * ユーザー別 MCP トークン（/mcp/<token>）の SHA-256 ハッシュ（hex）。
   * 平文トークンは発行時の応答でのみ返し、KV には置かない。
   * 未発行/失効済みなら undefined/null。過去に保存された state には存在しないため optional。
   */
  mcpTokenHash?: string | null;
  /**
   * ユーザー別 MCP トークン(user モード)からの不可逆書き込みを本人が許可したか。
   * Web 画面(セッション必須)からのみ変更でき、true のときだけ /mcp user モードに
   * CONFIRM_SECRET が注入される。未設定/false は拒否(fail-closed)。
   */
  mcpAllowWrites?: boolean;
}

/** 復号後の認証情報（メモリ上でのみ保持し永続化しない）。 */
export interface Credential {
  id: string;
  password: string;
  /** Moodle 接続先ホスト名。未設定（空文字）なら Moodle 系機能は使わない。 */
  moodleOrigin: string;
  /**
   * Moodle 専用の ID/パスワード（LCAM と Moodle のアカウントが別の場合に使う）。
   * 両方が非空のときだけ有効。未設定なら id/password をそのまま Moodle にも使う。
   * 過去に保存された credential には存在しないため optional。
   */
  moodleId?: string;
  moodlePassword?: string;
}
