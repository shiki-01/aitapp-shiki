// worker/ が返す JSON の型。契約型（LCAM 連絡・時間割・スケジュール・シラバス・課題）は
// shared/contract.ts を単一情報源とし、ここで取り込んで再エクスポートする
// （web/mcp/worker で同一定義を共有し、手作業コピーによる drift を防ぐ）。
export type {
  UnivNotice,
  ClassNotice,
  Notice,
  NoticeDetail,
  TimetableEntry,
  ScheduleEvent,
  ScheduleDay,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
  Assignment,
  PcFileLink,
  CommonFileItem,
  CommonFileDetail,
  ReportItem,
  ReportDetail,
  FacilityItem,
  FacilityWeek,
  CreditStatus,
  CurriculumItem,
  SchoolEvents,
  LotteryResult,
  PcNoticeKind,
  PcNoticeQuery,
  PcNoticeItem,
  PcNoticeList,
  PcNoticeDetail,
} from '../../shared/contract';
// AssignmentWithStatus が extends するためローカル束縛としても取り込む。
import type { Assignment } from '../../shared/contract';

export interface PerformanceEntry {
  category: string;
  subject: string;
  teacher: string;
  year: string;
  semester: string;
  credits: number | null;
  grade: string;
  inProgress: boolean;
}

export interface EnqueteListItem {
  fields: Record<string, string>;
}
export interface EnqueteList {
  count: number;
  items: EnqueteListItem[];
}

export interface EnqueteQuestion {
  index: number;
  label: string;
  prompt: string;
  maxLength: number | null;
  answerType: 'text' | 'unsupported';
  fieldName: string;
}
export interface EnqueteAnswerForm {
  classEnqId: string;
  questions: EnqueteQuestion[];
}

/** 課題＋提出状況（GET /api/moodle/assignment/status）。 */
export interface AssignmentWithStatus extends Assignment {
  /** 'submitted' | 'new'(未提出) | 'draft' | 'reopened'。null = 未取得 */
  submissionStatus: string | null;
  /** null = 未取得（statusIncluded: false のとき） */
  submitted: boolean | null;
  gradingStatus: string | null;
  submittedAt: string | null;
}
export interface AssignmentStatusResponse {
  assignments: AssignmentWithStatus[];
  statusIncluded: boolean;
  note?: string;
}

/** クイズ＋受験状況（GET /api/moodle/quiz/status）。 */
export interface MoodleQuizWithStatus {
  id: number;
  courseId: number;
  courseName: string | null;
  name: string;
  timeOpen: string | null;
  timeClose: string | null;
  timeCloseEpochMs: number;
  attemptsAllowed: number;
  /** null = 未取得（statusIncluded: false のとき） */
  finishedAttempts: number | null;
  inProgressAttempts: number | null;
  /** 進行中の受験の attemptId（answer/finish で再開に使う）。 */
  inProgressAttemptId: number | null;
  finished: boolean | null;
  lastFinishedAt: string | null;
}
export interface QuizStatusResponse {
  quizzes: MoodleQuizWithStatus[];
  statusIncluded: boolean;
  note?: string;
}

export interface MoodleQuizInfoResponse {
  quizzes: MoodleQuizInfo[];
  accessInfoIncluded: boolean;
  note?: string;
}

export interface MoodleQuizInfo {
  id: number;
  courseId: number;
  name: string;
  intro: string;
  timeOpen: string | null;
  timeClose: string | null;
  timeLimitSeconds: number;
  attemptsAllowed: number;
  /** null = 未取得（対象クイズ数が多いため。quizId/nameFilterで絞り込んで再取得する） */
  canAttempt: boolean | null;
  preventAccessReasons: string[];
}

export interface MoodleQuizAttempt {
  id: number;
  quizId: number;
  attemptNumber: number;
  state: string;
}
/** 生HTMLのままの設問（GET /api/moodle/quiz/questions）。 */
export interface MoodleQuizQuestionHtml {
  slot: number;
  page: number;
  type: string;
  html: string;
}

export interface QuizChoiceOption {
  value: string;
  label: string;
}
export interface QuizQuestionInputsMultichoice {
  kind: 'multichoice';
  name: string;
  options: QuizChoiceOption[];
}
export interface QuizQuestionInputsMatch {
  kind: 'match';
  rows: { name: string; text: string; options: QuizChoiceOption[] }[];
}
export interface QuizQuestionInputsOrdering {
  kind: 'ordering';
  name: string;
  items: { id: string; text: string }[];
}
export interface QuizQuestionInputsGeneric {
  kind: 'generic';
  fields: {
    tag: 'input' | 'select' | 'textarea';
    type?: string;
    name: string;
    value?: string;
    options?: QuizChoiceOption[];
  }[];
}
export type QuizQuestionInputs =
  | QuizQuestionInputsMultichoice
  | QuizQuestionInputsMatch
  | QuizQuestionInputsOrdering
  | QuizQuestionInputsGeneric;

/** 要約済みの設問（POST /api/moodle/quiz/start）。 */
export interface MoodleQuizQuestionSummary {
  slot: number;
  page: number;
  type: string;
  text: string;
  inputs: QuizQuestionInputs;
  /** 要約パーサ未対応の形式のときのみ、元の設問HTML全文 */
  html?: string;
  note?: string;
}
export interface MoodleQuizStart {
  attempt: MoodleQuizAttempt;
  questions: MoodleQuizQuestionSummary[];
}

/** 採点結果（GET /api/moodle/quiz/result）。 */
export interface MoodleQuizAttemptResult {
  attemptId: number;
  quizId: number;
  attemptNumber: number;
  state: string;
  grade: string | null;
  sumGrades: number | null;
  timeFinish: string | null;
  questions: {
    slot: number;
    type: string;
    status: string;
    mark: string | null;
    maxMark: number | null;
    text: string;
    rightAnswer: string | null;
  }[];
}

export interface MoodleCourse {
  id: number;
  fullName: string;
  shortName: string;
  visible: boolean;
}

export interface MoodleCourseFile {
  name: string;
  courseModuleId: number;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
}

// SyllabusFilters / SyllabusListItem / SyllabusDetail は shared/contract.ts に集約し、
// このファイル冒頭で再エクスポート済み。
