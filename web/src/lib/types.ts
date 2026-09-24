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

export interface LcamSessionStatus {
  registered: boolean;
  registeredAt: number | null;
  lastOkAt: number | null;
  expiredAt: number | null;
}

// browser版はブラウザの<a>にURLを渡して開き、desktop版は一時ファイルへ
// 保存してOS既定アプリで開く。呼び出し側(Notices.svelte)は isTauri で
// どちらの方式か分かった上でどちらかだけを呼ぶため、未使用側は投げてよい。
export interface ApiClient {
  // lcam: LCAM の Cookie が登録済みか（ログインでは LCAM に入れないため別途登録が要る）。
  login(
    id: string,
    password: string,
  ): Promise<{ ok: boolean; userId: string; moodle: boolean; lcam?: boolean }>;
  logout(): Promise<{ ok: boolean }>;
  // mcp: ユーザー別 MCP トークンの発行済みフラグ。desktop 版（restore_session 経由）では
  // 取得できないため optional。
  // mcpWrites: user モード MCP からの不可逆書き込みを本人が許可しているか。
  me(): Promise<{ userId: string; mcp?: boolean; mcpWrites?: boolean }>;
  /** 自分専用の MCP URL を発行/再発行する。平文トークンはこの応答でのみ得られる。 */
  mcpTokenIssue(): Promise<{ ok: boolean; token: string; url: string }>;
  /** 発行済みのユーザー別 MCP トークンを失効させる。 */
  mcpTokenRevoke(): Promise<{ ok: boolean }>;
  /** user モード MCP からの不可逆書き込み（提出等）の許可を切り替える。 */
  mcpWritesSet(allow: boolean): Promise<{ ok: boolean; allow: boolean }>;
  /** LCAM セッションの登録状況（時刻は ms epoch。Cookie の値は返らない）。 */
  lcamSession(): Promise<LcamSessionStatus>;
  /**
   * ブラウザで LCAM にログイン（MFA 込み）して取得した Cookie を登録する。
   * 無効な Cookie は 422（code: lcam_session_rejected）で拒否される。
   */
  lcamSessionSet(cookies: string): Promise<{ ok: boolean; registeredAt: number }>;
  /**
   * （デスクトップ版のみ）WebView で LCAM の SSO ログインを通し、Cookie を自動で登録する。
   * ウィンドウが開き、番号入力などが要ればそのまま操作する。ブラウザ版には無い。
   */
  lcamConnect?(): Promise<{ ok: boolean; registeredAt: number }>;
  /** （デスクトップ版のみ）切れたときに自動で再接続する設定の取得/変更（既定オフ）。 */
  lcamAutoGet?(): Promise<boolean>;
  lcamAutoSet?(enabled: boolean): Promise<void>;
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
