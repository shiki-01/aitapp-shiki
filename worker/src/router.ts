// Hono ルーター。session 検証・ルーティング・上流 proxy（要件 §9）。
// browser には正規化済みエンドポイントのみ公開し、上流 URL は隠蔽する。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, UserState } from './types';
import { encryptCredential, decryptCredential } from './crypto/aes';
import {
  signSession,
  verifySession,
  buildSessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from './session/cookie';
import { readState, writeState } from './store/kv';
import { getCookie, loginLcam } from './upstream/lcam/access';
import { parseHtml } from './html/parser';
import { isLoginSuccess } from './upstream/lcam/detect';
import { withLcamRelogin } from './upstream/relogin';
import {
  fetchNotices,
  fetchNoticeDetail,
  fetchTimetable,
  fetchFile,
  fetchSchedule,
  fetchPerformance,
  fetchEnqueteList,
  fetchEnqueteQuestions,
  submitEnqueteAnswer,
  finalizeEnqueteAnswer,
} from './upstream/lcam/client';
import type { EnqueteType } from './upstream/lcam/access';
import {
  getMoodleToken,
  getMoodleAssignments,
  getQuizInfoByCourse,
  startQuizAttempt,
  saveQuizAttempt,
  finishQuizAttempt,
  saveAssignTextDraft,
  getUnusedDraftItemId,
  uploadFileToDraftArea,
  saveAssignFileSubmission,
  submitAssignmentForGrading,
  getCourseResources,
  getUserCourses,
  downloadMoodleFile,
} from './upstream/moodle/access';
import { withMoodleToken } from './upstream/moodle/token';
import {
  getSyllabusSession,
  getSyllabusListBody,
  getSyllabus,
  refreshFiltersSession,
} from './upstream/syllabus/access';
import {
  extractSyllabusCookie,
  parseFilters,
  parseSearchList,
  parseDetail,
} from './upstream/syllabus/parse';
import {
  AuthFailedError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from './upstream/errors';
import { handleMcpRequest } from './mcp/handler';

type Variables = { userId: string; state: UserState };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- CORS（credentials 付き、APP_ORIGIN 限定） ----
app.use('/api/*', async (c, next) => {
  const origin = c.env.APP_ORIGIN ?? 'http://localhost:5173';
  return cors({
    origin,
    credentials: true,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })(c, next);
});

// ---- 状態変更系の Origin チェック（要件 §13） ----
function checkOrigin(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const allowed = c.env.APP_ORIGIN ?? 'http://localhost:5173';
  const origin = c.req.header('Origin');
  return origin === allowed;
}

// ---- 認証ミドルウェア（auth 配下以外の /api を保護） ----
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // /api/auth/me は signed cookie の検証のみで完結させる。KV の state 読み取りに
  // 依存すると、ログイン直後(write直後のread)は Workers KV の結果整合性
  // （伝播遅延・negative cache）により state がまだ見えず、ログイン成功直後に
  // 未ログイン扱いで /login へ差し戻されてしまう。
  if (
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/me'
  ) {
    return next();
  }
  if (c.req.method === 'OPTIONS') return next();

  const token = readSessionCookie(c.req.header('Cookie'));
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let state = await readState(c.env, payload.uid);

  // /mcp からの内部呼び出し（X-Aitapp-Internal: MCP_TOKEN）は、env の資格情報で state を
  // ブートストラップ/上書きする。目的:
  //   - 初回呼び出し時に /api/auth/login を経由せず state を確立する（KV の negative cache
  //     による write 直後の read miss にも影響されない）
  //   - LCAM が Worker の egress IP を拒否する環境でも、Moodle/シラバス系は動かせる
  //     （lcamCookies は null のままにし、必要になった時点で withLcamRelogin が試行する）
  //   - シークレット変更が即時反映される（credential は常に env から再構成）
  const internal =
    Boolean(c.env.MCP_TOKEN) && c.req.header('X-Aitapp-Internal') === c.env.MCP_TOKEN;
  if (
    internal &&
    c.env.AITAPP_ID &&
    c.env.AITAPP_PASSWORD &&
    payload.uid === c.env.AITAPP_ID
  ) {
    const hasMoodleCred = Boolean(c.env.AITAPP_MOODLE_ID && c.env.AITAPP_MOODLE_PASSWORD);
    const credential = await encryptCredential(c.env.CRED_KEY, {
      id: c.env.AITAPP_ID,
      password: c.env.AITAPP_PASSWORD,
      moodleOrigin: c.env.AITAPP_MOODLE_ORIGIN ?? '',
      ...(hasMoodleCred
        ? { moodleId: c.env.AITAPP_MOODLE_ID, moodlePassword: c.env.AITAPP_MOODLE_PASSWORD }
        : {}),
    });
    state = state
      ? { ...state, credential }
      : { lcamCookies: null, moodleToken: null, credential };
  }

  if (!state) {
    return c.json({ error: 'no state' }, 401);
  }
  c.set('userId', payload.uid);
  c.set('state', state);
  await next();
});

// Moodle 接続先ホスト名として妥当な形式か（スキーム・パス・`@` を含まない）。
const MOODLE_ORIGIN_PATTERN =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// ---- POST /api/auth/login ----
app.post('/api/auth/login', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);

  let bodyIn: {
    id?: string;
    password?: string;
    moodleOrigin?: string;
    moodleId?: string;
    moodlePassword?: string;
  };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  const id = (bodyIn.id ?? '').trim();
  const password = (bodyIn.password ?? '').trim();
  if (!id || !password) return c.json({ error: 'id/password required' }, 400);

  // ローカル開発時は .dev.vars の MOODLE_ORIGIN_OVERRIDE が常にクライアント指定より優先される。
  const moodleOrigin = c.env.MOODLE_ORIGIN_OVERRIDE || (bodyIn.moodleOrigin ?? '').trim();
  if (moodleOrigin && !MOODLE_ORIGIN_PATTERN.test(moodleOrigin)) {
    return c.json({ error: 'invalid moodleOrigin' }, 400);
  }

  // Moodle 専用資格情報（LCAM とアカウントが別の場合）。両方揃ったときだけ採用し、
  // 揃っていなければ LCAM の id/password を Moodle にも使う（従来挙動）。
  const moodleId = (bodyIn.moodleId ?? '').trim();
  const moodlePassword = (bodyIn.moodlePassword ?? '').trim();
  const hasMoodleCred = Boolean(moodleId && moodlePassword);

  // LCAM(SP) ログインで認証情報を検証しつつ上流 Cookie を確立する。
  const initial = await getCookie();
  const { body: loginBody, cookies } = await loginLcam(id, password, initial);
  if (!isLoginSuccess(parseHtml(loginBody))) {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  // Moodle token を取得（moodleOrigin 未設定 or 失敗しても LCAM ログインは成立させる）。
  let moodleToken: string | null = null;
  if (moodleOrigin) {
    try {
      moodleToken = await getMoodleToken(
        moodleOrigin,
        hasMoodleCred ? moodleId : id,
        hasMoodleCred ? moodlePassword : password,
      );
    } catch {
      moodleToken = null;
    }
  }

  // credential を即暗号化して保存。平文は browser に返さない。
  const credential = await encryptCredential(c.env.CRED_KEY, {
    id,
    password,
    moodleOrigin,
    ...(hasMoodleCred ? { moodleId, moodlePassword } : {}),
  });
  const state: UserState = { lcamCookies: cookies, moodleToken, credential };
  await writeState(c.env, id, state);

  const session = await signSession(c.env.SESSION_SECRET, {
    uid: id,
    iat: Date.now(),
  });
  c.header('Set-Cookie', buildSessionCookie(session));
  return c.json({ ok: true, userId: id, moodle: moodleToken !== null });
});

// ---- POST /api/auth/logout ----
app.post('/api/auth/logout', (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

// ---- GET /api/auth/me ----
// KV の state には依存せず、signed session cookie の検証のみで応答する
// （ミドルウェアの対象外にしてあるため、ここで自前検証する）。
app.get('/api/auth/me', async (c) => {
  const token = readSessionCookie(c.req.header('Cookie'));
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({ userId: payload.uid });
});

// ---- GET /api/notices?type=common|class&count=10 ----
// count は累積表示件数（上流 listPageNo）。上流は先頭から count 件を返し、
// index は全件通しの 0..N-1。ページ番号方式ではないため append しない。
app.get('/api/notices', async (c) => {
  const isCommon = (c.req.query('type') ?? 'common') !== 'class';
  const count = Math.max(1, parseInt(c.req.query('count') ?? '10', 10) || 10);
  const userId = c.get('userId');
  const state = c.get('state');
  try {
    const notices = await withLcamRelogin(c.env, userId, state, (cookies) =>
      fetchNotices(cookies, isCommon, count),
    );
    return c.json({ notices });
  } catch (e) {
    // 連絡が 1 件も無い場合はパースが空で失敗する。空配列として正常扱いする。
    if (e instanceof NotFoundError) return c.json({ notices: [] });
    throw e;
  }
});

// ---- GET /api/notices/detail?type=&index= ----
app.get('/api/notices/detail', async (c) => {
  const isCommon = (c.req.query('type') ?? 'common') !== 'class';
  const index = parseInt(c.req.query('index') ?? '', 10);
  if (Number.isNaN(index)) return c.json({ error: 'index required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const detail = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchNoticeDetail(cookies, isCommon, index),
  );
  return c.json({ detail });
});

// ---- GET /api/timetable ----
app.get('/api/timetable', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  const timetable = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchTimetable(cookies),
  );
  return c.json({ timetable });
});

// ---- GET /api/schedule ----
app.get('/api/schedule', async (c) => {
  const state = c.get('state');
  const weeks = Math.max(1, parseInt(c.env.SCHEDULE_WEEKS ?? '8', 10) || 8);
  // スケジュールは PC 経路でリクエストごとにフレッシュにログインする。
  const cred = await decryptCredential(c.env.CRED_KEY, state.credential);
  const schedule = await fetchSchedule(cred, weeks);
  return c.json({ schedule });
});

// ---- GET /api/performance（成績情報） ----
app.get('/api/performance', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  try {
    const performance = await withLcamRelogin(c.env, userId, state, (cookies) =>
      fetchPerformance(cookies),
    );
    return c.json({ performance });
  } catch (e) {
    // 履修科目が1件も無い場合はパースが空で失敗する。空配列として正常扱いする。
    if (e instanceof NotFoundError) return c.json({ performance: [] });
    throw e;
  }
});

// ---- GET /api/enquetes?type=class|evaluation|campus ----
app.get('/api/enquetes', async (c) => {
  const type = (c.req.query('type') ?? 'class') as EnqueteType;
  if (type !== 'class' && type !== 'evaluation' && type !== 'campus') {
    return c.json({ error: 'invalid type' }, 400);
  }
  const userId = c.get('userId');
  const state = c.get('state');
  const list = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchEnqueteList(cookies, type),
  );
  return c.json(list);
});

// ---- GET /api/enquetes/questions?index=（授業アンケートの設問。参照のみ） ----
app.get('/api/enquetes/questions', async (c) => {
  const index = parseInt(c.req.query('index') ?? '', 10);
  if (Number.isNaN(index)) return c.json({ error: 'index required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const form = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchEnqueteQuestions(cookies, index),
  );
  return c.json(form);
});

// アンケート回答系エンドポイント共通のリクエストボディ検証。
function parseEnqueteAnswerBody(
  bodyIn: { index?: number; answers?: Record<string, string> },
): { index: number; answers: Record<number, string> } | { error: string } {
  const index = bodyIn.index;
  const answersIn = bodyIn.answers ?? {};
  if (typeof index !== 'number' || Number.isNaN(index)) {
    return { error: 'index required' };
  }
  const answers: Record<number, string> = {};
  for (const [k, v] of Object.entries(answersIn)) {
    const n = Number(k);
    if (Number.isNaN(n)) return { error: `invalid question index: ${k}` };
    answers[n] = String(v);
  }
  return { index, answers };
}

// ---- POST /api/enquetes/answer（授業アンケートへの回答を一時保存） ----
// 実データで動作検証済み。MIGRATION_NOTES §11 参照。
app.post('/api/enquetes/answer', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { index?: number; answers?: Record<string, string> };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  const parsed = parseEnqueteAnswerBody(bodyIn);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withLcamRelogin(c.env, userId, state, (cookies) =>
    submitEnqueteAnswer(cookies, parsed.index, parsed.answers),
  );
  return c.json(result);
});

// ---- POST /api/enquetes/submit（授業アンケートの最終提出。確認画面を経由した本登録） ----
// MIGRATION_NOTES §11.5。取り消しにくい操作のため API 層でも明示的な confirm 文字列を要求する
// （MCP ツール側のガードと合わせた多層防御。ブラウザや curl から直接叩かれた場合の保険）。
app.post('/api/enquetes/submit', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { index?: number; answers?: Record<string, string>; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (bodyIn.confirm !== 'CONFIRM_FINAL_SUBMIT') {
    return c.json(
      { error: 'confirm_required', message: 'confirm に "CONFIRM_FINAL_SUBMIT" を指定してください' },
      400,
    );
  }
  const parsed = parseEnqueteAnswerBody(bodyIn);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withLcamRelogin(c.env, userId, state, (cookies) =>
    finalizeEnqueteAnswer(cookies, parsed.index, parsed.answers),
  );
  return c.json(result);
});

// ---- GET /api/assignments（Moodle） ----
app.get('/api/assignments', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  const assignments = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getMoodleAssignments(moodleOrigin, token),
  );
  return c.json({ assignments });
});

// ---- GET /api/moodle/quiz/info?courseId=[&quizId=][&nameFilter=]（クイズ一覧・受験可否） ----
// 受験可否はクイズ1件1 subrequestのため、絞り込み後の件数が上限以下のときだけ取得する
// （超えるとWorkersのsubrequest上限に達するため。quizId/nameFilterで絞り込んで再取得させる）。
app.get('/api/moodle/quiz/info', async (c) => {
  const courseId = parseInt(c.req.query('courseId') ?? '', 10);
  if (Number.isNaN(courseId)) return c.json({ error: 'courseId required' }, 400);
  const quizIdRaw = c.req.query('quizId');
  const quizId = quizIdRaw !== undefined ? parseInt(quizIdRaw, 10) : undefined;
  if (quizId !== undefined && Number.isNaN(quizId)) {
    return c.json({ error: 'invalid quizId' }, 400);
  }
  const nameFilter = c.req.query('nameFilter') || undefined;
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getQuizInfoByCourse(moodleOrigin, token, courseId, { quizId, nameFilter }),
  );
  return c.json(
    result.accessInfoIncluded
      ? result
      : {
          ...result,
          note:
            'クイズ数が多いため受験可否(canAttempt/preventAccessReasons)は取得していない。' +
            'quizId または nameFilter で対象を絞り込んで再取得すること。',
        },
  );
});

// ---- POST /api/moodle/quiz/start（受験開始。試行回数を1回消費する） ----
app.post('/api/moodle/quiz/start', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { quizId?: number };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (typeof bodyIn.quizId !== 'number') return c.json({ error: 'quizId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    startQuizAttempt(moodleOrigin, token, bodyIn.quizId as number),
  );
  return c.json(result);
});

// ---- POST /api/moodle/quiz/answer（回答の一時保存） ----
app.post('/api/moodle/quiz/answer', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { attemptId?: number; answers?: Record<string, string> };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (typeof bodyIn.attemptId !== 'number') return c.json({ error: 'attemptId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    saveQuizAttempt(moodleOrigin, token, bodyIn.attemptId as number, bodyIn.answers ?? {}),
  );
  return c.json(result);
});

// ---- POST /api/moodle/quiz/finish（受験の確定。取り消し不可） ----
app.post('/api/moodle/quiz/finish', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { attemptId?: number; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (bodyIn.confirm !== 'CONFIRM_FINISH_ATTEMPT') {
    return c.json(
      { error: 'confirm_required', message: 'confirm に "CONFIRM_FINISH_ATTEMPT" を指定してください' },
      400,
    );
  }
  if (typeof bodyIn.attemptId !== 'number') return c.json({ error: 'attemptId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    finishQuizAttempt(moodleOrigin, token, bodyIn.attemptId as number),
  );
  return c.json(result);
});

// ---- POST /api/moodle/assignment/draft（テキストのみの下書き保存） ----
app.post('/api/moodle/assignment/draft', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { assignmentId?: number; text?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (typeof bodyIn.assignmentId !== 'number') return c.json({ error: 'assignmentId required' }, 400);
  if (typeof bodyIn.text !== 'string') return c.json({ error: 'text required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    saveAssignTextDraft(moodleOrigin, token, bodyIn.assignmentId as number, bodyIn.text as string),
  );
  return c.json(result);
});

// ---- POST /api/moodle/assignment/upload（ファイル添付。multipart/form-data） ----
app.post('/api/moodle/assignment/upload', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  const form = await c.req.formData();
  const assignmentId = parseInt(String(form.get('assignmentId') ?? ''), 10);
  const file = form.get('file');
  if (Number.isNaN(assignmentId)) return c.json({ error: 'assignmentId required' }, 400);
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, async (token, moodleOrigin) => {
    const itemId = await getUnusedDraftItemId(moodleOrigin, token);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await uploadFileToDraftArea(
      moodleOrigin,
      token,
      itemId,
      file.name,
      bytes,
      file.type || 'application/octet-stream',
    );
    return saveAssignFileSubmission(moodleOrigin, token, assignmentId, itemId);
  });
  return c.json(result);
});

// ---- POST /api/moodle/assignment/submit（採点対象として最終提出。取り消し不可） ----
app.post('/api/moodle/assignment/submit', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { assignmentId?: number; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (bodyIn.confirm !== 'CONFIRM_SUBMIT_ASSIGNMENT') {
    return c.json(
      { error: 'confirm_required', message: 'confirm に "CONFIRM_SUBMIT_ASSIGNMENT" を指定してください' },
      400,
    );
  }
  if (typeof bodyIn.assignmentId !== 'number') return c.json({ error: 'assignmentId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    submitAssignmentForGrading(moodleOrigin, token, bodyIn.assignmentId as number),
  );
  return c.json(result);
});

// ---- GET /api/moodle/courses（受講中コース一覧） ----
app.get('/api/moodle/courses', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  const courses = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getUserCourses(moodleOrigin, token),
  );
  return c.json({ courses });
});

// ---- GET /api/moodle/resources?courseId=（コース内「ファイル」リソース一覧） ----
app.get('/api/moodle/resources', async (c) => {
  const courseId = parseInt(c.req.query('courseId') ?? '', 10);
  if (Number.isNaN(courseId)) return c.json({ error: 'courseId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const files = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getCourseResources(moodleOrigin, token, courseId),
  );
  return c.json({ files });
});

// ---- GET /api/moodle/file?url=（Moodle上のファイルをstream proxy。課題・クイズが参照する
// 補助資料や設問中の音声等をダウンロードするための汎用エンドポイント） ----
app.get('/api/moodle/file', async (c) => {
  const url = c.req.query('url');
  const userId = c.get('userId');
  const state = c.get('state');
  const cred = await decryptCredential(c.env.CRED_KEY, state.credential);
  // SSRF/オープンプロキシ防止: このユーザーの Moodle 接続先配下のみ許可。
  if (!cred.moodleOrigin) {
    return c.json({ error: 'moodleOrigin not configured for this user' }, 400);
  }
  const allowedPrefix = `https://${cred.moodleOrigin}/`;
  if (!url || !url.startsWith(allowedPrefix)) {
    return c.json({ error: `valid ${cred.moodleOrigin} url required` }, 400);
  }
  const upstream = await withMoodleToken(c.env, userId, state, (token) =>
    downloadMoodleFile(url, token, cred),
  );
  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  const cd = upstream.headers.get('content-disposition');
  const cl = upstream.headers.get('content-length');
  if (ct) headers.set('content-type', ct);
  if (cd) headers.set('content-disposition', cd);
  if (cl) headers.set('content-length', cl);
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ---- シラバス（状態を持たない・都度 JSESSIONID） ----

// GET /api/syllabus/filters?year=（year 省略時は初期 filters）
app.get('/api/syllabus/filters', async (c) => {
  const year = c.req.query('year');
  const res = await getSyllabusSession();
  const jSessionId = extractSyllabusCookie(res);
  const initial = await res.text();
  if (!year) {
    return c.json({ filters: parseFilters(initial) });
  }
  const refreshed = await refreshFiltersSession(year, jSessionId);
  return c.json({ filters: parseFilters(refreshed) });
});

// GET /api/syllabus/search?year=&word=&campus=&semester=&week=&hour=&folder=
app.get('/api/syllabus/search', async (c) => {
  const year = c.req.query('year');
  if (!year) return c.json({ error: 'year required' }, 400);
  const res = await getSyllabusSession();
  const jSessionId = extractSyllabusCookie(res);
  await res.text().catch(() => undefined);

  const numParam = (name: string): number | undefined => {
    const v = c.req.query(name);
    if (v === undefined || v === '') return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  const body = await getSyllabusListBody({
    year,
    jSessionId,
    campus: numParam('campus'),
    semester: numParam('semester'),
    week: numParam('week'),
    hour: numParam('hour'),
    searchWord: c.req.query('word') ?? '',
    folder: c.req.query('folder') ?? '',
  });
  return c.json({ results: parseSearchList(body) });
});

// GET /api/syllabus/detail?url=&year=&...（url は検索結果の相対 URL）
// シラバス詳細は「同一セッションで検索 POST 済み」というサーバー状態を要求するため、
// 新セッションで検索条件（フロントが使ったものと同じ）を再実行してから詳細を取得する。
app.get('/api/syllabus/detail', async (c) => {
  const url = c.req.query('url');
  if (!url || !url.startsWith('/')) {
    return c.json({ error: 'valid url required' }, 400);
  }
  const res = await getSyllabusSession();
  const jSessionId = extractSyllabusCookie(res);
  await res.text().catch(() => undefined);

  const numParam = (name: string): number | undefined => {
    const v = c.req.query(name);
    if (v === undefined || v === '') return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  // 検索状態を確立するための warm-up 検索（year があれば同一条件を再現）。
  const year = c.req.query('year');
  if (year) {
    try {
      await getSyllabusListBody({
        year,
        jSessionId,
        campus: numParam('campus'),
        semester: numParam('semester'),
        week: numParam('week'),
        hour: numParam('hour'),
        searchWord: c.req.query('word') ?? '',
        folder: c.req.query('folder') ?? '',
      });
    } catch {
      // warm-up の失敗は致命的でないため無視する。
    }
  }

  const body = await getSyllabus(url, jSessionId);
  return c.json({ detail: parseDetail(body) });
});

// ---- GET /api/file/:id（添付バイナリ stream proxy） ----
app.get('/api/file/:id', async (c) => {
  const id = c.req.param('id');
  let path: string;
  try {
    const pad = id.length % 4 === 0 ? '' : '='.repeat(4 - (id.length % 4));
    path = atob(id.replace(/-/g, '+').replace(/_/g, '/') + pad);
  } catch {
    return c.json({ error: 'invalid id' }, 400);
  }
  // SSRF/オープンプロキシ防止: 添付ダウンロードのパスのみ許可。
  if (!path.startsWith('/portalv2/common/fileUploadDownload/')) {
    return c.json({ error: 'forbidden path' }, 403);
  }

  const userId = c.get('userId');
  const state = c.get('state');
  const upstream = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchFile(cookies, path),
  );
  // Response body をそのまま pipe（バッファリングしない）。
  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  const cd = upstream.headers.get('content-disposition');
  const cl = upstream.headers.get('content-length');
  if (ct) headers.set('content-type', ct);
  if (cd) headers.set('content-disposition', cd);
  if (cl) headers.set('content-length', cl);
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ---- /mcp（MCP Streamable HTTP。ツールは自身の /api/* へ in-process dispatch する） ----
app.all('/mcp', (c) =>
  handleMcpRequest(c, (req) => Promise.resolve(app.fetch(req, c.env, c.executionCtx))),
);
// Authorization ヘッダを設定できないクライアント（スマホの Claude アプリの
// カスタムコネクタ等）向け: トークンを URL パスに埋め込む。MCP_TOKEN は
// パスセグメントとして安全な文字のみ（例: openssl rand -hex 32）で生成すること。
app.all('/mcp/:token', (c) =>
  handleMcpRequest(
    c,
    (req) => Promise.resolve(app.fetch(req, c.env, c.executionCtx)),
    c.req.param('token'),
  ),
);

// ---- エラーハンドラ ----
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  // 診断用: 全エラーを種別とメッセージ付きでログ出力する。
  console.log(`[error] ${c.req.method} ${path} -> ${err.name}: ${err.message}`);
  if (err instanceof AuthFailedError) {
    return c.json({ error: 'reauth_required', message: err.message }, 401);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: 'not_found', message: err.message }, 404);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: err.message }, 400);
  }
  if (err instanceof UpstreamError) {
    return c.json({ error: 'upstream_error', message: err.message }, 502);
  }
  console.error('unhandled error stack:', err.stack);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

export default app;
