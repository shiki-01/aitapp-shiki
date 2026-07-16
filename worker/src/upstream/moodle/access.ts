// Moodle（token 方式・JSON）。移植元: access_moodle.dart（読み取り系のみ）。
// クイズ回答・課題提出（書き込み系）は Dart 側に実装が無いため、
// core_webservice_get_site_info で確認済みの利用可能関数を元に Moodle 公式
// Web Service（Mobile app 用）の標準的なパラメータ仕様に従って実装している。
// 透過再ログインのラップ対象外。token 失効時のみ password で再取得する。

import type { Credential } from '../../types';
import { UpstreamError } from '../errors';

const WEBSERVICE = '/webservice/rest/server.php';
const UPLOAD_ENDPOINT = '/webservice/upload.php';

/** ユーザーの資格情報に紐づく Moodle 接続先ホストから base URL を組み立てる。 */
function moodleBase(origin: string): string {
  return `https://${origin}`;
}

const baseHeaders: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

/** token が失効しているときに投げる（router が token 再取得→リトライ）。 */
export class MoodleTokenError extends Error {
  constructor(message = 'moodle token invalid') {
    super(message);
    this.name = 'MoodleTokenError';
  }
}

interface MoodleExceptionBody {
  exception?: string;
  errorcode?: string;
  message?: string;
}

/**
 * Moodle webservice/rest/server.php への共通 POST 呼び出し。
 * `params` のキーは PHP 配列パラメータ（例: `data[0][name]`）をそのまま文字列で渡せる。
 */
async function callMoodleApi<T>(
  origin: string,
  token: string,
  wsfunction: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${moodleBase(origin)}${WEBSERVICE}`, {
    method: 'POST',
    headers: baseHeaders,
    body: new URLSearchParams({
      wstoken: token,
      wsfunction,
      moodlewsrestformat: 'json',
      ...params,
    }).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle ${wsfunction} error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as T & MoodleExceptionBody;
  if (data && typeof data === 'object' && !Array.isArray(data) && 'exception' in data) {
    if (data.errorcode === 'invalidtoken') {
      throw new MoodleTokenError(data.message ?? data.errorcode);
    }
    throw new UpstreamError(`Moodle ${wsfunction} error: ${data.message ?? data.exception}`);
  }
  return data;
}

/** `data[i][name]=...&data[i][value]=...` 形式のパラメータを組み立てる。 */
function indexedNameValuePairs(
  key: string,
  pairs: { name: string; value: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  pairs.forEach((pair, i) => {
    out[`${key}[${i}][name]`] = pair.name;
    out[`${key}[${i}][value]`] = pair.value;
  });
  return out;
}

export interface MoodleAssignment {
  id: number;
  name: string;
  description: string;
  dueDate: string; // ISO
  dueEpochMs: number;
  /** 提出受付終了日時（cutoffdate）。未設定なら null。 */
  cutoffDate: string | null;
  cutoffEpochMs: number; // 0 = 未設定
  courseId: number;
  courseName: string;
}

/** token 取得。POST /login/token.php。 */
export async function getMoodleToken(
  origin: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${moodleBase(origin)}/login/token.php`, {
    method: 'POST',
    headers: baseHeaders,
    body: new URLSearchParams({
      username,
      password,
      service: 'moodle_mobile_app',
    }).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle token error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as { token?: string; error?: string };
  if (data.error) {
    throw new UpstreamError(`Moodle token error: ${data.error}`);
  }
  if (!data.token) {
    throw new UpstreamError('Moodle token error: token missing');
  }
  return data.token;
}

export interface MoodleCourse {
  id: number;
  fullName: string;
  shortName: string;
  visible: boolean;
}

interface RawSiteInfo {
  userid: number;
}
interface RawUserCourse {
  id: number;
  fullname: string;
  shortname: string;
  visible?: number;
}

/**
 * 受講中コース一覧。core_webservice_get_site_info で自ユーザーの userid を取り、
 * core_enrol_get_users_courses で取得する（Mobile app 用標準関数、読み取りのみ）。
 * quiz/resources 系ツールが要求する courseId の取得起点になる。
 */
export async function getUserCourses(origin: string, token: string): Promise<MoodleCourse[]> {
  const site = await callMoodleApi<RawSiteInfo>(origin, token, 'core_webservice_get_site_info', {});
  const courses = await callMoodleApi<RawUserCourse[]>(
    origin,
    token,
    'core_enrol_get_users_courses',
    { userid: String(site.userid) },
  );
  return (courses ?? []).map((course) => ({
    id: course.id,
    fullName: course.fullname,
    shortName: course.shortname,
    visible: course.visible !== 0,
  }));
}

interface MoodleAssignmentRaw {
  id: number;
  name: string;
  intro: string;
  duedate: number;
  cutoffdate?: number;
}
interface MoodleCourseRaw {
  id: number;
  fullname: string;
  assignments: MoodleAssignmentRaw[];
}

/** 課題一覧。POST webservice mod_assign_get_assignments。 */
export async function getMoodleAssignments(
  origin: string,
  token: string,
): Promise<MoodleAssignment[]> {
  const res = await fetch(`${moodleBase(origin)}${WEBSERVICE}`, {
    method: 'POST',
    headers: baseHeaders,
    body: new URLSearchParams({
      wstoken: token,
      wsfunction: 'mod_assign_get_assignments',
      moodlewsrestformat: 'json',
    }).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle assignments error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as {
    courses?: MoodleCourseRaw[];
    exception?: string;
    errorcode?: string;
    message?: string;
  };
  if (data.exception) {
    // token 失効のみ再取得対象。Moodle 標準の errorcode を前提（要確認）。
    if (data.errorcode === 'invalidtoken') {
      throw new MoodleTokenError(data.message ?? data.errorcode);
    }
    throw new UpstreamError(`Moodle assignments error: ${data.message ?? data.exception}`);
  }

  const out: MoodleAssignment[] = [];
  for (const course of data.courses ?? []) {
    for (const a of course.assignments ?? []) {
      const epochMs = a.duedate * 1000;
      const cutoffEpochMs = (a.cutoffdate ?? 0) * 1000;
      out.push({
        id: a.id,
        name: a.name,
        description: a.intro,
        dueDate: new Date(epochMs).toISOString(),
        dueEpochMs: epochMs,
        cutoffDate: cutoffEpochMs ? new Date(cutoffEpochMs).toISOString() : null,
        cutoffEpochMs,
        courseId: course.id,
        courseName: course.fullname,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 課題の提出状況（参照のみ）
// ---------------------------------------------------------------------------

export interface AssignSubmissionStatus {
  /** 'submitted' | 'new'(未提出) | 'draft'(下書きのみ) | 'reopened'(再提出要求) */
  submissionStatus: string | null;
  /** null = 未取得（statusIncluded: false のとき） */
  submitted: boolean | null;
  /** 'graded' | 'notgraded' 等 */
  gradingStatus: string | null;
  /** 提出済みの場合の最終更新日時（ISO） */
  submittedAt: string | null;
}

interface RawSubmissionStatus {
  lastattempt?: {
    submission?: { status?: string; timemodified?: number };
    teamsubmission?: { status?: string; timemodified?: number };
    gradingstatus?: string;
  };
}

/**
 * 課題1件の提出状況。mod_assign_get_submission_status（実データで応答形状確認済み）。
 * 個人提出は lastattempt.submission、チーム提出課題は teamsubmission に入る。
 */
export async function getAssignSubmissionStatus(
  origin: string,
  token: string,
  assignmentId: number,
): Promise<AssignSubmissionStatus> {
  const data = await callMoodleApi<RawSubmissionStatus>(
    origin,
    token,
    'mod_assign_get_submission_status',
    { assignid: String(assignmentId) },
  );
  const attempt = data.lastattempt;
  const submission = attempt?.submission ?? attempt?.teamsubmission;
  const status = submission?.status ?? null;
  const submitted = status === 'submitted';
  const timeModified = submission?.timemodified ?? 0;
  return {
    submissionStatus: status,
    submitted,
    gradingStatus: attempt?.gradingstatus ?? null,
    submittedAt: submitted && timeModified ? new Date(timeModified * 1000).toISOString() : null,
  };
}

/**
 * 提出状況（mod_assign_get_submission_status）を問い合わせる課題数の上限。
 * クイズの MAX_ACCESS_INFO_LOOKUPS と同じ理由（課題1件につき1 subrequest 消費、
 * Workers 無料プランの subrequest 上限対策）で抑える。
 */
const MAX_SUBMISSION_STATUS_LOOKUPS = 20;

export interface AssignmentStatusFilter {
  assignmentId?: number;
  courseId?: number;
  /** 課題名の部分一致（大文字小文字を区別しない）。 */
  nameFilter?: string;
  /** 締切（dueDate）が今からN日以内の課題のみ（締切なしの課題は除外）。 */
  dueWithinDays?: number;
  /** true で締切超過済みの課題も含める（assignmentId 指定時は常に含める）。 */
  includePastDue?: boolean;
}

export type AssignmentWithStatus = MoodleAssignment & AssignSubmissionStatus;

export interface AssignmentStatusResult {
  assignments: AssignmentWithStatus[];
  /** false のとき submissionStatus 等は未取得（絞り込んで再取得する）。 */
  statusIncluded: boolean;
}

/** 提出の実質的な締切（cutoffdate があればそちらが受付終了）。0 = 締切なし。 */
function effectiveDeadlineMs(a: MoodleAssignment): number {
  return Math.max(a.dueEpochMs, a.cutoffEpochMs);
}

/**
 * 課題一覧＋提出状況。mod_assign_get_assignments（常に1コール）に、filter 適用後の
 * 件数が MAX_SUBMISSION_STATUS_LOOKUPS 以下の場合のみ mod_assign_get_submission_status
 * （1件1コール。バッチAPIは存在しない）を重ねる。超える場合は submissionStatus: null の
 * まま返し、呼び出し側に絞り込みを促す（クイズの受験可否と同じパターン）。
 * デフォルトでは締切超過済み（due/cutoff の遅い方が過去）の課題を除外する。
 * 締切なし（duedate=0）の課題は除外しない。
 */
export async function getAssignmentsWithStatus(
  origin: string,
  token: string,
  filter?: AssignmentStatusFilter,
): Promise<AssignmentStatusResult> {
  let list = await getMoodleAssignments(origin, token);
  if (filter?.assignmentId !== undefined) {
    list = list.filter((a) => a.id === filter.assignmentId);
  }
  if (filter?.courseId !== undefined) {
    list = list.filter((a) => a.courseId === filter.courseId);
  }
  if (filter?.nameFilter) {
    const needle = filter.nameFilter.toLowerCase();
    list = list.filter((a) => a.name.toLowerCase().includes(needle));
  }
  const now = Date.now();
  if (!filter?.includePastDue && filter?.assignmentId === undefined) {
    list = list.filter((a) => {
      const deadline = effectiveDeadlineMs(a);
      return deadline === 0 || deadline >= now;
    });
  }
  if (filter?.dueWithinDays !== undefined) {
    const limit = now + filter.dueWithinDays * 24 * 60 * 60 * 1000;
    list = list.filter((a) => a.dueEpochMs !== 0 && a.dueEpochMs <= limit);
  }
  list.sort((a, b) => (a.dueEpochMs || Number.MAX_SAFE_INTEGER) - (b.dueEpochMs || Number.MAX_SAFE_INTEGER));

  const statusIncluded = list.length <= MAX_SUBMISSION_STATUS_LOOKUPS;
  const empty: AssignSubmissionStatus = {
    submissionStatus: null,
    submitted: null,
    gradingStatus: null,
    submittedAt: null,
  };
  const out: AssignmentWithStatus[] = [];
  for (const a of list) {
    const status = statusIncluded ? await getAssignSubmissionStatus(origin, token, a.id) : empty;
    out.push({ ...a, ...status });
  }
  return { assignments: out, statusIncluded };
}

// ---------------------------------------------------------------------------
// クイズ回答（書き込み系）
// ---------------------------------------------------------------------------

export interface MoodleQuizInfo {
  id: number;
  courseId: number;
  name: string;
  intro: string;
  timeOpen: string | null; // ISO。0 なら null（無期限）。
  timeClose: string | null;
  timeLimitSeconds: number; // 0 = 無制限
  attemptsAllowed: number; // 0 = 無制限
  canAttempt: boolean | null; // null = 未取得（対象クイズ数が多く受験可否の問い合わせを省略した）
  preventAccessReasons: string[];
}

interface RawQuiz {
  id: number;
  course: number;
  name: string;
  intro: string;
  timeopen: number;
  timeclose: number;
  timelimit: number;
  attempts: number;
}
interface RawQuizAccessInfo {
  canattempt: boolean;
  preventaccessreasons?: string[];
}

/**
 * 受験可否（mod_quiz_get_quiz_access_information）を問い合わせるクイズ数の上限。
 * この関数はクイズ1件につき1 subrequest を消費し、Workers 無料プランの
 * 1リクエストあたり subrequest 上限（50。KV read やトークン再取得も同枠）を
 * クイズ数の多い科目（語学系など）で超過した実績があるため、余裕をみて抑える。
 */
const MAX_ACCESS_INFO_LOOKUPS = 20;

export interface QuizInfoFilter {
  quizId?: number;
  /** クイズ名の部分一致（大文字小文字を区別しない）。 */
  nameFilter?: string;
}

export interface QuizInfoResult {
  quizzes: MoodleQuizInfo[];
  /** false のとき canAttempt/preventAccessReasons は未取得（quizId/nameFilter で絞り込んで再取得する）。 */
  accessInfoIncluded: boolean;
}

/**
 * クイズ一覧＋受験可否情報。mod_quiz_get_quizzes_by_courses（一覧は常に1コール）に、
 * filter 適用後のクイズ数が MAX_ACCESS_INFO_LOOKUPS 以下の場合のみ
 * mod_quiz_get_quiz_access_information（1件1コール。バッチAPIは存在しない）を重ねる。
 * 超える場合は canAttempt: null のまま返し、呼び出し側に絞り込みを促す。
 */
export async function getQuizInfoByCourse(
  origin: string,
  token: string,
  courseId: number,
  filter?: QuizInfoFilter,
): Promise<QuizInfoResult> {
  const quizzes = await callMoodleApi<{ quizzes: RawQuiz[] }>(
    origin,
    token,
    'mod_quiz_get_quizzes_by_courses',
    { 'courseids[0]': String(courseId) },
  );
  let list = quizzes.quizzes ?? [];
  if (filter?.quizId !== undefined) {
    list = list.filter((q) => q.id === filter.quizId);
  }
  if (filter?.nameFilter) {
    const needle = filter.nameFilter.toLowerCase();
    list = list.filter((q) => q.name.toLowerCase().includes(needle));
  }
  const accessInfoIncluded = list.length <= MAX_ACCESS_INFO_LOOKUPS;

  const out: MoodleQuizInfo[] = [];
  for (const q of list) {
    let canAttempt: boolean | null = null;
    let preventAccessReasons: string[] = [];
    if (accessInfoIncluded) {
      const access = await callMoodleApi<RawQuizAccessInfo>(
        origin,
        token,
        'mod_quiz_get_quiz_access_information',
        { quizid: String(q.id) },
      );
      canAttempt = access.canattempt;
      preventAccessReasons = access.preventaccessreasons ?? [];
    }
    out.push({
      id: q.id,
      courseId: q.course,
      name: q.name,
      intro: q.intro,
      timeOpen: q.timeopen ? new Date(q.timeopen * 1000).toISOString() : null,
      timeClose: q.timeclose ? new Date(q.timeclose * 1000).toISOString() : null,
      timeLimitSeconds: q.timelimit,
      attemptsAllowed: q.attempts,
      canAttempt,
      preventAccessReasons,
    });
  }
  return { quizzes: out, accessInfoIncluded };
}

// ---------------------------------------------------------------------------
// クイズの受験状況（参照のみ）
// ---------------------------------------------------------------------------

export interface MoodleQuizWithStatus {
  id: number;
  courseId: number;
  /** コース名（core_enrol_get_users_courses から解決。見つからなければ null）。 */
  courseName: string | null;
  name: string;
  timeOpen: string | null; // null = 開始日時なし
  timeClose: string | null; // null = 受験期限なし
  timeCloseEpochMs: number; // 0 = 受験期限なし
  attemptsAllowed: number; // 0 = 無制限
  /** 完了済み受験回数。null = 未取得（statusIncluded: false のとき） */
  finishedAttempts: number | null;
  /** 進行中（開始したが未確定）の受験数。null = 未取得 */
  inProgressAttempts: number | null;
  /**
   * 進行中の受験の attemptId（複数あれば最新）。moodle_answer_quiz_question /
   * moodle_finish_quiz_attempt にそのまま渡して再開できる（新規開始は
   * attemptstillinprogress エラーになるため、進行中があればこちらを使う）。
   */
  inProgressAttemptId: number | null;
  /** 1回以上受験を完了済みか。null = 未取得 */
  finished: boolean | null;
  /** 最後に受験を完了した日時（ISO）。 */
  lastFinishedAt: string | null;
}

export interface QuizStatusFilter {
  quizId?: number;
  courseId?: number;
  /** クイズ名の部分一致（大文字小文字を区別しない）。 */
  nameFilter?: string;
  /** 受験期限（timeClose）が今からN日以内のクイズのみ（期限なしは除外）。 */
  closeWithinDays?: number;
  /** true で受験期限超過済みのクイズも含める（quizId 指定時は常に含める）。 */
  includeClosed?: boolean;
}

export interface QuizStatusResult {
  quizzes: MoodleQuizWithStatus[];
  /** false のとき finishedAttempts 等は未取得（絞り込んで再取得する）。 */
  statusIncluded: boolean;
}

/**
 * 受験履歴（mod_quiz_get_user_attempts）を問い合わせるクイズ数の上限。
 * MAX_ACCESS_INFO_LOOKUPS と同じ理由（1件1 subrequest、Workers 無料プランの上限対策）。
 */
const MAX_ATTEMPT_STATUS_LOOKUPS = 20;

interface RawUserAttempt {
  id?: number;
  state?: string;
  timefinish?: number;
}

/**
 * クイズ一覧＋受験状況。mod_quiz_get_quizzes_by_courses を courseids 省略で呼ぶと
 * 全受講コースのクイズが1コールで返る（実データ確認済み）。filter 適用後の件数が
 * MAX_ATTEMPT_STATUS_LOOKUPS 以下の場合のみ mod_quiz_get_user_attempts
 * （status=all・1件1コール）を重ねて完了/進行中の受験数を付ける。超える場合は
 * finishedAttempts: null のまま返し、呼び出し側に絞り込みを促す
 * （課題の getAssignmentsWithStatus と同じパターン）。
 * デフォルトでは受験期限超過済み（timeclose が過去）のクイズを除外する。
 * 期限なし（timeclose=0）のクイズは除外しない。
 */
export async function getQuizzesWithStatus(
  origin: string,
  token: string,
  filter?: QuizStatusFilter,
): Promise<QuizStatusResult> {
  const data = await callMoodleApi<{ quizzes: RawQuiz[] }>(
    origin,
    token,
    'mod_quiz_get_quizzes_by_courses',
    {},
  );
  let list = data.quizzes ?? [];
  if (filter?.quizId !== undefined) {
    list = list.filter((q) => q.id === filter.quizId);
  }
  if (filter?.courseId !== undefined) {
    list = list.filter((q) => q.course === filter.courseId);
  }
  if (filter?.nameFilter) {
    const needle = filter.nameFilter.toLowerCase();
    list = list.filter((q) => q.name.toLowerCase().includes(needle));
  }
  const now = Date.now();
  if (!filter?.includeClosed && filter?.quizId === undefined) {
    list = list.filter((q) => q.timeclose === 0 || q.timeclose * 1000 >= now);
  }
  if (filter?.closeWithinDays !== undefined) {
    const limit = now + filter.closeWithinDays * 24 * 60 * 60 * 1000;
    list = list.filter((q) => q.timeclose !== 0 && q.timeclose * 1000 <= limit);
  }
  list.sort(
    (a, b) =>
      (a.timeclose * 1000 || Number.MAX_SAFE_INTEGER) -
      (b.timeclose * 1000 || Number.MAX_SAFE_INTEGER),
  );

  // 教科単位のグルーピング用にコース名を解決する（+2 subrequest。
  // mod_quiz_get_quizzes_by_courses の応答にはコースIDしか入らないため）。
  const courses = list.length > 0 ? await getUserCourses(origin, token) : [];
  const courseNameById = new Map(courses.map((c) => [c.id, c.fullName]));

  const statusIncluded = list.length <= MAX_ATTEMPT_STATUS_LOOKUPS;
  const out: MoodleQuizWithStatus[] = [];
  for (const q of list) {
    let finishedAttempts: number | null = null;
    let inProgressAttempts: number | null = null;
    let inProgressAttemptId: number | null = null;
    let lastFinishedAt: string | null = null;
    if (statusIncluded) {
      const res = await callMoodleApi<{ attempts?: RawUserAttempt[] }>(
        origin,
        token,
        'mod_quiz_get_user_attempts',
        { quizid: String(q.id), status: 'all' },
      );
      const attempts = res.attempts ?? [];
      const finishedList = attempts.filter((a) => a.state === 'finished');
      const inProgressList = attempts.filter((a) => a.state === 'inprogress');
      finishedAttempts = finishedList.length;
      inProgressAttempts = inProgressList.length;
      inProgressAttemptId = inProgressList.at(-1)?.id ?? null;
      const lastFinish = Math.max(0, ...finishedList.map((a) => a.timefinish ?? 0));
      lastFinishedAt = lastFinish ? new Date(lastFinish * 1000).toISOString() : null;
    }
    out.push({
      id: q.id,
      courseId: q.course,
      courseName: courseNameById.get(q.course) ?? null,
      name: q.name,
      timeOpen: q.timeopen ? new Date(q.timeopen * 1000).toISOString() : null,
      timeClose: q.timeclose ? new Date(q.timeclose * 1000).toISOString() : null,
      timeCloseEpochMs: q.timeclose * 1000,
      attemptsAllowed: q.attempts,
      finishedAttempts,
      inProgressAttempts,
      inProgressAttemptId,
      finished: finishedAttempts === null ? null : finishedAttempts > 0,
      lastFinishedAt,
    });
  }
  return { quizzes: out, statusIncluded };
}

export interface MoodleQuizAttempt {
  id: number;
  quizId: number;
  attemptNumber: number;
  state: string;
}
export interface MoodleQuizQuestion {
  slot: number;
  page: number;
  type: string;
  html: string;
}

interface RawQuizAttempt {
  id: number;
  quiz: number;
  attempt: number;
  state: string;
}
interface RawQuizQuestion {
  slot: number;
  page: number;
  type: string;
  html: string;
}
interface RawWarning {
  item?: string;
  itemid?: number;
  warningcode?: string;
  message?: string;
}

// 受験できない場合、mod_quiz_start_attempt は Moodle exception を投げず
// HTTP 200 で `attempt: []`（空配列）+ `warnings` を返す（実データで確認済み）。
// そのため `attempt` がオブジェクトかどうかを明示的に判定する必要がある。
function isStartedAttempt(attempt: unknown): attempt is RawQuizAttempt {
  return typeof attempt === 'object' && attempt !== null && !Array.isArray(attempt);
}

/**
 * 開始済み（進行中）attempt の設問一覧を全ページ分収集する（参照のみ・試行回数を消費しない）。
 * mod_quiz_get_attempt_data の `nextpage` を -1（最終ページ）になるまで辿る。
 * 無限ループ防止のため上限ページ数を設ける。
 */
export async function getAttemptQuestions(
  origin: string,
  token: string,
  attemptId: number,
): Promise<RawQuizQuestion[]> {
  const out: RawQuizQuestion[] = [];
  let page = 0;
  const MAX_PAGES = 50;
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await callMoodleApi<{ questions: RawQuizQuestion[]; nextpage: number }>(
      origin,
      token,
      'mod_quiz_get_attempt_data',
      { attemptid: String(attemptId), page: String(page) },
    );
    out.push(...(data.questions ?? []));
    if (data.nextpage === -1 || data.nextpage === undefined) break;
    page = data.nextpage;
  }
  return out;
}

/**
 * クイズの新規受験を開始する。mod_quiz_start_attempt。
 * 【注意】この呼び出し自体が受験試行回数を1回消費する（取り消し不可）。
 * 受験不可の場合（時間外・試行回数超過等）は Moodle exception ではなく
 * `attempt: []` + warnings で返る仕様のため、その場合は UpstreamError にして呼び出し元へ伝える。
 *
 * 【重要】設問の取得（getAttemptQuestions）はこの関数に含めない。試行を消費する
 * mod_quiz_start_attempt と非消費の設問取得を同一のリトライ単位（withMoodleToken）に
 * まとめると、開始成功後の設問取得でトークンが失効した際に処理全体が再実行され、
 * mod_quiz_start_attempt が二重に走って試行を二重消費する（取り消し不可）。
 * そのため開始だけを1回実行し、設問取得は呼び出し側で別のリトライ単位として行う。
 */
export async function startQuizAttempt(
  origin: string,
  token: string,
  quizId: number,
): Promise<{ attempt: MoodleQuizAttempt }> {
  const started = await callMoodleApi<{ attempt: unknown; warnings?: RawWarning[] }>(
    origin,
    token,
    'mod_quiz_start_attempt',
    { quizid: String(quizId) },
  );
  if (!isStartedAttempt(started.attempt)) {
    const reason = started.warnings?.[0]?.message ?? '受験を開始できませんでした';
    throw new UpstreamError(`Moodle mod_quiz_start_attempt error: ${reason}`);
  }
  const attempt = started.attempt;
  return {
    attempt: { id: attempt.id, quizId: attempt.quiz, attemptNumber: attempt.attempt, state: attempt.state },
  };
}

/** `answers` のキー（`q{usage}:{slot}_...`）から回答対象の slot 番号を集める。 */
function answeredSlotsOf(answers: Record<string, string>): Set<number> {
  const slots = new Set<number>();
  for (const name of Object.keys(answers)) {
    const m = name.match(/^q\d+:(\d+)_/);
    if (m) slots.add(Number(m[1]));
  }
  return slots;
}

/**
 * 回答する slot について、設問HTMLから `_:sequencecheck` の name/value を取り出す。
 * これを同梱しないと mod_quiz_save_attempt は成功を返しつつ回答を黙って破棄する。
 * 回答しない slot には触れない（送ると既存回答が消える恐れがあるため）。
 */
function sequenceChecksFor(
  questions: RawQuizQuestion[],
  answeredSlots: Set<number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    if (!answeredSlots.has(q.slot)) continue;
    const m = q.html.match(/name="(q\d+:\d+_:sequencecheck)"\s+value="(\d+)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * 回答を一時保存する（本提出はしない）。mod_quiz_save_attempt。
 * `answers` は設問HTML中のinput/select要素のname属性→値。
 * 型別の値: multichoice(radio)は選択肢のindex(`_answer`)、match(select)は各`_sub{n}`に
 * 選択肢value、ordering は `_response_{qid}` に `ordering_item_{hash}` を正しい順でカンマ連結。
 * `_:sequencecheck` は当関数がライブHTMLから自動同梱するため呼び出し側は渡さなくてよい。
 * 返り値の unsavedSlots は、保存後に再取得しても未回答(notyetanswered)のままだった slot。
 * 空でなければ、指定した name/value が Moodle の期待と一致していない（保存に失敗した）ことを示す。
 */
export async function saveQuizAttempt(
  origin: string,
  token: string,
  attemptId: number,
  answers: Record<string, string>,
): Promise<{ ok: boolean; answeredSlots: number[]; unsavedSlots: number[] }> {
  const answeredSlots = answeredSlotsOf(answers);

  // ライブHTMLから sequencecheck を取得して必ず同梱する（保存が破棄される主因の対策）。
  const before = await getAttemptQuestions(origin, token, attemptId);
  const seqChecks = sequenceChecksFor(before, answeredSlots);

  const merged = { ...seqChecks, ...answers };
  const pairs = Object.entries(merged).map(([name, value]) => ({ name, value }));
  // mod_quiz_save_attempt は保存に失敗しても Moodle exception を投げず、HTTP 200 で
  // warnings を返すことがある。warnings の正確な形は 要検証 のため、保守的に
  // 「warnings が非空なら保存が反映されなかったとみなし失敗扱い」とし、明確なエラーを投げる。
  // （ここで握りつぶすと後続の finish が空の提出を確定してしまう。）
  const saved = await callMoodleApi<{ warnings?: RawWarning[] }>(origin, token, 'mod_quiz_save_attempt', {
    attemptid: String(attemptId),
    ...indexedNameValuePairs('data', pairs),
  });
  if (saved.warnings && saved.warnings.length > 0) {
    const reason =
      saved.warnings
        .map((w) => w.message ?? w.warningcode ?? '')
        .filter(Boolean)
        .join('; ') || '回答の保存に失敗しました';
    throw new UpstreamError(`Moodle mod_quiz_save_attempt warning: ${reason}`);
  }

  // 保存が実際に反映されたかを検証する（{ok:true} の偽陽性を防ぐ）。
  const after = await getAttemptQuestions(origin, token, attemptId);
  const stillUnanswered = new Set(
    after.filter((q) => /\bnotyetanswered\b/.test(q.html)).map((q) => q.slot),
  );
  const unsavedSlots = [...answeredSlots].filter((s) => stillUnanswered.has(s)).sort((a, b) => a - b);
  return { ok: unsavedSlots.length === 0, answeredSlots: [...answeredSlots].sort((a, b) => a - b), unsavedSlots };
}

/**
 * クイズの受験を確定する（取り消し不可）。mod_quiz_process_attempt に finishattempt=1 で呼ぶ。
 * 事前に saveQuizAttempt で保存済みの回答が対象になる（このAPI自体には回答データを渡さない）。
 */
export async function finishQuizAttempt(
  origin: string,
  token: string,
  attemptId: number,
): Promise<{ state: string }> {
  const data = await callMoodleApi<{ state: string }>(origin, token, 'mod_quiz_process_attempt', {
    attemptid: String(attemptId),
    finishattempt: '1',
    timeup: '0',
  });
  return { state: data.state };
}

export interface RawQuizReviewQuestion {
  slot: number;
  type: string;
  page: number;
  html: string;
  /** Moodle の正誤ステータス表示（例: 「正解」「部分的に正解」） */
  status?: string;
  /** 得点の表示文字列（例: "0.83"）。未採点なら欠落する */
  mark?: string;
  maxmark?: number;
}

export interface RawQuizReviewAttempt {
  id: number;
  quiz: number;
  attempt: number;
  state: string;
  sumgrades?: number | null;
  timefinish?: number;
}

export interface QuizAttemptReview {
  /** クイズ全体の評点（コース設定のスケールに換算済み）。未採点なら null */
  grade: string | null;
  attempt: RawQuizReviewAttempt;
  questions: RawQuizReviewQuestion[];
}

/**
 * 確定済み attempt の採点結果。mod_quiz_get_attempt_review（page=-1 で全設問・参照のみ）。
 * 進行中（inprogress）の attempt には使えず、Moodle が exception を返す
 * （そのまま UpstreamError として呼び出し元へ伝わる）。
 */
export async function getQuizAttemptReview(
  origin: string,
  token: string,
  attemptId: number,
): Promise<QuizAttemptReview> {
  const data = await callMoodleApi<{
    grade?: string | number;
    attempt: RawQuizReviewAttempt;
    questions?: RawQuizReviewQuestion[];
  }>(origin, token, 'mod_quiz_get_attempt_review', {
    attemptid: String(attemptId),
    page: '-1',
  });
  return {
    grade: data.grade != null ? String(data.grade) : null,
    attempt: data.attempt,
    questions: data.questions ?? [],
  };
}

// ---------------------------------------------------------------------------
// 課題提出（書き込み系）
// ---------------------------------------------------------------------------

async function startAssignSubmission(
  origin: string,
  token: string,
  assignmentId: number,
): Promise<void> {
  await callMoodleApi(origin, token, 'mod_assign_start_submission', {
    assignid: String(assignmentId),
  });
}

/** テキストのみの下書き保存。plugindataにファイル指定はしない。mod_assign_save_submission。 */
export async function saveAssignTextDraft(
  origin: string,
  token: string,
  assignmentId: number,
  text: string,
): Promise<{ warnings: unknown[] }> {
  await startAssignSubmission(origin, token, assignmentId);
  return callMoodleApi(origin, token, 'mod_assign_save_submission', {
    assignmentid: String(assignmentId),
    'plugindata[onlinetext_editor][text]': text,
    'plugindata[onlinetext_editor][format]': '1',
    'plugindata[onlinetext_editor][itemid]': '0',
  });
}

/** ファイル添付先の空draft area itemidを発行する。core_files_get_unused_draft_itemid。 */
export async function getUnusedDraftItemId(origin: string, token: string): Promise<number> {
  const data = await callMoodleApi<{ itemid: number }>(
    origin,
    token,
    'core_files_get_unused_draft_itemid',
    {},
  );
  return data.itemid;
}

/**
 * draft area へファイル本体をアップロードする。webservice/upload.php（REST APIとは別エンドポイント）。
 * レスポンスはアップロード済みファイル情報の配列（itemid/filename/filesize等）。
 * 実データでの疎通確認済み（MIGRATION_NOTES参照）。
 */
export async function uploadFileToDraftArea(
  origin: string,
  token: string,
  itemId: number,
  fileName: string,
  fileBytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const form = new FormData();
  form.append('token', token);
  form.append('itemid', String(itemId));
  form.append('file_1', new Blob([fileBytes], { type: contentType }), fileName);

  const res = await fetch(`${moodleBase(origin)}${UPLOAD_ENDPOINT}`, { method: 'POST', body: form });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle upload error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data) || data.length === 0) {
    throw new UpstreamError(`Moodle upload error: unexpected response ${JSON.stringify(data)}`);
  }
}

/** draft area にアップロード済みのファイルを提出物として紐付ける。mod_assign_save_submission。 */
export async function saveAssignFileSubmission(
  origin: string,
  token: string,
  assignmentId: number,
  draftItemId: number,
): Promise<{ warnings: unknown[] }> {
  await startAssignSubmission(origin, token, assignmentId);
  return callMoodleApi(origin, token, 'mod_assign_save_submission', {
    assignmentid: String(assignmentId),
    'plugindata[files_filemanager]': String(draftItemId),
  });
}

/**
 * 課題を採点対象として最終提出する（取り消し不可）。mod_assign_submit_for_grading。
 * 呼び出し前に save_assignment_draft / upload_assignment_file で内容を保存しておくこと。
 */
export async function submitAssignmentForGrading(
  origin: string,
  token: string,
  assignmentId: number,
): Promise<{ warnings: unknown[] }> {
  return callMoodleApi(origin, token, 'mod_assign_submit_for_grading', {
    assignmentid: String(assignmentId),
    acceptsubmissionstatement: '1',
  });
}

// ---------------------------------------------------------------------------
// コース内ファイル参照・ダウンロード（クイズ・課題が参照する補助資料向け）
// ---------------------------------------------------------------------------

export interface MoodleCourseFile {
  name: string;
  courseModuleId: number;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
}

interface RawResourceFile {
  filename: string;
  fileurl: string;
  filesize: number;
  mimetype: string;
}
interface RawResource {
  name: string;
  coursemodule: number;
  contentfiles?: RawResourceFile[];
}

/** コース内の「ファイル」リソース一覧。mod_resource_get_resources_by_courses。 */
export async function getCourseResources(
  origin: string,
  token: string,
  courseId: number,
): Promise<MoodleCourseFile[]> {
  const data = await callMoodleApi<{ resources: RawResource[] }>(
    origin,
    token,
    'mod_resource_get_resources_by_courses',
    { 'courseids[0]': String(courseId) },
  );
  const out: MoodleCourseFile[] = [];
  for (const r of data.resources ?? []) {
    for (const f of r.contentfiles ?? []) {
      out.push({
        name: r.name,
        courseModuleId: r.coursemodule,
        fileName: f.filename,
        fileUrl: f.fileurl,
        fileSize: f.filesize,
        mimeType: f.mimetype,
      });
    }
  }
  return out;
}

function pluginfilePrefix(origin: string): string {
  return `${moodleBase(origin)}/webservice/pluginfile.php/`;
}

/**
 * 通常のMoodle Webログイン(ユーザー名/パスワード→セッションCookie)。
 * `file.php`等、webservice tokenでは認証できない旧形式のファイルURL向けの都度ログイン
 * （実データ確認済み: file.phpはtoken非対応でCookie必須、逆にwebservice/pluginfile.phpは
 * token必須でCookieのみでは`missingparam`エラーになる）。セッションは永続化しない。
 */
async function moodleWebLogin(origin: string, username: string, password: string): Promise<string> {
  const jar: Record<string, string> = {};
  const collectCookies = (res: Response) => {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const raw of headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';', 1)[0];
      const name = pair.split('=', 1)[0];
      jar[name] = pair;
    }
  };

  let res = await fetch(`${moodleBase(origin)}/login/index.php`);
  collectCookies(res);
  const html = await res.text();
  const tokenMatch = html.match(/name="logintoken" value="([^"]+)"/);
  if (!tokenMatch) {
    throw new UpstreamError('Moodle web login error: logintoken not found');
  }

  res = await fetch(`${moodleBase(origin)}/login/index.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: Object.values(jar).join('; '),
    },
    body: new URLSearchParams({ username, password, logintoken: tokenMatch[1] }).toString(),
  });
  collectCookies(res);
  if (!Object.keys(jar).some((name) => name.startsWith('Moodle'))) {
    throw new UpstreamError('Moodle web login error: no session cookie issued');
  }
  return Object.values(jar).join('; ');
}

/**
 * Moodle上のファイルURLを認証付きで取得する。
 * `webservice/pluginfile.php`形式はtokenをクエリ付与、それ以外(legacy `file.php`等)は
 * 都度Webログインしたセッションcookieで取得する。呼び出し元でストリームをそのまま
 * proxyすることを想定し、Responseを返す（バッファリングしない）。
 */
export async function downloadMoodleFile(
  fileUrl: string,
  token: string,
  credential: Credential,
): Promise<Response> {
  if (fileUrl.startsWith(pluginfilePrefix(credential.moodleOrigin))) {
    const sep = fileUrl.includes('?') ? '&' : '?';
    return fetch(`${fileUrl}${sep}token=${token}`);
  }
  const cookie = await moodleWebLogin(credential.moodleOrigin, credential.id, credential.password);
  return fetch(fileUrl, { headers: { Cookie: cookie } });
}
