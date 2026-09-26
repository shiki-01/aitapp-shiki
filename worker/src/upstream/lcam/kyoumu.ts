// 学事システム（`/kyoumu/`）。ホームの「学事システム」リンクから入る別アプリで、参照系のみ扱う。
// 入り方（実 LCAM で確認: 2026-09-25。docs/LCAM_FEATURES.md §0）:
//   1. PC ホームの home_systemCooperationLink フォームを POST（TOKEN のみ）
//      → 自動送信フォーム（action=/kyoumu/portalRedirect.do;JSESSIONID=…、hidden loginID）が返る
//   2. その action へ loginID を POST → 学事システムのメニュー（各画面への dbLinkClick リンク）が返る。Set-Cookie で
//      学事システム側の JSESSIONID が発行される
//   3. 以降は `;jsessionid=…` 付きの URL への GET。**URL の jsessionid だけでは 500 になる。2 で得た Cookie が要る**
//      （LCAM 本体の Cookie とは別物。本体の JSESSIONID を送ると衝突するため、学事システムには送らない）
// 参照専用。登録・更新・取消の画面（履修登録・学籍情報の更新など）は扱わない。

import type { LcamCookies } from '../../types';
import { parseHtml, textLines, HTMLElement } from '../../html/parser';
import { UpstreamError, LcamExpiredError } from '../errors';
import { BASE, lcamFetch, pcHeaders, resolveRedirect } from './access';
import { firstToken, pcEnter, pcMenu, cellText } from './pc';
import { extractStrutsTokenByForm } from './csrf';
import type {
  CreditStatus,
  CurriculumItem,
  LotteryResult,
  SchoolEvents,
  SchoolEventMonth,
} from '../../../../shared/contract';

const KYOUMU_PREFIX = '/kyoumu/';
const MAX_REDIRECTS = 3;

export interface KyoumuSession {
  /** 学事システムの Cookie（name=value; …）。 */
  cookie: string;
  /** メニューのリンク: 表示名 → パス（`/kyoumu/xxx.do;jsessionid=…?mainMenuCode=…`）。 */
  links: Map<string, string>;
  /** Referer に使うメニューの URL。 */
  menuUrl: string;
}

/** 応答本文。charset が UTF-8 以外（学事システムのエラー画面は Shift_JIS）なら、その文字コードで読む。 */
async function bodyText(res: Response): Promise<string> {
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  if (!charset || charset === 'utf-8') return res.text();
  try {
    return new TextDecoder(charset).decode(await res.arrayBuffer());
  } catch {
    return res.text();
  }
}

function cookiePairs(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='));
}

/** 学事システムへのリクエスト。同一ホストの /kyoumu/ 内のリダイレクトだけ追従し、Cookie を他へ送らない。 */
async function kyoumuFetch(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
): Promise<Response> {
  let target = url;
  let { method, body } = init;
  let headers = init.headers;
  for (let hop = 0; ; hop++) {
    const res = await lcamFetch(target, { method, headers, body, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      await res.body?.cancel();
      target = resolveRedirect(location, target); // SSO なら LcamExpiredError、他ホストなら UpstreamError
      if (hop >= MAX_REDIRECTS) throw new UpstreamError('学事システム: リダイレクトが多すぎます');
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
        const { 'Content-Type': _ct, ...rest } = headers;
        headers = rest;
      }
      continue;
    }
    return res;
  }
}

/**
 * メニューの本文が空だったときに使う既定のリンク（メニューコードは docs/LCAM_FEATURES.md §3）。
 * アプリ方式（lamyapp:// の key）のセッションでは、引き渡し後の POST が本文の無い 200 と学事システムの Cookie だけを返し、
 * その Cookie で各画面を直接 GET できた（実測 2026-09-25）。PC 画面ログインのときはメニューが返るので、そちらを優先する。
 */
const DEFAULT_LINKS: ReadonlyArray<[string, string]> = [
  ['単位修得情報の参照', '/kyoumu/taniShuutokuJouhouSearchInit.do?mainMenuCode=009&parentMenuCode=007'],
  ['カリキュラムの参照', '/kyoumu/curriculumReference.do?mainMenuCode=010&parentMenuCode=007'],
  ['学内スケジュール', '/kyoumu/schoolEventSchedule.do?mainMenuCode=017&parentMenuCode=014'],
  ['抽選履修登録結果', '/kyoumu/chuusenRishuuInit.do?mainMenuCode=020'],
];

/** 引き渡し用の自動送信フォームから action と loginID を取る。action は /kyoumu/ 配下だけ許す。 */
export function parseHandoff(html: string): { action: string; loginId: string } {
  const action = /name="ssoCooperation"[^>]*\baction="([^"]+)"/.exec(html)?.[1] ?? /\baction="([^"]*\/kyoumu\/[^"]+)"/.exec(html)?.[1];
  const loginId = /name="loginID"[^>]*\bvalue="([^"]*)"/.exec(html)?.[1];
  if (html.includes('不正な操作') || !action || !loginId) {
    throw new UpstreamError('学事システムへの引き渡し画面を認識できませんでした');
  }
  const url = new URL(action.replace(/&amp;/g, '&'), `${BASE}/`);
  if (url.origin !== BASE || !url.pathname.startsWith(KYOUMU_PREFIX)) {
    throw new UpstreamError('学事システムの接続先が想定外です');
  }
  return { action: url.toString(), loginId };
}

/** メニューの各リンク（`onclick="dbLinkClick('/kyoumu/…')"`）。同じ表示名があれば先のものを使う。 */
export function parseKyoumuMenu(html: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const a of parseHtml(html).querySelectorAll('a')) {
    const m = /dbLinkClick\('([^']+)'\)/.exec(a.getAttribute('onclick') ?? '');
    const label = a.text.replace(/\s+/g, ' ').trim();
    if (!m || !label || links.has(label)) continue;
    if (!m[1].startsWith(KYOUMU_PREFIX) && !m[1].startsWith('/syllabus2/')) continue;
    links.set(label, m[1]);
  }
  return links;
}

/**
 * 学事システムへの引き渡しの手前まで進め、自動送信フォームの宛先（action と loginID）を返す。
 * ユーザーのブラウザにこのフォームを POST させれば、ブラウザが学事システムのセッション（Cookie）を持って入れる
 * （実測: Cookie なしの POST でメニューが返る）。Worker 自身は学事システムのセッションを作らない。
 */
export async function prepareKyoumuHandoff(cookies: LcamCookies): Promise<{ action: string; loginId: string }> {
  const token = await homeCooperationToken(cookies);
  const step1 = await kyoumuFetch(`${BASE}/portalv2/home/systemCooperationLink/initialize?renkeiType=kyoumu`, {
    method: 'POST',
    headers: pcHeaders(cookies, { post: true }),
    body: new URLSearchParams({ 'org.apache.struts.taglib.html.TOKEN': token }).toString(),
  });
  if (step1.status !== 200) throw new UpstreamError(`学事システムの引き渡しに失敗しました（${step1.status}）`);
  return parseHandoff(await bodyText(step1));
}

/** PC ホーム（Z07）を開き、連携リンクのフォームの token を返す。 */
async function homeCooperationToken(cookies: LcamCookies): Promise<string> {
  const entry = await pcEnter(cookies);
  const home = await pcMenu(cookies, entry, 'Z07', '/home/home/initialize');
  const token = extractStrutsTokenByForm(home, 'home_systemCooperationLink') ?? firstToken(home);
  if (token == null) throw new UpstreamError('LCAM のホームから token を取得できませんでした');
  return token;
}

/** LCAM のセッションから学事システムへ入る（3〜4 リクエスト）。 */
export async function openKyoumu(cookies: LcamCookies): Promise<KyoumuSession> {
  const token = await homeCooperationToken(cookies);

  const step1 = await kyoumuFetch(`${BASE}/portalv2/home/systemCooperationLink/initialize?renkeiType=kyoumu`, {
    method: 'POST',
    headers: pcHeaders(cookies, { post: true }),
    body: new URLSearchParams({ 'org.apache.struts.taglib.html.TOKEN': token }).toString(),
  });
  if (step1.status !== 200) throw new UpstreamError(`学事システムの引き渡しに失敗しました（${step1.status}）`);
  const { action, loginId } = parseHandoff(await bodyText(step1));

  // 学事システムには LCAM 本体の Cookie を送らない（JSESSIONID が衝突する）。
  const step2 = await kyoumuFetch(action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      Referer: `${BASE}/portalv2/home/systemCooperationLink/initialize?renkeiType=kyoumu`,
      'User-Agent': pcHeaders(cookies)['User-Agent'],
      'Accept-Language': 'ja',
    },
    body: new URLSearchParams({ loginID: loginId }).toString(),
  });
  if (step2.status !== 200) throw new UpstreamError(`学事システムに入れませんでした（${step2.status}）`);
  const jar = cookiePairs(step2);
  const menuHtml = await bodyText(step2);
  const links = parseKyoumuMenu(menuHtml);
  if (links.size === 0) {
    // 本文が空で Cookie がある場合だけ既定のリンクを使う（エラー画面などの想定外の本文は認識失敗のまま）。
    if (menuHtml.trim() !== '' || jar.length === 0) throw new UpstreamError('学事システムのメニューを認識できませんでした');
    for (const [label, path] of DEFAULT_LINKS) links.set(label, path);
  }
  return { cookie: jar.join('; '), links, menuUrl: action };
}

/** 学事システムの画面を GET する。path は /kyoumu/ 配下（メニューのリンクか、その派生）だけ。 */
export async function kyoumuGet(session: KyoumuSession, path: string): Promise<string> {
  if (!path.startsWith(KYOUMU_PREFIX)) throw new UpstreamError('学事システムの外への遷移は許可していません');
  const res = await kyoumuFetch(`${BASE}${path}`, {
    method: 'GET',
    headers: {
      Cookie: session.cookie,
      Referer: session.menuUrl,
      'User-Agent': pcHeaders({ jsessionid: '', liveApps: '' })['User-Agent'],
      'Accept-Language': 'ja',
    },
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    // 学事システムのセッション切れは 500 のエラー画面になる（実測）。呼び出し側はメニューから入り直せる。
    throw new UpstreamError(`学事システムの画面を取得できませんでした（${res.status}）`);
  }
  const html = await bodyText(res);
  if (html.includes('ログインされていないため')) throw new LcamExpiredError();
  return html;
}

function menuPath(session: KyoumuSession, label: string): string {
  const p = session.links.get(label);
  if (!p) throw new UpstreamError(`学事システムのメニューに「${label}」がありません`);
  return p;
}

// ---- 表の展開 ----

/** 結合セル（rowspan/colspan）を展開して、各行の長さが同じ表にする。 */
export function tableGrid(table: HTMLElement): string[][] {
  const grid: string[][] = [];
  const trs = table.querySelectorAll('tr');
  trs.forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of tr.childNodes) {
      if (!(cell instanceof HTMLElement) || (cell.tagName !== 'TD' && cell.tagName !== 'TH')) continue;
      while (grid[r][c] !== undefined) c++;
      const text = cellText(cell).replace(/\s*\n\s*/g, ' ');
      const rs = Math.max(1, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1);
      const cs = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
      for (let dr = 0; dr < rs; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = text;
      }
      c += cs;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row?.length ?? 0));
  return grid
    .filter((row) => row !== undefined)
    .slice(0, trs.length)
    .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

/** 入れ子の表を持たない表（実データを持つのはこちら）。 */
function innermostTables(root: HTMLElement): HTMLElement[] {
  return root.querySelectorAll('table').filter((t) => t.querySelector('table') === null);
}

// ---- 単位修得情報 ----

export function parseCreditStatus(html: string): CreditStatus {
  const root = parseHtml(html);
  const tables = innermostTables(root);
  const data = tables.find((t) => t.classList.contains('txt12') && cellText(t).includes('必要単位'));
  if (!data) throw new UpstreamError('単位修得情報の表を認識できませんでした');
  const rows = tableGrid(data);
  // 見出しは「必要単位」を含む行まで。
  const headerEnd = rows.findIndex((r) => r.some((c) => c.includes('必要単位')));
  const tabs = tables
    .map((t) => cellText(t))
    .find((t) => t.includes('卒業進級用'))
    ?.split(/\s+/)
    .filter(Boolean) ?? [];
  const note = tables
    .filter((t) => t.classList.contains('txt12') && t !== data)
    .map((t) => cellText(t).replace(/\s+/g, ' '))
    .find((t) => t.includes('総修得単位数')) ?? '';
  return { tabs, headerRows: headerEnd >= 0 ? headerEnd + 1 : 1, rows, note };
}

export async function fetchCreditStatus(cookies: LcamCookies): Promise<CreditStatus> {
  const session = await openKyoumu(cookies);
  return parseCreditStatus(await kyoumuGet(session, menuPath(session, '単位修得情報の参照')));
}

// ---- カリキュラム ----

export function parseCurriculum(html: string): CurriculumItem[] {
  const table = innermostTables(parseHtml(html)).find(
    (t) => t.classList.contains('txt12') && cellText(t.querySelector('tr') ?? t).includes('科目コード'),
  );
  if (!table) throw new UpstreamError('カリキュラムの表を認識できませんでした');
  const items: CurriculumItem[] = [];
  for (const row of tableGrid(table).slice(1)) {
    if (row.length < 6 || !row[0]) continue;
    items.push({
      code: row[0],
      name: row[1],
      category: row[2],
      creditType: row[3],
      credits: parseFloat(row[4]) || 0,
      grade: row[5],
    });
  }
  return items;
}

export async function fetchCurriculum(cookies: LcamCookies): Promise<CurriculumItem[]> {
  const session = await openKyoumu(cookies);
  return parseCurriculum(await kyoumuGet(session, menuPath(session, 'カリキュラムの参照')));
}

// ---- 学内スケジュール（年間行事） ----

/** 月の表（見出し: 日・曜日・祝祭日・行事）を読む。nendo は年度（1〜3 月は翌年）。 */
export function parseSchoolEventMonth(html: string, month: number, nendo: number): SchoolEventMonth {
  const table = innermostTables(parseHtml(html)).find((t) => {
    const first = textLines(t.querySelector('tr')).join('');
    return first.includes('曜日') && first.includes('行事');
  });
  if (!table) throw new UpstreamError('学内スケジュールの表を認識できませんでした');
  const year = month >= 4 ? nendo : nendo + 1;
  const days = tableGrid(table)
    .slice(1)
    .filter((r) => /^\d{1,2}$/.test(r[0]))
    .map((r) => ({
      date: `${year}-${String(month).padStart(2, '0')}-${r[0].padStart(2, '0')}`,
      weekday: r[1] ?? '',
      holiday: r[2] ?? '',
      event: r[3] ?? '',
    }));
  return { month, days };
}

/** ページの見出し「2026年度」。 */
export function parseNendo(html: string): number {
  const m = /(20\d{2})年度/.exec(parseHtml(html).text);
  if (!m) throw new UpstreamError('学内スケジュールの年度を認識できませんでした');
  return parseInt(m[1], 10);
}

/**
 * 学内スケジュール。month は 1〜12 の月、'all' は 12 か月（1 リクエストずつ。上流へ 12 回）。
 * 年度は上流が最初に表示するもの（今の年度）。月の切り替えは GET（changeTarget=month&targetMonth=N）。
 */
export async function fetchSchoolEvents(cookies: LcamCookies, month: number | 'all'): Promise<SchoolEvents> {
  const session = await openKyoumu(cookies);
  const base = menuPath(session, '学内スケジュール');
  const months = month === 'all' ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3] : [month];
  const out: SchoolEventMonth[] = [];
  // 上流は画面の状態をセッションに持つため、月の切り替えの前に通常の表示を 1 回 GET する（切り替えだけだと
  // 別の画面が返る。実測 2026-09-25）。年度はこの最初の表示から取る。
  const sep = base.includes('?') ? '&' : '?';
  const nendo = parseNendo(await kyoumuGet(session, base));
  for (const m of months) {
    const html = await kyoumuGet(session, `${base}${sep}actionStatus=change&changeTarget=month&targetMonth=${m}`);
    out.push(parseSchoolEventMonth(html, m, nendo));
  }
  return { nendo, months: out };
}

// ---- 抽選履修登録の結果 ----

/**
 * 抽選履修登録結果の表。曜日時限ごとに表が分かれ、どれも同じ見出し（曜日時限・ナンバリング・科目名・クラスコード・隔週授業・
 * 科目区分・単位区分・単位数・校舎区分・定員・希望順位・抽選結果・抽選処理日）を持つ。
 * 抽選に申し込んでいなければ表が無い（空配列）。画面自体を認識できなければ UpstreamError。
 */
export function parseLotteryResults(html: string): LotteryResult[] {
  const root = parseHtml(html);
  if (!root.text.includes('抽選')) throw new UpstreamError('抽選履修登録結果の画面を認識できませんでした');
  const results: LotteryResult[] = [];
  for (const table of innermostTables(root)) {
    if (!table.classList.contains('txt12')) continue;
    const grid = tableGrid(table);
    if (!grid[0]?.[0]?.includes('曜日時限')) continue;
    for (const r of grid.slice(1)) {
      if (r.length < 13 || !r[2]) continue;
      results.push({
        slot: r[0],
        subject: r[2],
        classCode: r[3],
        biweekly: r[4],
        category: r[5],
        creditType: r[6],
        credits: parseFloat(r[7]) || 0,
        campus: r[8],
        capacity: parseInt(r[9], 10) || 0,
        preference: parseInt(r[10], 10) || 0,
        result: r[11],
        processedAt: r[12],
      });
    }
  }
  return results;
}

export async function fetchLotteryResults(cookies: LcamCookies): Promise<LotteryResult[]> {
  const session = await openKyoumu(cookies);
  return parseLotteryResults(await kyoumuGet(session, menuPath(session, '抽選履修登録結果')));
}
