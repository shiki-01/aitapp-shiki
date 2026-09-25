// 施設の使用状況（FacilityWeek）から「空き」を求める純関数。worker・mcp・web で共有する
// （ランタイム依存なし。shared/contract.ts の型だけを使う）。

import type { FacilityEvent, FacilityRoomWeek } from './contract';

/** 授業の時限（LCAM の時間割。Ⅰ〜Ⅶ）。 */
export const PERIODS: ReadonlyArray<{ period: number; label: string; start: string; end: string }> = [
  { period: 1, label: 'Ⅰ限', start: '09:00', end: '10:30' },
  { period: 2, label: 'Ⅱ限', start: '10:40', end: '12:10' },
  { period: 3, label: 'Ⅲ限', start: '13:00', end: '14:30' },
  { period: 4, label: 'Ⅳ限', start: '14:40', end: '16:10' },
  { period: 5, label: 'Ⅴ限', start: '16:20', end: '17:50' },
  { period: 6, label: 'Ⅵ限', start: '18:00', end: '19:30' },
  { period: 7, label: 'Ⅶ限', start: '19:40', end: '21:10' },
];

/** HH:MM を分にする。 */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/**
 * 予定が [start, end) の時間帯に重なるか。時刻の無い予定（終日の予約など）は、その日のすべての時間帯に重なる
 * ものとして扱う（空きと誤って案内しないため）。
 */
export function eventOverlaps(e: FacilityEvent, start: string, end: string): boolean {
  if (!e.start || !e.end) return true;
  return minutes(e.start) < minutes(end) && minutes(start) < minutes(e.end);
}

/** 指定日の指定時間帯に重なる予定。無ければ空き。 */
export function busyEvents(room: FacilityRoomWeek, date: string, start: string, end: string): FacilityEvent[] {
  const day = room.days.find((d) => d.date === date);
  return day ? day.events.filter((e) => eventOverlaps(e, start, end)) : [];
}

/** 指定日の指定時間帯に空いている施設。取得した週に date が含まれない施設は空きとしない。 */
export function freeRooms(rooms: FacilityRoomWeek[], date: string, start: string, end: string): FacilityRoomWeek[] {
  return rooms.filter((r) => r.days.some((d) => d.date === date) && busyEvents(r, date, start, end).length === 0);
}
