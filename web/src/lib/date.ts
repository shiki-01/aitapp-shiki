// 日付ユーティリティと時限定義。タイムゾーンはローカル扱い。

export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 時間割の曜日キー（既存 API の TimetableEntry.day に合わせる）。
// 注: 木曜は上流実装の綴り 'thurstay' に合わせている。
export const TIMETABLE_DAY_KEYS = [
  null, // 日
  'monday',
  'tuesday',
  'wednesday',
  'thurstay',
  'friday',
  null, // 土
] as const;

export interface Period {
  period: number;
  start: string; // HH:MM
  end: string;
}

// 愛工大の標準時限。
export const PERIODS: Period[] = [
  { period: 1, start: '09:00', end: '10:30' },
  { period: 2, start: '10:40', end: '12:10' },
  { period: 3, start: '13:00', end: '14:30' },
  { period: 4, start: '14:40', end: '16:10' },
  { period: 5, start: '16:20', end: '17:50' },
  { period: 6, start: '18:00', end: '19:30' },
];

// 月のカレンダーグリッド（日曜始まり・6週固定 = 42セル）を生成する。
export function monthGrid(year: number, month0: number): Date[] {
  const first = new Date(year, month0, 1);
  const start = new Date(year, month0, 1 - first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

export function fmtMonthTitle(year: number, month0: number): string {
  return `${year} / ${String(month0 + 1).padStart(2, '0')}`;
}
