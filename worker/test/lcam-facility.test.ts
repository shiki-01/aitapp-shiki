import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseFacilityList,
  parseFacilityWeek,
  fetchFacilityList,
  fetchFacilityWeek,
  normalizeFacilityIds,
} from '../src/upstream/lcam/facility';
import { LcamExpiredError, UpstreamError, ValidationError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp/portalv2';
const T = 'org.apache.struts.taglib.html.TOKEN';

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML。
function listPage(token: string, rooms: Array<[string, string, string, string, string, string]>): string {
  // [id, buildingCode, building, name, capacity, equipment]
  const trs = rooms
    .map(
      (r, i) =>
        `<tr><td class="colCheck center"><input type="checkbox" name="checkArray" value="${r[0]}"></td>` +
        `<td>${r[2]}</td><td>${r[3]}</td><td class="right">${r[4]}</td><td class="right">0</td>` +
        `<td>${r[5]}<input type="hidden" name="listRows" value="${i}"></td><td>${r[0]}</td><td>${r[1]}</td></tr>`,
    )
    .join('');
  return (
    `<form name="facilityresv_facilityInfoSelectActionForm" method="post" action="/portalv2/facilityresv/facilityInfoSelect/">` +
    `<input type="hidden" name="${T}" value="${token}">` +
    `<table id="tbl_facilityInfoList" class="display"><thead><tr><th><input type="checkbox" name="checkAll"></th><th>施設種別</th><th>施設名称</th><th>定員数</th><th>試験時<br>収容人数</th><th>備品情報</th></tr></thead>` +
    `<tbody>${trs}</tbody></table></form>`
  );
}

const ROOMS: Array<[string, string, string, string, string, string]> = [
  ['21602', '21', '１号館', '１－６０２', '70', 'プロジェクター,スクリーン'],
  ['21301', '21', '１号館', '１－３０１', '182', ''],
];

function weekPage(token: string, heads: string[], rooms: Array<{ name: string; cells: string[] }>): string {
  const td = (inner: string) => `<td class=""><div class="div_content"> ${inner} </div></td>`;
  return (
    `<form name="facilityresv_facilityResvRefWeekActionForm"><input type="hidden" name="${T}" value="${token}"></form>` +
    `<table class="calendar-body"><thead><tr><th width="9%"></th>${heads.map((h) => `<th class="">${h}</th>`).join('')}</tr></thead><tbody>` +
    rooms.map((r) => `<tr><th><div class="div_period">${r.name}</div></th>${r.cells.map(td).join('')}</tr>`).join('') +
    `</tbody></table>`
  );
}

const LINE = '<hr class="schedule_line" noshade="">';
const HEADS = ['09/21(月)', '09/22(火)'];
const NOW = new Date('2026-09-25T12:00:00+09:00');

describe('parseFacilityList', () => {
  it('施設コード・建物・名称・定員・備品を読む（隠し列は建物コードに使う）', () => {
    expect(parseFacilityList(listPage('T1', ROOMS))).toEqual([
      { id: '21602', building: '１号館', buildingCode: '21', name: '１－６０２', capacity: 70, examCapacity: 0, equipment: ['プロジェクター', 'スクリーン'] },
      { id: '21301', building: '１号館', buildingCode: '21', name: '１－３０１', capacity: 182, examCapacity: 0, equipment: [] },
    ]);
  });
  it('一覧の form が無ければ UpstreamError', () => {
    expect(() => parseFacilityList('<html>別画面</html>')).toThrow(UpstreamError);
  });
});

describe('parseFacilityWeek', () => {
  it('行=施設（依頼順）、列=日。時刻・科目・教員を読み、空のセルは予定なし', () => {
    const html = weekPage('T2', HEADS, [
      {
        name: '１－６０２',
        cells: [
          `09:00-10:30<br>[八]サンプル科目(11)<br>山田 太郎 <br> ${LINE} 10:40-12:10<br>[八]サンプル科目(11)<br>山田 太郎 <br>`,
          '',
        ],
      },
      { name: '１－３０１', cells: ['', '9:00-10:30<br>行事<br>担当者<br>補足'] },
    ]);
    const w = parseFacilityWeek(html, ['21602', '21301'], NOW);
    expect(w.dates).toEqual(['2026-09-21', '2026-09-22']);
    expect(w.rooms[0]).toEqual({
      id: '21602',
      name: '１－６０２',
      days: [
        {
          date: '2026-09-21',
          events: [
            { start: '09:00', end: '10:30', title: '[八]サンプル科目(11)', teacher: '山田 太郎' },
            { start: '10:40', end: '12:10', title: '[八]サンプル科目(11)', teacher: '山田 太郎' },
          ],
        },
        { date: '2026-09-22', events: [] },
      ],
    });
    expect(w.rooms[1].days[1].events).toEqual([
      { start: '09:00', end: '10:30', title: '行事', teacher: '担当者', note: '補足' },
    ]);
  });

  it('時刻の無い予定は全行を題名にする。年をまたぐ週は年を補正する', () => {
    const html = weekPage('T2', ['12/29(月)', '01/02(金)'], [{ name: 'A', cells: ['終日<br>貸切', ''] }]);
    const w = parseFacilityWeek(html, ['1'], new Date('2026-12-30T12:00:00+09:00'));
    expect(w.dates).toEqual(['2026-12-29', '2027-01-02']);
    expect(w.rooms[0].days[0].events).toEqual([{ start: '', end: '', title: '終日 貸切' }]);
  });

  it('行数が依頼と合わなければ UpstreamError（施設の取り違えを防ぐ）', () => {
    const html = weekPage('T2', HEADS, [{ name: 'A', cells: ['', ''] }]);
    expect(() => parseFacilityWeek(html, ['1', '2'], NOW)).toThrow(UpstreamError);
  });
});

describe('normalizeFacilityIds', () => {
  it('重複を除き、数字以外・多すぎ・空は ValidationError', () => {
    expect(normalizeFacilityIds(['1', '2', '1'])).toEqual(['1', '2']);
    expect(() => normalizeFacilityIds([])).toThrow(ValidationError);
    expect(() => normalizeFacilityIds(['1;2'])).toThrow(ValidationError);
    expect(() => normalizeFacilityIds(Array.from({ length: 61 }, (_, i) => String(i)))).toThrow(ValidationError);
  });
});

// ---- 遷移の検証 ----

afterEach(() => vi.unstubAllGlobals());

interface Call { method: string; path: string; body: URLSearchParams }
function stub(opts: { menu?: string } = {}): Call[] {
  const calls: Call[] = [];
  let weeks = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(BASE, '');
    calls.push({ method: String(init.method ?? 'GET'), path, body: new URLSearchParams(String(init.body ?? '')) });
    if (path === '/smartphone/smartPhoneHome/nextPage/timeTable') return new Response(`<input type="hidden" name="${T}" value="SP">`);
    if (path === '/common/generalPurpose/') return new Response(opts.menu ?? listPage('T1', ROOMS));
    const rooms = [{ name: '１－６０２', cells: ['', ''] }, { name: '１－３０１', cells: ['', ''] }];
    if (path === '/facilityresv/facilityInfoSelect/checkInput') return new Response(weekPage('W0', HEADS, rooms));
    if (path === '/facilityresv/facilityResvRefWeek/reload') return new Response(weekPage(`W${++weeks}`, HEADS, rooms));
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('fetchFacilityList / fetchFacilityWeek', () => {
  it('一覧: SP の token → メニュー B03', async () => {
    const calls = stub();
    expect((await fetchFacilityList(cookies)).length).toBe(2);
    expect(calls[1].body.get('menuCode')).toBe('B03');
    expect(calls[1].body.get('nextPath')).toBe('/facilityresv/facilityInfoSelect/initialize');
  });

  it('今週: checkInput に checkArray（依頼順）を送る', async () => {
    const calls = stub();
    const w = await fetchFacilityWeek(cookies, ['21602', '21301']);
    expect(w.rooms.map((r) => r.id)).toEqual(['21602', '21301']);
    const c = calls.at(-1)!;
    expect(c.path).toBe('/facilityresv/facilityInfoSelect/checkInput');
    expect(c.body.get(T)).toBe('T1');
    expect(c.body.getAll('checkArray')).toEqual(['21602', '21301']);
  });

  it('週送り: 翌週は dayMoveDivision=5 を、直前の応答の token で繰り返す。前週は 3', async () => {
    const calls = stub();
    await fetchFacilityWeek(cookies, ['21602', '21301'], 2);
    const reloads = calls.filter((c) => c.path.endsWith('/reload'));
    expect(reloads.map((c) => [c.body.get(T), c.body.get('dayMoveDivision')])).toEqual([['W0', '5'], ['W1', '5']]);
    const calls2 = stub();
    await fetchFacilityWeek(cookies, ['21602', '21301'], -1);
    expect(calls2.at(-1)!.body.get('dayMoveDivision')).toBe('3');
  });

  it('一覧に無い施設・範囲外の週は ValidationError（施設の表示へは進まない）', async () => {
    const calls = stub();
    await expect(fetchFacilityWeek(cookies, ['99999'])).rejects.toBeInstanceOf(ValidationError);
    expect(calls.some((c) => c.path.includes('checkInput'))).toBe(false);
    await expect(fetchFacilityWeek(cookies, ['21602'], 99)).rejects.toBeInstanceOf(ValidationError);
  });

  it('メニューがログイン画面なら LcamExpiredError', async () => {
    stub({ menu: '<html>ログインされていないため</html>' });
    await expect(fetchFacilityList(cookies)).rejects.toBeInstanceOf(LcamExpiredError);
  });
});
