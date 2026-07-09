// Moodle（token 方式・JSON）。移植元: access_moodle.dart（読み取り系のみ）。
// クイズ回答・課題提出（書き込み系）は Dart 側に実装が無いため、
// core_webservice_get_site_info で確認済みの利用可能関数を元に Moodle 公式
// Web Service（Mobile app 用）の標準的なパラメータ仕様に従って実装している。
// 透過再ログインのラップ対象外。token 失効時のみ password で再取得する。

import type { Credential } from '../../types';
import { UpstreamError } from '../errors';

const MOODLE_ORIGIN = 'cms.aitech.ac.jp';
const WEBSERVICE = '/webservice/rest/server.php';
const UPLOAD_ENDPOINT = '/webservice/upload.php';
const BASE = `https://${MOODLE_ORIGIN}`;

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
  token: string,
  wsfunction: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${BASE}${WEBSERVICE}`, {
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
  courseId: number;
  courseName: string;
}

/** token 取得。POST /login/token.php。 */
export async function getMoodleToken(
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${BASE}/login/token.php`, {
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

interface MoodleAssignmentRaw {
  id: number;
  name: string;
  intro: string;
  duedate: number;
}
interface MoodleCourseRaw {
  id: number;
  fullname: string;
  assignments: MoodleAssignmentRaw[];
}

/** 課題一覧。POST webservice mod_assign_get_assignments。 */
export async function getMoodleAssignments(
  token: string,
): Promise<MoodleAssignment[]> {
  const res = await fetch(`${BASE}${WEBSERVICE}`, {
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
      out.push({
        id: a.id,
        name: a.name,
        description: a.intro,
        dueDate: new Date(epochMs).toISOString(),
        dueEpochMs: epochMs,
        courseId: course.id,
        courseName: course.fullname,
      });
    }
  }
  return out;
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
  canAttempt: boolean;
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

/** クイズ一覧＋受験可否情報。mod_quiz_get_quizzes_by_courses + mod_quiz_get_quiz_access_information。 */
export async function getQuizInfoByCourse(
  token: string,
  courseId: number,
): Promise<MoodleQuizInfo[]> {
  const quizzes = await callMoodleApi<{ quizzes: RawQuiz[] }>(
    token,
    'mod_quiz_get_quizzes_by_courses',
    { 'courseids[0]': String(courseId) },
  );
  const out: MoodleQuizInfo[] = [];
  for (const q of quizzes.quizzes ?? []) {
    const access = await callMoodleApi<RawQuizAccessInfo>(
      token,
      'mod_quiz_get_quiz_access_information',
      { quizid: String(q.id) },
    );
    out.push({
      id: q.id,
      courseId: q.course,
      name: q.name,
      intro: q.intro,
      timeOpen: q.timeopen ? new Date(q.timeopen * 1000).toISOString() : null,
      timeClose: q.timeclose ? new Date(q.timeclose * 1000).toISOString() : null,
      timeLimitSeconds: q.timelimit,
      attemptsAllowed: q.attempts,
      canAttempt: access.canattempt,
      preventAccessReasons: access.preventaccessreasons ?? [],
    });
  }
  return out;
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

/*
 * ページ内の設問一覧を全ページ分収集する。mod_quiz_get_attempt_data の `nextpage` を
 * -1（最終ページ）になるまで辿る。無限ループ防止のため上限ページ数を設ける。
 */
async function getAllAttemptQuestions(
  token: string,
  attemptId: number,
): Promise<RawQuizQuestion[]> {
  const out: RawQuizQuestion[] = [];
  let page = 0;
  const MAX_PAGES = 50;
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await callMoodleApi<{ questions: RawQuizQuestion[]; nextpage: number }>(
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
 */
export async function startQuizAttempt(
  token: string,
  quizId: number,
): Promise<{ attempt: MoodleQuizAttempt; questions: MoodleQuizQuestion[] }> {
  const started = await callMoodleApi<{ attempt: unknown; warnings?: RawWarning[] }>(
    token,
    'mod_quiz_start_attempt',
    { quizid: String(quizId) },
  );
  if (!isStartedAttempt(started.attempt)) {
    const reason = started.warnings?.[0]?.message ?? '受験を開始できませんでした';
    throw new UpstreamError(`Moodle mod_quiz_start_attempt error: ${reason}`);
  }
  const attempt = started.attempt;
  const questions = await getAllAttemptQuestions(token, attempt.id);
  return {
    attempt: { id: attempt.id, quizId: attempt.quiz, attemptNumber: attempt.attempt, state: attempt.state },
    questions: questions.map((q) => ({ slot: q.slot, page: q.page, type: q.type, html: q.html })),
  };
}

/**
 * 回答を一時保存する（本提出はしない）。mod_quiz_save_attempt。
 * `answers` は設問HTML中のinput/select要素のname属性→値。
 */
export async function saveQuizAttempt(
  token: string,
  attemptId: number,
  answers: Record<string, string>,
): Promise<{ ok: boolean }> {
  const pairs = Object.entries(answers).map(([name, value]) => ({ name, value }));
  await callMoodleApi(token, 'mod_quiz_save_attempt', {
    attemptid: String(attemptId),
    ...indexedNameValuePairs('data', pairs),
  });
  return { ok: true };
}

/**
 * クイズの受験を確定する（取り消し不可）。mod_quiz_process_attempt に finishattempt=1 で呼ぶ。
 * 事前に saveQuizAttempt で保存済みの回答が対象になる（このAPI自体には回答データを渡さない）。
 */
export async function finishQuizAttempt(
  token: string,
  attemptId: number,
): Promise<{ state: string }> {
  const data = await callMoodleApi<{ state: string }>(token, 'mod_quiz_process_attempt', {
    attemptid: String(attemptId),
    finishattempt: '1',
    timeup: '0',
  });
  return { state: data.state };
}

// ---------------------------------------------------------------------------
// 課題提出（書き込み系）
// ---------------------------------------------------------------------------

async function startAssignSubmission(token: string, assignmentId: number): Promise<void> {
  await callMoodleApi(token, 'mod_assign_start_submission', { assignid: String(assignmentId) });
}

/** テキストのみの下書き保存。plugindataにファイル指定はしない。mod_assign_save_submission。 */
export async function saveAssignTextDraft(
  token: string,
  assignmentId: number,
  text: string,
): Promise<{ warnings: unknown[] }> {
  await startAssignSubmission(token, assignmentId);
  return callMoodleApi(token, 'mod_assign_save_submission', {
    assignmentid: String(assignmentId),
    'plugindata[onlinetext_editor][text]': text,
    'plugindata[onlinetext_editor][format]': '1',
    'plugindata[onlinetext_editor][itemid]': '0',
  });
}

/** ファイル添付先の空draft area itemidを発行する。core_files_get_unused_draft_itemid。 */
export async function getUnusedDraftItemId(token: string): Promise<number> {
  const data = await callMoodleApi<{ itemid: number }>(
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

  const res = await fetch(`${BASE}${UPLOAD_ENDPOINT}`, { method: 'POST', body: form });
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
  token: string,
  assignmentId: number,
  draftItemId: number,
): Promise<{ warnings: unknown[] }> {
  await startAssignSubmission(token, assignmentId);
  return callMoodleApi(token, 'mod_assign_save_submission', {
    assignmentid: String(assignmentId),
    'plugindata[assignsubmission_file_filemanager]': String(draftItemId),
  });
}

/**
 * 課題を採点対象として最終提出する（取り消し不可）。mod_assign_submit_for_grading。
 * 呼び出し前に save_assignment_draft / upload_assignment_file で内容を保存しておくこと。
 */
export async function submitAssignmentForGrading(
  token: string,
  assignmentId: number,
): Promise<{ warnings: unknown[] }> {
  return callMoodleApi(token, 'mod_assign_submit_for_grading', {
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
  token: string,
  courseId: number,
): Promise<MoodleCourseFile[]> {
  const data = await callMoodleApi<{ resources: RawResource[] }>(
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

const WEBSERVICE_PLUGINFILE_PREFIX = `${BASE}/webservice/pluginfile.php/`;

/**
 * 通常のMoodle Webログイン(ユーザー名/パスワード→セッションCookie)。
 * `file.php`等、webservice tokenでは認証できない旧形式のファイルURL向けの都度ログイン
 * （実データ確認済み: file.phpはtoken非対応でCookie必須、逆にwebservice/pluginfile.phpは
 * token必須でCookieのみでは`missingparam`エラーになる）。セッションは永続化しない。
 */
async function moodleWebLogin(username: string, password: string): Promise<string> {
  const jar: Record<string, string> = {};
  const collectCookies = (res: Response) => {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const raw of headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';', 1)[0];
      const name = pair.split('=', 1)[0];
      jar[name] = pair;
    }
  };

  let res = await fetch(`${BASE}/login/index.php`);
  collectCookies(res);
  const html = await res.text();
  const tokenMatch = html.match(/name="logintoken" value="([^"]+)"/);
  if (!tokenMatch) {
    throw new UpstreamError('Moodle web login error: logintoken not found');
  }

  res = await fetch(`${BASE}/login/index.php`, {
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
  if (fileUrl.startsWith(WEBSERVICE_PLUGINFILE_PREFIX)) {
    const sep = fileUrl.includes('?') ? '&' : '?';
    return fetch(`${fileUrl}${sep}token=${token}`);
  }
  const cookie = await moodleWebLogin(credential.id, credential.password);
  return fetch(fileUrl, { headers: { Cookie: cookie } });
}
