// 施設（PC 版 キャンパスライフ > 施設。menuCode=B03）。参照のみ（学生に予約の権限は無い）。
// 一覧（全施設。1 ページ）→ 施設を選んで「表示」（POST facilityInfoSelect/checkInput。checkArray に施設コード）
// → 施設予約参照（週表示。行=施設、列=月〜日）。週送りは POST facilityResvRefWeek/reload（dayMoveDivision）。
// 実 LCAM で確認済みの遷移（2026-09-25）: いずれも TOKEN + 最小フィールドで通る。複数施設を選ぶと、
// 選んだ順に行が並ぶ。dayMoveDivision: 3=前週 4=今日 5=翌週。

import type { LcamCookies } from '../../types';
import { parseHtml, textLines } from '../../html/parser';
import { UpstreamError, ValidationError } from '../errors';
import { formInputs, nextToken, pcOpen, pcSubmit, cellText } from './pc';
import type { FacilityItem, FacilityEvent, FacilityRoomWeek, FacilityWeek } from '../../../../shared/contract';

const MENU = { code: 'B03', path: '/facilityresv/facilityInfoSelect/initialize' };
const SELECT_PATH = '/facilityresv/facilityInfoSelect';
const WEEK_PATH = '/facilityresv/facilityResvRefWeek';
const SELECT_FORM = 'facilityresv_facilityInfoSelectActionForm';

/** 1 回で表示する施設数の上限（上流の 1 画面・Worker の処理量を抑える）。 */
export const MAX_FACILITIES = 60;
/** 週送りの範囲（今週からの週数）。1 週ごとに上流へ 1 回リクエストするため、範囲を絞る。 */
export const MIN_WEEK_OFFSET = -4;
export const MAX_WEEK_OFFSET = 8;

function toInt(s: string): number {
  return parseInt(s.replace(/[^\d]/g, ''), 10) || 0;
}

/** 施設一覧（`table#tbl_facilityInfoList`）。列: 選択・施設種別・施設名称・定員・試験時収容・備品 + 隠し列（施設コード・建物コード）。 */
export function parseFacilityList(html: string): FacilityItem[] {
  if (formInputs(html, SELECT_FORM).length === 0) {
    throw new UpstreamError('施設の一覧画面を認識できませんでした');
  }
  const items: FacilityItem[] = [];
  for (const tr of parseHtml(html).querySelectorAll('#tbl_facilityInfoList tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 8) continue; // 見出し行・「データなし」行
    const id = tr.querySelector('input[name="checkArray"]')?.getAttribute('value');
    if (!id) throw new UpstreamError('施設の一覧から施設コードを取得できませんでした');
    items.push({
      id,
      building: cellText(tds[1]),
      buildingCode: cellText(tds[7]),
      name: cellText(tds[2]),
      capacity: toInt(cellText(tds[3])),
      examCapacity: toInt(cellText(tds[4])),
      equipment: cellText(tds[5]).split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return items;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 見出し「09/21(月)」の月日から、基準日（今日）に最も近い年を選んで YYYY-MM-DD にする。 */
function headDate(head: string, anchor: Date): string {
  const m = /(\d{1,2})\/(\d{1,2})/.exec(head);
  if (!m) throw new UpstreamError('施設予約の日付見出しを認識できませんでした');
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const ay = anchor.getUTCFullYear();
  let best = ay;
  let bestDist = Infinity;
  for (const y of [ay - 1, ay, ay + 1]) {
    const dist = Math.abs(Date.UTC(y, month - 1, day) - anchor.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return `${best}-${pad(month)}-${pad(day)}`;
}

function parseEvents(cellHtml: string): FacilityEvent[] {
  const events: FacilityEvent[] = [];
  for (const chunk of cellHtml.split(/<hr[^>]*schedule_line[^>]*>/i)) {
    const lines = chunk
      .split(/<br\s*\/?>/i)
      .map((l) => l.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const t = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(lines[0]);
    if (t) {
      const [, start, end] = t;
      const rest = lines.slice(1);
      events.push({
        start: start.padStart(5, '0'),
        end: end.padStart(5, '0'),
        title: rest[0] ?? '',
        ...(rest[1] ? { teacher: rest[1] } : {}),
        ...(rest.length > 2 ? { note: rest.slice(2).join(' ') } : {}),
      });
    } else {
      // 時刻の無い予定（終日の予約など）は全行を題名にする。
      events.push({ start: '', end: '', title: lines.join(' ') });
    }
  }
  return events;
}

/**
 * 施設予約参照（週表示）。ids は表示を頼んだ施設コード（頼んだ順に行が並ぶ）。
 * anchor は年の判定に使う基準日（省略時は今）。
 */
export function parseFacilityWeek(html: string, ids: string[], anchor: Date = new Date()): FacilityWeek {
  const table = parseHtml(html).querySelector('table.calendar-body');
  if (!table) throw new UpstreamError('施設予約の週表示を認識できませんでした');
  const dates = table.querySelectorAll('thead th').slice(1).map((th) => headDate(cellText(th), anchor));
  const trs = table.querySelectorAll('tbody tr');
  if (trs.length !== ids.length) {
    throw new UpstreamError(`施設予約の行数が想定と違います（${trs.length} 行 / 依頼 ${ids.length} 件）`);
  }
  const rooms: FacilityRoomWeek[] = trs.map((tr, i) => {
    const name = textLines(tr.querySelector('th')).join(' ');
    const cells = tr.querySelectorAll('td');
    return {
      id: ids[i],
      name,
      days: dates.map((date, d) => ({ date, events: parseEvents(cells[d]?.innerHTML ?? '') })),
    };
  });
  return { dates, rooms };
}

export async function fetchFacilityList(cookies: LcamCookies): Promise<FacilityItem[]> {
  const { html } = await pcOpen(cookies, MENU.code, MENU.path);
  return parseFacilityList(html);
}

/** 施設コード（数字 1〜8 桁）。重複は除く（上流は重複を 1 行にするため、行数の照合が合わなくなる）。 */
export function normalizeFacilityIds(raw: string[]): string[] {
  const ids = [...new Set(raw)];
  if (ids.length === 0 || ids.length > MAX_FACILITIES) {
    throw new ValidationError(`facility ids must be 1..${MAX_FACILITIES}`);
  }
  for (const id of ids) if (!/^\d{1,8}$/.test(id)) throw new ValidationError('facility id is invalid');
  return ids;
}

/** 指定した施設の、今週から weekOffset 週ずらした週の使用状況。 */
export async function fetchFacilityWeek(
  cookies: LcamCookies,
  rawIds: string[],
  weekOffset = 0,
): Promise<FacilityWeek> {
  const ids = normalizeFacilityIds(rawIds);
  const offset = Math.trunc(weekOffset);
  if (offset < MIN_WEEK_OFFSET || offset > MAX_WEEK_OFFSET) throw new ValidationError('week is out of range');

  const list = await pcOpen(cookies, MENU.code, MENU.path);
  const known = new Set(parseFacilityList(list.html).map((f) => f.id));
  for (const id of ids) if (!known.has(id)) throw new ValidationError('unknown facility id');

  // 「表示」。選んだ順に行が並ぶ。今週（今日を含む週）が開く。
  let html = await pcSubmit(cookies, list.token, `${SELECT_PATH}/checkInput`, { checkArray: ids });
  for (let i = 0; i < Math.abs(offset); i++) {
    html = await pcSubmit(cookies, nextToken(html), `${WEEK_PATH}/reload`, {
      dayMoveDivision: offset > 0 ? '5' : '3',
    });
  }
  return parseFacilityWeek(html, ids);
}
