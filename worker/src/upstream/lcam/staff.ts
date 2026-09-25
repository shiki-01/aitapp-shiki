// 教職員スケジュール（PC 版 キャンパスライフ > スケジュール > 教職員スケジュールを検索。menuCode=B02）。参照のみ。
// メニュー → 検索画面（POST weeklySchedule/staffSearcheDisp）→ 氏名で検索（POST staffSearch/staffSearch）
// → 選んだ人の週間スケジュール（POST staffSearch/someoneWeeklyScheduleDisp）→ 週送り（POST
// someoneWeeklySchedule/initialize、dayMoveDivision 3=前週 5=翌週）。
// 実 LCAM で確認済みの遷移（2026-09-25）: いずれも TOKEN + 最小の項目で通る。
// 週間スケジュールの表は自分の個人スケジュールと同じ形式（table.calendar-body）なので parseSchedule を使う。
// 最初の表示は「今日から 7 日」。週送りの最初の 1 回で月曜始まりの週に揃う。

import type { LcamCookies } from '../../types';
import { parseHtml } from '../../html/parser';
import { NotFoundError, UpstreamError, ValidationError } from '../errors';
import { cellText, nextToken, pcMenu, pcEnter, pcSubmit } from './pc';
import { parseSchedule } from './parse';
import type { ScheduleDay, StaffMember } from '../../../../shared/contract';

/** 週送りの範囲。1 週ごとに上流へ 1 回リクエストするため絞る。 */
export const MIN_STAFF_WEEK = -4;
export const MAX_STAFF_WEEK = 8;

const SEARCH_FIELDS = { targetStaffCode: '', targetStaffName: '' };

/** 検索結果の表。行の onclick の someoneWeeklyScheduleDisp('コード','氏名') から教職員コードを取る。 */
export function parseStaffList(html: string): StaffMember[] {
  if (!html.includes('schedule_staffSearchActionForm')) {
    throw new UpstreamError('教職員検索の画面を認識できませんでした');
  }
  const staff: StaffMember[] = [];
  for (const tr of parseHtml(html).querySelectorAll('tr')) {
    const a = tr.querySelectorAll('a').find((x) => (x.getAttribute('onclick') ?? '').includes('someoneWeeklyScheduleDisp'));
    if (!a) continue;
    const m = /someoneWeeklyScheduleDisp\(\s*'(\d+)'\s*,\s*'([^']*)'\s*\)/.exec(a.getAttribute('onclick') ?? '');
    if (!m) continue;
    const tds = tr.querySelectorAll('td');
    staff.push({ code: m[1], name: m[2], department: cellText(tds[0] ?? tr), kana: cellText(tds[2] ?? tr) });
  }
  return staff;
}

/** メニュー → 検索画面 → 氏名で検索。検索結果の HTML と次の token。 */
async function search(cookies: LcamCookies, name: string): Promise<{ html: string; token: string }> {
  const entry = await pcEnter(cookies);
  const menu = await pcMenu(cookies, entry, 'B02', '/schedule/weeklySchedule/initialize');
  const form = await pcSubmit(cookies, nextToken(menu), '/schedule/weeklySchedule/staffSearcheDisp', {});
  const html = await pcSubmit(cookies, nextToken(form), '/schedule/staffSearch/staffSearch', {
    searchStaffName: name,
    ...SEARCH_FIELDS,
  });
  return { html, token: nextToken(html) };
}

export function normalizeStaffName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (name.length < 1 || name.length > 30) throw new ValidationError('name must be 1..30 characters');
  return name;
}

export async function searchStaff(cookies: LcamCookies, rawName: string): Promise<StaffMember[]> {
  const { html } = await search(cookies, normalizeStaffName(rawName));
  return parseStaffList(html);
}

/**
 * 教職員の週間スケジュール。name は検索語（結果に code が含まれる必要がある）。
 * week=0 は今日から 7 日、week=N（N≠0）は N 週後（負は前）の月曜始まりの週。
 */
export async function fetchStaffSchedule(
  cookies: LcamCookies,
  rawName: string,
  code: string,
  week = 0,
  now: Date = new Date(),
): Promise<{ staff: StaffMember; days: ScheduleDay[] }> {
  const name = normalizeStaffName(rawName);
  if (!/^\d{1,10}$/.test(code)) throw new ValidationError('code is invalid');
  const offset = Math.trunc(week);
  if (offset < MIN_STAFF_WEEK || offset > MAX_STAFF_WEEK) throw new ValidationError('week is out of range');

  const found = await search(cookies, name);
  const staff = parseStaffList(found.html).find((s) => s.code === code);
  if (!staff) throw new NotFoundError('staff not found');

  let html = await pcSubmit(cookies, found.token, '/schedule/staffSearch/someoneWeeklyScheduleDisp', {
    searchStaffName: name,
    targetStaffCode: staff.code,
    targetStaffName: staff.name,
  });
  for (let i = 0; i < Math.abs(offset); i++) {
    html = await pcSubmit(cookies, nextToken(html), '/schedule/someoneWeeklySchedule/initialize', {
      dayMoveDivision: offset > 0 ? '5' : '3',
    });
  }
  return { staff, days: parseSchedule(html, now) };
}
