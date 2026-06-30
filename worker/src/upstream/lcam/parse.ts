// LCAM HTML パース。移植元: lcam_parse.dart。
// node-html-parser が Dart(universal_html) と同等の CSS セレクタに対応するため、
// Dart のセレクタをほぼそのまま使う。

import {
  type HTMLElement,
  parseHtml,
  textLines,
  nodeText,
  selAll,
  selOne,
} from '../../html/parser';
import { NotFoundError } from '../errors';

// ---- 出力型 ----

export interface UnivNotice {
  type: 'common';
  sender: string;
  title: string;
  sendAt: string;
  isImportant: boolean;
  index: number;
}

export interface ClassNotice {
  type: 'class';
  sender: string;
  title: string;
  subject: string;
  makeupClassAt: string;
  isImportant: boolean;
  index: number;
}

export interface NoticeDetail {
  sender: string;
  title: string;
  content: string;
  sendAt: string;
  subject?: string;
  url: string[];
  files: Record<string, string>;
}

export interface TimetableEntry {
  day: string; // monday..sunday
  period: number; // 1..7
  title: string;
  classRoom: string;
  teacher: string;
}

export interface ScheduleEvent {
  title: string;
  startTime: string; // YYYY-MM-DDTHH:mm
  endTime: string;
  location?: string;
  teacher?: string;
  period?: number;
}

export interface ScheduleDay {
  date: string; // YYYY-MM-DD
  events: ScheduleEvent[];
}

// 授業時限の開始/終了（const.dart classPeriods）。[startH, startM, endH, endM]
const CLASS_PERIODS: Record<number, [number, number, number, number]> = {
  1: [9, 0, 10, 30],
  2: [10, 40, 12, 10],
  3: [13, 0, 14, 30],
  4: [14, 40, 16, 10],
  5: [16, 20, 17, 50],
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
  const rows = root.querySelectorAll(
    '#smartPhoneCommonContactList > form:nth-child(4) > div.listItem',
  );
  if (rows.length === 0) {
    throw new NotFoundError('[parseUnivNotice]データの取得に失敗しました');
  }
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
  const rows = root.querySelectorAll(
    '#smartPhoneClassContactList > form:nth-child(4) > div.listItem',
  );
  if (rows.length === 0) {
    throw new NotFoundError('[parseClassNotice]データの取得に失敗しました');
  }
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

function filterContentHtml(rawHtml: string): string {
  return rawHtml
    .replace(/style="background-color: #[a-f0-9]{6};"/g, '')
    .replace(/style="color: #[a-f0-9]{6};"/g, '')
    .replace(/background-color: #[a-f0-9]{6};/g, '')
    .replace(/color: #[a-f0-9]{6};/g, '')
    .replace(
      /(http(s)?:\/\/[a-zA-Z0-9-.!'*;/?:@&=+$,%_#]+)/gi,
      (m) => `<a href="${m}">${m}</a>`,
    );
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

/** 移植元: schedule。`table.calendar-body` を解析。 */
export function parseSchedule(html: string, now: Date = new Date()): ScheduleDay[] {
  const root = parseHtml(html);
  const element = root.querySelector('table.calendar-body');
  if (!element) {
    throw new NotFoundError('[parseSchedule]データの取得に失敗しました');
  }

  const ths = selAll(element, 'thead > tr > th');
  const dates = ths.map((th) => {
    const m = /(\d{1,2})\/(\d{1,2})/.exec(th.text.trim());
    if (!m) throw new NotFoundError('[parseSchedule]日付の取得に失敗しました');
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const year = now.getMonth() + 1 > month ? now.getFullYear() + 1 : now.getFullYear();
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

      let eventText: string | null = null;
      let location: string | undefined;
      let teacher: string | undefined;
      let period: number | null = null;

      if (parts.length === 4) {
        teacher = parts[2].replace(/他/g, '').trim();
        location = parts[3];
        eventText = parts[1].replace(/\[八\]/g, '');
        const pm = /(Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ)限/.exec(parts[0]);
        period = pm
          ? { Ⅰ: 1, Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5 }[pm[1] as 'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | 'Ⅴ'] ?? null
          : null;
      } else if (parts.length === 1) {
        eventText = parts[0];
      }

      if (period != null && eventText != null && CLASS_PERIODS[period]) {
        const [sh, sm, eh, em] = CLASS_PERIODS[period];
        events.push({
          title: eventText,
          startTime: `${dateStr}T${pad(sh)}:${pad(sm)}`,
          endTime: `${dateStr}T${pad(eh)}:${pad(em)}`,
          location,
          teacher,
          period,
        });
      } else if (eventText != null) {
        events.push({
          title: eventText,
          startTime: `${dateStr}T00:00`,
          endTime: `${dateStr}T23:59`,
        });
      }
    }
    result.push({ date: dateStr, events });
  }
  return result;
}
