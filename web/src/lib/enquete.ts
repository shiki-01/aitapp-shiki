// LCAM 授業アンケート一覧の項目（上流のラベル→値）を画面用に整える。
// 実データで確認済みのラベルは 授業科目 / タイトル / 状態 / 提出期間 / 提出状況（MIGRATION_NOTES §10.2）。
// 値の語彙（「未提出」「受付中」など）は実観測が少ないため、判定は保守的な部分一致にとどめ、
// 分からないものは「未回答」と決めつけずに生の値をそのまま見せる。

import type { EnqueteListItem } from './types';

export interface EnqueteView {
  /** 一覧内の位置（上流の goDetail/{index} と同じ 0 始まり）。 */
  index: number;
  subject: string;
  title: string;
  /** 状態（受付中など。無ければ空）。 */
  status: string;
  /** 提出期間（無ければ空）。 */
  period: string;
  /** 提出状況（未提出・提出済など。無ければ空）。 */
  submission: string;
  /** 回答が済んでいるか。判定できないときは null。 */
  done: boolean | null;
  /** 受付が終わっているか。判定できないときは null。 */
  closed: boolean | null;
  /** 上のラベルに当てはまらない項目（ラベル, 値）。 */
  extra: [string, string][];
}

const KNOWN = ['授業科目', 'タイトル', '状態', '提出期間', '提出状況'];

export function toEnqueteView(item: EnqueteListItem, index: number): EnqueteView {
  const f = item.fields;
  const submission = f['提出状況'] ?? '';
  const status = f['状態'] ?? '';
  const done = submission ? /済|完了|提出しました/.test(submission) : null;
  const closed = status ? /終了|締切|締め切|期限切れ|受付前/.test(status) : null;
  return {
    index,
    subject: f['授業科目'] ?? '',
    title: f['タイトル'] ?? Object.values(f)[0] ?? '',
    status,
    period: f['提出期間'] ?? '',
    submission,
    done,
    closed,
    extra: Object.entries(f).filter(([k]) => !KNOWN.includes(k)),
  };
}

/** まだ回答していない（受付が終わっていない）アンケート。 */
export function isPending(v: EnqueteView): boolean {
  return v.done === false && v.closed !== true;
}
