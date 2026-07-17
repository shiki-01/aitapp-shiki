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

// 契約型（連絡・時間割・スケジュール・課題・シラバス）は shared/contract.ts を
// 単一情報源とし、取り込んで再エクスポートする（worker/mcp と同一定義を共有する）。
// ApiClient インターフェースがこれらを参照するため、ローカル束縛としても取り込む。
import type {
  UnivNotice,
  ClassNotice,
  Notice,
  NoticeDetail,
  TimetableEntry,
  ScheduleEvent,
  ScheduleDay,
  Assignment,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
} from '../../../shared/contract';
export type {
  UnivNotice,
  ClassNotice,
  Notice,
  NoticeDetail,
  TimetableEntry,
  ScheduleEvent,
  ScheduleDay,
  Assignment,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
};

// NoticeDetail / TimetableEntry / ScheduleEvent / ScheduleDay / Assignment /
// SyllabusFilters / SyllabusListItem / SyllabusDetail は shared/contract.ts に
// 集約し、冒頭で再エクスポート済み。

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
