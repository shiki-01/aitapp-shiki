import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSchedule } from '../src/upstream/lcam/parse';
import { fetchSchedule } from '../src/upstream/lcam/client';
import { LcamExpiredError, UpstreamError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const NOW = new Date('2026-09-25T12:00:00+09:00');

function cell(inner: string): string {
  return `<td><div class="div_content_reference"> ${inner} </div></td>`;
}
function week(heads: string[], cells: string[]): string {
  return (
    `<table class="calendar-body"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody><tr>${cells.join('')}</tr></tbody></table>`
  );
}
const LINE = '<hr class="schedule_line" noshade="">';
const CLASS_A = 'Ⅰ限(09:00-10:30)<br>[八]サンプル科目(11)<br>山田 太郎 他<br>八草 １－６０２<br>';
const CLASS_6 = 'Ⅵ限(18:00-19:30)<br>[八]夜間科目(X1)<br>鈴木 花子<br>八草 Ｇ２４０７<br>';

describe('parseSchedule', () => {
  it('授業（4 行）は時限・教員・教室を取り、6 限（Ⅵ限）も時刻を落とさない', () => {
    const html = week(['9/25(金)', '9/26(土)'], [cell(CLASS_A + LINE + CLASS_6), cell('')]);
    const days = parseSchedule(html, NOW);
    expect(days).toEqual([
      {
        date: '2026-09-25',
        events: [
          {
            title: 'サンプル科目(11)',
            startTime: '2026-09-25T09:00',
            endTime: '2026-09-25T10:30',
            period: 1,
            teacher: '山田 太郎',
            location: '八草 １－６０２',
          },
          {
            title: '夜間科目(X1)',
            startTime: '2026-09-25T18:00',
            endTime: '2026-09-25T19:30',
            period: 6,
            teacher: '鈴木 花子',
            location: '八草 Ｇ２４０７',
          },
        ],
      },
      { date: '2026-09-26', events: [] },
    ]);
  });

  it('1 行だけの予定（学校行事など）は終日の予定になる', () => {
    const days = parseSchedule(week(['9/30(水)'], [cell('履修登録(終了)<br>')]), NOW);
    expect(days[0].events).toEqual([
      { title: '履修登録(終了)', startTime: '2026-09-30T00:00', endTime: '2026-09-30T23:59' },
    ]);
  });

  it('想定外の行数の授業表記は捨てずに、科目以外の行を note に残す', () => {
    const days = parseSchedule(
      week(
        ['10/2(金)'],
        [cell('Ⅲ限(13:00-14:30)<br>[八]サンプル科目(11)<br>山田 太郎<br>八草 Ｇ３３０２<br>教室変更<br>')],
      ),
      NOW,
    );
    expect(days[0].events).toEqual([
      {
        title: 'サンプル科目(11)',
        startTime: '2026-10-02T13:00',
        endTime: '2026-10-02T14:30',
        period: 3,
        note: '山田 太郎 八草 Ｇ３３０２ 教室変更',
      },
    ]);
  });

  it('休講（実測: 印 1 行 + 時限・科目・教員の 3 行）は、その時限の授業として「休講」注記つきで残す', () => {
    const days = parseSchedule(
      week(
        ['6/23(火)'],
        [cell('【休講】<br>Ⅴ限(16:20-17:50)<br>教育原論(X1)<br>川口\u3000洋誉\u3000他<br>')],
      ),
      new Date('2026-06-20T12:00:00+09:00'),
    );
    expect(days[0].events).toEqual([
      {
        title: '教育原論(X1)',
        startTime: '2026-06-23T16:20',
        endTime: '2026-06-23T17:50',
        period: 5,
        teacher: '川口\u3000洋誉',
        note: '休講',
      },
    ]);
  });

  it('印が時限の行の先頭に付く 1 行の形も同じに扱う', () => {
    const days = parseSchedule(
      week(['6/23(火)'], [cell('【休講】 Ⅴ限(16:20-17:50) 教育原論(X1) 川口\u3000洋誉\u3000他')]),
      new Date('2026-06-20T12:00:00+09:00'),
    );
    expect(days[0].events[0]).toMatchObject({ title: '教育原論(X1)', period: 5, note: '休講' });
  });

  it('補講など、印が時限の行に付く 4 行表記も印を note に残す', () => {
    const days = parseSchedule(
      week(['6/24(水)'], [cell('【補講】 Ⅵ限(18:00-19:30)<br>[八]サンプル科目(11)<br>山田 太郎<br>八草 Ｇ３３０２<br>')]),
      new Date('2026-06-20T12:00:00+09:00'),
    );
    expect(days[0].events[0]).toMatchObject({
      title: 'サンプル科目(11)',
      period: 6,
      teacher: '山田 太郎',
      location: '八草 Ｇ３３０２',
      note: '補講',
    });
  });

  it('形が未知の複数行は、連結したタイトルの終日予定として残す', () => {
    const days = parseSchedule(week(['10/3(土)'], [cell('休講日<br>全学<br>')]), NOW);
    expect(days[0].events).toEqual([
      { title: '休講日 全学', startTime: '2026-10-03T00:00', endTime: '2026-10-03T23:59' },
    ]);
  });

  it('年をまたぐ週（12/30〜1/2）は 1 月が翌年になる', () => {
    const days = parseSchedule(
      week(['12/30(水)', '12/31(木)', '1/1(金)', '1/2(土)'], [cell(''), cell(''), cell(''), cell('')]),
      new Date('2026-12-30T12:00:00+09:00'),
    );
    expect(days.map((d) => d.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('JST で月をまたぐ直前後でも年の判定がずれない（UTC 12/31 15:00 = JST 1/1 0:00）', () => {
    const days = parseSchedule(
      week(['1/1(金)', '1/2(土)'], [cell(''), cell('')]),
      new Date('2026-12-31T15:00:00Z'),
    );
    expect(days.map((d) => d.date)).toEqual(['2027-01-01', '2027-01-02']);
  });

  it('過去の月の見出し（今日より前の月）は、基準日に近い年になる', () => {
    const html = week(['3/30(月)', '3/31(火)', '4/1(水)'], [cell(''), cell(''), cell('')]);
    expect(parseSchedule(html, new Date('2026-05-01T12:00:00+09:00')).map((d) => d.date)).toEqual([
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
    ]);
    // 基準日が 2027 年の 1 月なら、12 月は 2026 年、2 月は 2027 年。
    const h2 = week(['12/28(月)', '2/1(月)'], [cell(''), cell('')]);
    expect(parseSchedule(h2, new Date('2027-01-05T12:00:00+09:00')).map((d) => d.date)).toEqual([
      '2026-12-28',
      '2027-02-01',
    ]);
  });

  it('カレンダーが無ければ NotFoundError', () => {
    expect(() => parseSchedule('<html><body>x</body></html>', NOW)).toThrow();
  });
});

// ---- fetchSchedule（手順の検証） ----

const SP_TT = 'https://lcam.aitech.ac.jp/portalv2/smartphone/smartPhoneHome/nextPage/timeTable';
const INIT = 'https://lcam.aitech.ac.jp/portalv2/common/generalPurpose/';
const RELOAD = 'https://lcam.aitech.ac.jp/portalv2/home/home/reload';
const MOVE = 'https://lcam.aitech.ac.jp/portalv2/schedule/scheduleForHome/getSchedule';

function tokenInput(v: string): string {
  return `<form><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="${v}"></form>`;
}

afterEach(() => vi.unstubAllGlobals());

interface Call {
  url: string;
  method: string;
  body: string;
}

function stub(reloadPages: string[], initPage = page('T0', '9/25(金)', '')): Call[] {
  const calls: Call[] = [];
  let r = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: String(init.body ?? '') });
    if (url === SP_TT) return new Response(tokenInput('SPTOKEN'), { status: 200 });
    if (url === INIT) return new Response(initPage, { status: 200 });
    if (url === RELOAD) return new Response(reloadPages[r++] ?? reloadPages.at(-1)!, { status: 200 });
    if (url === MOVE) return new Response('{}', { status: 200 });
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

function page(token: string, head: string, inner: string): string {
  return tokenInput(token) + week([head], [cell(inner)]);
}

describe('fetchSchedule', () => {
  it('SP の token で reload → 今日に揃える → 週ごとに reload して次の token を引き継ぐ', async () => {
    const calls = stub([
      page('T2', '9/25(金)', CLASS_A),
      page('T3', '10/2(金)', '履修登録(終了)<br>'),
    ]);
    const days = await fetchSchedule(cookies, 2);

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://lcam.aitech.ac.jp/portalv2', '')}`)).toEqual([
      'GET /smartphone/smartPhoneHome/nextPage/timeTable',
      'POST /common/generalPurpose/', // メニュー「ホーム」
      'POST /schedule/scheduleForHome/getSchedule', // 今日
      'POST /home/home/reload',
      'POST /schedule/scheduleForHome/getSchedule', // 翌週
      'POST /home/home/reload',
    ]);
    // token は直前のページのものを使う。
    const init = new URLSearchParams(calls[1].body);
    expect(init.get('org.apache.struts.taglib.html.TOKEN')).toBe('SPTOKEN');
    expect(init.get('menuCode')).toBe('Z07');
    expect(init.get('nextPath')).toBe('/home/home/initialize');
    expect(calls[3].body).toContain('TOKEN=T0');
    expect(calls[5].body).toContain('TOKEN=T2');
    expect(new URLSearchParams(calls[2].body).get('_mode')).toBe('4');
    expect(new URLSearchParams(calls[4].body).get('_mode')).toBe('5');

    expect(days.map((d) => d.date)).toEqual(['2026-09-25', '2026-10-02']);
    expect(days[0].events[0].title).toBe('サンプル科目(11)');
    expect(days[1].events[0].title).toBe('履修登録(終了)');
  });

  it('PC 画面が「不正な操作」を返したら UpstreamError（LcamExpiredError にしない）', async () => {
    stub([], '<html><body>不正な操作が行われました。</body></html>');
    const p = fetchSchedule(cookies, 1);
    await expect(p).rejects.toBeInstanceOf(UpstreamError);
    await expect(p).rejects.not.toBeInstanceOf(LcamExpiredError);
  });

  it('システムエラーのページ（想定外の応答）も UpstreamError', async () => {
    stub([], '<html><body>システムエラーにより利用を継続することができなくなりました。</body></html>');
    await expect(fetchSchedule(cookies, 1)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('SP ページに token が無ければセッション喪失（LcamExpiredError）', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>ログインされていないため</html>', { status: 200 }));
    await expect(fetchSchedule(cookies, 1)).rejects.toBeInstanceOf(LcamExpiredError);
  });

  it('週数は 1〜14 に丸める', async () => {
    const calls = stub([page('T', '9/25(金)', '')]);
    await fetchSchedule(cookies, 99);
    // SP 1 + 初回 開く/move 2 + 14 週の reload 14 + 途中の move 13
    expect(calls.length).toBe(1 + 2 + 14 + 13);
  });

  it('month 指定は、今日に揃えたあと月送り（前月=2 / 翌月=6）してから週を取る', async () => {
    const modes = (calls: Call[]) =>
      calls
        .filter((c) => c.url === MOVE)
        .map((c) => new URLSearchParams(c.body).get('_mode'));

    let calls = stub([page('T', '3/30(月)', '')]);
    await fetchSchedule(cookies, 1, -3);
    expect(modes(calls)).toEqual(['4', '2', '2', '2']);

    calls = stub([page('T', '9/28(月)', '')]);
    await fetchSchedule(cookies, 1, 2);
    expect(modes(calls)).toEqual(['4', '6', '6']);

    // 0 は「今月の 1 日を含む週」: 前月→翌月で戻る。
    calls = stub([page('T', '8/31(月)', '')]);
    await fetchSchedule(cookies, 1, 0);
    expect(modes(calls)).toEqual(['4', '2', '6']);
  });

  it('month 指定で過去の月を取っても、年は基準日に近いほうになる（3 月は今年）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T12:00:00+09:00'));
    try {
      stub([page('T', '3/30(月)', '')]);
      const days = await fetchSchedule(cookies, 1, -6);
      expect(days[0].date).toBe('2026-03-30');
    } finally {
      vi.useRealTimers();
    }
  });
});
