// worker/ の REST API を叩く薄いクライアント。
// スクレイピング・CSRF・再ログインのロジックは worker 側に置いたまま持たない。
// ここでは「session cookie を保持し、401なら1回だけ再ログインしてリトライする」
// という transport 層の責務だけを持つ（直列化・keep-alive・自動復旧はしない）。

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Config } from './config';
import type { ToolClient, DownloadedFile } from './tool-client';
import { loadCachedCookie, saveCachedCookie } from './session';
import { SESSION_COOKIE_NAME } from './constants';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function extractSessionCookie(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie ? headers.getSetCookie() : [];
  const raw = values.find((v) => v.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? res.headers.get('set-cookie');
  if (!raw) return undefined;
  const pair = raw.split(';', 1)[0];
  return pair?.startsWith(`${SESSION_COOKIE_NAME}=`) ? pair : undefined;
}

export class WorkerClient implements ToolClient {
  private cookie: string | undefined;
  private loginInFlight: Promise<void> | undefined;

  constructor(private readonly config: Config) {}

  /** out-of-band 確認秘密（env AITAPP_CONFIRM_SECRET 由来）。モデル引数からは取らない。 */
  get confirmSecret(): string {
    return this.config.confirmSecret;
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.config.workerUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.config.appOrigin,
      },
      body: JSON.stringify({
        id: this.config.portalId,
        password: this.config.portalPassword,
        moodleOrigin: this.config.moodleOrigin,
        // Moodle 専用資格情報は両方揃っているときだけ渡す（片方だけなら無視される）。
        ...(this.config.moodleId && this.config.moodlePassword
          ? { moodleId: this.config.moodleId, moodlePassword: this.config.moodlePassword }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(res.status, body.message ?? body.error ?? `login failed: HTTP ${res.status}`, body.error);
    }
    const cookie = extractSessionCookie(res);
    if (!cookie) throw new ApiError(res.status, 'login succeeded but no session cookie was returned');
    this.cookie = cookie;
    await saveCachedCookie(this.config.portalId, this.config.workerUrl, cookie);
  }

  /** ログイン処理を多重起動しないための直列化（同一プロセス内のみ）。 */
  private async ensureLogin(): Promise<void> {
    if (this.cookie) return;
    const cached = await loadCachedCookie(this.config.portalId, this.config.workerUrl);
    if (cached) {
      this.cookie = cached;
      return;
    }
    if (!this.loginInFlight) this.loginInFlight = this.login().finally(() => (this.loginInFlight = undefined));
    await this.loginInFlight;
  }

  private async rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureLogin();
    return fetch(`${this.config.workerUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Cookie: this.cookie ?? '',
        // 状態変更系エンドポイント（例: /api/enquetes/answer）は Origin チェックを行うため付与する。
        Origin: this.config.appOrigin,
      },
    });
  }

  /**
   * JSON API 呼び出し。401（session無効/失効）を検知したら1回だけ再ログインして
   * リトライし、それでも失敗したらエラーをそのまま呼び出し元に返す。
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res = await this.rawRequest(path, init);
    if (res.status === 401) {
      this.cookie = undefined;
      this.loginInFlight = undefined;
      await this.login();
      res = await this.rawRequest(path, init);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${res.status}`, body.error);
    }
    return (await res.json()) as T;
  }

  private fileId(relativePath: string): string {
    return Buffer.from(relativePath, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * LCAM連絡の添付ファイルをローカル一時ディレクトリへ保存し、パスを返す。
   * `relativePath` は get_notice_detail が返す `files` の値をそのまま渡す。
   */
  async downloadAttachment(
    relativePath: string,
    suggestedName: string,
  ): Promise<DownloadedFile> {
    const id = this.fileId(relativePath);
    let res = await this.rawRequest(`/api/file/${id}`);
    if (res.status === 401) {
      this.cookie = undefined;
      this.loginInFlight = undefined;
      await this.login();
      res = await this.rawRequest(`/api/file/${id}`);
    }
    if (!res.ok) {
      throw new ApiError(res.status, `attachment download failed: HTTP ${res.status}`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'aitapp-mcp-'));
    const safeName = suggestedName.replace(/[\\/:*?"<>|]/g, '_') || 'attachment';
    const path = join(dir, safeName);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path, buf);
    return { fileName: safeName, path, contentType: res.headers.get('content-type') };
  }

  /**
   * Moodle上のファイル(コースの資料・設問中の音声等)をローカル一時ディレクトリへ保存し、
   * パスを返す。`fileUrl` は moodle_get_course_files の fileUrl、または設問HTML中の
   * pluginfile.php/file.php の絶対URLをそのまま渡す。
   */
  async downloadMoodleFile(
    fileUrl: string,
    suggestedName: string,
  ): Promise<DownloadedFile> {
    const path = `/api/moodle/file?url=${encodeURIComponent(fileUrl)}`;
    let res = await this.rawRequest(path);
    if (res.status === 401) {
      this.cookie = undefined;
      this.loginInFlight = undefined;
      await this.login();
      res = await this.rawRequest(path);
    }
    if (!res.ok) {
      throw new ApiError(res.status, `Moodle file download failed: HTTP ${res.status}`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'aitapp-mcp-'));
    const safeName = suggestedName.replace(/[\\/:*?"<>|]/g, '_') || 'moodle-file';
    const savedPath = join(dir, safeName);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(savedPath, buf);
    return { fileName: safeName, path: savedPath, contentType: res.headers.get('content-type') };
  }

  /** ローカル実行専用: MCPサーバーと同じマシン上のファイルを読む（課題アップロード用）。 */
  async readLocalFile(filePath: string): Promise<{ bytes: Uint8Array; name: string }> {
    const buf = await readFile(filePath);
    return { bytes: new Uint8Array(buf), name: basename(filePath) };
  }
}
