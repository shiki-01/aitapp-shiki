// Hono ルーター。session 検証・ルーティング・上流 proxy（要件 §9）。
// browser には正規化済みエンドポイントのみ公開し、上流 URL は隠蔽する。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
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
import { configureLcamRelay } from './upstream/lcam/access';
import { parseLcamCookies } from './upstream/lcam/cookies';
import { withLcamSession } from './upstream/lcam/session';
import { parseAppKey, exchangeAppKey, appLogin } from './upstream/lcam/app-login';
import { encryptJson } from './crypto/aes';
import {
  fetchNotices,
  fetchNoticeDetail,
  fetchTimetable,
  probeSpSession,
  fetchFile,
  fetchPerformance,
  fetchEnqueteList,
  fetchSchedule,
  MAX_SCHEDULE_MONTH_OFFSET,
  fetchEnqueteQuestions,
  fetchEnqueteFile,
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
  LcamExpiredError,
  LcamReauthRequiredError,
  LcamAppKeyRejectedError,
  LcamAppCredentialRejectedError,
  MoodleTokenError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from './upstream/errors';
import { classifyUpstreamService } from './upstream/service';
import { handleMcpRequest } from './mcp/handler';
import { mintUserMcpToken } from './mcp/token';
import { log, redactPath } from './log';
import { applyInlineView } from './inline-view';
import { registerPcRoutes } from './routes-pc';

type Variables = { userId: string; state: UserState; correlationId: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---- 相関ID（リクエスト単位）----
// 全リクエストに correlationId を付与し、構造化ログとエラー応答本文で共有する。
// ユーザーが提示するエラーコードとサーバーログを突き合わせるための識別子。
app.use('*', async (c, next) => {
  c.set('correlationId', crypto.randomUUID());
  // LCAM 中継 relay の設定を注入（env 由来の deployment 定数。§13.4）。
  configureLcamRelay(c.env);
  await next();
});

// ---- 許可オリジン（APP_ORIGIN + 追加のローカル開発ポート 5174） ----
const EXTRA_DEV_ORIGINS = ['http://localhost:5174'];

function allowedOrigins(env: Env): string[] {
  return [env.APP_ORIGIN ?? 'http://localhost:5173', ...EXTRA_DEV_ORIGINS];
}

// ---- CORS（credentials 付き、許可オリジン限定） ----
app.use('/api/*', async (c, next) => {
  const allowed = allowedOrigins(c.env);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })(c, next);
});

// ---- 状態変更系の Origin チェック（要件 §13） ----
function checkOrigin(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const origin = c.req.header('Origin');
  return origin !== undefined && allowedOrigins(c.env).includes(origin);
}

// ---- 不可逆/取り消しにくい書き込み操作の out-of-band confirm 検証 ----
// confirm 値はモデルに見えるツール引数ではなく、MCP ホストが人間保有の秘密
// （env.CONFIRM_SECRET）から注入したもの。worker を権威ある検証点とし、LLM が選んだ
// （あるいは上流データのプロンプトインジェクションが指示した）任意文字列では通さない。
// env.CONFIRM_SECRET 未設定なら fail-closed（常に不成立＝実行拒否）。
function confirmOk(env: Env, confirm: unknown): boolean {
  const secret = env.CONFIRM_SECRET;
  return typeof secret === 'string' && secret.length > 0 && confirm === secret;
}

// confirm 不成立時の共通レスポンス（未設定・不一致を区別せず 400 で拒否する）。
const CONFIRM_REQUIRED_MESSAGE =
  'out-of-band の確認値が未設定または不一致です。worker の CONFIRM_SECRET と ' +
  'MCP ホストの AITAPP_CONFIRM_SECRET（/mcp 実行時は worker の CONFIRM_SECRET）を同一値に設定してください。';

// ---- LCAM セッション（Entra SSO + MFA）の再登録案内 ----
// 保存済みの資格情報（アプリ方式）があれば Worker が自動で再ログインするため、この案内は
// 「未登録」または「資格情報が拒否された」ときだけ出る。MFA は自動化できないので、本人がブラウザで
// ログインして得た lamyapp:// の URL（key）を登録し直す手順を、MCP・Web の両方へ固定文言で返す（上流本文は含めない）。
const LCAM_REAUTH_STEPS =
  '手順: ①PC のブラウザで DevTools（F12）→ Network →「Preserve log」を ON にして ' +
  'https://lcam.aitech.ac.jp/portalv2/sp を開き、ログイン（MFA 込み）→ ' +
  '②最後に遷移する lamyapp://lcam?key=… の URL（Network の 302 の Location、または Console のエラー文言）をコピー → ' +
  '③Web 画面（その他 → LCAM 連携）またはチャットの lcam_set_session ツールでその URL を登録' +
  '（key は使い捨てで短時間で無効になるため、コピーしたらすぐ登録する。デスクトップ版アプリは「LCAM に接続」で自動登録できる）。';
const LCAM_REAUTH_MESSAGE: Record<'not_registered' | 'expired', string> = {
  not_registered: `LCAM が未登録です。${LCAM_REAUTH_STEPS}`,
  expired: `LCAM の資格情報が失効しています（再登録が必要です）。${LCAM_REAUTH_STEPS}`,
};
const LCAM_COOKIE_REJECTED_MESSAGE =
  'この Cookie では LCAM に入れませんでした。値の貼り間違い・古い Cookie・ログアウト済み・' +
  'ログインしたセッションが SP 画面で認められない（PC 画面ログインの場合。要確認）・mellon 系 Cookie の不足のいずれかの可能性があります。' +
  'ログイン直後に、ログアウトせずコピーし直してください。';
const LCAM_KEY_REJECTED_MESSAGE =
  'key が無効か期限切れです。もう一度 LCAM にログインして、lamyapp:// の URL を取り直してください' +
  '（key は使い捨てで短時間で無効になります）。';

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
  //     （lcamCookies は null のままにし、必要になった時点で withLcamSession が「未登録」エラーを返す）
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
      : { lcamCookies: null, lcamApp: null, moodleToken: null, credential };
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

// クライアント（web/desktop）は login で moodleOrigin を送らないため、本番では
// MOODLE_ORIGIN_OVERRIDE も無く moodleOrigin が空になり、以後の Moodle 呼び出しが
// すべて UpstreamError（token.ts: origin 未設定）で 502 になっていた。単一大学前提の
// 本アプリでは本番ホストを既定値にする（allowlist・形式チェックにも適合する値）。
const DEFAULT_MOODLE_ORIGIN = 'cms.aitech.ac.jp';
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
  // クライアントは moodleOrigin を送らないため、未指定時は本番ホストを既定値にする
  // （空のままだと credential に空 origin が保存され、以後の Moodle 呼び出しが 502 になる）。
  const moodleOrigin =
    c.env.MOODLE_ORIGIN_OVERRIDE || (bodyIn.moodleOrigin ?? '').trim() || DEFAULT_MOODLE_ORIGIN;
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

  // 認証情報は Moodle のローカル認証（login/token.php）で検証し、token を確立する。
  // LCAM は Entra ID の SSO + MFA に移行したため、パスワードでのログイン検証はできない
  // （LCAM の Cookie は POST /api/lcam/session で別途登録する。MIGRATION_NOTES §14）。
  let moodleToken: string;
  try {
    moodleToken = await getMoodleToken(
      moodleOrigin,
      hasMoodleCred ? moodleId : id,
      hasMoodleCred ? moodlePassword : password,
    );
  } catch (e) {
    if (e instanceof UpstreamError && e.upstreamCode === 'invalidlogin') {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    throw e;
  }

  // credential を即暗号化して保存。平文は browser に返さない。
  const credential = await encryptCredential(c.env.CRED_KEY, {
    id,
    password,
    moodleOrigin,
    ...(hasMoodleCred ? { moodleId, moodlePassword } : {}),
  });
  // 再ログイン（新端末・cookie 失効後など）で、発行済みのユーザー別 MCP トークンと、
  // 登録済みの LCAM Cookie・資格情報（ログインでは再取得できない）を失わないよう既存 state から引き継ぐ。
  const prev = await readState(c.env, id);
  const state: UserState = {
    lcamCookies: prev?.lcamCookies ?? null,
    lcamSession: prev?.lcamSession ?? null,
    lcamApp: prev?.lcamApp ?? null,
    moodleToken,
    credential,
    mcpTokenHash: prev?.mcpTokenHash ?? null,
    mcpAllowWrites: prev?.mcpAllowWrites ?? false,
  };
  await writeState(c.env, id, state);

  const session = await signSession(c.env.SESSION_SECRET, {
    uid: id,
    iat: Date.now(),
  });
  c.header('Set-Cookie', buildSessionCookie(session));
  return c.json({ ok: true, userId: id, moodle: true, lcam: state.lcamCookies !== null || !!state.lcamApp });
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
  // mcp: ユーザー別 MCP トークンを発行済みかどうか（UI の表示用。トークン自体は返さない）。
  // mcpWrites: user モード MCP からの不可逆書き込みを許可しているか。
  return c.json({
    userId: payload.uid,
    mcp: Boolean(state.mcpTokenHash),
    mcpWrites: state.mcpAllowWrites === true,
  });
});

// ---- POST /api/auth/mcp-token（ユーザー別 MCP トークンの発行/再発行） ----
// ログイン済みユーザーが自分専用の /mcp/<token> URL を自己発行する。
// 平文トークンはこの応答でのみ返し、KV には SHA-256 ハッシュだけを保存する。
// 再発行するとハッシュが置き換わり、旧トークンは無効になる。
// 認証ミドルウェア対象（session cookie + KV state 必須）。
app.post('/api/auth/mcp-token', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  const userId = c.get('userId');
  const state = c.get('state');
  const { token, hash } = await mintUserMcpToken(userId);
  await writeState(c.env, userId, { ...state, mcpTokenHash: hash });
  // URL は worker 自身のオリジンから組み立てる（クライアント入力を混ぜない）。
  const url = `${new URL(c.req.url).origin}/mcp/${token}`;
  return c.json({ ok: true, token, url });
});

// ---- POST /api/auth/mcp-token/revoke（ユーザー別 MCP トークンの失効） ----
// DELETE ではなく POST なのは、CORS の allowMethods と desktop(Tauri) 側の
// api_request（GET/POST のみ）を変えずに済ませるため。
app.post('/api/auth/mcp-token/revoke', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  const userId = c.get('userId');
  const state = c.get('state');
  if (state.mcpTokenHash) {
    await writeState(c.env, userId, { ...state, mcpTokenHash: null });
  }
  return c.json({ ok: true });
});

// ---- POST /api/auth/mcp-writes（user モード MCP からの不可逆書き込み許可の切替） ----
// ユーザー別 MCP トークン(user モード)は既定で不可逆書き込みを拒否する。ここで本人が
// 明示的に許可した場合のみ、/mcp user モードに CONFIRM_SECRET が注入されて実行可能になる。
// セッション cookie + Origin 検証必須の Web UI からのみ呼ばれる想定で、MCP ツール経由の
// 経路は存在しない(モデルはこのフラグを立てられない)。
app.post('/api/auth/mcp-writes', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let body: { allow?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  const allow = body.allow === true;
  const userId = c.get('userId');
  const state = c.get('state');
  await writeState(c.env, userId, { ...state, mcpAllowWrites: allow });
  return c.json({ ok: true, allow });
});

// ---- GET /api/lcam/session（LCAM セッションの登録状況。値は返さない） ----
// registeredAt / lastOkAt / expiredAt から、セッション寿命を自然な利用で測れる
// （寿命は [lastOkAt - registeredAt, expiredAt - registeredAt] の範囲）。
// registered: Cookie またはアプリ用資格情報が登録済み（資格情報があれば、Cookie が失効していても
// 次のリクエストで自動再ログインするため「登録済み」）。appRegistered: アプリ用資格情報が登録済み。
app.get('/api/lcam/session', async (c) => {
  const state = c.get('state');
  const meta = state.lcamSession;
  return c.json({
    registered: state.lcamCookies !== null || !!state.lcamApp,
    appRegistered: !!state.lcamApp,
    registeredAt: meta?.registeredAt || null,
    lastOkAt: meta?.lastOkAt ?? null,
    expiredAt: meta?.expiredAt ?? null,
  });
});

// ---- POST /api/lcam/session（LCAM の Cookie または app key を登録） ----
// appKey: lamyapp://lcam?key=... または key の値。key を交換して userId/password を得て、
//         資格情報を暗号化保存。以後は自動再ログイン可能。
// cookies: ユーザーがブラウザで LCAM に SSO（MFA 込み）ログインして取得した Cookie。
//          （JSESSIONID / LiveApps-Cookie、必要なら mellon*）
// いずれか一方のみ（両方 または 両方なしなら 400）。
app.post('/api/lcam/session', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);

  let bodyIn: { appKey?: unknown; cookies?: unknown };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }

  const hasAppKey = Boolean(bodyIn.appKey);
  const hasCookies = Boolean(bodyIn.cookies);
  if ((hasAppKey && hasCookies) || (!hasAppKey && !hasCookies)) {
    return c.json({ error: 'invalid body', message: 'appKey または cookies いずれか一方だけを指定してください' }, 400);
  }

  const userId = c.get('userId');
  const state = c.get('state');
  const now = Date.now();

  // appKey 方式: key を交換して資格情報を取得・保存。
  if (hasAppKey) {
    if (typeof bodyIn.appKey !== 'string' || bodyIn.appKey.length === 0 || bodyIn.appKey.length > 2048) {
      return c.json({ error: 'invalid_app_key', message: 'appKey は 1～2048 文字の文字列です' }, 400);
    }

    const appKey = parseAppKey(bodyIn.appKey);
    if (!appKey) {
      return c.json(
        {
          error: 'invalid_app_key',
          message: 'key の形式が無効です。lamyapp://lcam?key=... または key の値を指定してください。',
          correlationId: c.get('correlationId'),
        },
        400,
      );
    }

    try {
      const cred = await exchangeAppKey(appKey);
      const cookies = await appLogin(cred);
      const encrypted = await encryptJson(c.env.CRED_KEY, cred);

      await writeState(c.env, userId, {
        ...state,
        lcamCookies: cookies,
        lcamApp: encrypted,
        lcamSession: { registeredAt: now, lastOkAt: now },
      });

      return c.json({ ok: true, registeredAt: now, viaApp: true });
    } catch (e) {
      if (e instanceof LcamAppKeyRejectedError || e instanceof LcamAppCredentialRejectedError) {
        return c.json(
          {
            error: 'lcam_key_rejected',
            message: LCAM_KEY_REJECTED_MESSAGE,
            correlationId: c.get('correlationId'),
          },
          422,
        );
      }
      throw e;
    }
  }

  // cookies 方式: 従来の Cookie 貼り付け。
  if (typeof bodyIn.cookies !== 'string' || bodyIn.cookies.length === 0 || bodyIn.cookies.length > 4096) {
    return c.json({ error: 'invalid_cookies', message: 'cookies（文字列）が必要です' }, 400);
  }
  const parsed = parseLcamCookies(bodyIn.cookies);
  if (!parsed.ok) {
    return c.json({ error: 'invalid_cookies', message: parsed.error }, 400);
  }
  try {
    await probeSpSession(parsed.cookies);
  } catch (e) {
    if (e instanceof LcamExpiredError) {
      return c.json(
        {
          error: 'lcam_session_rejected',
          message: LCAM_COOKIE_REJECTED_MESSAGE,
          correlationId: c.get('correlationId'),
        },
        422,
      );
    }
    throw e;
  }
  // Cookie は登録するが lcamApp には触れない（既存の資格情報を失わない）。
  await writeState(c.env, userId, {
    ...state,
    lcamCookies: parsed.cookies,
    lcamSession: { registeredAt: now, lastOkAt: now },
  });
  return c.json({ ok: true, registeredAt: now });
});

// ---- POST /api/lcam/session/revoke（LCAM セッションと資格情報を削除） ----
// Cookie と資格情報の両方をクリア。以後は再登録が必要になる。
// DELETE ではなく POST なのは、CORS の allowMethods と desktop(Tauri) 側の api_request（GET/POST のみ）を
// 変えずに済ませるため（/api/auth/mcp-token/revoke と同じ）。
app.post('/api/lcam/session/revoke', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  const userId = c.get('userId');
  const state = c.get('state');
  await writeState(c.env, userId, {
    ...state,
    lcamCookies: null,
    lcamApp: null,
    lcamSession: null,
  });
  return c.json({ ok: true });
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
  const notices = await withLcamSession(c.env, userId, state, (cookies) =>
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
  const detail = await withLcamSession(c.env, userId, state, (cookies) =>
    fetchNoticeDetail(cookies, isCommon, index),
  );
  return c.json({ detail });
});

// ---- GET /api/timetable ----
app.get('/api/timetable', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  const timetable = await withLcamSession(c.env, userId, state, (cookies) =>
    fetchTimetable(cookies),
  );
  return c.json({ timetable });
});

// ---- GET /api/schedule?weeks=&month=（個人スケジュール。休講・補講・学校行事など） ----
// PC ホームのカレンダーを、SP ページの token 付き POST（メニュー遷移）でたどって取得する
// （PC 画面への直接 GET は「不正な操作」でセッションが破棄されるため使わない。MIGRATION_NOTES §14.4 / §16）。
//   month 省略: 今日から weeks 週。
//   month=N（-8〜8）: 今月から N か月ずらした月の 1 日を含む週（月曜始まり）から weeks 週。
// 1 リクエストで動かせる回数（subrequest 50）に限りがあるため、広い範囲は呼び出し側が month をずらして分割して呼ぶ。
// LCAM は単一セッションで、PC 画面へ入ると SP 側の Cookie が失効することがある。その場合は次の SP リクエストが
// 透過再ログインで復帰する。
app.get('/api/schedule', async (c) => {
  const weeks = parseInt(c.req.query('weeks') ?? '6', 10);
  if (Number.isNaN(weeks) || weeks < 1) return c.json({ error: 'invalid weeks' }, 400);
  let month: number | undefined;
  const monthRaw = c.req.query('month');
  if (monthRaw !== undefined) {
    month = parseInt(monthRaw, 10);
    if (Number.isNaN(month) || Math.abs(month) > MAX_SCHEDULE_MONTH_OFFSET) {
      return c.json({ error: 'invalid month' }, 400);
    }
  }
  const userId = c.get('userId');
  const state = c.get('state');
  const schedule = await withLcamSession(c.env, userId, state, (cookies) =>
    fetchSchedule(cookies, weeks, month),
  );
  return c.json({ schedule });
});

// ---- GET /api/performance（成績情報） ----
app.get('/api/performance', async (c) => {
  const userId = c.get('userId');
  const state = c.get('state');
  // 成績セル欠落（構造変化）はパーサ側で UpstreamError(502) を投げる。
  // ログイン済みの成績ページは常に科目を含むため silent [] にはしない。
  const performance = await withLcamSession(c.env, userId, state, (cookies) =>
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
  const list = await withLcamSession(c.env, userId, state, (cookies) =>
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
  const form = await withLcamSession(c.env, userId, state, (cookies) =>
    fetchEnqueteQuestions(cookies, index),
  );
  return c.json(form);
});

// ---- GET /api/enquetes/file?index=&path=（授業アンケートの問題ファイル。stream proxy） ----
// path は /api/enquetes/questions の files の値のみ許可（fetchEnqueteFile 内で照合）。
app.get('/api/enquetes/file', async (c) => {
  const index = parseInt(c.req.query('index') ?? '', 10);
  const path = c.req.query('path') ?? '';
  if (Number.isNaN(index) || !path) return c.json({ error: 'index and path required' }, 400);
  const userId = c.get('userId');
  const state = c.get('state');
  const upstream = await withLcamSession(c.env, userId, state, (cookies) =>
    fetchEnqueteFile(cookies, index, path),
  );
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
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
// 本物のアンケートに下書きが残る書き込みのため、out-of-band confirm を要求する。
app.post('/api/enquetes/answer', async (c) => {
  if (!checkOrigin(c)) return c.json({ error: 'bad origin' }, 403);
  let bodyIn: { index?: number; answers?: Record<string, string>; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
  }
  const parsed = parseEnqueteAnswerBody(bodyIn);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withLcamSession(c.env, userId, state, (cookies) =>
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
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
  }
  const parsed = parseEnqueteAnswerBody(bodyIn);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withLcamSession(c.env, userId, state, (cookies) =>
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
  // assignmentIds=1,2,3（Web 画面が表示中の課題の提出状況をまとめて取る）。
  let assignmentIds: number[] | undefined;
  const idsRaw = c.req.query('assignmentIds');
  if (idsRaw !== undefined) {
    assignmentIds = idsRaw.split(',').map((v) => parseInt(v, 10));
    if (assignmentIds.length === 0 || assignmentIds.some((n) => Number.isNaN(n))) {
      return c.json({ error: 'invalid assignmentIds' }, 400);
    }
  }

  const userId = c.get('userId');
  const state = c.get('state');
  const result = await withMoodleToken(c.env, userId, state, (token, moodleOrigin) =>
    getAssignmentsWithStatus(moodleOrigin, token, {
      assignmentId,
      assignmentIds,
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
  let bodyIn: { quizId?: number; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  // 受験開始は試行回数を1回消費する取り消し不可の操作のため out-of-band confirm を要求する。
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
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
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
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
  let bodyIn: { assignmentId?: number; text?: string; confirm?: string };
  try {
    bodyIn = await c.req.json();
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  // 本物の課題に下書き（submissiondrafts=0 の課題では即時提出扱い）が残る書き込みのため
  // out-of-band confirm を要求する。
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
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
  // 本物の課題に提出物（submissiondrafts=0 の課題では即時提出扱い）が紐付く書き込みのため
  // out-of-band confirm を要求する（multipart なので form フィールドで受け取る）。
  if (!confirmOk(c.env, form.get('confirm'))) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
  }
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
  if (!confirmOk(c.env, bodyIn.confirm)) {
    return c.json({ error: 'confirm_required', message: CONFIRM_REQUIRED_MESSAGE }, 400);
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
  const upstream = await withLcamSession(c.env, userId, state, (cookies) =>
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
  // ?inline=1: ブラウザ標準ビューアで表示(pdf/画像/txt のみ。他はダウンロードのまま)。
  if (c.req.query('inline') === '1') applyInlineView(headers);
  // 認証済みファイルをブラウザのディスクキャッシュに残さない。
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ---- LCAM PC 版の機能（学内共有ファイル等。routes-pc.ts） ----
registerPcRoutes(app);

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

// ---- フロント静的配信（web/build、Workers Static Assets） ----
// [assets] run_worker_first = true で全リクエストが Worker を通るため、
// /api・/mcp に一致しなかった残りをここで受けて asset 配信へ回す。
// SPA フォールバック（/login 等 → index.html）は [assets] not_found_handling が担う。
app.all('*', (c) => {
  const path = new URL(c.req.url).pathname;
  // API/MCP 配下の未定義パスはフロントへフォールバックさせず 404 を返す。
  if (path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/')) {
    return c.json(
      { error: 'not_found', message: '対象が見つかりません', correlationId: c.get('correlationId') },
      404,
    );
  }
  if (!c.env.ASSETS) return c.notFound();
  const expected = c.env.WEB_BASIC_AUTH;
  if (expected && c.req.header('Authorization') !== `Basic ${btoa(expected)}`) {
    return new Response('authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="aitapp", charset="UTF-8"' },
    });
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---- エラーハンドラ ----
// client には固定の汎用メッセージ + correlationId のみ返し、上流本文・例外文字列・
// 内部パーサ/クラス名は透過させない。詳細は構造化ログ（error レベル）にのみ出す。
app.onError((err, c) => {
  // 依存ライブラリが意図して返す応答（HTTPException の res）はそのまま返す。500 に潰さない。
  // 例: @hono/mcp は、未対応の mcp-protocol-version を受けると JSON-RPC エラー入りの 4xx を投げ、
  // クライアントはそれを見て対応バージョンへ切り替える。ここで 500 にすると切り替えが起きず、
  // コネクタの接続が断続的に失敗する（SDK が最新の 2026-07-28 に未対応の間に発生した）。
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  const path = new URL(c.req.url).pathname;
  const correlationId = c.get('correlationId') ?? 'unknown';
  // handler が throw すると cors ミドルウェアは応答ヘッダを設定できないため、
  // /api のエラー応答にはここで CORS ヘッダを付ける（付けないとブラウザが本文を
  // 読めず、フロントでは一律「通信エラー」になり correlationId も見えない）。
  if (path.startsWith('/api/')) {
    const reqOrigin = c.req.header('Origin');
    if (reqOrigin && allowedOrigins(c.env).includes(reqOrigin)) {
      c.header('Access-Control-Allow-Origin', reqOrigin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
  }
  const upstreamService = classifyUpstreamService(path, err.message);
  // 診断用の詳細はサーバーログにのみ残す（client には返さない）。
  log('error', correlationId, 'request failed', {
    method: c.req.method,
    path: redactPath(path),
    upstreamService,
    errorName: err.name,
    detail: err.message,
    stack: err.stack,
  });
  // 既知の型付きエラーは stable な code / status を維持しつつ、メッセージは汎用化する。
  // LCAM の再登録要求は Web の「401 → /login 誘導」やクライアントの「401 → 再ログイン」を
  // 起動させないよう 424 で返す（アプリのセッションは有効で、LCAM 上流だけが要再登録）。
  if (err instanceof LcamReauthRequiredError) {
    return c.json(
      {
        error: 'reauth_required',
        target: 'lcam',
        reason: err.reason,
        message: LCAM_REAUTH_MESSAGE[err.reason],
        correlationId,
      },
      424,
    );
  }
  if (err instanceof AuthFailedError) {
    return c.json({ error: 'reauth_required', message: '再ログインが必要です', correlationId }, 401);
  }
  // Moodle token の再取得リトライでも回復できなかった場合（AuthFailedError と同様に
  // 再認証が必要な状態）。taxonomy を揃えるため reauth_required(401) に集約する。
  if (err instanceof MoodleTokenError) {
    return c.json({ error: 'reauth_required', message: '再ログインが必要です', correlationId }, 401);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: 'not_found', message: '対象が見つかりません', correlationId }, 404);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: 'リクエストが不正です', correlationId }, 400);
  }
  // クイズ採点結果のレビュー非公開（教員のレビュー設定による）。障害ではなく
  // 「まだ/そもそも公開されていない」状態なので、汎用の上流エラーと区別して返す。
  // Moodle は mod_quiz_get_attempt_review で review が許可されていないとき
  // errorcode "noreview" 系の exception を返す。
  if (err instanceof UpstreamError && err.upstreamCode?.startsWith('noreview')) {
    return c.json(
      {
        error: 'review_not_available',
        message:
          '採点結果は公開されていません。クイズのレビュー設定によっては、受験直後や成績公開前は結果を取得できません（提出自体は成立しています）。',
        correlationId,
      },
      409,
    );
  }
  if (err instanceof UpstreamError) {
    return c.json({ error: 'upstream_error', message: '上流エラー', correlationId }, 502);
  }
  return c.json({ error: 'internal_error', message: '内部エラー', correlationId }, 500);
});

export default app;
