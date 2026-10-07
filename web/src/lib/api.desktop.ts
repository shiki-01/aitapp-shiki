// desktop(Tauri)版 API クライアント。webviewからWorkerへは直接fetchせず、
// すべてRust backend(src-tauri)へのinvoke経由にする。TauriのwebviewはWorker
// と別サイト扱いになりSameSite=Strictのsession cookieが送れないため、Rustが
// 独自にHTTPクライアントとしてWorkerへ話しかけ、cookie保持とOSキーチェーンへの
// 永続化(永続ログイン)を担う。
import { invoke } from '@tauri-apps/api/core';
import { ApiError, type ApiClient } from './types';
import { qs, fileApiPath, reportParams, pcNoticeParams } from './apiPath';

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

async function invokeApi<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  try {
    return await invoke<T>('api_request', { path, method, body: body ?? null });
  } catch (err) {
    throw toApiError(err);
  }
}

// LCAM が要再登録(424)になったとき、「LCAM 自動再接続」がオンなら、次の画面操作を待たずに
// 裏で WebView の SSO を通し直し、失敗した呼び出しを 1 回だけ再実行する。
// 同時に失敗した呼び出しは 1 回の再接続を共有し、失敗したら一定時間は試さない(対話が要る場合など)。
const RECONNECT_COOLDOWN_MS = 30 * 60 * 1000;
let reconnecting: Promise<boolean> | null = null;
let reconnectBlockedUntil = 0;

function autoReconnect(): Promise<boolean> {
  if (Date.now() < reconnectBlockedUntil) return Promise.resolve(false);
  reconnecting ??= (async () => {
    try {
      if (!(await invoke<boolean>('lcam_auto_get'))) return false;
      await invoke('lcam_connect_auto');
      return true;
    } catch {
      reconnectBlockedUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      return false;
    } finally {
      reconnecting = null;
    }
  })();
  return reconnecting;
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  try {
    return await invokeApi<T>(path, method, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 424 && !path.startsWith('/api/lcam/session')) {
      if (await autoReconnect()) return invokeApi<T>(path, method, body);
    }
    throw err;
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
    return call('/api/auth/me');
  },
  // MCP トークンの発行/失効は worker の /api を Rust backend 経由で叩くだけ（GET/POST のみで
  // 済むよう worker 側のエンドポイントを POST に揃えてある）。
  async mcpTokenIssue() {
    return call('/api/auth/mcp-token', 'POST');
  },
  async mcpTokenRevoke() {
    return call('/api/auth/mcp-token/revoke', 'POST');
  },
  async mcpWritesSet(allow) {
    return call('/api/auth/mcp-writes', 'POST', { allow });
  },
  async lcamSession() {
    return call('/api/lcam/session');
  },
  async lcamSessionSet(cookies) {
    return call('/api/lcam/session', 'POST', { cookies });
  },
  async lcamAppKeySet(appKey) {
    return call('/api/lcam/session', 'POST', { appKey });
  },
  async lcamSessionDelete() {
    return call('/api/lcam/session/revoke', 'POST');
  },
  async lcamConnect() {
    try {
      return await invoke('lcam_connect');
    } catch (err) {
      throw toApiError(err);
    }
  },
  async lcamAutoGet() {
    try {
      return await invoke<boolean>('lcam_auto_get');
    } catch (err) {
      throw toApiError(err);
    }
  },
  async lcamAutoSet(enabled) {
    try {
      await invoke('lcam_auto_set', { enabled });
    } catch (err) {
      throw toApiError(err);
    }
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
  async schedule(weeks, month) {
    return call(`/api/schedule${qs({ weeks, month })}`);
  },
  async assignments() {
    return call('/api/assignments');
  },
  async assignmentStatuses(ids) {
    return call(`/api/moodle/assignment/status${qs({ assignmentIds: ids.join(',') })}`);
  },
  async enquetes() {
    return call(`/api/enquetes${qs({ type: 'class' })}`);
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
  async commonFiles() {
    return call('/api/commonfiles');
  },
  async commonFileDetail(id) {
    return call(`/api/commonfiles/detail${qs({ id })}`);
  },
  commonFileDownloadUrl() {
    // desktop版はopenCommonFile()で既定ブラウザを開くため呼ばれない。
    throw new ApiError(500, 'commonFileDownloadUrl is not supported on desktop');
  },
  async openCommonFile(id, no, filename) {
    // download_file の path は worker へ GET する生のパス（相対パスの base64 化は fileApiPath 側の都合）。
    let localPath: string;
    try {
      localPath = await invoke<string>('download_file', {
        path: `/api/commonfiles/download${qs({ id, no })}`,
        filename: filename ?? null,
      });
    } catch (err) {
      throw toApiError(err);
    }
    try {
      await invoke('open_in_browser', { path: localPath });
    } catch (err) {
      throw toApiError(err);
    }
  },
  async reports(query) {
    return call(`/api/reports${qs(reportParams(query))}`);
  },
  async reportDetail(id, query) {
    return call(`/api/reports/detail${qs({ id, ...reportParams(query) })}`);
  },
  reportDownloadUrl() {
    // desktop版はopenReportFile()で既定ブラウザを開くため呼ばれない。
    throw new ApiError(500, 'reportDownloadUrl is not supported on desktop');
  },
  async openReportFile(id, submitNo, fileNo, filename, query) {
    let localPath: string;
    try {
      localPath = await invoke<string>('download_file', {
        path: `/api/reports/download${qs({ id, submitNo, fileNo, ...reportParams(query) })}`,
        filename: filename ?? null,
      });
    } catch (err) {
      throw toApiError(err);
    }
    try {
      await invoke('open_in_browser', { path: localPath });
    } catch (err) {
      throw toApiError(err);
    }
  },
  async facilities() {
    return call('/api/facilities');
  },
  async facilitySchedule(ids, week) {
    return call(`/api/facilities/schedule${qs({ ids: ids.join(','), week })}`);
  },
  async credits() {
    return call('/api/credits');
  },
  async curriculum() {
    return call('/api/curriculum');
  },
  async schoolEvents(month) {
    return call(`/api/schoolevents${qs({ month })}`);
  },
  async lottery() {
    return call('/api/lottery');
  },
  async pcNotices(kind, query) {
    return call(`/api/pcnotices${qs({ kind, ...pcNoticeParams(query) })}`);
  },
  async pcNoticeDetail(kind, id, query) {
    return call(`/api/pcnotices/detail${qs({ kind, id, ...pcNoticeParams(query) })}`);
  },
  pcNoticeFileUrl() {
    // desktop版はopenPcNoticeFile()で既定ブラウザを開くため呼ばれない。
    throw new ApiError(500, 'pcNoticeFileUrl is not supported on desktop');
  },
  async openPcNoticeFile(kind, id, no, filename, query) {
    let localPath: string;
    try {
      localPath = await invoke<string>('download_file', {
        path: `/api/pcnotices/file${qs({ kind, id, no, ...pcNoticeParams(query) })}`,
        filename: filename ?? null,
      });
    } catch (err) {
      throw toApiError(err);
    }
    try {
      await invoke('open_in_browser', { path: localPath });
    } catch (err) {
      throw toApiError(err);
    }
  },
  async staff(name) {
    return call(`/api/staff${qs({ name })}`);
  },
  async staffSchedule(name, code, week) {
    return call(`/api/staff/schedule${qs({ name, code, week })}`);
  },
  kyoumuOpenUrl() {
    // Worker の session cookie が要るため、desktop 版（Rust backend 経由）では開けない。
    return null;
  },
  fileUrl() {
    // desktop版はopenFile()で既定ブラウザを開くため呼ばれない。
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
    try {
      await invoke('open_in_browser', { path: localPath });
    } catch (err) {
      throw toApiError(err);
    }
  },
};
