// 環境変数からの設定読み込み。値の永続化はしない。

export interface Config {
  /** worker/ のベースURL（デプロイ済みURL or `wrangler dev` のURL）。 */
  workerUrl: string;
  /** worker の APP_ORIGIN と一致させる Origin ヘッダ値（login/logoutのOriginチェック用）。 */
  appOrigin: string;
  /** 大学ポータルのログインID。 */
  portalId: string;
  /** 大学ポータルのログインパスワード。 */
  portalPassword: string;
  /** Moodle 接続先ホスト名。未設定なら Moodle 系ツールは使えない。 */
  moodleOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const workerUrl = env.AITAPP_WORKER_URL ?? 'http://localhost:8787';
  const appOrigin = env.AITAPP_APP_ORIGIN ?? 'http://localhost:5173';
  const portalId = env.AITAPP_ID ?? '';
  const portalPassword = env.AITAPP_PASSWORD ?? '';
  const moodleOrigin = env.AITAPP_MOODLE_ORIGIN ?? '';
  if (!portalId || !portalPassword) {
    throw new Error(
      'AITAPP_ID / AITAPP_PASSWORD が未設定です。MCPサーバー起動時の環境変数で渡してください。',
    );
  }
  return { workerUrl, appOrigin, portalId, portalPassword, moodleOrigin };
}
