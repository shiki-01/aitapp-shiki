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
//   いずれも上流ログインは withLcamRelogin / withMoodleToken が必要になった時点で行う。

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
}

export class SelfClient implements ToolClient {
  constructor(
    private readonly env: Env,
    private readonly dispatch: Dispatch,
    private readonly auth: SelfAuth,
  ) {}

  /**
   * out-of-band 確認秘密。owner モードのみ worker の CONFIRM_SECRET を注入する。
   * user モードでは常に空（＝不可逆書き込みツールは confirm_secret_unset で拒否）。
   * ユーザー別トークンには out-of-band の確認経路（トークンと別に人間が保持する秘密の
   * 伝達手段）が無いため、fail-closed に倒す。
   */
  get confirmSecret(): string {
    return this.auth.internal ? (this.env.CONFIRM_SECRET ?? '') : '';
  }

  /**
   * user モードでは CONFIRM_SECRET を設定しても不可逆書き込みは実行できない。
   * 「worker に secret を設定すれば動く」という誤案内を避けるため理由を返す。
   */
  get confirmUnavailableReason(): string | undefined {
    if (this.auth.internal) return undefined;
    return (
      'この接続はユーザー別 MCP トークン（user モード）のため、不可逆書き込みツールは実行できません。' +
      'worker の CONFIRM_SECRET を設定しても user モードには適用されません。' +
      '不可逆操作が必要な場合は、オーナー用 MCP_TOKEN を使った /mcp 接続に切り替えた上で、' +
      'worker に CONFIRM_SECRET を設定してください（bunx wrangler secret put CONFIRM_SECRET）。'
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

  // readLocalFile は提供しない（クラウド実行にローカルファイルは存在しない）。
}
