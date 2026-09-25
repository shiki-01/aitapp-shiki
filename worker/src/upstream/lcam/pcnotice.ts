// 連絡の検索（PC 版）。学内連絡（キャンパスライフ > 学内連絡。menuCode=B01）と授業連絡（授業サポート > 授業連絡。A01）。
// 既存の SP 版（client.ts の fetchNotices）は新しい順の一覧だけだが、PC 版は検索（キーワード・カテゴリ・日付・未読・ToDo・添付）が使える。
// 実 LCAM で確認済みの遷移（2026-09-25）:
//   学内連絡: 一覧（メニュー）→ 検索 POST commonContactRcvList/searchCommoncontactRcvList → 詳細 POST commonContact/dtlEdit
//   授業連絡: 一覧（メニュー）→ 検索 POST classContactList/selectClassContactList → 詳細 POST classContactList/goDetail/{行番号}
//   添付: POST common/fileUploadDownload/fileDownLoad2/…（画面の common_fileUpload フォームの項目を送る。token 検査の対象外）
// 検索フォームは「画面の初期値 + 指定した項目だけ上書き」で送る（ブラウザと同じ）。参照のみ（既読化・ToDo・返信は扱わない）。

import type { LcamCookies } from '../../types';
import { parseHtml, textLines } from '../../html/parser';
import { NotFoundError, UpstreamError, ValidationError } from '../errors';
import { postPcStream } from './access';
import { downloadPath } from './commonfile';
import {
  assertPcPage,
  cellText,
  findRow,
  formDefaults,
  formInputs,
  nextToken,
  parseEntryTable,
  pcOpen,
  pcSubmit,
  selectOptions,
} from './pc';
import type {
  PcFileLink,
  PcNoticeDetail,
  PcNoticeItem,
  PcNoticeKind,
  PcNoticeList,
  PcNoticeQuery,
} from '../../../../shared/contract';

const TOKEN_NAME = 'org.apache.struts.taglib.html.TOKEN';

const KINDS = {
  campus: {
    menu: { code: 'B01', path: '/commoncontact/commonContact/initialize' },
    searchForm: 'commoncontact_commonContactRcvListActionForm',
    searchPath: '/commoncontact/commonContactRcvList/searchCommoncontactRcvList',
    categoryField: 'commonContactCateIdRcv',
    subjectField: undefined,
  },
  class: {
    menu: { code: 'A01', path: '/classcontact/classContactList/initialize' },
    searchForm: 'classcontact_classContactListActionForm',
    searchPath: '/classcontact/classContactList/selectClassContactList',
    categoryField: 'contactKindCode',
    subjectField: 'subjectDispCode',
  },
} as const;

/** 一覧の 1 行。index・kindDivision は詳細へ進むための上流の値。 */
interface ListRow extends PcNoticeItem {
  index: number;
  /** 学内連絡の commonContactKindDivision。 */
  kindDivision: string;
}

function distinct(s: string): string {
  return [...new Set(s.split(/,\s*/).map((t) => t.trim()).filter(Boolean))].join(', ');
}

/** 学内連絡の一覧（`table#tbl_commoncontact_rcv`）。列: カテゴリ・タイトル・連絡元・連絡開始・（隠し）・連絡終了。 */
export function parseCampusNoticeList(html: string): ListRow[] {
  if (formInputs(html, KINDS.campus.searchForm).length === 0) {
    throw new UpstreamError('学内連絡の一覧画面を認識できませんでした');
  }
  const rows: ListRow[] = [];
  for (const tr of parseHtml(html).querySelectorAll('#tbl_commoncontact_rcv tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 6) continue;
    const link = tr.querySelector('a');
    const m = /dtlScreen\(\s*'(\d+)'\s*,\s*'(\d+)'\s*,\s*'(\w+)'\s*,\s*'(\d+)'/.exec(link?.getAttribute('onclick') ?? '');
    if (!m) throw new UpstreamError('学内連絡の一覧から ID を取得できませんでした');
    rows.push({
      kind: 'campus',
      id: m[1],
      index: parseInt(m[2], 10),
      kindDivision: m[4],
      title: cellText(link!),
      category: cellText(tds[0]),
      sender: cellText(tds[2]),
      important: cellText(tds[1]).includes('【重要】'),
      startAt: cellText(tds[3]),
      endAt: cellText(tds[5]),
    });
  }
  return rows;
}

/** 授業連絡の一覧（`table#tbl_A01_01`）。列: 選択・授業科目/学期・教員・タイトル・連絡種別・対象日・連絡開始・連絡終了・通知状況…。 */
export function parseClassNoticeList(html: string): ListRow[] {
  if (formInputs(html, KINDS.class.searchForm).length === 0) {
    throw new UpstreamError('授業連絡の一覧画面を認識できませんでした');
  }
  const rows: ListRow[] = [];
  for (const tr of parseHtml(html).querySelectorAll('#tbl_A01_01 tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 9) continue;
    const link = tr.querySelector('a');
    const idx = /showClassContactDetail\((\d+)\)/.exec(link?.getAttribute('onclick') ?? '')?.[1];
    const id = tr.querySelector('input[name="classContactIdCheck"]')?.getAttribute('value');
    if (idx === undefined || !id) throw new UpstreamError('授業連絡の一覧から ID を取得できませんでした');
    const [subject = '', term = ''] = textLines(tds[1]);
    rows.push({
      kind: 'class',
      id,
      index: parseInt(idx, 10),
      kindDivision: '',
      title: cellText(link!),
      category: cellText(tds[4]),
      sender: cellText(tds[2]),
      subject,
      term: distinct(term.replace(/^…/, '')),
      important: cellText(tds[3]).includes('【重要】'),
      startAt: cellText(tds[6]).replace(/\s+/g, ' '),
      endAt: cellText(tds[7]).replace(/\s+/g, ' '),
    });
  }
  return rows;
}

function toItem({ index: _i, kindDivision: _k, ...item }: ListRow): PcNoticeItem {
  return item;
}

const DETAIL_LABELS = {
  category: ['カテゴリ', '連絡種別'],
  body: ['連絡内容', '内容'],
  files: ['添付ファイル', 'ファイル'],
} as const;

/** 詳細画面。学内連絡・授業連絡で見出しの名前が少し違う（カテゴリ/連絡種別、連絡内容/内容、添付ファイル/ファイル）。 */
export function parseNoticeDetail(html: string, kind: PcNoticeKind, id: string, sender = ''): PcNoticeDetail {
  const rows = parseEntryTable(html);
  const pick = (labels: readonly string[]) => labels.map((l) => findRow(rows, l)).find(Boolean);
  const title = findRow(rows, 'タイトル');
  if (!title) throw new UpstreamError('連絡の詳細画面を認識できませんでした');
  const urlRow = findRow(rows, '参考URL');
  const referenceUrls = urlRow
    ? parseHtml(html)
        .querySelectorAll('table.ttb_entry tr')
        .filter((tr) => cellText(tr.querySelector('th') ?? tr).replace(/\s+/g, '') === '参考URL')
        .flatMap((tr) => tr.querySelectorAll('a').map((a) => a.getAttribute('href') ?? ''))
        .filter((h) => /^https?:\/\//.test(h))
    : [];
  return {
    kind,
    id,
    category: pick(DETAIL_LABELS.category)?.text ?? '',
    title: title.text,
    body: pick(DETAIL_LABELS.body)?.rich ?? '',
    sender: findRow(rows, '連絡元')?.text ?? sender,
    important: findRow(rows, '重要度')?.text.includes('重要') ?? false,
    period: findRow(rows, '連絡日時')?.text.replace(/\s+/g, ' ') ?? '',
    referenceUrls,
    files: pick(DETAIL_LABELS.files)?.files ?? [],
    ...(findRow(rows, '返信') ? { reply: findRow(rows, '返信')!.text } : {}),
  };
}

function hasQuery(q: PcNoticeQuery): boolean {
  return Object.values(q).some((v) => v !== undefined && v !== false && v !== '');
}

/** 表示名から select の値を引く。無ければ ValidationError（上流に知らない値を送らない）。 */
function optionValue(html: string, field: string, label: string): string {
  const opt = selectOptions(html, field).find((o) => o.label === label && o.value !== '');
  if (!opt) throw new ValidationError(`${field}: unknown option`);
  return opt.value;
}

function searchFields(kind: PcNoticeKind, html: string, q: PcNoticeQuery): Record<string, string | string[]> {
  const cfg = KINDS[kind];
  const f: Record<string, string | string[]> = { ...formDefaults(html, cfg.searchForm) };
  if (kind === 'campus') {
    if (q.keyword) {
      f.searchKeywordRcv = q.keyword;
      f.checkSearchKeywordTitleRcv = 'on';
      f.checkSearchKeywordExplanationRcv = 'on'; // 本文も対象にする
    }
    if (q.category) f.commonContactCateIdRcv = optionValue(html, 'commonContactCateIdRcv', q.category);
    if (q.from) f.reportDateFromRcv = q.from;
    if (q.to) f.reportDateToRcv = q.to;
    if (q.unreadOnly) f.contactConfirmNoLookRcv = '1';
    if (q.todoOnly) f.onlyTodoRcvFlag = '1';
    if (q.attachmentOnly) f.onlyAttachFileRcvFlag = '1';
  } else {
    if (q.keyword) {
      f.searchKeyWord = q.keyword;
      for (const c of ['TeacherUserName', 'SubjectName', 'Title', 'Comment']) f[`checkSearchKeyword${c}`] = 'on';
    }
    if (q.category) f.contactKindCode = optionValue(html, 'contactKindCode', q.category);
    if (q.subject) f.subjectDispCode = optionValue(html, 'subjectDispCode', q.subject);
    if (q.year !== undefined) f.schoolYear = String(q.year);
    if (q.semester !== undefined) f.semesterCode = String(q.semester);
    if (q.from) f.reportDateStart = q.from;
    if (q.to) f.reportDateEnd = q.to;
    if (q.unreadOnly) f.onlyUnRead = 'on';
    if (q.todoOnly) f.onlyTodo = 'on';
    if (q.attachmentOnly) f.onlyAttachFile = 'on';
  }
  return f;
}

/** 一覧を開く（条件があれば検索する）。 */
async function openList(
  cookies: LcamCookies,
  kind: PcNoticeKind,
  q: PcNoticeQuery,
): Promise<{ html: string; token: string; rows: ListRow[]; first: string }> {
  const cfg = KINDS[kind];
  const first = await pcOpen(cookies, cfg.menu.code, cfg.menu.path);
  let { html, token } = first;
  if (hasQuery(q)) {
    html = await pcSubmit(cookies, token, cfg.searchPath, searchFields(kind, first.html, q));
    token = nextToken(html);
  }
  const rows = kind === 'campus' ? parseCampusNoticeList(html) : parseClassNoticeList(html);
  return { html, token, rows, first: first.html };
}

export async function fetchPcNotices(
  cookies: LcamCookies,
  kind: PcNoticeKind,
  query: PcNoticeQuery = {},
): Promise<PcNoticeList> {
  const cfg = KINDS[kind];
  const { rows, first } = await openList(cookies, kind, query);
  const labels = (field: string | undefined) =>
    field ? selectOptions(first, field).filter((o) => o.value !== '').map((o) => o.label) : [];
  return {
    items: rows.map(toItem),
    categories: labels(cfg.categoryField),
    subjects: labels(cfg.subjectField),
  };
}

async function openDetail(
  cookies: LcamCookies,
  kind: PcNoticeKind,
  id: string,
  query: PcNoticeQuery,
): Promise<{ html: string; row: ListRow }> {
  const { token, rows } = await openList(cookies, kind, query);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new NotFoundError('notice not found');
  const html =
    kind === 'campus'
      ? await pcSubmit(cookies, token, '/commoncontact/commonContact/dtlEdit', {
          mode: 'initializeRcv',
          selectIndex: String(row.index),
          commonContactId: row.id,
          commonContactKindDivision: row.kindDivision,
        })
      : await pcSubmit(cookies, token, `/classcontact/classContactList/goDetail/${row.index}`, {});
  return { html, row };
}

export async function fetchPcNoticeDetail(
  cookies: LcamCookies,
  kind: PcNoticeKind,
  id: string,
  query: PcNoticeQuery = {},
): Promise<PcNoticeDetail> {
  const { html, row } = await openDetail(cookies, kind, id, query);
  return parseNoticeDetail(html, kind, id, row.sender);
}

/** 添付を 1 つ取得する（body はそのまま stream）。名前は詳細画面のものを使う。 */
export async function downloadPcNoticeFile(
  cookies: LcamCookies,
  kind: PcNoticeKind,
  id: string,
  no: number,
  query: PcNoticeQuery = {},
): Promise<Response> {
  const { html } = await openDetail(cookies, kind, id, query);
  const link: PcFileLink | undefined = parseNoticeDetail(html, kind, id).files.find((f) => f.no === no);
  if (!link) throw new NotFoundError('file not found');
  const fields: Record<string, string> = {};
  for (const i of formInputs(html, 'common_fileUploadActionForm')) fields[i.name] = i.value;
  if (!fields[TOKEN_NAME]) throw new UpstreamError('連絡の添付用フォームを認識できませんでした');
  const res = await postPcStream(cookies, downloadPath('/common/fileUploadDownload', link), fields);
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    const text = await res.text();
    assertPcPage(text);
    throw new UpstreamError('LCAM がファイルの代わりに画面を返しました');
  }
  return res;
}
