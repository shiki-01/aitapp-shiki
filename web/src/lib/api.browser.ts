// browser版 API クライアント。session cookie を送るため常に credentials: 'include'。
// 認証情報は cookie のみ。平文 password は login のリクエストボディでのみ送る。

import { goto } from '$app/navigation';
import { ApiError, type ApiClient } from './types';
import { qs, fileApiPath, reportParams } from './apiPath';

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

// session 失効（logout やパスワード変更で KV state が消え、cookie は有効でも
// データが取れない状態）からの回復。データ系エンドポイントで 401 を受けたら
// /login へ誘導する。auth 系（login/logout/me）は呼び出し側が扱うため除外し、
// 既に /login にいる場合は何もしない（リダイレクトループ防止）。
function recoverFromUnauthorized(path: string): void {
  if (path.startsWith('/api/auth/')) return;
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/login')) return;
  void goto('/login');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let code: string | undefined;
    let correlationId: string | undefined;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        correlationId?: string;
      };
      code = body.error;
      correlationId = body.correlationId;
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    // correlationId があれば、ユーザーが問い合わせ時に提示できるよう表示に含める。
    if (correlationId) message += `（エラーコード: ${correlationId}）`;
    // session 失効（KV state 消失）時はデータ系 401 で /login へ誘導する。
    if (res.status === 401) recoverFromUnauthorized(path);
    throw new ApiError(res.status, message, code, correlationId);
  }
  return (await res.json()) as T;
}

export const browserApi: ApiClient = {
  async login(id, password) {
    return request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password }),
    });
  },
  async logout() {
    return request('/api/auth/logout', { method: 'POST' });
  },
  async me() {
    return request('/api/auth/me');
  },
  async mcpTokenIssue() {
    return request('/api/auth/mcp-token', { method: 'POST' });
  },
  async mcpTokenRevoke() {
    return request('/api/auth/mcp-token/revoke', { method: 'POST' });
  },
  async mcpWritesSet(allow) {
    return request('/api/auth/mcp-writes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow }),
    });
  },
  async lcamSession() {
    return request('/api/lcam/session');
  },
  async lcamSessionSet(cookies) {
    return request('/api/lcam/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
  },
  async lcamAppKeySet(appKey) {
    return request('/api/lcam/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey }),
    });
  },
  async lcamSessionDelete() {
    return request('/api/lcam/session/revoke', { method: 'POST' });
  },
  // count は累積表示件数（上流の listPageNo）。ページ番号ではなく「先頭から何件
  // 表示するか」を表す。上流は 1..count の全件を返すため、毎回全件を取り直す。
  async notices(type, count = 10) {
    return request(`/api/notices${qs({ type, count })}`);
  },
  async noticeDetail(type, index) {
    return request(`/api/notices/detail${qs({ type, index })}`);
  },
  async timetable() {
    return request('/api/timetable');
  },
  async schedule(weeks, month) {
    return request(`/api/schedule${qs({ weeks, month })}`);
  },
  async assignments() {
    return request('/api/assignments');
  },
  async assignmentStatuses(ids) {
    return request(`/api/moodle/assignment/status${qs({ assignmentIds: ids.join(',') })}`);
  },
  async enquetes() {
    return request(`/api/enquetes${qs({ type: 'class' })}`);
  },
  async syllabusFilters(year) {
    return request(`/api/syllabus/filters${qs({ year })}`);
  },
  async syllabusSearch(params) {
    return request(`/api/syllabus/search${qs(params)}`);
  },
  async syllabusDetail(url, context = {}) {
    return request(`/api/syllabus/detail${qs({ url, ...context })}`);
  },
  async commonFiles() {
    return request('/api/commonfiles');
  },
  async commonFileDetail(id) {
    return request(`/api/commonfiles/detail${qs({ id })}`);
  },
  commonFileDownloadUrl(id, no) {
    // inline=1: ブラウザ標準ビューアで表示(pdf/画像/txt)。他形式は従来どおりダウンロード。
    return `${BASE}/api/commonfiles/download${qs({ id, no, inline: 1 })}`;
  },
  async openCommonFile() {
    // browser版はcommonFileDownloadUrl()を<a href target=_blank>で開くため呼ばれない。
    throw new ApiError(500, 'openCommonFile is not supported on browser');
  },
  async reports(query) {
    return request(`/api/reports${qs(reportParams(query))}`);
  },
  async reportDetail(id, query) {
    return request(`/api/reports/detail${qs({ id, ...reportParams(query) })}`);
  },
  reportDownloadUrl(id, submitNo, fileNo, query) {
    // inline=1: ブラウザ標準ビューアで表示(pdf/画像/txt)。他形式は従来どおりダウンロード。
    return `${BASE}/api/reports/download${qs({ id, submitNo, fileNo, ...reportParams(query), inline: 1 })}`;
  },
  async openReportFile() {
    // browser版はreportDownloadUrl()を<a href target=_blank>で開くため呼ばれない。
    throw new ApiError(500, 'openReportFile is not supported on browser');
  },
  async facilities() {
    return request('/api/facilities');
  },
  async facilitySchedule(ids, week) {
    return request(`/api/facilities/schedule${qs({ ids: ids.join(','), week })}`);
  },
  async credits() {
    return request('/api/credits');
  },
  async curriculum() {
    return request('/api/curriculum');
  },
  async schoolEvents(month) {
    return request(`/api/schoolevents${qs({ month })}`);
  },
  fileUrl(relativePath) {
    // inline=1: ブラウザ標準ビューアで表示(pdf/画像/txt)。他形式は従来どおりダウンロード。
    return `${BASE}${fileApiPath(relativePath)}?inline=1`;
  },
  async openFile() {
    // browser版はfileUrl()を<a href target=_blank>で開くため呼ばれない。
    throw new ApiError(500, 'openFile is not supported on browser');
  },
};
