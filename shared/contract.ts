// worker(サーバー)・mcp・web が共有する「契約」の単一情報源（Single Source of Truth）。
// ここにはランタイム依存を持たない型定義と定数のみを置く。node-html-parser 等を
// 巻き込まないため、worker(wrangler) / mcp(bun) / web(vite) のどのビルドからも
// 相対 import でそのまま取り込める。
//
// これまで worker のパース出力型・mcp/web のレスポンス型・confirm パスフレーズが
// 各パッケージに手作業でコピーされ drift していた。ここへ集約し、各パッケージは
// re-export で消費することで、1 箇所の変更が全パッケージへ伝播するようにする。

// ---- 取り消し困難な書き込み操作で要求する confirm パスフレーズ ----
// worker のルーターガードと mcp ツールのガードで同一の値を参照する（drift 防止）。
export const CONFIRM_FINAL_SUBMIT = 'CONFIRM_FINAL_SUBMIT';
export const CONFIRM_FINISH_ATTEMPT = 'CONFIRM_FINISH_ATTEMPT';
export const CONFIRM_SUBMIT_ASSIGNMENT = 'CONFIRM_SUBMIT_ASSIGNMENT';

// ---- LCAM 連絡 / 時間割 / スケジュール ----
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
  day: string; // monday..sunday
  period: number; // 1..7
  title: string;
  classRoom: string;
  teacher: string;
}

export interface ScheduleEvent {
  title: string;
  startTime: string; // YYYY-MM-DDTHH:mm
  endTime: string;
  location?: string;
  teacher?: string;
  period?: number;
  /** 時限・教員・教室に当てはまらない追加行（休講・補講の表記など。形は未確定）。 */
  note?: string;
}

export interface ScheduleDay {
  date: string; // YYYY-MM-DD
  events: ScheduleEvent[];
}

// ---- LCAM 授業アンケート（一覧） ----
// fields は上流の一覧のラベル→値（授業科目 / タイトル / 状態 / 提出期間 / 提出状況）。
export interface EnqueteListItem {
  fields: Record<string, string>;
}

export interface EnqueteList {
  count: number;
  items: EnqueteListItem[];
}

// ---- シラバス ----
export interface Teacher {
  name: string;
  ruby: string;
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
  teachers: Teacher[];
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

// ---- Moodle 課題 ----
export interface Assignment {
  id: number;
  name: string;
  description: string;
  /** 締切日時（ISO）。duedate が 0/未設定/非有限のときは null（締切なし）。 */
  dueDate: string | null;
  dueEpochMs: number; // 0 = 締切なし
  /** 提出受付終了日時（cutoffdate）。未設定なら null。 */
  cutoffDate: string | null;
  cutoffEpochMs: number; // 0 = 未設定
  courseId: number;
  courseName: string;
}

/** 課題1件の提出状況（Moodle mod_assign_get_submission_status）。参照のみ。 */
export interface AssignmentSubmission {
  id: number;
  /** 'submitted' | 'new'(未提出) | 'draft'(下書きのみ) | 'reopened'(再提出要求)。未取得は null。 */
  submissionStatus: string | null;
  submitted: boolean | null;
  /** 'graded' | 'notgraded' 等 */
  gradingStatus: string | null;
  /** 提出済みの場合の最終更新日時（ISO） */
  submittedAt: string | null;
}

// ---- LCAM PC 版（docs/LCAM_FEATURES.md）----

/** 詳細画面のダウンロードリンク。ダウンロードは prefix・no（上流の fileDownLoad の引数）で指定する。 */
export interface PcFileLink {
  prefix: string;
  no: number;
  name: string;
  /** 表示上のサイズ（例: "3.43 MB"）。 */
  size?: string;
}

/** 学内共有ファイルの一覧の 1 件。 */
export interface CommonFileItem {
  /** 上流のファイル ID。詳細・ダウンロードの指定に使う。 */
  id: string;
  category: string;
  title: string;
  downloadCount: number;
  size: string;
  updatedAt: string;
}

export interface CommonFileDetail {
  id: string;
  title: string;
  category: string;
  description: string;
  publicPeriod: string;
  files: PcFileLink[];
}

// ---- LCAM レポート（授業サポート > レポート）----

/** レポート一覧の 1 件。 */
export interface ReportItem {
  /** 上流のレポート ID。詳細・ファイル取得の指定に使う。 */
  id: string;
  subject: string;
  /** 学期/曜日時限（例: 後期/木1）。 */
  term: string;
  title: string;
  /** 状態（受付中・締切など。上流の表記のまま）。 */
  status: string;
  /** 提出期間（例: 2026/09/23 18:00 ～ 2026/09/24 23:00）。 */
  period: string;
  /** 最終提出日時。未提出なら空。 */
  lastSubmittedAt: string;
  /** 実施形式（Web / 紙）。 */
  format: string;
  /** 一覧の「提出」ボタンが出ているか（受付中で提出できる）。 */
  canSubmit: boolean;
  /** 一覧の「提出取消」ボタンが出ているか。 */
  canCancel: boolean;
}

export interface ReportSubmissionFile {
  studentCode: string;
  submitNo: number;
  fileNo: number;
  name: string;
}

/** 提出履歴の 1 回分。 */
export interface ReportSubmission {
  /** 見出し（例: 1.comment by 氏名 2026/09/24 22:25）。 */
  heading: string;
  /** 見出しの下の本文行（提出コメント・教員のコメント・点数など。上流の並びのまま）。 */
  lines: string[];
  files: ReportSubmissionFile[];
}

export interface ReportDetail {
  id: string;
  /** 全体の状態（受付中・締切など）。 */
  status: string;
  title: string;
  period: string;
  /** 評価方法（例: 点数（上限 200点））。 */
  evaluation: string;
  description: string;
  /** 参考資料の表記（ファイルの取得は未対応）。 */
  referenceMaterial: string;
  /** 伝達事項。 */
  notice: string;
  /** 催促通知の表記（例: 登録されていません。）。 */
  reminder: string;
  /** 評価結果の本文行（結果公開中のときだけ。形は未観測のため上流の並びのまま）。 */
  result: string[];
  submissions: ReportSubmission[];
}
