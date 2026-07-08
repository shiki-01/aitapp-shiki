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
