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

/**
 * date（YYYY-MM-DD）が、now の属する週（JST・月曜始まり）から何週先か（過去は負）。
 * 上流の週指定（今週からの週数）に合わせるために使う。date が不正な日付なら例外。
 */
export function weekOffsetFromToday(date: string, now: Date): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('date は YYYY-MM-DD で指定してください');
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const check = new Date(target);
  if (check.getUTCFullYear() !== +m[1] || check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) {
    throw new Error('date は実在する日付で指定してください');
  }
  const DAY = 24 * 60 * 60 * 1000;
  // JST の暦日に直し、UTC 0 時として扱う。月曜始まりの週頭（getUTCDay: 日=0 → 6 日戻る）へ揃えて差を週で数える。
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
  return Math.round((monday(target) - monday(today)) / (7 * DAY));
}
