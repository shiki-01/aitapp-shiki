// LCAM の高レベル操作。move元: get_lcam_data.dart のフロー。
// 各 op は失効を検知したら LcamExpiredError を投げ、relogin ラッパに委ねる。

import type { LcamCookies, Credential } from '../../types';
import { parseHtml } from '../../html/parser';
import { extractStrutsToken } from './csrf';
import { looksLikeLoginPage } from './detect';
import { LcamExpiredError, UpstreamError } from '../errors';
import {
  getStrutsTokenBody,
  getNoticeBody,
  getNoticeBodyNext,
  getNoticeDetailBody,
  getClassTimeTableBody,
  getFile,
  pcGetCookie,
  preAccess,
  initLogin,
  reload,
  getScheduleNext,
} from './access';
import {
  parseUnivNotice,
  parseClassNotice,
  parseUnivNoticeDetail,
  parseClassNoticeDetail,
  parseClassTimeTable,
  parseSchedule,
  type UnivNotice,
  type ClassNotice,
  type NoticeDetail,
  type TimetableEntry,
  type ScheduleDay,
} from './parse';

/** ログインページ（失効）なら LcamExpiredError を投げる。 */
function assertNotExpired(html: string): void {
  if (looksLikeLoginPage(html)) throw new LcamExpiredError();
}

/**
 * HTML から token を抽出。認証済みの SP ページには必ず Struts token フィールドが
 * 存在するため、無い場合はセッション喪失（PC ログイン等で無効化されたケース含む）
 * とみなして LcamExpiredError を投げ、透過再ログインに繋げる。
 */
function tokenOrThrow(html: string): string {
  const t = extractStrutsToken(parseHtml(html));
  if (t != null) return t;
  throw new LcamExpiredError();
}

/** 認証済み SP ページは必ず Struts token フィールドを含む。無ければ session 喪失。 */
function assertSpSessionAlive(html: string): void {
  if (!html.includes('org.apache.struts.taglib.html.TOKEN')) {
    throw new LcamExpiredError();
  }
}

/**
 * 連絡一覧（common/class）。count は累積表示件数（上流 listPageNo）。
 * 上流は先頭から count 件をまとめて返し、index は全件通しの 0..N-1。
 * 移植元 (load_noticelist_usecase.dart) は 10,20,30… と件数を増やして毎回全件を
 * 取り直す方式のため、ページ番号方式にはしない。
 */
export async function fetchNotices(
  cookies: LcamCookies,
  isCommon: boolean,
  count: number,
): Promise<UnivNotice[] | ClassNotice[]> {
  const tokenBody = await getStrutsTokenBody(cookies, isCommon);
  assertNotExpired(tokenBody);
  const tempToken = tokenOrThrow(tokenBody);

  const listBody = await getNoticeBody(cookies, tempToken, isCommon);
  assertNotExpired(listBody);
  const token = tokenOrThrow(listBody);

  const body = await getNoticeBodyNext(cookies, token, count, isCommon);
  assertNotExpired(body);

  return isCommon ? parseUnivNotice(body) : parseClassNotice(body);
}

/** 連絡詳細。一覧と同じ token bootstrap を行ってから goDetail。 */
export async function fetchNoticeDetail(
  cookies: LcamCookies,
  isCommon: boolean,
  index: number,
): Promise<NoticeDetail> {
  // token を一覧経由で確立（in-memory 完結）。
  const tokenBody = await getStrutsTokenBody(cookies, isCommon);
  assertNotExpired(tokenBody);
  const tempToken = tokenOrThrow(tokenBody);
  const listBody = await getNoticeBody(cookies, tempToken, isCommon);
  assertNotExpired(listBody);
  const token = tokenOrThrow(listBody);

  const body = await getNoticeDetailBody(index, cookies, token, isCommon);
  assertNotExpired(body);
  return isCommon ? parseUnivNoticeDetail(body) : parseClassNoticeDetail(body);
}

/** 時間割（SP）。 */
export async function fetchTimetable(
  cookies: LcamCookies,
): Promise<TimetableEntry[]> {
  const body = await getClassTimeTableBody(cookies);
  assertSpSessionAlive(body); // stub（セッション喪失）なら再ログインへ
  return parseClassTimeTable(body);
}

/** ファイル取得。content-type が text/html ならログイン画面=失効とみなす。 */
export async function fetchFile(
  cookies: LcamCookies,
  fileUrl: string,
): Promise<Response> {
  const res = await getFile(cookies, fileUrl);
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/html')) {
    // ボディは読み捨て（stream を消費しておく）。
    await res.text().catch(() => undefined);
    throw new LcamExpiredError();
  }
  return res;
}

/**
 * スケジュール（PC 経路・ステートレス）。リクエストごとに PC ログインし、
 * reload を weeks 回まわして週送りしながら集計する。
 * 透過再ログインのラップ対象外（毎回フレッシュにログインするため）。
 */
export async function fetchSchedule(
  cred: Credential,
  weeks: number,
): Promise<ScheduleDay[]> {
  let cookies = await pcGetCookie();
  const newJsession = await preAccess(cookies);
  cookies = { jsessionid: newJsession, liveApps: cookies.liveApps };

  const loginBody = await initLogin(cred.id, cred.password, cookies);
  let token = extractStrutsToken(parseHtml(loginBody));
  if (token == null) {
    throw new UpstreamError('PC login failed (token not found)');
  }

  const days: ScheduleDay[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < weeks; i++) {
    const body = await reload(cookies, token);
    token = extractStrutsToken(parseHtml(body)) ?? token;
    let part: ScheduleDay[] = [];
    try {
      part = parseSchedule(body);
    } catch {
      break; // カレンダーが取れなくなったら終了
    }
    for (const d of part) {
      if (!seen.has(d.date)) {
        seen.add(d.date);
        days.push(d);
      }
    }
    await getScheduleNext(cookies); // 次週へ送る
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}
