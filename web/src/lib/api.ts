// BFF(Worker) への API クライアント。
// session cookie を送るため常に credentials: 'include'。
// 認証情報は cookie のみ。平文 password は login のリクエストボディでのみ送る。

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let code: string | undefined;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error;
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message, code);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---- 型 ----

export interface UnivNotice {
  type: 'common';
  sender: string;
  title: string;
  sendAt: string;
  isImportant: boolean;
  index: number;
}
export interface ClassNotice {
  type: 'class';
  sender: string;
  title: string;
  subject: string;
  makeupClassAt: string;
  isImportant: boolean;
  index: number;
}
export type Notice = UnivNotice | ClassNotice;

export interface NoticeDetail {
  sender: string;
  title: string;
  content: string;
  sendAt: string;
  subject?: string;
  url: string[];
  files: Record<string, string>;
}

export interface TimetableEntry {
  day: string;
  period: number;
  title: string;
  classRoom: string;
  teacher: string;
}

export interface ScheduleEvent {
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  teacher?: string;
  period?: number;
}
export interface ScheduleDay {
  date: string;
  events: ScheduleEvent[];
}

export interface Assignment {
  id: number;
  name: string;
  description: string;
  dueDate: string;
  dueEpochMs: number;
  courseId: number;
  courseName: string;
}

export interface SyllabusFilters {
  year: Record<string, string>;
  folder: Record<string, string>;
  campus: Record<string, string>;
  hour: Record<string, string>;
  week: Record<string, string>;
  semester: Record<string, string>;
}
export interface SyllabusListItem {
  unitsNumber: number;
  classification: string;
  teacher: string;
  subject: string;
  url: string;
}
export interface SyllabusDetail {
  unitsNumber: number;
  classification: string;
  teachers: { name: string; ruby: string }[];
  semester: string;
  content: string[];
  subject: string;
  classPeriod: string;
  classRoom: string;
  plan: string[];
  learningGoal: string;
  features: string;
  records: string;
  teachersMessage: string;
  textBook: string;
  referenceBook: string;
}

// ---- API ----

export const api = {
  async login(id: string, password: string) {
    return request<{ ok: boolean; userId: string; moodle: boolean }>(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password }),
      },
    );
  },
  async logout() {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  async me() {
    return request<{ userId: string }>('/api/auth/me');
  },
  // count は累積表示件数（上流の listPageNo）。ページ番号ではなく「先頭から何件
  // 表示するか」を表す。上流は 1..count の全件を返すため、毎回全件を取り直す。
  async notices(type: 'common' | 'class', count = 10) {
    return request<{ notices: Notice[] }>(
      `/api/notices${qs({ type, count })}`,
    );
  },
  async noticeDetail(type: 'common' | 'class', index: number) {
    return request<{ detail: NoticeDetail }>(
      `/api/notices/detail${qs({ type, index })}`,
    );
  },
  async timetable() {
    return request<{ timetable: TimetableEntry[] }>('/api/timetable');
  },
  async schedule() {
    return request<{ schedule: ScheduleDay[] }>('/api/schedule');
  },
  async assignments() {
    return request<{ assignments: Assignment[] }>('/api/assignments');
  },
  async syllabusFilters(year?: string) {
    return request<{ filters: SyllabusFilters }>(
      `/api/syllabus/filters${qs({ year })}`,
    );
  },
  async syllabusSearch(params: {
    year: string;
    word?: string;
    campus?: number;
    semester?: number;
    week?: number;
    hour?: number;
    folder?: string;
  }) {
    return request<{ results: SyllabusListItem[] }>(
      `/api/syllabus/search${qs(params)}`,
    );
  },
  async syllabusDetail(
    url: string,
    context: {
      year?: string;
      word?: string;
      campus?: number;
      semester?: number;
      week?: number;
      hour?: number;
      folder?: string;
    } = {},
  ) {
    return request<{ detail: SyllabusDetail }>(
      `/api/syllabus/detail${qs({ url, ...context })}`,
    );
  },
  fileUrl(relativePath: string): string {
    const b64 = btoa(relativePath)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${BASE}/api/file/${b64}`;
  },
};
