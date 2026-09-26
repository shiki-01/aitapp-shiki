// 学内共有ファイル（PC 版 キャンパスライフ > 学内共有ファイル。menuCode=B08）。
// 一覧 → 詳細（POST commonFileDetail/initialize）→ ダウンロード（POST commonFileDetail/fileDownLoad2/…）。
// 実 LCAM で確認済みの遷移（2026-09-25）: 詳細は TOKEN + hiddenCommonFileId + prevPageId の最小フィールドで通る。
// ダウンロードは token 検査の対象外（画面側が EXCLUDE_SET を付けて POST する）。

import type { LcamCookies } from '../../types';
import { parseHtml } from '../../html/parser';
import { UpstreamError, NotFoundError } from '../errors';
import { postPcStream } from './access';
import {
  assertPcPage,
  findRow,
  formInputs,
  hiddenValues,
  nextToken,
  parseEntryTable,
  pcOpen,
  pcSubmit,
  rowCells,
} from './pc';
import type { CommonFileItem, CommonFileDetail, PcFileLink } from '../../../../shared/contract';

const MENU = { code: 'B08', path: '/commonfile/commonFile/initialize' };
const LIST_FORM = 'commonfile_commonFileActionForm';
const DETAIL_PATH = '/commonfile/commonFileDetail';

/** 一覧画面（`table#tbl_commonFileList`）を読む。行の並びと detailCommonFileId の並びは対応する。 */
export function parseCommonFileList(html: string): CommonFileItem[] {
  if (formInputs(html, LIST_FORM).length === 0) {
    throw new UpstreamError('学内共有ファイルの一覧画面を認識できませんでした');
  }
  const ids = hiddenValues(html, LIST_FORM, 'detailCommonFileId');
  const items: CommonFileItem[] = [];
  // 実 HTML は先頭にチェック用の空の列があり、末尾にも並べ替え用の列が付く（実測 2026-09-25）。位置は見出しから決める。
  const head = parseHtml(html).querySelectorAll('#tbl_commonFileList th').map((th) => th.text.replace(/\s+/g, '').trim());
  const col = (name: string) => head.indexOf(name);
  const [cCategory, cTitle, cCount, cSize, cUpdated] = ['カテゴリ（タグ）', 'タイトル', 'DL数', 'サイズ', '更新日時'].map(col);
  if ([cCategory, cTitle, cCount, cSize, cUpdated].includes(-1)) {
    throw new UpstreamError('学内共有ファイルの一覧の見出しを認識できませんでした');
  }
  for (const tr of parseHtml(html).querySelectorAll('#tbl_commonFileList tr')) {
    const cells = rowCells(tr);
    if (cells.length <= Math.max(cCategory, cTitle, cCount, cSize, cUpdated)) continue; // 見出し行・「データなし」行
    const link = tr.querySelector('a');
    const idx = /moveToDetail\((\d+)\)/.exec(`${link?.getAttribute('href') ?? ''}${link?.getAttribute('onclick') ?? ''}`)?.[1];
    const id = idx != null ? ids[parseInt(idx, 10)] : undefined;
    if (!id) throw new UpstreamError('学内共有ファイルの一覧から ID を取得できませんでした');
    items.push({
      id,
      category: cells[cCategory],
      title: cells[cTitle],
      downloadCount: parseInt(cells[cCount].replace(/[^\d]/g, ''), 10) || 0,
      size: cells[cSize],
      updatedAt: cells[cUpdated],
    });
  }
  return items;
}

/** 詳細画面を読む。 */
export function parseCommonFileDetail(html: string, id: string): CommonFileDetail {
  const rows = parseEntryTable(html);
  const title = findRow(rows, 'タイトル');
  if (!title) throw new UpstreamError('学内共有ファイルの詳細画面を認識できませんでした');
  return {
    id,
    title: title.text,
    category: findRow(rows, 'カテゴリ（タグ）')?.text ?? '',
    description: findRow(rows, 'ファイル説明')?.text ?? '',
    publicPeriod: findRow(rows, '公開期間')?.text.replace(/\s+/g, ' ') ?? '',
    files: findRow(rows, 'ファイル')?.files ?? [],
  };
}

export async function fetchCommonFileList(cookies: LcamCookies): Promise<CommonFileItem[]> {
  const { html } = await pcOpen(cookies, MENU.code, MENU.path);
  return parseCommonFileList(html);
}

/** 一覧を開いて詳細へ進む。詳細の HTML と、次の操作用の token を返す。 */
async function openDetail(
  cookies: LcamCookies,
  id: string,
): Promise<{ html: string; token: string }> {
  const list = await pcOpen(cookies, MENU.code, MENU.path);
  if (!parseCommonFileList(list.html).some((i) => i.id === id)) {
    throw new NotFoundError('common file not found');
  }
  const html = await pcSubmit(cookies, list.token, `${DETAIL_PATH}/initialize`, {
    hiddenCommonFileId: id,
    prevPageId: 'backToList',
  });
  return { html, token: nextToken(html) };
}

export async function fetchCommonFileDetail(
  cookies: LcamCookies,
  id: string,
): Promise<CommonFileDetail> {
  const { html } = await openDetail(cookies, id);
  return parseCommonFileDetail(html, id);
}

/**
 * ダウンロードの POST 先（画面の fileDownLoad() と同じ組み立て）。
 * 拡張子があれば fileDownLoad2/{拡張子を除いた名前（. は除去）}、無ければ fileDownLoad。
 */
export function downloadPath(actionPath: string, link: PcFileLink): string {
  const dot = link.name.lastIndexOf('.');
  const query = `?EXCLUDE_SET=&prefix=${link.prefix}&no=${link.no}`;
  if (dot > 0) {
    const base = link.name.slice(0, dot).replace(/[.]/g, '');
    return `${actionPath}/fileDownLoad2/${encodeURIComponent(base)}${query}`;
  }
  return `${actionPath}/fileDownLoad${query}`;
}

/**
 * ファイルを 1 つ取得して Response を返す（body はそのまま stream）。
 * 名前は詳細画面のものを使い、クライアントから渡された名前は信用しない。
 */
export async function downloadCommonFile(
  cookies: LcamCookies,
  id: string,
  no: number,
): Promise<Response> {
  const { html, token } = await openDetail(cookies, id);
  const link = parseCommonFileDetail(html, id).files.find((f) => f.no === no);
  if (!link) throw new NotFoundError('file not found');
  const res = await postPcStream(cookies, downloadPath(DETAIL_PATH, link), {
    'org.apache.struts.taglib.html.TOKEN': token,
    hiddenCommonFileId: id,
    prevPageId: 'backToDetail',
  });
  // ダウンロードのはずが HTML なら、ログイン画面（失効）か拒否のページ。
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    const text = await res.text();
    assertPcPage(text);
    throw new UpstreamError('LCAM がファイルの代わりに画面を返しました');
  }
  return res;
}
