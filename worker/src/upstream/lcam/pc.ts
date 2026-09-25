// LCAM PC 画面（Struts）共通の遷移・フォーム処理。
// PC 画面は「メニュー遷移 = POST /portalv2/common/generalPurpose/（TOKEN・menuCode・nextPath）」で開き、
// 以降の操作もその画面のフォームを POST する（実 LCAM の観測: docs/LCAM_FEATURES.md §0）。
// 実リンク（GET）や token の無い POST で PC 画面へ入ると「不正な操作」でセッションが破棄されるため、
// 必ずこのファイルの入口（pcEnter）で得た token から順にたどること。token は各ページで更新される。

import type { LcamCookies } from '../../types';
import { parseHtml, textLines, type HTMLElement } from '../../html/parser';
import { LcamExpiredError, UpstreamError } from '../errors';
import { looksLikeLoginPage } from './detect';
import { getClassTimeTableBody, postPcForm } from './access';
import type { PcFileLink } from '../../../../shared/contract';

const TOKEN_NAME = 'org.apache.struts.taglib.html.TOKEN';

/** 生 HTML から最初の Struts token の value を取る。 */
export function firstToken(html: string): string | null {
  const m = new RegExp(`<input[^>]*${TOKEN_NAME.replace(/\./g, '\\.')}[^>]*>`).exec(html);
  if (!m) return null;
  const v = /value="([^"]*)"/.exec(m[0]);
  return v ? v[1] : null;
}

/**
 * PC ページの応答を検査する。
 * - ログインされていない（SSO への誘導やスタブ）→ LcamExpiredError（透過再ログインへ）。
 * - 「不正な操作」「システムエラー」→ UpstreamError（再ログインを繰り返さない。遷移の誤りを疑う）。
 */
export function assertPcPage(html: string): void {
  if (looksLikeLoginPage(html)) throw new LcamExpiredError();
  if (html.includes('不正な操作') || html.includes('システムエラー')) {
    throw new UpstreamError('LCAM が PC 画面へのアクセスを拒否しました（不正な操作）');
  }
}

/**
 * PC 画面へ入るための最初の token を得る。認証済みの SP ページ（時間割）の token を使う
 * （直接 GET で PC 画面へ入ると「不正な操作」でセッションが破棄されるため。MIGRATION_NOTES §14.4）。
 */
export async function pcEnter(cookies: LcamCookies): Promise<string> {
  const body = await getClassTimeTableBody(cookies);
  if (looksLikeLoginPage(body)) throw new LcamExpiredError();
  const token = firstToken(body);
  if (token == null) throw new LcamExpiredError();
  return token;
}

/** PC メニュー遷移（POST common/generalPurpose/）。返す HTML は検査済み。 */
export async function pcMenu(
  cookies: LcamCookies,
  token: string,
  menuCode: string,
  nextPath: string,
): Promise<string> {
  const html = await postPcForm(cookies, '/common/generalPurpose/', {
    [TOKEN_NAME]: token,
    headTitle: '',
    menuCode,
    nextPath,
  });
  assertPcPage(html);
  return html;
}

/** 画面内のフォーム POST。TOKEN は付与する。返す HTML は検査済み。 */
export async function pcSubmit(
  cookies: LcamCookies,
  token: string,
  path: string,
  fields: Record<string, string>,
): Promise<string> {
  const html = await postPcForm(cookies, path, { [TOKEN_NAME]: token, ...fields });
  assertPcPage(html);
  return html;
}

/** 次の操作に使う token。無ければ想定外の応答。 */
export function nextToken(html: string): string {
  const t = firstToken(html);
  if (t == null) throw new UpstreamError('LCAM の PC 画面から token を取得できませんでした');
  return t;
}

/**
 * メニューから開いた一覧画面など、PC 画面を 1 つ開いて (html, token) を返す。
 * 入口 token → メニュー遷移 → 遷移後ページの token。
 */
export async function pcOpen(
  cookies: LcamCookies,
  menuCode: string,
  nextPath: string,
): Promise<{ html: string; token: string }> {
  const entry = await pcEnter(cookies);
  const html = await pcMenu(cookies, entry, menuCode, nextPath);
  return { html, token: nextToken(html) };
}

// ---- 生 HTML のフォーム部品 ----

/**
 * name のフォームの中の input の name → value を返す。node-html-parser は閉じ忘れのある
 * LCAM の HTML で form を見失うことがあるため、生テキストから form の開始位置を探す
 * （csrf.ts の extractStrutsTokenByForm と同じ理由）。
 */
export function formInputs(html: string, formName: string): Array<{ name: string; value: string; type: string }> {
  const start = html.indexOf(`name="${formName}"`);
  if (start < 0) return [];
  const rest = html.slice(start);
  const end = rest.search(/<\/form>|<form[\s>]/i);
  const region = end > 0 ? rest.slice(0, end) : rest;
  const out: Array<{ name: string; value: string; type: string }> = [];
  for (const m of region.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (!name) continue;
    out.push({
      name,
      value: decodeAttr(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ''),
      type: (/\btype="([^"]*)"/.exec(tag)?.[1] ?? 'text').toLowerCase(),
    });
  }
  return out;
}

/** 同名の hidden が並ぶフィールド（detailCommonFileId など）の値を出現順に返す。 */
export function hiddenValues(html: string, formName: string, fieldName: string): string[] {
  return formInputs(html, formName)
    .filter((i) => i.type === 'hidden' && i.name === fieldName)
    .map((i) => i.value);
}

function decodeAttr(v: string): string {
  return v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ---- 詳細画面（table.ttb_entry）の共通パーサ ----

export interface EntryRow {
  label: string;
  /** セルのテキスト（改行は残す）。 */
  text: string;
  /** セル内の fileDownLoad('PREFIX','no','name') のリンク。 */
  files: PcFileLink[];
}

const FILE_LINK = /fileDownLoad\(\s*'([^']*)'\s*,\s*'(\d+)'\s*,\s*'([^']*)'\s*\)/;

/** 詳細画面の `table.ttb_entry`（th=ラベル、td=値）を行ごとに読む。 */
export function parseEntryTable(html: string): EntryRow[] {
  const root = parseHtml(html);
  const rows: EntryRow[] = [];
  for (const tr of root.querySelectorAll('table.ttb_entry tr')) {
    const th = tr.querySelector('th');
    const td = tr.querySelector('td');
    if (!th || !td) continue;
    const files: PcFileLink[] = [];
    for (const a of td.querySelectorAll('a')) {
      const m = FILE_LINK.exec(a.getAttribute('onclick') ?? '');
      if (!m) continue;
      const after = nextSizeText(a);
      files.push({ prefix: m[1], no: parseInt(m[2], 10), name: m[3], ...(after ? { size: after } : {}) });
    }
    rows.push({ label: cellText(th), text: cellText(td), files });
  }
  return rows;
}

/** リンクの直後にある「(3.43 MB)」を取る。 */
function nextSizeText(a: HTMLElement): string | undefined {
  const parent = a.parentNode as HTMLElement | undefined;
  const text = parent?.text ?? '';
  const idx = text.indexOf(a.text.trim());
  const rest = idx >= 0 ? text.slice(idx + a.text.trim().length) : '';
  return /\(([^)]+)\)/.exec(rest)?.[1]?.trim();
}

/** セルのテキスト。行内の空白は詰め、改行は残す。 */
export function cellText(el: HTMLElement): string {
  return el.structuredText
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

/** `label` に一致する行（空白を無視）。 */
export function findRow(rows: EntryRow[], label: string): EntryRow | undefined {
  const norm = (s: string) => s.replace(/\s+/g, '');
  return rows.find((r) => norm(r.label) === norm(label));
}

/** 表の行のセルをテキスト配列にする（一覧表用）。 */
export function rowCells(tr: HTMLElement): string[] {
  return tr.querySelectorAll('td').map((td) => textLines(td).join(' '));
}
