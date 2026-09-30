// LCAM HTML パース。移植元: lcam_parse.dart。
// node-html-parser が Dart(universal_html) と同等の CSS セレクタに対応するため、
// Dart のセレクタをほぼそのまま使う。

import {
  HTMLElement,
  type Node,
  parseHtml,
  textLines,
  nodeText,
  selAll,
  selOne,
} from '../../html/parser';
import { NotFoundError, UpstreamError } from '../errors';

// ---- 出力型 ----
// 契約型の単一情報源（shared/contract.ts）から取り込み、そのまま再エクスポートする。
// パース関数の戻り値型として使いつつ、client.ts など従来の import 経路も維持する。
import type {
  UnivNotice,
  ClassNotice,
  NoticeDetail,
  TimetableEntry,
  ScheduleEvent,
  ScheduleDay,
} from '../../../../shared/contract';
export type {
  UnivNotice,
  ClassNotice,
  NoticeDetail,
  TimetableEntry,
  ScheduleEvent,
  ScheduleDay,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `> table > tbody > tr > td:nth-child(1)` のテキスト行（_extractText 相当）。 */
function extractListItemTexts(row: HTMLElement): string[] {
  const td = selOne(row, '> table > tbody > tr > td:nth-child(1)');
  return textLines(td);
}

// ---- 一覧 ----

/** 学内連絡一覧。移植元: univNotice。 */
export function parseUnivNotice(html: string): UnivNotice[] {
  const root = parseHtml(html);
  // コンテナ（SP 一覧枠）の有無で「本当に0件」と「構造破壊」を分離する。
  // コンテナ自体が無い＝セレクタ改名等の構造変化とみなし、UpstreamError で顕在化させる
  // （0件と同一視して silent [] にすると異常に気づけないため）。
  // 要検証: 連絡0件のアカウントでもこのコンテナが描画されるかは実データ未観測。
  const container = root.querySelector('#smartPhoneCommonContactList');
  if (container == null) {
    throw new UpstreamError('[parseUnivNotice]一覧コンテナが見つかりません（上流の構造変化の可能性）');
  }
  const rows = root.querySelectorAll(
    '#smartPhoneCommonContactList > form:nth-child(4) > div.listItem',
  );
  // コンテナは在るが行が0件＝正真正銘の空。空配列を返す（エラーにしない）。
  const result: UnivNotice[] = [];
  for (let i = 0; i < rows.length; i++) {
    const texts = extractListItemTexts(rows[i]);
    let c = 0;
    let sender = '';
    let title = '';
    let sendAt = '';
    let isImportant = false;
    for (const text of texts) {
      switch (c) {
        case 0:
          if (text === '重要') {
            isImportant = true;
            continue; // c をインクリメントしない（Dart 準拠）
          }
          title = text;
          break;
        case 1:
          sender = text;
          break;
        case 2:
          sendAt = text;
          break;
      }
      c++;
    }
    result.push({ type: 'common', sender, title, sendAt, isImportant, index: i });
  }
  return result;
}

/** 授業連絡一覧。移植元: classNotice。 */
export function parseClassNotice(html: string): ClassNotice[] {
  const root = parseHtml(html);
  // コンテナの有無で「本当に0件」と「構造破壊」を分離する（parseUnivNotice と同じ方針）。
  // 要検証: 授業連絡0件のアカウントでもこのコンテナが描画されるかは実データ未観測。
  const container = root.querySelector('#smartPhoneClassContactList');
  if (container == null) {
    throw new UpstreamError('[parseClassNotice]一覧コンテナが見つかりません（上流の構造変化の可能性）');
  }
  const rows = root.querySelectorAll(
    '#smartPhoneClassContactList > form:nth-child(4) > div.listItem',
  );
  // コンテナは在るが行が0件＝正真正銘の空。空配列を返す（エラーにしない）。
  const result: ClassNotice[] = [];
  for (let i = 0; i < rows.length; i++) {
    const texts = extractListItemTexts(rows[i]);
    let c = 0;
    let sender = '';
    let title = '';
    let makeupClassAt = '';
    let isImportant = false;
    for (const text of texts) {
      switch (c) {
        case 6:
          if (text === '重要') {
            isImportant = true;
            continue;
          }
          title = text;
          break;
        case 7:
          sender = text;
          break;
        case 10:
          makeupClassAt = text;
          break;
      }
      c++;
    }
    result.push({
      type: 'class',
      sender,
      title,
      subject: texts[2] ?? '',
      makeupClassAt,
      isImportant,
      index: i,
    });
  }
  return result;
}

// ---- 詳細 ----

// ---- 連絡本文サニタイズ ----
// 連絡本文は上流由来 HTML をそのまま {@html} で描画するため XSS の危険がある。
// 旧実装(filterContentHtml)は色指定を除くだけでサニタイズになっていなかった。
// node-html-parser で「許可タグ + 許可属性のみ残す」allowlist 方式に置き換え、
// script/iframe/object/embed 等の危険要素・on* イベント属性・javascript: 等の
// 危険スキームを全て除去する。整形用の安全なタグは残す。

// 残す整形タグ。
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'sub', 'sup',
  'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'font', 'center',
]);
// タグ・中身ごと丸ごと捨てる要素（テキストも残さない）。
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base',
]);
// 自己完結タグ。
const VOID_TAGS = new Set(['br', 'hr']);
// タグごとに残す属性。ここに無い属性(on* を含む)は全て除去する。
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align']),
  font: new Set(['color']),
};

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** href の危険スキームを弾く。相対 URL・http(s)・mailto・アンカーのみ許可。 */
function safeUrl(value: string): string | null {
  // 制御文字/空白(ASCII \x00-\x20, \x7f)を除去してからスキーム判定する。
  // ブラウザは href 解決時にこれらを剥がすため、`java\tscript:` のように
  // スキーム内へ制御文字を挟む偽装を許すと XSS になる（entity 由来の TAB/改行等も
  // node-html-parser がデコード済みのためここで確実に除去できる）。
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f]/g, '');
  if (v === '') return null;
  // 先頭が `scheme:` の絶対 URL は許可スキームのみ通す（javascript:/data:/vbscript: を排除）。
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s !== 'http' && s !== 'https' && s !== 'mailto') return null;
  }
  return v;
}

function renderAttrs(tag: string, attributes: Record<string, string>): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  let out = '';
  for (const [name, value] of Object.entries(attributes)) {
    const n = name.toLowerCase();
    if (!allowed.has(n)) continue;
    let v = value;
    if (n === 'href') {
      const safe = safeUrl(v);
      if (safe == null) continue;
      v = safe;
    }
    out += ` ${n}="${escapeAttr(v)}"`;
  }
  return out;
}

function sanitizeNode(node: Node): string {
  if (node instanceof HTMLElement) {
    const tag = node.rawTagName?.toLowerCase() ?? '';
    if (tag === '') {
      // ルート等のラッパ要素は子だけ描画する。
      return node.childNodes.map(sanitizeNode).join('');
    }
    if (DROP_WITH_CONTENT.has(tag)) return '';
    const inner = node.childNodes.map(sanitizeNode).join('');
    // 未許可タグは中身(サニタイズ済み)だけ残して unwrap する。
    if (!ALLOWED_TAGS.has(tag)) return inner;
    const attrs = renderAttrs(tag, node.attributes);
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  // テキストノードはデコード済みテキストを再エスケープして安全化する。
  const anyNode = node as unknown as { text?: string; rawText?: string };
  return escapeText(anyNode.text ?? anyNode.rawText ?? '');
}

/** 連絡本文 HTML を allowlist でサニタイズする。 */
function sanitizeContentHtml(html: string): string {
  const root = parseHtml(html);
  return root.childNodes.map(sanitizeNode).join('');
}

function filterContentHtml(rawHtml: string): string {
  // 生 URL を <a> 化(移植元 filterContentHtml の挙動を維持)してから
  // allowlist サニタイズする。色指定 style は sanitize が属性ごと除去する。
  const linked = rawHtml.replace(
    /(http(s)?:\/\/[a-zA-Z0-9-.!'*;/?:@&=+$,%_#]+)/gi,
    (m) => `<a href="${m}">${m}</a>`,
  );
  return sanitizeContentHtml(linked);
}

interface DetailConfig {
  contentLabel: string;
  fileLabel: string;
  wrapContent: boolean;
}

interface RawDetail {
  texts: string[];
  files: Record<string, string>;
}

/** 詳細 HTML を走査し texts + fileMap を抽出する（univ/class 共通の状態機械）。 */
function parseDetailCore(html: string, cfg: DetailConfig): RawDetail {
  const root = parseHtml(html);
  const trs = selAll(root, 'body > form > table > tbody > tr');
  if (trs.length === 0) {
    throw new NotFoundError('[parseNoticeDetail]データの取得に失敗しました');
  }

  const texts: string[] = [];
  const files: Record<string, string> = {};
  let mainContent = 0;

  for (const tr of trs) {
    if (mainContent === 0 || mainContent === 2) {
      for (const t of tr.text.replace(/\t/g, '').trim().split('\n')) {
        if (t.trim() !== '') texts.push(t.trim());
      }
    } else if (mainContent === 1) {
      const div = tr.querySelector('td > div');
      const filtered = filterContentHtml(div ? div.outerHTML : '');
      texts.push(cfg.wrapContent ? `<html><body>${filtered}</body></html>` : filtered);
      mainContent = 0;
    }

    if (mainContent === 2) {
      if (texts[texts.length - 1] !== '参考URL') {
        for (const childContents of tr.querySelectorAll('td > div')) {
          const anchors = childContents.querySelectorAll('div > a');
          for (let i = 0; i < anchors.length; i++) {
            const finalName = anchors[i].text.trim();
            const dot = finalName.lastIndexOf('.');
            if (finalName !== '' && dot > 0) {
              const nameNoExt = finalName.substring(0, dot);
              files[finalName] =
                `/portalv2/common/fileUploadDownload/fileDownLoad2/${encodeURI(nameNoExt)}/?EXCLUDE_SET=&prefix=no1&no=${i + 1}`;
            } else {
              files[`ファイル${i + 1}`] =
                `/portalv2/common/fileUploadDownload/fileDownLoad/?EXCLUDE_SET=&prefix=no1&no=${i + 1}`;
            }
          }
        }
      }
      mainContent = 0;
    }

    switch (texts[texts.length - 1]) {
      case cfg.contentLabel:
        mainContent = 1;
        break;
      case cfg.fileLabel:
        mainContent = 2;
        break;
    }
  }

  return { texts, files };
}

function sliceUrls(texts: string[]): string[] {
  const start = texts.indexOf('参考URL');
  const end = texts.indexOf('連絡日時');
  const url: string[] = [];
  if (start >= 0 && end >= 0) {
    for (let i = start + 1; i < end; i++) url.push(texts[i]);
  }
  return url;
}

/** 学内連絡詳細。移植元: univNoticeDetail。 */
export function parseUnivNoticeDetail(html: string): NoticeDetail {
  const { texts, files } = parseDetailCore(html, {
    contentLabel: '連絡内容',
    fileLabel: '添付ファイル',
    wrapContent: false,
  });
  const titleIndex = texts.indexOf('タイトル') + 1;
  const title = texts[titleIndex] !== '重要' ? texts[titleIndex] : texts[titleIndex + 1];
  return {
    sender: texts[texts.indexOf('管理所属') + 1] ?? '',
    title: title ?? '',
    content: texts[texts.indexOf('連絡内容') + 1] ?? '',
    sendAt: texts[texts.indexOf('連絡日時') + 1] ?? '',
    url: sliceUrls(texts),
    files,
  };
}

/** 授業連絡詳細。移植元: classNoticeDetail。 */
export function parseClassNoticeDetail(html: string): NoticeDetail {
  const { texts, files } = parseDetailCore(html, {
    contentLabel: '内容',
    fileLabel: 'ファイル',
    wrapContent: true,
  });
  const titleIndex = texts.indexOf('タイトル') + 1;
  const title = texts[titleIndex] !== '重要' ? texts[titleIndex] : texts[titleIndex + 1];
  const subjectIdx = texts.indexOf('授業科目');
  return {
    sender: texts[subjectIdx + 3] ?? '',
    title: title ?? '',
    content: texts[texts.indexOf('内容') + 1] ?? '',
    sendAt: texts[texts.indexOf('連絡日時') + 1] ?? '',
    subject: texts[subjectIdx + 1] ?? '',
    url: sliceUrls(texts),
    files,
  };
}

// ---- 成績情報 ----

export interface PerformanceEntry {
  category: string;
  subject: string;
  teacher: string;
  year: string;
  semester: string;
  credits: number | null;
  grade: string;
  inProgress: boolean;
}

/**
 * 成績情報。移植元 Dart 実装なし（webAccessLinks は WebView 表示のみで未パース）。
 * 実機観測: 結果テーブルの各行は `td.txt12` 1個で、カテゴリ見出し行（1行のみのテキスト）
 * と科目行（※・科目名・教員・年度・学期・単位・評価をラベルで判別できる複数行）が混在する。
 */
export function parsePerformance(html: string): PerformanceEntry[] {
  const root = parseHtml(html);
  const cells = root.querySelectorAll('td.txt12');
  // ログイン済みの成績ページは常にカテゴリ見出し/科目セル（td.txt12）を含む。
  // 在学生で完全に0件は非現実的なため、0件はセレクタ改名等の構造破壊とみなし
  // UpstreamError で顕在化させる（silent [] で異常を握り潰さない）。
  // 要検証: 上級学年/評価済みアカウントでのセル構造は実データ未観測。
  if (cells.length === 0) {
    throw new UpstreamError('[parsePerformance]成績セルが見つかりません（上流の構造変化の可能性）');
  }

  const result: PerformanceEntry[] = [];
  let category = '';
  for (const td of cells) {
    const lines = textLines(td);
    if (lines.length === 0) continue;
    if (lines.length === 1) {
      category = lines[0].replace(/^【|】$/g, '');
      continue;
    }

    let i = 0;
    const inProgress = lines[0] === '※';
    if (inProgress) i++;
    let subject = '';
    let teacher = '';
    let year = '';
    let semester = '';
    let credits: number | null = null;
    let grade = '';
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^教員/.test(line)) {
        teacher = line.replace(/^教員\s*/, '').trim();
      } else if (/^\d{4}年度$/.test(line)) {
        year = line.replace('年度', '');
      } else if (line === '前期' || line === '後期') {
        semester = line;
      } else if (/^単位\s*:/.test(line)) {
        const m = /単位\s*:\s*(\d+)/.exec(line);
        credits = m ? parseInt(m[1], 10) : null;
      } else if (/^評価\s*:/.test(line)) {
        grade = line.replace(/^評価\s*:\s*/, '').trim();
      } else if (subject === '') {
        subject = line;
      }
    }
    result.push({ category, subject, teacher, year, semester, credits, grade, inProgress });
  }
  return result;
}

// ---- アンケート一覧 ----

export interface EnqueteListItem {
  fields: Record<string, string>;
}

export interface EnqueteList {
  count: number;
  items: EnqueteListItem[];
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String(FULLWIDTH_DIGITS.indexOf(d)));
}

/**
 * アンケート一覧（授業アンケート/授業評価アンケート/学内アンケート）。移植元 Dart 実装なし。
 * 実機観測（授業アンケートのみ実データ1件で確認）: `div.listItem` 内のテキストは
 * 「ラベル行」→「":" のみの行」→「値（複数行可）」の繰り返しで構成される。
 * このラベル/コロン/値の並びは他の連絡詳細パース（lcam_parse.dart 由来）でも
 * 使われているサイト共通の JSP 出力パターンのため、ラベル文字列を固定せず
 * 「次行が ':' の行」をラベルとして汎用的に検出する。
 * 授業評価アンケート/学内アンケートは実データ0件のためこの構造の実観測はできておらず、
 * 同一パターンと推定（要確認）。
 */
export function parseEnqueteList(html: string): EnqueteList {
  const root = parseHtml(html);
  const countEl = root.querySelector('.resultCount');
  const countText = countEl ? toHalfWidthDigits(countEl.text) : '';
  const countMatch = /(\d+)/.exec(countText);
  const count = countMatch ? parseInt(countMatch[1], 10) : 0;

  const rows = root.querySelectorAll('div.listItem');
  const items: EnqueteListItem[] = [];
  for (const row of rows) {
    const lines = textLines(row);
    const fields: Record<string, string> = {};
    let label: string | null = null;
    let valueParts: string[] = [];
    const commit = () => {
      if (label != null) fields[label] = valueParts.join(' ').trim();
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const next = lines[i + 1];
      if (next === ':' || next === '：') {
        commit();
        label = line;
        valueParts = [];
        i += 2;
        continue;
      }
      valueParts.push(line);
      i++;
    }
    commit();
    if (Object.keys(fields).length > 0) items.push({ fields });
  }
  return { count, items };
}

// ---- 授業アンケート回答フォーム ----

export interface EnqueteQuestion {
  /** 1始まり。value{index} が回答欄の name になる。 */
  index: number;
  /** 設問ラベル（ア/イ/ウ...）。 */
  label: string;
  prompt: string;
  maxLength: number | null;
  /**
   * 実機観測できたのは「テキストボックス」形式のみ。他形式（テキストエリア/日付/
   * コンボボックス/ラジオボタン/チェックボックス/添付ファイル）はテンプレート上
   * 存在が確認できるが実データが無いため 'unsupported' として区別し、
   * submitEnqueteAnswer 側で弾く（誤った形式で送信しない）。
   */
  answerType: 'text' | 'unsupported';
  fieldName: string;
}

export interface EnqueteAnswerForm {
  classEnqId: string;
  questions: EnqueteQuestion[];
}

/**
 * 授業アンケート回答フォーム。移植元 Dart 実装なし・実機観測に基づく新規実装。
 * 設問は `<dt>ラベル</dt><dd><strong>プロンプト（Nバイト以内）</strong></dd>` の並びと、
 * 対応する回答欄（`name="value{i}"`）が設問と同じ順序で並ぶことを利用して対応付ける
 * （実データ3問で dt 3個・value1〜3 の順序一致を確認済み）。
 */
export function parseEnqueteAnswerForm(html: string): EnqueteAnswerForm {
  const root = parseHtml(html);
  const classEnqId = root.querySelector('#classEnqId')?.getAttribute('value') ?? '';
  if (!classEnqId) {
    throw new NotFoundError('[parseEnqueteAnswerForm]classEnqIdの取得に失敗しました');
  }

  const dts = root.querySelectorAll('dt');
  const questions: EnqueteQuestion[] = [];
  for (let i = 0; i < dts.length; i++) {
    const fieldName = `value${i + 1}`;
    const label = textLines(dts[i])[0] ?? '';
    const container = dts[i].parentNode;
    const promptRaw = container ? textLines(container.querySelector('dd')).join(' ') : '';
    const lenMatch = /（\s*(\d+)\s*文字以内\s*）/.exec(promptRaw);
    const maxLength = lenMatch ? parseInt(lenMatch[1], 10) : null;
    const prompt = promptRaw.replace(/（\s*\d+\s*文字以内\s*）/, '').trim();

    const textInput = root.querySelector(`input[name="${fieldName}"]`);
    const answerType: EnqueteQuestion['answerType'] = textInput ? 'text' : 'unsupported';

    questions.push({ index: i + 1, label, prompt, maxLength, answerType, fieldName });
  }
  return { classEnqId, questions };
}

// ---- 授業アンケート確認画面（登録確認） ----

export interface EnqueteConfirmForm {
  classEnqId: string;
  backPath: string;
}

/**
 * 「登録確認」画面（`smartphone_smartPhoneClassEnqAnswerConfirmActionForm`、SP フロー実測）
 * から最終登録 POST に必要な `classEnqId`/`backPath` を取り出す。
 * この画面もヘッダ/ナビ等の共通部品込みで巨大かつ他のアンケート系画面と同様に
 * node-html-parser がタグ閉じ忘れで壊れるおそれがあるため（§9, §11.4）、DOM
 * セレクタではなく生 HTML への正規表現で対象 form 以降の値を拾う。
 */
export function parseEnqueteConfirm(html: string): EnqueteConfirmForm {
  const formIdx = html.indexOf(
    'name="smartphone_smartPhoneClassEnqAnswerConfirmActionForm"',
  );
  if (formIdx < 0) {
    throw new NotFoundError('[parseEnqueteConfirm]登録確認フォームが見つかりません');
  }
  const tail = html.slice(formIdx);
  const classEnqIdMatch = /name="classEnqId"\s+value="([^"]*)"/.exec(tail);
  const backPathMatch = /name="backPath"\s+value="([^"]*)"/.exec(tail);
  if (!classEnqIdMatch) {
    throw new NotFoundError('[parseEnqueteConfirm]classEnqIdが見つかりません');
  }
  return {
    classEnqId: classEnqIdMatch[1],
    backPath: backPathMatch ? backPathMatch[1] : '',
  };
}

// ---- 時間割（SP） ----

const DAY_TH: Record<string, string> = {
  月: 'monday',
  火: 'tuesday',
  水: 'wednesday',
  木: 'thurstay',
  金: 'friday',
  土: 'saturday',
  日: 'sunday',
};
const ROMAN_PERIOD: Record<string, number> = {
  Ⅰ: 1,
  Ⅱ: 2,
  Ⅲ: 3,
  Ⅳ: 4,
  Ⅴ: 5,
  Ⅵ: 6,
  Ⅶ: 7,
};

/**
 * 上流の時間割セルは `<div class="kamokuDetailLink" ...>` を閉じタグ無しで出力する。
 * ブラウザ(universal_html)は `</td>` で自動補完するが node-html-parser は補完せず、
 * 後続の全行を最初の div 内にネストしてしまい `tbody > tr` が崩れて 0 件になる。
 * 各セル内で直後の `</td>` の前に `</div>` を補って正しく閉じる。
 */
function closeKamokuDivs(html: string): string {
  return html.replace(
    /(<div class="kamokuDetailLink"[\s\S]*?)(<\/td>)/g,
    '$1</div>$2',
  );
}

/**
 * 生 HTML から、keyword を class に含む <table> を、ネストした table を含めて
 * balanced に切り出す。全体パースが壊れるページ向けの局所抽出。
 */
function extractBalancedTable(html: string, keyword: string): string | null {
  const startRe = new RegExp(`<table[^>]*${keyword}[^>]*>`, 'i');
  const sm = startRe.exec(html);
  if (!sm) return null;
  const start = sm.index;
  const re = /<table\b|<\/table>/gi;
  re.lastIndex = start;
  let depth = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) {
        end = re.lastIndex;
        break;
      }
    } else {
      depth++;
    }
  }
  return end < 0 ? null : html.slice(start, end);
}

/**
 * SP 時間割（移植元: classTimeTable）。
 * 実 HTML は `<table class="jikanwari">` で、各行が「曜日 th（rowspan で初行のみ）+
 * 時限 th + セル td」という構造。Dart は universal_html の自動補完前提で
 * `body > form > table > tbody > tr` の連番に依存していたが、Workers では曜日 th /
 * 時限 th を辿って (day, period) を確定する堅牢方式にする。
 */
export function parseClassTimeTable(html: string): TimetableEntry[] {
  // 上流の閉じ忘れ div を補正してからパースする（補正前は時間割が 0 件になる）。
  html = closeKamokuDivs(html);
  const root = parseHtml(html);
  // 実ページは node-html-parser を壊す要素を含み、全体パースでは jikanwari テーブルが
  // 落ちることがある。その場合は生 HTML から（ネスト table を含め balanced に）
  // 当該テーブルを切り出して断片だけ解析する。
  let table = root.querySelector('table.jikanwari');
  if (!table && /jikanwari/i.test(html)) {
    const frag = extractBalancedTable(html, 'jikanwari');
    if (frag) table = parseHtml(frag).querySelector('table');
  }
  if (!table) table = root.querySelector('body > form > table'); // 旧構造フォールバック
  const rows = table ? selAll(table, 'tbody > tr') : [];
  if (rows.length === 0) {
    throw new NotFoundError('[parseClassTimeTable]データの取得に失敗しました');
  }

  const result: TimetableEntry[] = [];
  let currentDay: string | null = null;

  for (const row of rows) {
    let period: number | null = null;
    for (const th of row.querySelectorAll('th')) {
      const t = th.text.trim();
      if (DAY_TH[t]) currentDay = DAY_TH[t];
      const pm = /([ⅠⅡⅢⅣⅤⅥⅦ])限/.exec(t);
      if (pm) period = ROMAN_PERIOD[pm[1]] ?? null;
    }
    if (currentDay == null || period == null) continue;

    const cell = row.querySelector('td');
    if (!cell) continue;
    const div = cell.querySelector('div') ?? cell;
    const texts: string[] = [];
    for (const node of div.childNodes) {
      const t = nodeText(node).trim();
      if (t !== '') texts.push(t);
    }

    let c = 0;
    let subject = '';
    let teacher = '';
    let classRoom = '';
    for (const text of texts) {
      switch (c) {
        case 0:
          subject = text.replace(/\[八\]/g, '');
          break;
        case 1:
          teacher = text.replace(/　他$/, '');
          break;
        case 2:
          classRoom = text.replace(/八草/g, '').trim();
          break;
      }
      c++;
    }
    if (subject !== '') {
      result.push({ day: currentDay, period, title: subject, classRoom, teacher });
    }
  }
  return result;
}

// ---- スケジュール（PC） ----

const ROMAN_PERIODS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'];

/** JST の日付（Workers は UTC で動くため、日付をまたぐ直前後で年の判定がずれないよう JST に揃える）。 */
function jstDate(now: Date): { year: number; month: number; day: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1, day: jst.getUTCDate() };
}

/**
 * 移植元: schedule。`table.calendar-body` を解析。
 * 1 日ぶんのセルは `<hr class="schedule_line">` で予定ごとに区切られ、予定の中は `<br>` で行に分かれる。
 * 実機（2026-09-25）の形:
 *   授業: `Ⅰ限(09:00-10:30)` / `[八]科目(クラス)` / `教員` / `八草 教室`（4 行）
 *   行事: `履修登録(終了)`（1 行。終日扱い）
 * 年は基準日 `anchor` に最も近い年（表示範囲は基準日の前後 6 か月以内）。
 * 上記以外の形（休講・補講などの表記は未観測）は捨てずに、行を連結したタイトルの終日予定として残す
 * （時限行があれば、その時限の時刻を付け、残りの行は note に入れる）。
 */
export function parseSchedule(html: string, anchor: Date = new Date()): ScheduleDay[] {
  const root = parseHtml(html);
  const element = root.querySelector('table.calendar-body');
  if (!element) {
    throw new NotFoundError('[parseSchedule]データの取得に失敗しました');
  }

  // 見出しは「月/日」だけなので、年は基準日（表示範囲のおおよその中心）に最も近くなるものを選ぶ。
  const a = jstDate(anchor);
  const anchorMs = Date.UTC(a.year, a.month - 1, a.day);
  const ths = selAll(element, 'thead > tr > th');
  const dates = ths.map((th) => {
    const m = /(\d{1,2})\/(\d{1,2})/.exec(th.text.trim());
    if (!m) throw new NotFoundError('[parseSchedule]日付の取得に失敗しました');
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = a.year;
    let best = Infinity;
    for (const y of [a.year - 1, a.year, a.year + 1]) {
      const dist = Math.abs(Date.UTC(y, month - 1, day) - anchorMs);
      if (dist < best) {
        best = dist;
        year = y;
      }
    }
    return { year, month, day };
  });

  const contents = selAll(element, 'tbody > tr > td > div');

  const result: ScheduleDay[] = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const dateStr = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
    const events: ScheduleEvent[] = [];
    const inner = contents[i]?.innerHTML ?? '';
    const chunks = inner.split(/<hr[^>]*schedule_line[^>]*>/i);
    for (const chunk of chunks) {
      const parts = chunk
        .split(/<br\s*\/?>/i)
        .map((e) => e.replace(/<[^>]+>/g, '').trim())
        .filter((e) => e !== '');
      if (parts.length === 0) continue;

      // 休講・補講は先頭に `【休講】` のような印が付く。実測（2026-09-25）は印だけの 1 行 + 授業の 3 行:
      //   `【休講】` / `Ⅴ限(16:20-17:50)` / `教育原論(X1)` / `川口　洋誉　他`（教室の行は無い）。
      // 印が時限の行の先頭に付く形（`【補講】 Ⅵ限(…)`）も受ける。
      let lines = parts;
      let tag: string | undefined;
      const tagOnly = /^【([^】]+)】$/.exec(parts[0]);
      if (tagOnly && parts.length > 1) {
        tag = tagOnly[1];
        lines = parts.slice(1);
      } else {
        const tagPrefix = /^【([^】]+)】\s*/.exec(parts[0]);
        if (tagPrefix) {
          tag = tagPrefix[1];
          lines = [parts[0].slice(tagPrefix[0].length), ...parts.slice(1)];
        }
      }
      const first = lines[0];

      const head = new RegExp(
        `^(${ROMAN_PERIODS.join('|')})限\\s*[(（](\\d{1,2}):(\\d{2})\\s*[-〜~－]\\s*(\\d{1,2}):(\\d{2})[)）]\\s*`,
      ).exec(first);

      if (head) {
        const period = ROMAN_PERIODS.indexOf(head[1]) + 1;
        // 同じ行に続く「科目 教員」（休講の 1 行表記）と、次の行以降を合わせて扱う。
        const inline = first.slice(head[0].length).trim();
        let rest = lines.slice(1);
        let teacher: string | undefined;
        let location: string | undefined;
        let title: string;
        if (inline) {
          const [subject, ...others] = inline.split(/[\s\u3000]+/);
          title = subject;
          const t = others.join(' ').replace(/[\s\u3000]*他$/, '').trim();
          if (t) teacher = t;
        } else {
          title = (rest[0] ?? '').replace(/\[八\]/g, '').trim();
          if (rest.length === 3) {
            teacher = rest[1].replace(/[\s\u3000]*他$/, '').trim();
            location = rest[2];
            rest = [];
          } else if (rest.length === 2) {
            // 科目 + 教員（休講など教室の行が無い形）。
            teacher = rest[1].replace(/[\s\u3000]*他$/, '').trim();
            rest = [];
          } else {
            rest = rest.slice(1);
          }
        }
        const ev: ScheduleEvent = {
          title: title.replace(/\[八\]/g, '').trim() || first,
          startTime: `${dateStr}T${pad(parseInt(head[2], 10))}:${head[3]}`,
          endTime: `${dateStr}T${pad(parseInt(head[4], 10))}:${head[5]}`,
          period,
        };
        if (teacher) ev.teacher = teacher;
        if (location) {
          ev.location = location;
          ev.roomId = location.replace(/八草/g, '').trim();
        }
        // 印（休講・補講など）と、形が確定していない追加行は note に残す。
        const note = [tag, ...rest].filter(Boolean).join(' ');
        if (note) ev.note = note;
        events.push(ev);
      } else {
        events.push({
          title: [tag ? `【${tag}】` : '', ...lines].filter(Boolean).join(' ').replace(/\[八\]/g, '').trim(),
          startTime: `${dateStr}T00:00`,
          endTime: `${dateStr}T23:59`,
        });
      }
    }
    result.push({ date: dateStr, events });
  }
  return result;
}
