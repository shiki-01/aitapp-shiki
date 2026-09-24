// LCAM への生 HTTP アクセス。移植元: access_lcan.dart。
// Cookie / Origin / Referer / Sec-Fetch-* はすべてここ（Worker fetch）で付与する。
// URL・body フィールドは Dart 実装由来（推測補完なし）。

import { LcamExpiredError, UpstreamError } from '../errors';
import { isSsoRedirect } from './detect';
import { fetchUpstream, UPSTREAM_FILE_TIMEOUT_MS } from '../fetch';
import type { Env, LcamCookies } from '../../types';

export const LCAM_ORIGIN = 'lcam.aitech.ac.jp';
const BASE = `https://${LCAM_ORIGIN}`;

/**
 * LCAM 中継 relay の設定。deployment 定数（全リクエスト共通）のためモジュール変数に
 * 一度だけ注入する。値がリクエスト間で不変なので isolate 再利用でも state 汚染は起きない。
 * リクエスト入口の共通ミドルウェアで configureLcamRelay(env) を呼ぶこと。
 */
let relay: { url: string; token: string } | undefined;

export function configureLcamRelay(env: Env): void {
  relay =
    env.LCAM_RELAY_URL && env.LCAM_RELAY_TOKEN
      ? { url: env.LCAM_RELAY_URL, token: env.LCAM_RELAY_TOKEN }
      : undefined;
}

/**
 * LCAM 専用 fetch。relay が設定されていれば、宛先 URL を X-Aitapp-Target ヘッダに載せて
 * relay へ回す（LCAM の WAF が Cloudflare IP を拒否するため。MIGRATION_NOTES §13）。
 * 未設定なら従来どおり LCAM へ直接 fetch。Cookie/Origin/Sec-Fetch-* 等の全ヘッダと body は
 * relay がそのまま LCAM へ素通しする前提。
 */
function lcamFetch(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (!relay) return fetchUpstream(url, init, timeoutMs);
  return fetchUpstream(
    relay.url,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        'X-Aitapp-Target': url,
        Authorization: `Bearer ${relay.token}`,
      },
    },
    timeoutMs,
  );
}

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

/** Cookie ヘッダ値（Dart Cookies.toString() 相当: `JSESSIONID; LiveApps-Cookie`＋任意の追加 Cookie）。 */
export function cookieHeader(c: LcamCookies): string {
  return [c.jsessionid, c.liveApps, ...(c.extra ?? [])].filter(Boolean).join('; ');
}

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

/** 同一オリジン内リダイレクトの追従上限。 */
const MAX_REDIRECTS = 3;

/**
 * 3xx の Location を解決する。SSO（mellon / Entra）への誘導ならセッション失効として
 * LcamExpiredError、LCAM 以外のホストへは追従せず UpstreamError（Cookie を他ホストへ送らない）。
 * 戻り値は追従先の絶対 URL。
 */
export function resolveRedirect(location: string, from: string): string {
  if (isSsoRedirect(location)) {
    throw new LcamExpiredError('LCAM redirected to SSO login');
  }
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new UpstreamError('LCAM redirect: invalid Location');
  }
  if (next.protocol !== 'https:' || next.hostname !== LCAM_ORIGIN) {
    throw new UpstreamError(`LCAM redirect to unexpected host: ${next.hostname}`);
  }
  return next.toString();
}

/**
 * Dart httpAccess 相当。200 以外は例外。
 * リダイレクトは自前で追従する（redirect: 'manual'）。自動追従だと、SSO 誘導が
 * Entra（別オリジン）まで辿られ、Cookie ヘッダが他ホストへ送られ得るため。
 * SSO への 303 は要件 §8 の「リダイレクト先での失効判定」として LcamExpiredError にする。
 */
async function httpAccess(
  url: string,
  headers: Record<string, string>,
  body?: Record<string, string>,
): Promise<Response> {
  let target = url;
  let method = body ? 'POST' : 'GET';
  let payload = body ? formBody(body) : undefined;
  let hdrs = { ...headers };
  for (let hop = 0; ; hop++) {
    const res = await lcamFetch(target, {
      method,
      headers: hdrs,
      body: payload,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      await res.body?.cancel();
      target = resolveRedirect(location, target);
      if (hop >= MAX_REDIRECTS) {
        throw new UpstreamError('LCAM http error: too many redirects');
      }
      if (res.status !== 307 && res.status !== 308) {
        // 301/302/303 は GET に切り替える（fetch の自動追従と同じ扱い）。
        method = 'GET';
        payload = undefined;
        const { 'Content-Type': _ct, ...rest } = hdrs;
        hdrs = rest;
      }
      continue;
    }
    if (res.status !== 200) {
      throw new UpstreamError(`LCAM http error: statusCode=${res.status}`);
    }
    return res;
  }
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

// ---- 成績情報 ----

/**
 * GET smartPhonePerformanceInfor/nextPage/performance/。
 * デフォルト表示（卒業進級用１年タブ・未修得科目を含めて表示）のみ取得する。
 * 学年タブ切替（requirementTypeCode）は POST 遷移で別途 token が要るため対象外
 * （実データで複数学年の差異を確認できておらず、過剰実装を避ける。要確認）。
 */
export async function getPerformanceBody(cookies: LcamCookies): Promise<string> {
  const headers = {
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhonePerformanceInfor/nextPage/performance/`,
    headers,
  );
  return res.text();
}

// ---- アンケート一覧 ----

export type EnqueteType = 'class' | 'evaluation' | 'campus';

/** 実機観測した nextPage 名（const.dart webAccessLinks 由来）。 */
const ENQUETE_PATH: Record<EnqueteType, string> = {
  class: 'classEnquete',
  evaluation: 'courseEvaluation',
  campus: 'enqueteContact',
};

/**
 * GET smartPhoneContactNotice/nextPage/{classEnquete|courseEvaluation|enqueteContact}/。
 * デフォルト検索条件（当該画面の初期表示）の一覧をそのまま取得する。
 * 回答送信フローは実装しない（書き込み系のため対象外）。
 */
export async function getEnqueteBody(
  cookies: LcamCookies,
  type: EnqueteType,
): Promise<string> {
  const headers = {
    Cookie: cookieHeader(cookies),
    Referer: `${BASE}/portalv2/smartphone/smartPhoneHome/nextPage/contactNotice`,
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneContactNotice/nextPage/${ENQUETE_PATH[type]}/`,
    headers,
  );
  return res.text();
}

// ---- 授業アンケート回答（読み取りは実機検証済み。書き込みは未検証） ----

/** POST goDetail/{index} → アンケート詳細参照（タイトル・期間・設問数等）。 */
export async function getEnqueteDetailBody(
  cookies: LcamCookies,
  token: string,
  index: number,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhoneContactNotice/nextPage/classEnquete/`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    _screenIdentifier: 'smartPhoneClassEnqList',
    _scrollTop: '0',
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneClassEnqList/goDetail/${index}`,
    headers,
    data,
  );
  return res.text();
}

/**
 * GET smartPhoneClassEnqAnswer/initialize → 設問と回答欄。
 * サーバー側セッションが「goDetail で選択中のアンケート」を保持しているため、
 * 必ず getEnqueteDetailBody の直後に呼び出す必要がある（ID をパラメータで渡せない）。
 */
export async function getEnqueteAnswerFormBody(cookies: LcamCookies): Promise<string> {
  const headers = {
    Cookie: cookieHeader(cookies),
    Referer: `${BASE}/portalv2/smartphone/smartPhoneClassEnqDetail/`,
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/initialize`,
    headers,
  );
  return res.text();
}

/**
 * POST smartPhoneClassEnqAnswer/tempSaveAction（一時保存）。
 * ユーザー許可のもと実データで検証済み（value1〜3 が保存されサーバー側に反映されることを
 * goDetail→answer/initialize の再取得で確認した。MIGRATION_NOTES §11 参照）。
 * 「確認」(confirmAction) を経た最終提出フローは未解明のため実装していない（一時保存止まり）。
 */
export async function postEnqueteTempSave(
  cookies: LcamCookies,
  token: string,
  classEnqId: string,
  answers: Record<string, string>,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/initialize`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data: Record<string, string> = {
    'org.apache.struts.taglib.html.TOKEN': token,
    classEnqId,
    questionNumber: '',
    selectedKey: '',
    backPath: '',
    ...answers,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/tempSaveAction`,
    headers,
    data,
  );
  return res.text();
}

/**
 * POST smartPhoneClassEnqAnswer/confirmAction（確認画面表示。まだ確定しない）。
 * ユーザーから提供された実データ（「登録確認」画面の実 HTML）により、
 * このリクエストが `classenq_student_answerConfirmActionForm`
 * （classEnqId・questionNumber・backPath・TOKEN を持つ）を含む確認画面を返すことを確認済み。
 */
export async function postEnqueteConfirm(
  cookies: LcamCookies,
  token: string,
  classEnqId: string,
  answers: Record<string, string>,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/initialize`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data: Record<string, string> = {
    'org.apache.struts.taglib.html.TOKEN': token,
    classEnqId,
    questionNumber: '',
    selectedKey: '',
    backPath: '',
    ...answers,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/confirmAction`,
    headers,
    data,
  );
  return res.text();
}

/**
 * POST smartPhoneClassEnqAnswerConfirm/confirmAction（最終登録＝実際の提出）。
 * 確認画面自身のフォーム（`smartphone_smartPhoneClassEnqAnswerConfirmActionForm`）が持つ
 * token/classEnqId/questionNumber/backPath をそのまま送信する（回答値の再送は不要。
 * 確認画面は一時保存済みの値を読み取り表示しているだけで、フォーム自体に
 * value{i} の入力欄は無い）。
 * 実機観測: 当初ユーザーから提供された「登録確認」画面 HTML は
 * `classenq_student_answerConfirmActionForm`（PC 版の画面遷移）だったが、
 * SP 版フロー（本実装が使う list→goDetail→answer/initialize→confirmAction の経路）で
 * 実際に返る確認画面のフォーム名は `smartphone_smartPhoneClassEnqAnswerConfirmActionForm`、
 * 遷移先は `smartPhoneClassEnqAnswerConfirm/confirmAction` だった（実機再現で確認・修正）。
 */
export async function postEnqueteFinalize(
  cookies: LcamCookies,
  token: string,
  classEnqId: string,
  backPath: string,
): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswer/confirmAction`,
    Cookie: cookieHeader(cookies),
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data = {
    'org.apache.struts.taglib.html.TOKEN': token,
    classEnqId,
    questionNumber: '',
    backPath,
  };
  const res = await httpAccess(
    `${BASE}/portalv2/smartphone/smartPhoneClassEnqAnswerConfirm/confirmAction`,
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
  // ファイルは stream proxy するため、body 読み切りまで時間がかかり得る。タイムアウトを延長。
  // リダイレクトは追従しない（SSO 誘導＝失効を検知するため。Cookie を他ホストへ送らない）。
  const res = await lcamFetch(
    `${BASE}${fileUrl}`,
    { headers, redirect: 'manual' },
    UPSTREAM_FILE_TIMEOUT_MS,
  );
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '';
    await res.body?.cancel();
    resolveRedirect(location, `${BASE}${fileUrl}`); // SSO なら LcamExpiredError を投げる
    throw new UpstreamError(`LCAM file redirect: statusCode=${res.status}`);
  }
  return res;
}
