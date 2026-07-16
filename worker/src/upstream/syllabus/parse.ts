// シラバス HTML パース。移植元: syllabus_parse.dart。
// node-html-parser は Dart(universal_html) と同等の CSS セレクタに対応する。

import { type HTMLElement, parseHtml, nodeText, selAll } from '../../html/parser';
import { NotFoundError, UpstreamError } from '../errors';

// 契約型は shared/contract.ts に集約。ここでは取り込んで再エクスポートする。
import type {
  SyllabusFilters,
  SyllabusListItem,
  Teacher,
  SyllabusDetail,
} from '../../../../shared/contract';
export type { SyllabusFilters, SyllabusListItem, Teacher, SyllabusDetail };

/** set-cookie 群から先頭の `name=value`（JSESSIONID）を返す。 */
export function extractSyllabusCookie(res: Response): string {
  const list =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  for (const sc of list) {
    const first = sc.split(';')[0];
    if (first) return first;
  }
  return '';
}

function classification(text: string): string {
  switch (text.trim()) {
    case '選必':
      return 'requiredElective';
    case '選択':
      return 'choice';
    case '必修':
      return 'required';
    default:
      return 'unknown';
  }
}

// ---- filters ----

function extractOptions(rows: HTMLElement[], filterName: string): Record<string, string> {
  const options: Record<string, string> = {};
  const row = rows.find(
    (r) => r.querySelector('td:nth-child(1)')?.text.trim() === filterName,
  );
  if (!row) {
    throw new NotFoundError('[parseSyllabusFilters]データの取得に失敗しました');
  }
  const opts = row.querySelectorAll('td:nth-child(2) > div > select > option');
  for (let i = 0; i < opts.length; i++) {
    if (i === 0) continue; // 先頭（指定なし）はスキップ
    const value = opts[i].getAttribute('value');
    if (value != null) options[opts[i].text] = value;
  }
  return options;
}

export function parseFilters(html: string): SyllabusFilters {
  const root = parseHtml(html);
  const rows = selAll(
    root,
    'body > form > table:nth-child(1) > tbody > tr > td > table > tbody > tr',
  );
  return {
    year: extractOptions(rows, '年度'),
    folder: extractOptions(rows, 'フォルダ'),
    campus: extractOptions(rows, '校舎区分'),
    hour: extractOptions(rows, '時限'),
    week: extractOptions(rows, '曜日'),
    semester: extractOptions(rows, '開講学期'),
  };
}

// ---- 検索一覧 ----

function extractRowTexts(row: HTMLElement): string[] {
  const texts: string[] = [];
  for (const info of row.querySelectorAll('td')) {
    if (info.childNodes.some((n) => (n as unknown as { nodeType: number }).nodeType === 1)) {
      texts.push(info.querySelector('div')?.text.replace(/\n/g, '').trim() ?? '?');
    } else {
      texts.push(info.text.replace(/\n/g, '').trim() ?? '?');
    }
  }
  return texts;
}

function extractUrl(row: HTMLElement): string {
  const a = row.querySelector('td > a');
  const onclick = a?.getAttribute('onclick');
  if (!onclick) return '';
  return onclick.split("'")[1] ?? '';
}

export function parseSearchList(html: string): SyllabusListItem[] {
  const root = parseHtml(html);
  const rows = selAll(
    root,
    'body > form > table:nth-child(2) > tbody > tr > td > table > tbody > tr',
  );
  if (rows.length === 0) {
    const errLi = root.querySelector('#errorTag > li');
    if (errLi) {
      throw new NotFoundError(
        '検索条件と十分に一致する結果が見つかりません。条件を変えて再度検索してください',
      );
    }
    throw new UpstreamError('[parseSyllabusList]データの取得に失敗しました');
  }
  const result: SyllabusListItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const texts = extractRowTexts(rows[i]);
    result.push({
      unitsNumber: parseInt(texts[11] ?? '', 10) || 0,
      classification: classification((texts[10] ?? '').trim()),
      teacher: (texts[5] ?? '').trim(),
      subject: (texts[3] ?? '').trim(),
      url: extractUrl(rows[i]),
    });
  }
  return result;
}

// ---- 詳細 ----

const DETAIL_LABELS = [
  '科目名',
  '担当教員',
  '研究室・オフィスアワー',
  'メールアドレス',
  '対象学年',
  'クラスコード',
  '講義室（キャンパス）',
  '開講学期',
  '曜日・時限',
  '単位区分',
  '科目種別',
  '単位数',
  '準備事項',
  '備考',
  '概要',
  'ディプロマ・ポリシー',
  '実施形態',
  '計画',
  '教科書',
  '参考書',
  '学習到達目標',
  '方法と特徴',
  '成績評価の方法',
  '教員からのメッセージ',
  'アクティブ・ラーニング科目',
  '実務経験に基づく教育内容',
  '添付ファイル(5MBまで）',
];

function extractDetailText(rows: HTMLElement[]): string[] {
  const texts: string[] = [];
  for (const tr of rows) {
    const tds = tr.querySelectorAll('td');
    let index = 0;
    for (const tdtext of tds) {
      if (index === 0) {
        for (const t of tdtext.text
          .replace(/\t/g, '')
          .replace(/ /g, '')
          .trim()
          .split('\n')) {
          if (t !== '' && t !== ' ') {
            texts.push(t);
            if (t === '計画') index = 1;
          }
        }
      } else {
        for (const content of tdtext.childNodes) {
          const t = nodeText(content).trim();
          if (t !== '') texts.push(t);
        }
        index = 0;
      }
    }
  }
  return texts;
}

function extractExpain(labels: Set<string>, texts: string[], label: string): string[] {
  const start = texts.indexOf(label);
  const result: string[] = [];
  if (start >= 0) {
    let i = start + 1;
    while (i < texts.length && !labels.has(texts[i])) {
      result.push(texts[i]);
      i++;
    }
  }
  if (result.length === 0) result.push('不明');
  return result;
}

export function parseDetail(html: string): SyllabusDetail {
  const root = parseHtml(html);
  const rows = selAll(
    root,
    'body > table:nth-child(16) > tbody > tr > td > table > tbody > tr',
  );
  if (rows.length === 0) {
    throw new UpstreamError('[parseSyllabus]データの取得に失敗しました');
  }
  const texts = extractDetailText(rows);
  const labels = new Set(DETAIL_LABELS);

  const teacherList = extractExpain(labels, texts, '担当教員');
  const teachers: Teacher[] = [];
  for (let i = 0; i + 1 < teacherList.length; i += 3) {
    teachers.push({ name: teacherList[i], ruby: teacherList[i + 1] });
  }

  const subjectArr = extractExpain(labels, texts, '科目名');
  return {
    unitsNumber: parseInt(extractExpain(labels, texts, '単位数')[0], 10) || 0,
    classification: classification(extractExpain(labels, texts, '単位区分')[0]),
    teachers,
    semester: extractExpain(labels, texts, '開講学期')[0],
    content: extractExpain(labels, texts, '概要'),
    subject: subjectArr[2] ?? subjectArr[0] ?? '',
    classPeriod: extractExpain(labels, texts, '曜日・時限')[0],
    classRoom: extractExpain(labels, texts, '講義室（キャンパス）')[0],
    plan: extractExpain(labels, texts, '計画'),
    learningGoal: extractExpain(labels, texts, '学習到達目標')[0],
    features: extractExpain(labels, texts, '方法と特徴')[0],
    records: extractExpain(labels, texts, '成績評価の方法')[0],
    teachersMessage: extractExpain(labels, texts, '教員からのメッセージ')[0],
    textBook: extractExpain(labels, texts, '教科書')[0],
    referenceBook: extractExpain(labels, texts, '参考書')[0],
  };
}
