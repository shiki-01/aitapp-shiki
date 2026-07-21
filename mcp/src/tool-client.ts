// ツール実装(tools/*)が依存するクライアントの抽象。
// 実装は2つ:
//   - mcp/src/client.ts   … ローカル(stdio)実行。worker へ HTTP で接続し、
//                           ダウンロードはローカル一時ファイルへ保存する。
//   - worker/src/mcp/self-client.ts … クラウド(Streamable HTTP)実行。同一 worker 内で
//                           ルーターへ in-process dispatch し、ダウンロードは base64 で返す。
// この分離により tools/* は Node 依存(fs 等)を持たず、Workers 上でもそのまま動く。

/** ダウンロード結果。path / base64 のどちらか一方が入る。 */
export interface DownloadedFile {
  fileName: string;
  contentType: string | null;
  /** ローカル(stdio)実行時のみ: 一時保存先の絶対パス。 */
  path?: string;
  /** クラウド(HTTP)実行時のみ: ファイル内容の base64。 */
  base64?: string;
}

export interface ToolClient {
  /**
   * 不可逆/取り消しにくい書き込み操作の out-of-band 確認秘密。
   * 人間が MCP ホストの設定（stdio は env `AITAPP_CONFIRM_SECRET`、`/mcp` は worker の
   * `CONFIRM_SECRET`）に入れた値で、モデルからは見えない・指定できない。ツール実装はこれを
   * worker へ転送するだけで、値そのものは決して LLM 由来の引数から取らない。
   * 未設定なら空文字（＝書き込みツールは実行前にエラーを返す）。
   */
  readonly confirmSecret: string;
  /**
   * confirmSecret が構造的に利用できない実装で、その理由をユーザー向けに説明する文字列。
   * 例: /mcp のユーザー別トークン（user モード）は out-of-band 確認経路が無いため、
   * worker の CONFIRM_SECRET を設定しても不可逆書き込みは実行できない。
   * 設定漏れ（confirmSecret が空）とは区別してエラーメッセージに使う。
   */
  readonly confirmUnavailableReason?: string;
  /** worker の JSON API 呼び出し。session 失効時は1回だけ再ログインしてリトライする。 */
  request<T>(path: string, init?: RequestInit): Promise<T>;
  /** LCAM 連絡の添付ファイルを取得する。 */
  downloadAttachment(relativePath: string, suggestedName: string): Promise<DownloadedFile>;
  /** Moodle 上のファイルを取得する。 */
  downloadMoodleFile(fileUrl: string, suggestedName: string): Promise<DownloadedFile>;
  /**
   * MCP サーバーが動作しているマシン上のローカルファイルを読む。
   * ローカル(stdio)実装のみ提供する。クラウド実装では undefined のままにし、
   * ツール側は base64 直接指定へ誘導するエラーを返す。
   */
  readLocalFile?(filePath: string): Promise<{ bytes: Uint8Array; name: string }>;
}
