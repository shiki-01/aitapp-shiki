import { describe, it, expect } from 'vitest';
import { eventOverlaps, busyEvents, freeRooms, weekOffsetFromToday } from '../../shared/facility';
import type { FacilityRoomWeek } from '../../shared/contract';

const room = (name: string, events: Array<[string, string, string]>): FacilityRoomWeek => ({
  id: name,
  name,
  days: [{ date: '2026-09-25', events: events.map(([start, end, title]) => ({ start, end, title })) }],
});

describe('facility free-time', () => {
  it('時間帯の重なり: 端が接するだけなら重ならない', () => {
    const e = { start: '09:00', end: '10:30', title: 'x' };
    expect(eventOverlaps(e, '10:30', '12:00')).toBe(false);
    expect(eventOverlaps(e, '10:00', '11:00')).toBe(true);
    expect(eventOverlaps(e, '08:00', '09:00')).toBe(false);
  });
  it('時刻の無い予定は終日として、どの時間帯にも重なる', () => {
    expect(eventOverlaps({ start: '', end: '', title: '貸切' }, '09:00', '10:30')).toBe(true);
  });
  it('freeRooms: 重なる予定が無い施設だけ。取得範囲に無い日は空きにしない', () => {
    const rooms = [room('A', [['09:00', '10:30', '授業']]), room('B', [['10:40', '12:10', '授業']])];
    expect(freeRooms(rooms, '2026-09-25', '09:00', '10:30').map((r) => r.name)).toEqual(['B']);
    expect(freeRooms(rooms, '2026-10-02', '09:00', '10:30')).toEqual([]);
    expect(busyEvents(rooms[0], '2026-09-25', '09:30', '10:00')).toHaveLength(1);
  });
});

describe('weekOffsetFromToday', () => {
  // 2026-09-25 は金曜。その週は 09-21(月)〜09-27(日)。
  const now = new Date('2026-09-25T03:00:00Z');
  it('同じ週（月〜日）は 0', () => {
    expect(weekOffsetFromToday('2026-09-21', now)).toBe(0);
    expect(weekOffsetFromToday('2026-09-25', now)).toBe(0);
    expect(weekOffsetFromToday('2026-09-27', now)).toBe(0);
  });
  it('翌週・前週', () => {
    expect(weekOffsetFromToday('2026-09-28', now)).toBe(1);
    expect(weekOffsetFromToday('2026-09-20', now)).toBe(-1);
    expect(weekOffsetFromToday('2026-11-20', now)).toBe(8);
    expect(weekOffsetFromToday('2026-08-24', now)).toBe(-4);
  });
  it('now は JST で暦日を判定する（UTC では日曜でも JST では月曜）', () => {
    // 2026-09-27(日) 15:30Z = JST 09-28(月) 00:30 → 今週は 09-28 の週
    const sundayNightUtc = new Date('2026-09-27T15:30:00Z');
    expect(weekOffsetFromToday('2026-09-28', sundayNightUtc)).toBe(0);
    expect(weekOffsetFromToday('2026-09-27', sundayNightUtc)).toBe(-1);
  });
  it('月をまたぐ・年をまたぐ', () => {
    expect(weekOffsetFromToday('2027-01-04', new Date('2026-12-30T00:00:00Z'))).toBe(1);
  });
  it('不正・実在しない日付は例外', () => {
    expect(() => weekOffsetFromToday('2026-9-25', now)).toThrow();
    expect(() => weekOffsetFromToday('2026-02-30', now)).toThrow();
  });
});
