// desktop(Tauri)版 API クライアント。webviewからWorkerへは直接fetchせず、
// すべてRust backend(src-tauri)へのinvoke経由にする。TauriのwebviewはWorker
// と別サイト扱いになりSameSite=Strictのsession cookieが送れないため、Rustが
// 独自にHTTPクライアントとしてWorkerへ話しかけ、cookie保持とOSキーチェーンへの
// 永続化(永続ログイン)を担う。
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { ApiError, type ApiClient } from './types';
import { qs, fileApiPath } from './apiPath';

interface UpstreamErrorShape {
  status?: number;
  code?: string;
  message?: string;
}

function toApiError(err: unknown): ApiError {
  if (typeof err === 'string') {
    try {
      const parsed = JSON.parse(err) as UpstreamErrorShape;
      return new ApiError(parsed.status ?? 500, parsed.message ?? 'desktop error', parsed.code);
    } catch {
      return new ApiError(500, err);
    }
  }
  return new ApiError(500, String(err));
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  try {
    return await invoke<T>('api_request', { path, method, body: body ?? null });
  } catch (err) {
    throw toApiError(err);
  }
}

export const desktopApi: ApiClient = {
  async login(id, password) {
    try {
      return await invoke('login', { id, password });
    } catch (err) {
      throw toApiError(err);
    }
  },
  async logout() {
    try {
      await invoke('logout');
    } catch (err) {
      throw toApiError(err);
    }
    return { ok: true };
  },
  async me() {
    let uid: string | null;
    try {
      uid = await invoke<string | null>('restore_session');
    } catch (err) {
      throw toApiError(err);
    }
    if (!uid) throw new ApiError(401, 'unauthorized');
    return { userId: uid };
  },
  // MCP トークンの発行/失効は worker の /api を Rust backend 経由で叩くだけ（GET/POST のみで
  // 済むよう worker 側のエンドポイントを POST に揃えてある）。
  async mcpTokenIssue() {
    return call('/api/auth/mcp-token', 'POST');
  },
  async mcpTokenRevoke() {
    return call('/api/auth/mcp-token/revoke', 'POST');
  },
  async notices(type, count = 10) {
    return call(`/api/notices${qs({ type, count })}`);
  },
  async noticeDetail(type, index) {
    return call(`/api/notices/detail${qs({ type, index })}`);
  },
  async timetable() {
    return call('/api/timetable');
  },
  async schedule() {
    return call('/api/schedule');
  },
  async assignments() {
    return call('/api/assignments');
  },
  async syllabusFilters(year) {
    return call(`/api/syllabus/filters${qs({ year })}`);
  },
  async syllabusSearch(params) {
    return call(`/api/syllabus/search${qs(params)}`);
  },
  async syllabusDetail(url, context = {}) {
    return call(`/api/syllabus/detail${qs({ url, ...context })}`);
  },
  fileUrl() {
    // desktop版はopenFile()でOS既定アプリを開くため呼ばれない。
    throw new ApiError(500, 'fileUrl is not supported on desktop');
  },
  async openFile(relativePath) {
    let localPath: string;
    try {
      localPath = await invoke<string>('download_file', {
        path: fileApiPath(relativePath),
        filename: null,
      });
    } catch (err) {
      throw toApiError(err);
    }
    await openPath(localPath);
  },
};
