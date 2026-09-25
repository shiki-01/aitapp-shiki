// レポート（PC 版 授業サポート > レポート。menuCode=A02）。学生の参照系のみ（提出は未対応）。
// 一覧 → 検索（年度・学期。POST searchList/search）→ 提出レポート参照（POST searchList/forwardSubmitRef）
// → 提出履歴のファイル（POST submitReportReference/fileDownload）。
// 実 LCAM で確認済みの遷移（2026-09-25）: いずれも TOKEN + 最小フィールドで通る。ダウンロードは画面の
// フォームの hidden をそのまま送る（token 検査の対象外。画面側が EXCLUDE_SET を付ける）。

import type { LcamCookies } from '../../types';
import { parseHtml, textLines, HTMLElement } from '../../html/parser';
import { NotFoundError, UpstreamError } from '../errors';
import { postPcStream } from './access';
import {
  assertPcPage,
  cellText,
  entrySummary,
  findRow,
  formInputs,
  nextToken,
  parseEntryTable,
  pcOpen,
  pcSubmit,
} from './pc';
import type {
  ReportItem,
  ReportDetail,
  ReportSubmission,
  ReportSubmissionFile,
} from '../../../../shared/contract';

const MENU = { code: 'A02', path: '/report/student/searchList/initialize' };
const LIST_PATH = '/report/student/searchList';
const REF_FORM = 'report_student_submitReportReferenceActionForm';
const REF_PATH = '/report/student/submitReportReference';
const TOKEN_NAME = 'org.apache.struts.taglib.html.TOKEN';

/** 一覧の絞り込み。省略時は上流の初期表示（今の年度・学期）。 */
export interface ReportQuery {
  year?: number;
  /** 1=前期 2=後期 */
  semester?: 1 | 2;
  /** 未提出のみ。 */
  unsubmittedOnly?: boolean;
}

/** 一覧（`table#searchList`）を読む。先頭 7 列が表示列（以降は上流の隠し列）。 */
export function parseReportList(html: string): ReportItem[] {
  if (!html.includes('report_student_searchListActionForm')) {
    throw new UpstreamError('レポート一覧の画面を認識できませんでした');
  }
  const items: ReportItem[] = [];
  for (const tr of parseHtml(html).querySelectorAll('#searchList tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 7) continue; // 見出し行・「データなし」行
    const link = tr.querySelector('a');
    const id = /formSubmit\(\s*'forwardSubmitRef'\s*,\s*'(\d+)'/.exec(link?.getAttribute('onclick') ?? '')?.[1];
    if (!id) throw new UpstreamError('レポート一覧から ID を取得できませんでした');
    const [subject, term = ''] = textLines(tds[0]);
    const ops = cellText(tds[6]);
    const canCancel = ops.includes('提出取消');
    items.push({
      id,
      subject: subject ?? '',
      term,
      title: cellText(tds[1]),
      status: cellText(tds[2]),
      period: cellText(tds[3]).replace(/\s+/g, ' '),
      lastSubmittedAt: cellText(tds[4]),
      format: cellText(tds[5]),
      canSubmit: !canCancel && ops.includes('提出'),
      canCancel,
    });
  }
  return items;
}

/**
 * 見出し（`h3.h3_bg`）の次の見出しまでの本文行。該当する見出しが無ければ空。
 * 催促通知は「登録されていません。」（div.noData）か一覧、評価結果は結果公開中のときだけ出る。
 */
function sectionLines(root: HTMLElement, heading: string): string[] {
  const h3 = root.querySelectorAll('h3.h3_bg').find((h) => cellText(h) === heading);
  const siblings = h3?.parentNode?.childNodes;
  if (!h3 || !siblings) return [];
  const lines: string[] = [];
  for (const node of siblings.slice(siblings.indexOf(h3) + 1)) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.tagName === 'H3' && node.classList.contains('h3_bg')) break;
    if (node.tagName === 'TABLE' && node.classList.contains('ttb_entry')) continue; // 提出履歴は submissions で読む
    lines.push(...textLines(node));
  }
  return lines;
}

const HISTORY_LINK = /historyFileDownload\(\s*'([^']*)'\s*,\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/;

/** 提出レポート参照の画面を読む。 */
export function parseReportDetail(html: string, id: string): ReportDetail {
  const rows = parseEntryTable(html);
  const title = findRow(rows, 'タイトル');
  if (!title) throw new UpstreamError('レポートの参照画面を認識できませんでした');

  const root = parseHtml(html);
  const submissions: ReportSubmission[] = [];
  for (const inner of root.querySelectorAll('table.ttb_entry_inner')) {
    const trs = inner.querySelectorAll('tr');
    const heading = trs[0] ? cellText(trs[0]) : '';
    const lines: string[] = [];
    const files: ReportSubmissionFile[] = [];
    for (const tr of trs.slice(1)) {
      const links = tr.querySelectorAll('a');
      for (const a of links) {
        const m = HISTORY_LINK.exec(a.getAttribute('onclick') ?? '');
        if (m) files.push({ studentCode: m[1], submitNo: parseInt(m[2], 10), fileNo: parseInt(m[3], 10), name: cellText(a) });
      }
      if (links.length === 0) {
        const t = cellText(tr);
        if (t) lines.push(t);
      }
    }
    submissions.push({ heading, lines, files });
  }

  return {
    id,
    status: entrySummary(html),
    title: title.text,
    period: findRow(rows, '提出期間')?.text.replace(/\s+/g, ' ') ?? '',
    evaluation: findRow(rows, '評価方法')?.text ?? '',
    description: findRow(rows, '説明')?.text ?? '',
    referenceMaterial: findRow(rows, '参考資料')?.text ?? '',
    notice: findRow(rows, '伝達事項')?.text ?? '',
    reminder: sectionLines(root, '催促通知').join('\n'),
    result: sectionLines(root, '評価結果'),
    submissions,
  };
}

/** 一覧を開く（query があれば検索する）。一覧の HTML と次の操作用の token を返す。 */
async function openList(
  cookies: LcamCookies,
  query: ReportQuery,
): Promise<{ html: string; token: string }> {
  const first = await pcOpen(cookies, MENU.code, MENU.path);
  if (query.year === undefined && query.semester === undefined && !query.unsubmittedOnly) return first;
  // 検索は年度・学期を必ず送る。指定の無い方は画面で選択中の値（上流の初期値）。実施形式は両方、科目は指定なし。
  const year = query.year !== undefined ? String(query.year) : currentSelect(first.html, 'schoolYear');
  const semester = query.semester !== undefined ? String(query.semester) : currentSelect(first.html, 'semesterCode');
  if (!year || !semester) throw new UpstreamError('レポート一覧の検索条件を認識できませんでした');
  const html = await pcSubmit(cookies, first.token, `${LIST_PATH}/search`, {
    schoolYear: year,
    semesterCode: semester,
    subjectDispCode: '',
    operationFormat: ['1', '2'],
    ...(query.unsubmittedOnly ? { submitStatus: '0' } : {}),
  });
  return { html, token: nextToken(html) };
}

/** `<select name=…>` の選択中の値。 */
function currentSelect(html: string, name: string): string | undefined {
  const sel = parseHtml(html).querySelector(`select[name="${name}"]`);
  if (!sel) return undefined;
  const opt = sel.querySelector('option[selected]');
  return opt?.getAttribute('value') ?? undefined;
}

export async function fetchReportList(cookies: LcamCookies, query: ReportQuery = {}): Promise<ReportItem[]> {
  const { html } = await openList(cookies, query);
  return parseReportList(html);
}

async function openDetail(
  cookies: LcamCookies,
  id: string,
  query: ReportQuery,
): Promise<{ html: string; token: string }> {
  const list = await openList(cookies, query);
  if (!parseReportList(list.html).some((r) => r.id === id)) throw new NotFoundError('report not found');
  const html = await pcSubmit(cookies, list.token, `${LIST_PATH}/forwardSubmitRef`, { reportId: id });
  return { html, token: nextToken(html) };
}

export async function fetchReportDetail(
  cookies: LcamCookies,
  id: string,
  query: ReportQuery = {},
): Promise<ReportDetail> {
  const { html } = await openDetail(cookies, id, query);
  return parseReportDetail(html, id);
}

/** 提出履歴のファイルを 1 つ取得する（body はそのまま stream）。提出物の指定は詳細画面のものだけを受け付ける。 */
export async function downloadReportFile(
  cookies: LcamCookies,
  id: string,
  submitNo: number,
  fileNo: number,
  query: ReportQuery = {},
): Promise<Response> {
  const { html } = await openDetail(cookies, id, query);
  const file = parseReportDetail(html, id)
    .submissions.flatMap((s) => s.files)
    .find((f) => f.submitNo === submitNo && f.fileNo === fileNo);
  if (!file) throw new NotFoundError('file not found');

  // 画面の historyFileDownload() と同じ: 画面のフォームの項目をそのまま送り、3 項目だけ差し替える。
  const fields: Record<string, string> = {};
  for (const i of formInputs(html, REF_FORM)) fields[i.name] = i.value;
  if (!fields[TOKEN_NAME]) throw new UpstreamError('レポート参照画面のフォームを認識できませんでした');
  fields.studentCode = file.studentCode;
  fields.submitNo = String(file.submitNo);
  fields.fileNo = String(file.fileNo);

  const res = await postPcStream(cookies, `${REF_PATH}/fileDownload?EXCLUDE_SET=`, fields);
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    const text = await res.text();
    assertPcPage(text);
    throw new UpstreamError('LCAM がファイルの代わりに画面を返しました');
  }
  return res;
}
