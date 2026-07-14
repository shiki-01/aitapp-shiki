// worker/ が返す JSON の型（web/src/lib/api.ts の型定義と揃えている）。

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

export interface Assignment {
  id: number;
  name: string;
  description: string;
  dueDate: string;
  dueEpochMs: number;
  courseId: number;
  courseName: string;
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
