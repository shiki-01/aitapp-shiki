// 本家アプリ方式（MIGRATION_NOTES §15）のログインを実測するローカル用スクリプト。
//
//   export LCAM_PROBE_DIR=<repo 外の作業ディレクトリ>          # 状態ファイルの置き場（cred.json / session.json）
//   read -s LCAM_APP_KEY; export LCAM_APP_KEY                  # lamyapp://lcam?key=… の URL 丸ごと、または key の値（画面には出ない）
//   bun run scripts/lcam-app-login-probe.ts exchange           # key → userId/password を取得して保存
//   bun run scripts/lcam-app-login-probe.ts login              # 保存値で smartPhoneLogin → SP 時間割で確認
//   bun run scripts/lcam-app-login-probe.ts check              # 保存したセッションで SP 時間割を 1 回確認
//
// 出力は状態（status・Cookie 名・OK/NG）のみ。Cookie・userId・password・key の値は出力しない。
// 状態ファイルは資格情報と同等なので repo 内に置かないこと。SP 時間割への GET 以外は行わない。
//
// 【禁止】PC 画面（common/generalPurpose/ 等）へ GET で直接アクセスしないこと（MIGRATION_NOTES §14.4）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeSpSession } from '../src/upstream/lcam/client';
import { LcamExpiredError } from '../src/upstream/errors';
import type { LcamCookies } from '../src/types';

const BASE = 'https://lcam.aitech.ac.jp';
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const dir = process.env.LCAM_PROBE_DIR;
if (!dir) fail('LCAM_PROBE_DIR が未設定です。');
mkdirSync(dir, { recursive: true });
const credFile = join(dir, 'cred.json');
const sessionFile = join(dir, 'session.json');

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Set-Cookie 群から name=value の組だけを取り出す（属性は捨てる）。 */
function pairsFrom(res: Response): Map<string, string> {
  const m = new Map<string, string>();
  for (const sc of res.headers.getSetCookie()) {
    const first = sc.split(';')[0]!;
    const i = first.indexOf('=');
    if (i > 0) m.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return m;
}

function cookieString(m: Map<string, string>): string {
  return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function post(path: string, body: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Accept-Language': 'ja',
      Accept: '*/*',
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie, Origin: BASE, Referer: `${BASE}/portalv2/sp` } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

function jsonOrNull(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function exchange(): Promise<void> {
  const raw = process.env.LCAM_APP_KEY?.trim();
  if (!raw) fail('LCAM_APP_KEY が未設定です。');
  // `lamyapp://lcam?key=…` の URL 丸ごとでも、key の値だけでも受け付ける（アプリと同様 searchParams で復号）。
  const key = raw.startsWith('lamyapp://') ? new URL(raw).searchParams.get('key') : raw;
  if (!key) fail('URL から key を取り出せませんでした。');
  const res = await post('/portalv2/login/login/spAppLogin/', { userId: key, password: '' });
  const text = await res.text();
  const j = jsonOrNull(text);
  console.log(`HTTP ${res.status} / JSON: ${j ? 'yes' : 'no'} / body ${text.length} bytes`);
  if (!j) return;
  console.log(`status=${String(j.status)} keys=[${Object.keys(j).join(',')}]`);
  if (j.status !== 'success') return;
  const userId = String(j.userId ?? '');
  const password = String(j.password ?? '');
  console.log(`userId 長さ=${userId.length} / password 長さ=${password.length} / role=${String(j.role)}`);
  if (!userId || !password) fail('userId または password が空です。保存しません。');
  writeFileSync(credFile, JSON.stringify({ userId, password }), { mode: 0o600 });
  console.log(`保存: ${credFile}`);
}

async function probe(label: string, cookies: LcamCookies): Promise<boolean> {
  try {
    await probeSpSession(cookies);
    console.log(`OK    ${label}`);
    return true;
  } catch (e) {
    const why = e instanceof LcamExpiredError ? `拒否（${e.message}）` : `エラー（${(e as Error).message}）`;
    console.log(`NG    ${label}: ${why}`);
    return false;
  }
}

function toCookies(m: Map<string, string>, jsessionid: string): LcamCookies {
  const live = m.get('LiveApps-Cookie');
  return {
    jsessionid: `JSESSIONID=${jsessionid}`,
    liveApps: live ? `LiveApps-Cookie=${live}` : '',
    extra: ['L-CamApp=Y'],
  };
}

async function login(): Promise<void> {
  const cred = JSON.parse(readFileSync(credFile, 'utf8')) as { userId: string; password: string };

  // アプリの authCookies と同じ順序: GET /portalv2/sp → POST smartPhoneLogin/（Cookie は cookie jar 相当）。
  const sp = await fetch(`${BASE}/portalv2/sp`, {
    redirect: 'manual',
    headers: { 'Accept-Language': 'ja', Accept: '*/*', 'User-Agent': UA },
  });
  await sp.arrayBuffer();
  const before = pairsFrom(sp);
  console.log(`GET /portalv2/sp: HTTP ${sp.status} / Set-Cookie=[${[...before.keys()].join(',')}]`);
  const jsBefore = before.get('JSESSIONID');
  if (!jsBefore) fail('JSESSIONID が発行されませんでした。');

  const res = await post(
    '/portalv2/login/login/smartPhoneLogin/',
    {
      userID: cred.userId,
      password: cred.password,
      selectLocale: 'ja',
      mode: 'sp',
      userDivision: '2',
      spAppFlag: '1',
      spFlg: '1',
      locale: 'ja',
      lCamApp: 'Y',
      clientLocationUrl: `${BASE}/`,
    },
    `${cookieString(before)}; L-CamApp=Y`,
  );
  const text = await res.text();
  const j = jsonOrNull(text);
  const after = pairsFrom(res);
  console.log(
    `POST smartPhoneLogin/: HTTP ${res.status} / JSON: ${j ? `status=${String(j.status)}` : 'no'} / body ${text.length} bytes / Set-Cookie=[${[...after.keys()].join(',')}]`,
  );

  // アプリは POST 前の JSESSIONID を使う。POST で rotate された場合に備え、両方を試す。
  const merged = new Map([...before, ...after]);
  const candidates: Array<[string, string]> = [['POST 前の JSESSIONID', jsBefore]];
  const jsAfter = after.get('JSESSIONID');
  if (jsAfter && jsAfter !== jsBefore) candidates.push(['POST 後（rotate）の JSESSIONID', jsAfter]);

  for (const [label, js] of candidates) {
    const cookies = toCookies(merged, js);
    if (await probe(`SP 時間割（${label} + L-CamApp=Y）`, cookies)) {
      writeFileSync(sessionFile, JSON.stringify(cookies), { mode: 0o600 });
      console.log(`保存: ${sessionFile}（${label}）`);
      return;
    }
  }
}

async function check(): Promise<void> {
  const cookies = JSON.parse(readFileSync(sessionFile, 'utf8')) as LcamCookies;
  await probe('保存済みセッションで SP 時間割', cookies);
}

const mode = process.argv[2];
if (mode === 'exchange') await exchange();
else if (mode === 'login') await login();
else if (mode === 'check') await check();
else fail('使い方: exchange | login | check');
