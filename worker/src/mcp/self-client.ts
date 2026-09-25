// /mcp (Streamable HTTP) から自身の REST API を呼ぶ ToolClient 実装。
// ルーターへ in-process dispatch するため、ネットワーク往復も subrequest 消費もない。
//
// 認証まわり（2 モード）:
//   - owner モード（env の MCP_TOKEN で認証されたオーナー用）:
//     session cookie は SESSION_SECRET で毎回自己署名し、X-Aitapp-Internal: MCP_TOKEN を
//     付与する。認証ミドルウェアが env の資格情報（AITAPP_ID 等）で state を
//     ブートストラップするため、/api/auth/login の事前呼び出しは不要
//     （router.ts の認証ミドルウェア参照）。
//   - user モード（ユーザー別 MCP トークンで認証された一般ユーザー用）:
//     session cookie を該当 uid で自己署名するだけで、内部ヘッダは付けない。
//     state は本人が Web ログイン時に保存した KV の暗号化 credential をそのまま使う
//     （オーナーの env 資格情報には一切触れない）。
//   上流の認証は withMoodleToken（Moodle token の再取得）が必要になった時点で行う。
//   LCAM は MFA のため自動ログインせず、登録済み Cookie を withLcamSession で使う。

import type { Env } from '../types';
import type { ToolClient, DownloadedFile } from '../../../mcp/src/tool-client';
import { signSession, SESSION_COOKIE_NAME } from '../session/cookie';

export type Dispatch = (req: Request) => Promise<Response>;

/** base64 で返すダウンロードの上限（MCP レスポンスとして現実的な範囲に制限する）。 */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fileId(relativePath: string): string {
  const bytes = new TextEncoder().encode(relativePath);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SelfClient の認証コンテキスト。owner/user どちらのモードで動くかを表す。 */
export interface SelfAuth {
  /** リクエストを実行する userId（session cookie の uid）。 */
  uid: string;
  /**
   * true なら owner モード: X-Aitapp-Internal を付与し、認証ミドルウェアが env の
   * 資格情報で state をブートストラップする。false（user モード）なら KV の
   * 本人 state をそのまま使う。
   */
  internal: boolean;
  /** 不可逆書き込みツールへ CONFIRM_SECRET を注入するか。owner は常に true、
   *  user モードは本人が Web 画面で許可した場合のみ true。 */
  allowWrites: boolean;
}

export class SelfClient implements ToolClient {
  constructor(
    private readonly env: Env,
    private readonly dispatch: Dispatch,
    private readonly auth: SelfAuth,
  ) {}

  /**
   * out-of-band 確認秘密。owner モード、または本人が Web 画面で不可逆書き込みを
   * 許可した user モードにのみ worker の CONFIRM_SECRET を注入する。
   * 許可していない user モードでは常に空（＝不可逆書き込みツールは実行前に拒否）。
   */
  get confirmSecret(): string {
    return this.auth.internal || this.auth.allowWrites ? (this.env.CONFIRM_SECRET ?? '') : '';
  }

  /**
   * 許可していない user モードでは、worker に CONFIRM_SECRET を設定しても実行できない。
   * 「secret を設定すれば動く」という誤案内を避け、正しい許可経路（Web 画面）へ誘導する。
   */
  get confirmUnavailableReason(): string | undefined {
    if (this.auth.internal || this.auth.allowWrites) return undefined;
    return (
      'この接続のユーザーは不可逆書き込み（受験開始・提出等）を許可していません。' +
      'Web 画面（その他 → Claude 連携）で「不可逆操作を許可」をオンにしてから再実行してください。' +
      'MCP URL の再発行は不要です。'
    );
  }

  private origin(): string {
    return this.env.APP_ORIGIN ?? 'http://localhost:5173';
  }

  private async cookie(): Promise<string> {
    const token = await signSession(this.env.SESSION_SECRET, {
      uid: this.auth.uid,
      iat: Date.now(),
    });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  private async rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set('Cookie', await this.cookie());
    headers.set('Origin', this.origin());
    if (this.auth.internal) {
      headers.set('X-Aitapp-Internal', this.env.MCP_TOKEN ?? '');
    }
    return this.dispatch(new Request(`https://self${path}`, { ...init, headers }));
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.rawRequest(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async downloadAsBase64(path: string, suggestedName: string): Promise<DownloadedFile> {
    const res = await this.rawRequest(path);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const declared = parseInt(res.headers.get('content-length') ?? '', 10);
    if (!Number.isNaN(declared) && declared > MAX_DOWNLOAD_BYTES) {
      await res.body?.cancel();
      throw new Error(`file too large for remote MCP download (${declared} bytes > ${MAX_DOWNLOAD_BYTES})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`file too large for remote MCP download (${buf.byteLength} bytes > ${MAX_DOWNLOAD_BYTES})`);
    }
    const safeName = suggestedName.replace(/[\\/:*?"<>|]/g, '_') || 'download';
    return {
      fileName: safeName,
      contentType: res.headers.get('content-type'),
      base64: toBase64(buf),
    };
  }

  async downloadAttachment(relativePath: string, suggestedName: string): Promise<DownloadedFile> {
    return this.downloadAsBase64(`/api/file/${fileId(relativePath)}`, suggestedName);
  }

  async downloadMoodleFile(fileUrl: string, suggestedName: string): Promise<DownloadedFile> {
    return this.downloadAsBase64(`/api/moodle/file?url=${encodeURIComponent(fileUrl)}`, suggestedName);
  }

  async downloadApi(apiPath: string, suggestedName: string): Promise<DownloadedFile> {
    return this.downloadAsBase64(apiPath, suggestedName);
  }

  // readLocalFile は提供しない（クラウド実行にローカルファイルは存在しない）。
}
