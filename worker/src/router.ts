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
import { readState, writeState, deleteState } from './store/kv';
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
  getAssignmentsWithStatus,
  getQuizzesWithStatus,
  getQuizInfoByCourse,
  startQuizAttempt,
  getAttemptQuestions,
  getQuizAttemptReview,
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
import { summarizeQuizQuestions, summarizeReviewQuestion } from './upstream/moodle/quiz_parse';
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
import { log } from './log';

type Variables = { userId: string; state: UserState; correlationId: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- 相関ID（リクエスト単位）----
// 全リクエストに correlationId を付与し、構造化ログとエラー応答本文で共有する。
// ユーザーが提示するエラーコードとサーバーログを突き合わせるための識別子。
app.use('*', async (c, next) => {
  c.set('correlationId', crypto.randomUUID());
  await next();
});

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
  // auth 系は認証セマンティクスが他と異なるため、この共有ミドルウェア（session 検証＋
  // 内部 MCP ブートストラップ）の対象外にし、各ハンドラで自前検証する。
  //   - login: まだ session が無い。
  //   - logout/me: cookie 検証＋KV state の存在確認のみを行い、env 資格情報による
  //     state 上書き（内部 MCP 用ブートストラップ）は行わない。
  // なお me が KV state に依存するため、ログイン直後は Workers KV の結果整合性
  // （伝播遅延・negative cache）で一時的に 401 になり得るが、失効（logout での KV 削除）を
  // 検知するために許容する。ブラウザ側は 401 を /login へ誘導して回復する。
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

// moodleOrigin に許可するホストの allowlist。id/password を POST する接続先を
// 任意ホストにさせない（限定的な SSRF 対策）。本番 `cms.aitech.ac.jp` と
// dev docker-compose の `moodle.shiki-01.com` の両方を必ず含める（後者を落とすと
// dev 環境が丸ごと壊れる）。MOODLE_ORIGIN_OVERRIDE（dev:sandbox 用）が設定されて
// いれば、その値も許可対象に加える（実効 allowlist に合流させる）。
const MOODLE_ORIGIN_ALLOWLIST = ['cms.aitech.ac.jp', 'moodle.shiki-01.com'];
function isMoodleOriginAllowed(origin: string, env: Env): boolean {
  if (MOODLE_ORIGIN_ALLOWLIST.includes(origin)) return true;
  return Boolean(env.MOODLE_ORIGIN_OVERRIDE) && origin === env.MOODLE_ORIGIN_OVERRIDE;
}

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
  // 形式検証に加えて allowlist で接続先ホストを限定する（SSRF 対策）。
  if (moodleOrigin && !isMoodleOriginAllowed(moodleOrigin, c.env)) {
    return c.json({ error: 'moodleOrigin not allowed' }, 400);
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
// cookie 破棄に加えて KV の user state を削除し、session を実効失効させる（連鎖C/D）。
// cookie は署名付きで書き込み可能な bearer のため、KV を残すと盗まれた cookie が
// logout 後も生き続ける。state を消せばデータ系ミドルウェアと /api/auth/me の双方が
// state 不在で 401 を返すため、当該ユーザーの全 session が失効する。
app.post('/api/auth/logout', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  const token = readSessionCookie(c.req.header('Cookie'));
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (payload) {
    await deleteState(c.env, payload.uid);
  }
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

// ---- GET /api/auth/me ----
// signed session cookie の検証に加えて KV state の存在も要求する
// （ミドルウェアの対象外にしてあるため、ここで自前検証する）。
// logout で state を消すと me も 401 になるため、失効した cookie で me だけ成功し
// 全データが 401 という不整合（罠 C1）を避けられる。KV の結果整合性により
// ログイン直後は一時的に 401 になり得るが、ブラウザ側の 401→/login 回復で吸収する。
app.get('/api/auth/me', async (c) => {
  const token = readSessionCookie(c.req.header('Cookie'));
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const state = await readState(c.env, payload.uid);
  if (!state) {
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
  // 「本当に0件」と「構造破壊」の分離はパーサ側で行う。
  // 0件はコンテナが在れば [] で返り、コンテナ欠落（構造変化）は UpstreamError(502) として
  // ここでは握り潰さず伝播させる（silent [] にしない）。
  const notices = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchNotices(cookies, isCommon, count),
  );
  return c.json({ notices });
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
  // 成績セル欠落（構造変化）はパーサ側で UpstreamError(502) を投げる。
  // ログイン済みの成績ページは常に科目を含むため silent [] にはしない。
  const performance = await withLcamRelogin(c.env, userId, state, (cookies) =>
    fetchPerformance(cookies),
  );
  return c.json({ performance });
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

// ---- GET /api/moodle/assignment/status（課題一覧＋提出状況・参照のみ） ----
// クエリ: assignmentId / courseId / nameFilter / dueWithinDays / includePastDue。
// 提出状況は課題1件1 subrequestのため、絞り込み後の件数が上限以下のときだけ取得する
// （quiz/info の受験可否と同じパターン。超えたら絞り込んで再取得させる）。
app.get('/api/moodle/assignment/status', async (c) => {
  const parseIntQuery = (name: string): number | undefined | 'invalid' => {
    const raw = c.req.query(name);
    if (raw === undefined) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 'invalid' : n;
  };
  const assignmentId = parseIntQuery('assignmentId');
  if (assignmentId === 'invalid') return c.json({ error: 'invalid assignmentId' }, 400);
  const courseId = parseIntQuery('courseId');
  if (courseId === 'invalid') return c.json({ error: 'invalid courseId' }, 400);
  const dueWithinDays = parseIntQuery('dueWithinDays');
  if (dueWithinDays === 'invalid') return c.json({ error: 'invalid dueWithinDays' }, 400);
  const nameFilter = c.req.query('nameFilter') || undefined;
  const includePastDue = ['1', 'true'].includes(c.req.query('includePastDue') ?? '');

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getAssignmentsWithStatus(moodleOrigin, token, {
      assignmentId,
      courseId,
      nameFilter,
      dueWithinDays,
      includePastDue,
    }),
  );
  return c.json(
    result.statusIncluded
      ? result
      : {
          ...result,
          note:
            '対象の課題数が多いため提出状況(submissionStatus/submitted等)は取得していない。' +
            'assignmentId / courseId / nameFilter / dueWithinDays で対象を絞り込んで再取得すること。',
        },
  );
});

// ---- GET /api/moodle/quiz/status（全コースのクイズ一覧＋受験状況・参照のみ） ----
// クエリ: quizId / courseId / nameFilter / closeWithinDays / includeClosed。
// 受験履歴はクイズ1件1 subrequestのため、絞り込み後の件数が上限以下のときだけ取得する
// （assignment/status と同じパターン。超えたら絞り込んで再取得させる）。
app.get('/api/moodle/quiz/status', async (c) => {
  const parseIntQuery = (name: string): number | undefined | 'invalid' => {
    const raw = c.req.query(name);
    if (raw === undefined) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 'invalid' : n;
  };
  const quizId = parseIntQuery('quizId');
  if (quizId === 'invalid') return c.json({ error: 'invalid quizId' }, 400);
  const courseId = parseIntQuery('courseId');
  if (courseId === 'invalid') return c.json({ error: 'invalid courseId' }, 400);
  const closeWithinDays = parseIntQuery('closeWithinDays');
  if (closeWithinDays === 'invalid') return c.json({ error: 'invalid closeWithinDays' }, 400);
  const nameFilter = c.req.query('nameFilter') || undefined;
  const includeClosed = ['1', 'true'].includes(c.req.query('includeClosed') ?? '');

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getQuizzesWithStatus(moodleOrigin, token, {
      quizId,
      courseId,
      nameFilter,
      closeWithinDays,
      includeClosed,
    }),
  );
  return c.json(
    result.statusIncluded
      ? result
      : {
          ...result,
          note:
            '対象のクイズ数が多いため受験状況(finishedAttempts/finished等)は取得していない。' +
            'quizId / courseId / nameFilter / closeWithinDays で対象を絞り込んで再取得すること。',
        },
  );
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
// 設問は要約（設問文＋入力欄のname/選択肢）で返す。生HTMLのままでは設問数が多いと
// MCPクライアントのツール結果上限を超えるため（実測: 20問で約29万文字）。
// 生HTMLが必要な場合は GET /api/moodle/quiz/questions で取り直せる。
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
  // 試行を消費する開始は1回だけ実行する（withMoodleToken の失効リトライは、
  // 開始が invalidtoken で弾かれた＝未消費のケースのみ安全に再実行される）。
  const { attempt } = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    startQuizAttempt(moodleOrigin, token, bodyIn.quizId as number),
  );
  // 設問取得は非消費なので、開始とは別のリトライ単位で行う。ここで失効しても
  // 再実行されるのは設問取得のみで、開始（試行消費）が再実行されることはない。
  const questions = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getAttemptQuestions(moodleOrigin, token, attempt.id),
  );
  return c.json({ attempt, questions: summarizeQuizQuestions(questions) });
});

// ---- GET /api/moodle/quiz/questions?attemptId=（開始済みattemptの設問HTML全文・参照のみ） ----
// 要約で情報が足りない設問形式のためのフォールバック。試行回数は消費しない。
app.get('/api/moodle/quiz/questions', async (c) => {
  const attemptId = parseInt(c.req.query('attemptId') ?? '', 10);
  if (Number.isNaN(attemptId)) return c.json({ error: 'attemptId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const questions = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getAttemptQuestions(moodleOrigin, token, attemptId),
  );
  return c.json({ questions });
});

// ---- GET /api/moodle/quiz/result?attemptId=（確定済みattemptの採点結果・参照のみ） ----
app.get('/api/moodle/quiz/result', async (c) => {
  const attemptId = parseInt(c.req.query('attemptId') ?? '', 10);
  if (Number.isNaN(attemptId)) return c.json({ error: 'attemptId required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const review = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getQuizAttemptReview(moodleOrigin, token, attemptId),
  );
  return c.json({
    attemptId: review.attempt.id,
    quizId: review.attempt.quiz,
    attemptNumber: review.attempt.attempt,
    state: review.attempt.state,
    grade: review.grade,
    sumGrades: review.attempt.sumgrades ?? null,
    timeFinish: review.attempt.timefinish
      ? new Date(review.attempt.timefinish * 1000).toISOString()
      : null,
    questions: review.questions.map(summarizeReviewQuestion),
  });
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
  // 認証済みファイルをブラウザのディスクキャッシュに残さない。
  headers.set('cache-control', 'no-store');
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
  // 認証済みファイルをブラウザのディスクキャッシュに残さない。
  headers.set('cache-control', 'no-store');
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
// client には固定の汎用メッセージ + correlationId のみ返し、上流本文・例外文字列・
// 内部パーサ/クラス名は透過させない。詳細は構造化ログ（error レベル）にのみ出す。
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  const correlationId = c.get('correlationId') ?? 'unknown';
  // 診断用の詳細はサーバーログにのみ残す（client には返さない）。
  log('error', correlationId, 'request failed', {
    method: c.req.method,
    path,
    errorName: err.name,
    detail: err.message,
    stack: err.stack,
  });
  // 既知の型付きエラーは stable な code / status を維持しつつ、メッセージは汎用化する。
  if (err instanceof AuthFailedError) {
    return c.json({ error: 'reauth_required', message: '再ログインが必要です', correlationId }, 401);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: 'not_found', message: '対象が見つかりません', correlationId }, 404);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: 'リクエストが不正です', correlationId }, 400);
  }
  if (err instanceof UpstreamError) {
    return c.json({ error: 'upstream_error', message: '上流エラー', correlationId }, 502);
  }
  return c.json({ error: 'internal_error', message: '内部エラー', correlationId }, 500);
});

export default app;
