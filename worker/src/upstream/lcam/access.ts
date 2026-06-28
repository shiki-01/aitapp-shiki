// LCAM への生 HTTP アクセス。移植元: access_lcan.dart。
// Cookie / Origin / Referer / Sec-Fetch-* はすべてここ（Worker fetch）で付与する。
// URL・body フィールドは Dart 実装由来（推測補完なし）。

import { UpstreamError } from '../errors';
import type { LcamCookies } from '../../types';

export const LCAM_ORIGIN = 'lcam.aitech.ac.jp';
const BASE = `https://${LCAM_ORIGIN}`;

// SP（スマホ）系エンドポイントはモバイル UA を前提とするため必須。
// Workers の fetch は既定で UA を送らないので Worker 側で付与する。
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const constHeader: Record<string, string> = {
  'Accept-Language': 'ja',
  Accept: '*/*',
  'User-Agent': USER_AGENT,
};
const secFetchHeader: Record<string, string> = {
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
};
const contentTypeHeader: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

/** Cookie ヘッダ値（Dart Cookies.toString() 相当: `JSESSIONID; LiveApps-Cookie`）。 */
export function cookieHeader(c: LcamCookies): string {
  return `${c.jsessionid}; ${c.liveApps}`;
}

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

/** Dart httpAccess 相当。200 以外は例外。 */
async function httpAccess(
  url: string,
  headers: Record<string, string>,
  body?: Record<string, string>,
): Promise<Response> {
  // Dart の http パッケージはリダイレクトを自動追従し、失効時はログイン HTML(200)
  // を受け取って DOM 判定する。これに合わせ追従させる（要件 §8: status 非依存）。
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers },
    body: body ? formBody(body) : undefined,
  });
  if (res.status !== 200) {
    throw new UpstreamError(`LCAM http error: statusCode=${res.status}`);
  }
  return res;
}

/**
 * set-cookie 群から JSESSIONID と LiveApps-Cookie を名前一致で取り出す。
 * Dart は位置依存 split をしていたが、Workers の getSetCookie() で配列取得し
 * 名前一致で拾う（堅牢化、挙動同等）。MIGRATION_NOTES §3.1。
 */
export function extractCookies(res: Response): LcamCookies {
  const list =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  let jsessionid = '';
  let liveApps = '';
  for (const sc of list) {
    const first = sc.split(';')[0]; // name=value
    const lower = first.toLowerCase();
    if (lower.startsWith('jsessionid=')) jsessionid = first;
    else if (lower.startsWith('liveapps-cookie=')) liveApps = first;
  }
  return { jsessionid, liveApps };
}

// ---- ログイン（SP 経路） ----

/** GET /portalv2/sp → set-cookie から初期 Cookie 取得。 */
export async function getCookie(): Promise<LcamCookies> {
  const res = await httpAccess(`${BASE}/portalv2/sp`, {
    ...constHeader,
    ...secFetchHeader,
  });
  return extractCookies(res);
}

/**
 * POST /portalv2/login/login/smartPhoneLogin。
 * 返却 HTML と、ログイン後の Cookie（セッション ID が再生成された場合は新しい値で
 * 上書きしたもの）を返す。Java 系はログイン時に session を rotate することがある。
 */
export async function loginLcam(
  id: string,
  password: string,
  cookies: LcamCookies,
): Promise<{ body: string; cookies: LcamCookies }> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/sp`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    userID: id,
    password,
    selectLocale: 'ja',
    mode: 'sp',
    userDivision: '2',
    spFlg: '1',
    locale: 'ja',
    spAppFlag: '1',
    clientLocationUrl: `${BASE}/`,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/login/login/smartPhoneLogin`,
    headers,
    data,
  );
  const set = extractCookies(res);
  const merged: LcamCookies = {
    jsessionid: set.jsessionid || cookies.jsessionid,
    liveApps: set.liveApps || cookies.liveApps,
  };
  return { body: await res.text(), cookies: merged };
}

/** POST /portalv2/login/login/spAppLogin/ → JSON status で認証情報を検証。 */
export async function canLoginLcam(
  id: string,
  password: string,
): Promise<boolean> {
  const headers = {
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  // Dart 原文どおりフィールド名は userId（smartPhoneLogin の userID とは別）。
  const data = { userId: id, password };
  const res = await httpAccess(
    `${BASE}/portalv2/login/login/spAppLogin/`,
    headers,
    data,
  );
  const json = (await res.json()) as { status?: string };
  return json.status === 'success';
}

// ---- 連絡（notices） ----

/** GET nextPage/{commonContact|classContact} → token 抽出用 HTML。 */
export async function getStrutsTokenBody(
  cookies: LcamCookies,
  isCommon: boolean,
): Promise<string> {
  const contactType = isCommon ? 'commonContact' : 'classContact';
  const headers = {
    Cookie: cookieHeader(cookies),
    Referer: `${BASE}/portalv2/smartphone/smartPhoneHome/nextPage/contactNotice`,
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneContactNotice/nextPage/${contactType}`,
    headers,
  );
  return res.text();
}

/** POST select{Type}ContactList（listPageNo=1）。 */
export async function getNoticeBody(
  cookies: LcamCookies,
  token: string,
  isCommon: boolean,
): Promise<string> {
  const type = isCommon ? 'Common' : 'Class';
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhoneContactNotice/nextPage/${type.toLowerCase()}Contact`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    unReadFlg: '1',
    listPageNo: '1',
    _screenIdentifier: `smartPhone${type}ContactList`,
    _scrollTop: '0',
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhone${type}Contact/select${type}ContactList`,
    headers,
    data,
  );
  return res.text();
}

/** POST nextSelect{Type}ContactList（listPageNo=page）。一覧パース対象。 */
/**
 * listPageNo は累積表示件数（先頭から何件返すか）であり、ページ番号ではない。
 * 移植元 (load_noticelist_usecase.dart) は 10,20,30… と増やして全件を取り直す。
 */
export async function getNoticeBodyNext(
  cookies: LcamCookies,
  token: string,
  count: number,
  isCommon: boolean,
): Promise<string> {
  const type = isCommon ? 'Common' : 'Class';
  const headers = {
    // Dart 原文の 'https://origin'（$欠落バグ）を修正して正しいオリジンを送る。
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhone${type}Contact/select${type}ContactList`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    unReadFlg: '1',
    listPageNo: String(count),
    _screenIdentifier: `smartPhone${type}ContactList`,
    _scrollTop: '0',
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhone${type}Contact/nextSelect${type}ContactList`,
    headers,
    data,
  );
  return res.text();
}

/** POST goDetail/{index} → 詳細 HTML。 */
export async function getNoticeDetailBody(
  index: number,
  cookies: LcamCookies,
  token: string,
  isCommon: boolean,
): Promise<string> {
  const type = isCommon ? 'Common' : 'Class';
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhone${type}Contact/nextSelect${type}ContactList`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    _screenIdentifier: `smartPhone${type}ContactList`,
    _scrollTop: '0',
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhone${type}Contact/goDetail/${index}`,
    headers,
    data,
  );
  return res.text();
}

// ---- 時間割（SP） ----

/** GET smartPhoneHome/nextPage/timeTable。 */
export async function getClassTimeTableBody(
  cookies: LcamCookies,
): Promise<string> {
  const headers = {
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneHome/nextPage/timeTable`,
    headers,
  );
  return res.text();
}

// ---- ファイル ----

/** GET {fileUrl}（cookies のみ）。Response をそのまま返す（stream 用）。 */
export async function getFile(
  cookies: LcamCookies,
  fileUrl: string,
): Promise<Response> {
  const headers = {
    Cookie: cookieHeader(cookies),
    ...constHeader,
  };
  return fetch(`${BASE}${fileUrl}`, { headers });
}

// ---- スケジュール（PC 経路） ----

/** GET /portalv2/ → set-cookie から初期 Cookie。 */
export async function pcGetCookie(): Promise<LcamCookies> {
  const res = await httpAccess(`${BASE}/portalv2/`, {
    ...constHeader,
    ...secFetchHeader,
  });
  return extractCookies(res);
}

/** POST preLogin → 新 JSESSIONID（set-cookie）。返り値は JSESSIONID 行。 */
export async function preAccess(cookies: LcamCookies): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = { mistakeChecker: '0', clientLocationUrl: `${BASE}/` };
  const res = await httpAccess(
    `${BASE}/portalv2/login/preLogin/preLogin`,
    headers,
    data,
  );
  const extracted = extractCookies(res);
  return extracted.jsessionid;
}

/** POST initLogin（PC ログイン）→ 返却 HTML（token 抽出用）。 */
export async function initLogin(
  id: string,
  password: string,
  cookies: LcamCookies,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    userID: id,
    password,
    selectLocale: 'ja',
    authenticMethod: '1',
    mistakeChecker: '0',
    EXCLUDE_SET: '',
  };
  const res = await httpAccess(
    `${BASE}/portalv2/login/login/initLogin`,
    headers,
    data,
  );
  return res.text();
}

/** POST home/home/reload → スケジュール HTML。 */
export async function reload(
  cookies: LcamCookies,
  token: string,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    _screenIdentifier: 'home',
    _screenInfoDisp: '',
    _scrollTop: '148',
  };
  const res = await httpAccess(`${BASE}/portalv2/home/home/reload`, headers, data);
  return res.text();
}

/** POST scheduleForHome/getSchedule → 次週送り。 */
export async function getScheduleNext(cookies: LcamCookies): Promise<string> {
  const headers = {
    Origin: BASE,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = { _mode: '5', EXCLUDE_SET: '' };
  const res = await httpAccess(
    `${BASE}/portalv2/schedule/scheduleForHome/getSchedule`,
    headers,
    data,
  );
  return res.text();
}
