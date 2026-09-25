import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseStaffList, searchStaff, fetchStaffSchedule } from '../src/upstream/lcam/staff';
import { LcamExpiredError, NotFoundError, UpstreamError, ValidationError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp/portalv2';
const T = 'org.apache.struts.taglib.html.TOKEN';
const NOW = new Date('2026-09-25T12:00:00+09:00');

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML。
const tok = (v: string) => `<input type="hidden" name="${T}" value="${v}">`;

function staffResult(token: string): string {
  const row = (dept: string, name: string, kana: string, code: string) =>
    `<tr><td>${dept}</td><td><a href="javascript:void(0);" onclick="someoneWeeklyScheduleDisp('${code}','${name}');">${name}</a></td><td>${kana}</td></tr>`;
  return (
    `<form name="schedule_staffSearchActionForm" action="/portalv2/schedule/staffSearch/">${tok(token)}</form>` +
    `<table><tr><th>教職員所属</th><th>教職員氏名</th><th></th></tr>` +
    row('建築学科', '井上　知宏', 'イノウエ トモヒロ', '480479') +
    row('総合教育教室', '井上　智之', 'イノウエ サトシ', '600167') +
    `</table>`
  );
}

function weekPage(token: string, heads: string[]): string {
  const cells = heads.map(() => `<td><div class="div_content_reference"> Ⅰ限(09:00-10:30)<br>[八]サンプル科目(C2)<br>井上 智之<br>八草 Ｇ２５０７<br> </div></td>`);
  return (
    `<form name="schedule_someoneWeeklyScheduleActionForm">${tok(token)}</form>` +
    `<table class="calendar-body"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr>${cells.join('')}</tr></tbody></table>`
  );
}

describe('parseStaffList', () => {
  it('所属・氏名・かな・教職員コードを読む', () => {
    expect(parseStaffList(staffResult('T'))).toEqual([
      { code: '480479', name: '井上　知宏', kana: 'イノウエ トモヒロ', department: '建築学科' },
      { code: '600167', name: '井上　智之', kana: 'イノウエ サトシ', department: '総合教育教室' },
    ]);
  });
  it('検索画面でなければ UpstreamError。0 件は空配列', () => {
    expect(() => parseStaffList('<html>別画面</html>')).toThrow(UpstreamError);
    expect(parseStaffList(`<form name="schedule_staffSearchActionForm"></form>`)).toEqual([]);
  });
});

afterEach(() => vi.unstubAllGlobals());

interface Call { method: string; path: string; body: URLSearchParams }
function stub(opts: { menu?: string } = {}): Call[] {
  const calls: Call[] = [];
  let move = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(BASE, '');
    calls.push({ method: String(init.method ?? 'GET'), path, body: new URLSearchParams(String(init.body ?? '')) });
    if (path === '/smartphone/smartPhoneHome/nextPage/timeTable') return new Response(tok('SP'));
    if (path === '/common/generalPurpose/') return new Response(opts.menu ?? tok('M1'));
    if (path === '/schedule/weeklySchedule/staffSearcheDisp') return new Response(tok('F1'));
    if (path === '/schedule/staffSearch/staffSearch') return new Response(staffResult('R1'));
    if (path === '/schedule/staffSearch/someoneWeeklyScheduleDisp') return new Response(weekPage('W0', ['9/25(金)', '9/26(土)']));
    if (path === '/schedule/someoneWeeklySchedule/initialize') return new Response(weekPage(`W${++move}`, ['9/28(月)', '9/29(火)']));
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('searchStaff / fetchStaffSchedule', () => {
  it('検索: メニュー B02 → 検索画面 → 氏名で検索（token は直前の応答のもの）', async () => {
    const calls = stub();
    const r = await searchStaff(cookies, '井上');
    expect(r).toHaveLength(2);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /smartphone/smartPhoneHome/nextPage/timeTable',
      'POST /common/generalPurpose/',
      'POST /schedule/weeklySchedule/staffSearcheDisp',
      'POST /schedule/staffSearch/staffSearch',
    ]);
    expect(calls[1].body.get('menuCode')).toBe('B02');
    expect(calls[2].body.get(T)).toBe('M1');
    expect(calls[3].body.get(T)).toBe('F1');
    expect(calls[3].body.get('searchStaffName')).toBe('井上');
  });

  it('週間スケジュール: 検索結果の氏名（全角スペース）を targetStaffName に送り、授業を読む', async () => {
    const calls = stub();
    const { staff, days } = await fetchStaffSchedule(cookies, '井上', '600167', 0, NOW);
    expect(staff.name).toBe('井上　智之');
    const c = calls.at(-1)!;
    expect(c.path).toBe('/schedule/staffSearch/someoneWeeklyScheduleDisp');
    expect(Object.fromEntries(c.body)).toEqual({ [T]: 'R1', searchStaffName: '井上', targetStaffCode: '600167', targetStaffName: '井上　智之' });
    expect(days.map((d) => d.date)).toEqual(['2026-09-25', '2026-09-26']);
    expect(days[0].events[0]).toMatchObject({ title: 'サンプル科目(C2)', period: 1, teacher: '井上 智之' });
  });

  it('週送り: 翌週は 5、前週は 3。直前の応答の token を使う', async () => {
    const calls = stub();
    await fetchStaffSchedule(cookies, '井上', '600167', 2, NOW);
    const moves = calls.filter((c) => c.path === '/schedule/someoneWeeklySchedule/initialize');
    expect(moves.map((c) => [c.body.get(T), c.body.get('dayMoveDivision')])).toEqual([['W0', '5'], ['W1', '5']]);
    const calls2 = stub();
    await fetchStaffSchedule(cookies, '井上', '600167', -1, NOW);
    expect(calls2.at(-1)!.body.get('dayMoveDivision')).toBe('3');
  });

  it('検索結果に無い教職員コード・範囲外の週・空の氏名は拒否（スケジュールへは進まない）', async () => {
    const calls = stub();
    await expect(fetchStaffSchedule(cookies, '井上', '999', 0, NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(calls.some((c) => c.path.includes('someone'))).toBe(false);
    await expect(fetchStaffSchedule(cookies, '井上', '600167', 99, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(searchStaff(cookies, '  ')).rejects.toBeInstanceOf(ValidationError);
  });

  it('メニューがログイン画面なら LcamExpiredError', async () => {
    stub({ menu: '<html>ログインされていないため</html>' });
    await expect(searchStaff(cookies, '井上')).rejects.toBeInstanceOf(LcamExpiredError);
  });
});
