// Moodleクイズ設問HTMLの要約。mod_quiz_get_attempt_data / mod_quiz_get_attempt_review が
// 返す設問HTMLはテーマ由来のマークアップ込みで非常に大きく（実測: 20問で約29万文字）、
// MCPクライアントのツール結果トークン上限を超える。ここで回答生成に必要な情報
// （設問文・入力欄のname・選択肢/並び替え項目）だけに落とす。
// 要約パーサが対応していない設問形式は、情報欠落を避けるため元HTMLをそのまま添付する。

import { parseHtml, selAll, selOne, type HTMLElement } from '../../html/parser';
import type { MoodleQuizQuestion, RawQuizReviewQuestion } from './access';

export interface QuizChoiceOption {
  value: string;
  label: string;
}

/** multichoice / truefalse 等のラジオ1グループ。`name` に options[].value を渡して回答する。 */
export interface ParsedRadioInputs {
  kind: 'multichoice';
  name: string;
  options: QuizChoiceOption[];
}

export interface ParsedMatchRow {
  name: string;
  text: string;
  options: QuizChoiceOption[];
}

/** match(セレクト)。各 rows[].name にその行の options[].value を渡して回答する。 */
export interface ParsedMatchInputs {
  kind: 'match';
  rows: ParsedMatchRow[];
}

export interface ParsedOrderingItem {
  id: string;
  text: string;
}

/** ordering(並び替え)。`name` に items[].id を正しい順でカンマ区切り連結して回答する。 */
export interface ParsedOrderingInputs {
  kind: 'ordering';
  name: string;
  items: ParsedOrderingItem[];
}

export interface ParsedGenericField {
  tag: 'input' | 'select' | 'textarea';
  type?: string;
  name: string;
  value?: string;
  options?: QuizChoiceOption[];
}

/** 要約パーサ未対応の形式。入力欄の機械的な列挙のみ（設問の意味は併記の html を読む）。 */
export interface ParsedGenericInputs {
  kind: 'generic';
  fields: ParsedGenericField[];
}

export type ParsedQuestionInputs =
  | ParsedRadioInputs
  | ParsedMatchInputs
  | ParsedOrderingInputs
  | ParsedGenericInputs;

export interface MoodleQuizQuestionSummary {
  slot: number;
  page: number;
  type: string;
  /** 設問文（HTMLタグ除去済み） */
  text: string;
  inputs: ParsedQuestionInputs;
  /** 要約パーサ未対応の形式のときのみ、元の設問HTML全文 */
  html?: string;
  note?: string;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 設問文（.qtext）のテキストを取り出す。ordering では並び替え対象の li が
 * .qtext 内に含まれるため、除去してから取る（inputs.items と重複するので）。
 */
function questionText(root: HTMLElement): string {
  const qtext = selOne(root, '.qtext');
  if (!qtext) return '';
  for (const li of selAll(qtext, 'li')) {
    if ((li.getAttribute('id') ?? '').startsWith('ordering_item_')) li.remove();
  }
  return cleanText(qtext.text);
}

/** `name` を持つ回答入力欄か（sequencecheck / flagged などの制御用は除外）。 */
function isAnswerFieldName(name: string | undefined): name is string {
  return !!name && /^q\d+:\d+_/.test(name) && !name.includes('_:');
}

function labelTextFor(root: HTMLElement, input: HTMLElement): string {
  const id = input.getAttribute('id');
  const src =
    (id ? selAll(root, 'label').find((l) => l.getAttribute('for') === id) : undefined) ??
    (input.parentNode as HTMLElement | null);
  if (!src) return '';
  // 「a.」「b.」等の選択肢番号は値ではないので除去する。
  for (const n of selAll(src, '.answernumber')) n.remove();
  return cleanText(src.text);
}

/** multichoice / truefalse: `..._answer` のラジオ群。value="-1"（選択のクリア）は除外。 */
function parseRadioInputs(root: HTMLElement): ParsedRadioInputs | null {
  const radios = selAll(root, 'input').filter(
    (i) =>
      (i.getAttribute('type') ?? '').toLowerCase() === 'radio' &&
      /_answer$/.test(i.getAttribute('name') ?? ''),
  );
  if (radios.length === 0) return null;
  const name = radios[0].getAttribute('name') as string;
  const options: QuizChoiceOption[] = [];
  for (const radio of radios) {
    const value = radio.getAttribute('value') ?? '';
    if (value === '-1') continue;
    options.push({ value, label: labelTextFor(root, radio) });
  }
  return options.length > 0 ? { kind: 'multichoice', name, options } : null;
}

/** match: 行ごとに「英文セル + select」。 */
function parseMatchInputs(root: HTMLElement): ParsedMatchInputs | null {
  const rows: ParsedMatchRow[] = [];
  for (const tr of selAll(root, 'tr')) {
    const select = selAll(tr, 'select').find((s) => isAnswerFieldName(s.getAttribute('name')));
    if (!select) continue;
    const tds = selAll(tr, 'td');
    const textCell =
      tds.find((td) => (td.getAttribute('class') ?? '').split(/\s+/).includes('text')) ?? tds[0];
    rows.push({
      name: select.getAttribute('name') as string,
      text: textCell ? cleanText(textCell.text) : '',
      options: selAll(select, 'option').map((o) => ({
        value: o.getAttribute('value') ?? '',
        label: cleanText(o.text),
      })),
    });
  }
  return rows.length > 0 ? { kind: 'match', rows } : null;
}

/** ordering: hidden の `..._response_{qid}` と、並び替え対象の li（初期表示順）。 */
function parseOrderingInputs(root: HTMLElement): ParsedOrderingInputs | null {
  const input = selAll(root, 'input').find((i) =>
    /_response_/.test(i.getAttribute('name') ?? ''),
  );
  if (!input) return null;
  const items = selAll(root, 'li')
    .filter((li) => (li.getAttribute('id') ?? '').startsWith('ordering_item_'))
    .map((li) => ({ id: li.getAttribute('id') as string, text: cleanText(li.text) }));
  return items.length > 0
    ? { kind: 'ordering', name: input.getAttribute('name') as string, items }
    : null;
}

/** フォールバック: 回答入力欄（input/select/textarea）を機械的に列挙する。 */
function parseGenericInputs(root: HTMLElement): ParsedGenericInputs {
  const fields: ParsedGenericField[] = [];
  const seenRadioNames = new Set<string>();
  for (const el of selAll(root, 'input')) {
    const name = el.getAttribute('name');
    if (!isAnswerFieldName(name)) continue;
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      // 同名グループは1フィールドにまとめ、value を options として列挙する。
      if (seenRadioNames.has(name)) {
        const field = fields.find((f) => f.name === name);
        field?.options?.push({ value: el.getAttribute('value') ?? '', label: labelTextFor(root, el) });
        continue;
      }
      seenRadioNames.add(name);
      fields.push({
        tag: 'input',
        type,
        name,
        options: [{ value: el.getAttribute('value') ?? '', label: labelTextFor(root, el) }],
      });
      continue;
    }
    fields.push({ tag: 'input', type, name, value: el.getAttribute('value') ?? '' });
  }
  for (const el of selAll(root, 'select')) {
    const name = el.getAttribute('name');
    if (!isAnswerFieldName(name)) continue;
    fields.push({
      tag: 'select',
      name,
      options: selAll(el, 'option').map((o) => ({
        value: o.getAttribute('value') ?? '',
        label: cleanText(o.text),
      })),
    });
  }
  for (const el of selAll(root, 'textarea')) {
    const name = el.getAttribute('name');
    if (!isAnswerFieldName(name)) continue;
    fields.push({ tag: 'textarea', name });
  }
  return { kind: 'generic', fields };
}

/** 要約パーサが構造を理解できる設問タイプ。 */
const RADIO_TYPES = new Set(['multichoice', 'truefalse', 'calculatedmulti']);

/**
 * 設問HTMLを要約する。既知タイプ（multichoice系/match/ordering）は構造化した inputs のみ
 * 返し、それ以外（essay/shortanswer/cloze等）やパースに失敗した設問は、汎用フィールド
 * 列挙 + 元HTML添付にフォールバックして情報欠落を防ぐ。
 */
export function summarizeQuizQuestion(q: MoodleQuizQuestion): MoodleQuizQuestionSummary {
  const root = parseHtml(q.html);
  let inputs: ParsedQuestionInputs | null = null;
  if (RADIO_TYPES.has(q.type)) inputs = parseRadioInputs(root);
  else if (q.type === 'match') inputs = parseMatchInputs(root);
  else if (q.type === 'ordering') inputs = parseOrderingInputs(root);
  // questionText は qtext 内の並び替え li を除去（破壊的）するため、inputs のパース後に呼ぶ。
  const text = questionText(root);
  if (inputs) return { slot: q.slot, page: q.page, type: q.type, text, inputs };
  return {
    slot: q.slot,
    page: q.page,
    type: q.type,
    text,
    inputs: parseGenericInputs(root),
    html: q.html,
    note:
      '要約パーサ未対応の設問形式のため、元の設問HTMLを html に添付。' +
      '全設問の生HTMLは /api/moodle/quiz/questions でも再取得できる。',
  };
}

export function summarizeQuizQuestions(
  questions: MoodleQuizQuestion[],
): MoodleQuizQuestionSummary[] {
  return questions.map(summarizeQuizQuestion);
}

export interface QuizResultQuestionSummary {
  slot: number;
  type: string;
  /** Moodle の正誤ステータス表示（例: 「正解」「部分的に正解」「不正解」） */
  status: string;
  mark: string | null;
  maxMark: number | null;
  text: string;
  /** 正答の表示（教員がレビューでの正答表示を許可している場合のみ） */
  rightAnswer: string | null;
}

/** 採点結果レビューの設問を要約する（生HTMLは返さない）。 */
export function summarizeReviewQuestion(q: RawQuizReviewQuestion): QuizResultQuestionSummary {
  const root = parseHtml(q.html);
  const rightAnswer = selOne(root, '.rightanswer');
  return {
    slot: q.slot,
    type: q.type,
    status: q.status ?? '',
    mark: q.mark ?? null,
    maxMark: q.maxmark ?? null,
    text: questionText(root),
    rightAnswer: rightAnswer ? cleanText(rightAnswer.text) : null,
  };
}
