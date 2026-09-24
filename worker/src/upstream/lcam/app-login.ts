// LCAM アプリ用ログイン（本家アプリと同じ方式）。
// 初回のみ key を交換して userId/password を得、以後はこの資格情報で
// 再ログイン可能（MFA 不要）。参照実装: scripts/lcam-app-login-probe.ts。

import type { LcamAppCredential, LcamCookies } from '../../types';
import {
  LcamAppKeyRejectedError,
  LcamAppCredentialRejectedError,
  LcamExpiredError,
  UpstreamError,
} from '../errors';
import { probeSpSession } from './client';
import { lcamFetch, USER_AGENT } from './access';

const BASE = 'https://lcam.aitech.ac.jp';

/** key の入力値から key 部分を抽出・検証する（lamyapp://lcam?key=... または key の値のみ）。 */
export function parseAppKey(input: string): string | null {
  if (!input || input.length > 2048) return null;
  const trimmed = input.trim();

  // lamyapp://lcam?key=... の形式か判定。
  if (trimmed.startsWith('lamyapp://')) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'lamyapp:' || url.hostname !== 'lcam') return null;
      const key = url.searchParams.get('key');
      return key && key.length > 0 && key.length <= 512 ? key : null;
    } catch {
      return null;
    }
  }

  // key の値だけかどうか：空白を含まない印字可能 ASCII、1～512 文字。
  if (/^[\x21-\x7e]{1,512}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/** key を spAppLogin エンドポイントへ送り、userId/password を得る。 */
export async function exchangeAppKey(key: string): Promise<LcamAppCredential> {
  const headers = {
    'Accept-Language': 'ja',
    Accept: '*/*',
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams({ userId: key, password: '' }).toString();

  const res = await lcamFetch(`${BASE}/portalv2/login/login/spAppLogin/`, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
  });

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON ではない応答（HTML など）。
  }

  if (!json || typeof json !== 'object') {
    throw new LcamAppKeyRejectedError('key 交換が失敗しました（非 JSON 応答）。');
  }

  const status = String(json.status ?? '');
  if (status === 'stop_login') {
    throw new UpstreamError('LCAM login is temporarily restricted');
  }
  if (status !== 'success') {
    throw new LcamAppKeyRejectedError('key が無効か期限切れです。');
  }

  const userId = String(json.userId ?? '').trim();
  const password = String(json.password ?? '').trim();
  if (!userId || !password) {
    throw new LcamAppKeyRejectedError('key 交換で userId/password が返りませんでした。');
  }

  return { userId, password };
}

/**
 * 保存されたアプリ用資格情報でログインし、Cookie を取得する。
 * 手順 (1) GET /portalv2/sp → (2) POST /portalv2/login/login/smartPhoneLogin/ で Cookie 取得。
 */
export async function appLogin(cred: LcamAppCredential): Promise<LcamCookies> {
  // (1) GET /portalv2/sp で JSESSIONID・LiveApps-Cookie 初期化。
  const spRes = await lcamFetch(`${BASE}/portalv2/sp`, {
    method: 'GET',
    headers: {
      'Accept-Language': 'ja',
      Accept: '*/*',
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  });
  await spRes.arrayBuffer(); // body 消費。

  // Set-Cookie から JSESSIONID と LiveApps-Cookie を抽出。
  const setCookies = spRes.headers.getSetCookie() || [];
  const cookieMap = new Map<string, string>();
  for (const sc of setCookies) {
    const first = sc.split(';')[0]!;
    const eq = first.indexOf('=');
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      cookieMap.set(name, value);
    }
  }

  const jsessionid = cookieMap.get('JSESSIONID');
  if (!jsessionid) {
    throw new LcamAppCredentialRejectedError('JSESSIONID を取得できませんでした。');
  }

  // (2) POST /portalv2/login/login/smartPhoneLogin/ で ログイン。
  const cookieHeaderVal = [
    `JSESSIONID=${jsessionid}`,
    cookieMap.get('LiveApps-Cookie') ? `LiveApps-Cookie=${cookieMap.get('LiveApps-Cookie')}` : '',
    'L-CamApp=Y',
  ]
    .filter(Boolean)
    .join('; ');

  const loginRes = await lcamFetch(`${BASE}/portalv2/login/login/smartPhoneLogin/`, {
    method: 'POST',
    headers: {
      'Accept-Language': 'ja',
      Accept: '*/*',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeaderVal,
      Origin: BASE,
      Referer: `${BASE}/portalv2/sp`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    },
    body: new URLSearchParams({
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
    }).toString(),
    redirect: 'manual',
  });

  const loginText = await loginRes.text();
  let loginJson: Record<string, unknown> | null = null;
  try {
    loginJson = JSON.parse(loginText);
  } catch {
    // HTML 応答が期待される。JSON ならエラー。
  }

  // JSON レスポンスの場合、status を確認。
  if (loginJson && typeof loginJson === 'object') {
    const status = String(loginJson.status ?? '');
    if (status === 'stop_login') {
      throw new UpstreamError('LCAM login is temporarily restricted');
    }
    if (status === 'fail') {
      throw new LcamAppCredentialRejectedError('ログインが拒否されました。資格情報が無効です。');
    }
  }

  // Cookie オブジェクト構築（JSESSIONID は GET /portalv2/sp で得たもの）。
  const liveApps = cookieMap.get('LiveApps-Cookie');
  const cookies: LcamCookies = {
    jsessionid: `JSESSIONID=${jsessionid}`,
    liveApps: liveApps ? `LiveApps-Cookie=${liveApps}` : '',
    extra: ['L-CamApp=Y'],
  };

  // 有効性確認（probeSpSession で失効判定）。
  try {
    await probeSpSession(cookies);
  } catch (e) {
    if (e instanceof LcamExpiredError) {
      throw new LcamAppCredentialRejectedError('ログイン後に SP セッション確認で失効を検知しました。');
    }
    throw e;
  }

  return cookies;
}
