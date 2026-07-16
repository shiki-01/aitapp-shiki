// /mcp (Streamable HTTP) から自身の REST API を呼ぶ ToolClient 実装。
// ルーターへ in-process dispatch するため、ネットワーク往復も subrequest 消費もない。
//
// 認証まわり:
//   - session cookie は SESSION_SECRET で毎回自己署名する（永続化しない）。
//   - X-Aitapp-Internal: MCP_TOKEN を付与すると、認証ミドルウェアが env の資格情報
//     （AITAPP_ID 等）で state をブートストラップするため、/api/auth/login の事前呼び出しは
//     不要（router.ts の認証ミドルウェア参照）。上流ログインは withLcamRelogin /
//     withMoodleToken が必要になった時点で行う。

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

export class SelfClient implements ToolClient {
  constructor(
    private readonly env: Env,
    private readonly dispatch: Dispatch,
  ) {}

  /** out-of-band 確認秘密（worker の CONFIRM_SECRET 由来）。モデル引数からは取らない。 */
  get confirmSecret(): string {
    return this.env.CONFIRM_SECRET ?? '';
  }

  private origin(): string {
    return this.env.APP_ORIGIN ?? 'http://localhost:5173';
  }

  private async cookie(): Promise<string> {
    const token = await signSession(this.env.SESSION_SECRET, {
      uid: this.env.AITAPP_ID ?? '',
      iat: Date.now(),
    });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  private async rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set('Cookie', await this.cookie());
    headers.set('Origin', this.origin());
    headers.set('X-Aitapp-Internal', this.env.MCP_TOKEN ?? '');
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
