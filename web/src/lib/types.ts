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
  AssignmentSubmission,
  EnqueteList,
  EnqueteListItem,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
  CommonFileItem,
  CommonFileDetail,
  PcFileLink,
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
  AssignmentSubmission,
  EnqueteList,
  EnqueteListItem,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
  CommonFileItem,
  CommonFileDetail,
  PcFileLink,
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
  appRegistered: boolean;
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
   * LCAM アプリ方式で登録する。lamyapp:// URL または key を渡す。
   * key が無効か期限切れなら 422（code: lcam_key_rejected）、形式が違えば 400（code: invalid_app_key）。
   */
  lcamAppKeySet(appKey: string): Promise<{ ok: boolean; registeredAt: number; viaApp: boolean }>;
  /**
   * LCAM セッション（Cookie またはアプリ方式）の登録をすべて解除する。
   */
  lcamSessionDelete(): Promise<{ ok: boolean }>;
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
  /**
   * LCAM の個人スケジュール。month 省略: 今日から weeks 週。month=N: 今月から N か月ずらした月の 1 日を含む週から weeks 週
   * （Worker の 1 リクエストの上限のため、広い範囲は month をずらして分けて呼ぶ）。
   */
  schedule(weeks?: number, month?: number): Promise<{ schedule: ScheduleDay[] }>;
  assignments(): Promise<{ assignments: Assignment[] }>;
  /** 指定した課題の提出状況（1 回 20 件まで。Worker の subrequest 上限のため）。参照のみ。 */
  assignmentStatuses(ids: number[]): Promise<{ assignments: AssignmentSubmission[] }>;
  /** LCAM の授業アンケート一覧（参照のみ）。 */
  enquetes(): Promise<EnqueteList>;
  syllabusFilters(year?: string): Promise<{ filters: SyllabusFilters }>;
  syllabusSearch(params: SyllabusSearchParams): Promise<{ results: SyllabusListItem[] }>;
  syllabusDetail(
    url: string,
    context?: SyllabusDetailContext,
  ): Promise<{ detail: SyllabusDetail }>;
  /** LCAM の学内共有ファイル一覧。 */
  commonFiles(): Promise<{ files: CommonFileItem[] }>;
  commonFileDetail(id: string): Promise<{ detail: CommonFileDetail }>;
  /** ファイル本体の URL（inline=1 付き）。browser 版のみ。desktop 版は openCommonFile を使う。 */
  commonFileDownloadUrl(id: string, no: number): string;
  /**
   * （desktop 版のみ）学内共有ファイルを一時ファイルへ保存し OS 既定アプリで開く。
   * openFile は添付の「相対パス」を base64 化して /api/file/:b64 を叩く前提で、
   * /api/commonfiles/download?id&no（クエリ指定）には使えないため別メソッドにしている。
   */
  openCommonFile(id: string, no: number, filename?: string): Promise<void>;
  fileUrl(relativePath: string): string;
  openFile(relativePath: string): Promise<void>;
}
