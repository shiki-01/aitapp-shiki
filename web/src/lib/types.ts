// browser版(fetch)/desktop版(tauri invoke)で共有する型定義とAPIクライアント契約。

export class ApiError extends Error {
  status: number;
  code?: string;
  // サーバーが発行した相関ID。ユーザーが問い合わせ時に伝えるとログ突合できる。
  correlationId?: string;
  constructor(status: number, message: string, code?: string, correlationId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

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

export interface SyllabusSearchParams {
  year: string;
  word?: string;
  campus?: number;
  semester?: number;
  week?: number;
  hour?: number;
  folder?: string;
}

export interface SyllabusDetailContext {
  year?: string;
  word?: string;
  campus?: number;
  semester?: number;
  week?: number;
  hour?: number;
  folder?: string;
}

// browser版はブラウザの<a>にURLを渡して開き、desktop版は一時ファイルへ
// 保存してOS既定アプリで開く。呼び出し側(Notices.svelte)は isDesktop で
// どちらの方式か分かった上でどちらかだけを呼ぶため、未使用側は投げてよい。
export interface ApiClient {
  login(id: string, password: string): Promise<{ ok: boolean; userId: string; moodle: boolean }>;
  logout(): Promise<{ ok: boolean }>;
  me(): Promise<{ userId: string }>;
  notices(type: 'common' | 'class', count?: number): Promise<{ notices: Notice[] }>;
  noticeDetail(type: 'common' | 'class', index: number): Promise<{ detail: NoticeDetail }>;
  timetable(): Promise<{ timetable: TimetableEntry[] }>;
  schedule(): Promise<{ schedule: ScheduleDay[] }>;
  assignments(): Promise<{ assignments: Assignment[] }>;
  syllabusFilters(year?: string): Promise<{ filters: SyllabusFilters }>;
  syllabusSearch(params: SyllabusSearchParams): Promise<{ results: SyllabusListItem[] }>;
  syllabusDetail(
    url: string,
    context?: SyllabusDetailContext,
  ): Promise<{ detail: SyllabusDetail }>;
  fileUrl(relativePath: string): string;
  openFile(relativePath: string): Promise<void>;
}
