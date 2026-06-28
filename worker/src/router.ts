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
} from './upstream/lcam/client';
import { getMoodleToken, getMoodleAssignments, MoodleTokenError } from './upstream/moodle/access';
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
} from './upstream/errors';

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
  if (path === '/api/auth/login' || path === '/api/auth/logout') {
    return next();
  }
  if (c.req.method === 'OPTIONS') return next();

  const token = readSessionCookie(c.req.header('Cookie'));
  const payload = await verifySession(c.env.SESSION_SECRET, token);
  if (!payload) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const state = await readState(c.env, payload.uid);
  if (!state) {
    return c.json({ error: 'no state' }, 401);
  }
  c.set('userId', payload.uid);
  c.set('state', state);
  await next();
});

// ---- POST /api/auth/login ----
app.post('/api/auth/login', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);

  let bodyIn: { id?: string; password?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  const id = (bodyIn.id ?? '').trim();
  const password = (bodyIn.password ?? '').trim();
  if (!id || !password) return c.json({ error: 'id/password required' }, 400);

  // LCAM(SP) ログインで認証情報を検証しつつ上流 Cookie を確立する。
  const initial = await getCookie();
  const { body: loginBody, cookies } = await loginLcam(id, password, initial);
  if (!isLoginSuccess(parseHtml(loginBody))) {
    return c.json({ error: 'invalid credentials' }, 401);
  }

  // Moodle token を取得（失敗しても LCAM ログインは成立させる）。
  let moodleToken: string | null = null;
  try {
    moodleToken = await getMoodleToken(id, password);
  } catch {
    moodleToken = null;
  }

  // credential を即暗号化して保存。平文は browser に返さない。
  const credential = await encryptCredential(c.env.CRED_KEY, { id, password });
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
app.get('/api/auth/me', (c) => {
  return c.json({ userId: c.get('userId') });
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

// ---- GET /api/assignments（Moodle） ----
app.get('/api/assignments', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');

  async function ensureToken(): Promise<string> {
    if (state.moodleToken) return state.moodleToken;
    const cred = await decryptCredential(c.env.CRED_KEY, state.credential);
    const token = await getMoodleToken(cred.id, cred.password);
    state.moodleToken = token;
    await writeState(c.env, userId, state);
    return token;
  }

  let token = await ensureToken();
  try {
    const assignments = await getMoodleAssignments(token);
    return c.json({ assignments });
  } catch (e) {
    if (!(e instanceof MoodleTokenError)) throw e;
    // token 失効 → password で再取得 → 1回リトライ。
    const cred = await decryptCredential(c.env.CRED_KEY, state.credential);
    token = await getMoodleToken(cred.id, cred.password);
    state.moodleToken = token;
    await writeState(c.env, userId, state);
    const assignments = await getMoodleAssignments(token);
    return c.json({ assignments });
  }
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
  if (err instanceof UpstreamError) {
    return c.json({ error: 'upstream_error', message: err.message }, 502);
  }
  console.error('unhandled error stack:', err.stack);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

export default app;
