// browser版 API クライアント。session cookie を送るため常に credentials: 'include'。
// 認証情報は cookie のみ。平文 password は login のリクエストボディでのみ送る。

import { ApiError, type ApiClient } from './types';
import { qs, fileApiPath } from './apiPath';

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

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
  async schedule() {
    return request('/api/schedule');
  },
  async assignments() {
    return request('/api/assignments');
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
  fileUrl(relativePath) {
    return `${BASE}${fileApiPath(relativePath)}`;
  },
  async openFile() {
    // browser版はfileUrl()を<a href target=_blank>で開くため呼ばれない。
    throw new ApiError(500, 'openFile is not supported on browser');
  },
};
