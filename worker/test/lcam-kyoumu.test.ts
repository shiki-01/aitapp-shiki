import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  tableGrid,
  parseHandoff,
  parseKyoumuMenu,
  parseCreditStatus,
  parseCurriculum,
  parseSchoolEventMonth,
  parseNendo,
  parseLotteryResults,
  fetchCreditStatus,
  fetchSchoolEvents,
  kyoumuGet,
  prepareKyoumuHandoff,
} from '../src/upstream/lcam/kyoumu';
import { handoffPage } from '../src/handoff-page';
import { parseHtml } from '../src/html/parser';
import { UpstreamError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=portal', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp';
const T = 'org.apache.struts.taglib.html.TOKEN';

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML。個人情報・実際の成績は含めない。
const HANDOFF =
  `<html><body onload="postCooperation()"><form name="ssoCooperation" action="${BASE}/kyoumu/portalRedirect.do;JSESSIONID=SESSK.kmap2" method="post">` +
  `<input type="hidden" name="loginID" value="x00000"/></form></body></html>`;

const MENU =
  `<html><body>` +
  `<a href="#" onclick="dbLinkClick('/kyoumu/taniShuutokuJouhouSearchInit.do;jsessionid=SESSK?mainMenuCode=009&parentMenuCode=007');">単位修得情報の参照</a>` +
  `<a href="#" onclick="dbLinkClick('/kyoumu/curriculumReference.do;jsessionid=SESSK?mainMenuCode=010&parentMenuCode=007');">カリキュラムの参照</a>` +
  `<a href="#" onclick="dbLinkClick('/kyoumu/schoolEventSchedule.do;jsessionid=SESSK?mainMenuCode=017&parentMenuCode=014');">学内スケジュール</a>` +
  `<a href="#" onclick="dbLinkClick('/syllabus2/syllabusSearchInit.do;jsessionid=SESSK?mainMenuCode=015');">シラバス参照</a>` +
  `<a href="javascript:void(0);">ログアウト</a>` +
  `</body></html>`;

// 単位修得情報: 要件の階層を rowspan で描く表（見出し 2 行 + データ行）。
const CREDIT =
  `<html><body><table><tr><td>卒業進級用１年 卒業進級用２年</td></tr></table>` +
  `<table class="txt12">` +
  `<tr><td colspan="2">要件情報</td><td colspan="2">成績情報</td></tr>` +
  `<tr><td>科目区分</td><td>単位区分</td><td>必要単位(A)</td><td>修得単位(C)</td></tr>` +
  `<tr><td rowspan="2">専門教育科目</td><td>必修</td><td>11</td><td>11</td></tr>` +
  `<tr><td>選択</td><td>7</td><td>7</td></tr>` +
  `</table><table class="txt12"><tr><td>総修得単位数</td><td>35 単位以上</td></tr></table></body></html>`;

const CURRICULUM =
  `<html><body><table class="txt12"><tr><td>科目コード</td><td>科目名</td><td>科目区分</td><td>単位区分</td><td>単位</td><td>評価</td></tr>` +
  `<tr><td>A2103000</td><td>微分方程式</td><td>専門（他学科等）</td><td>選択</td><td>2</td><td></td></tr>` +
  `<tr><td>B0101000</td><td>英語１</td><td>総合（必修）</td><td>必修</td><td>1</td><td>A</td></tr></table></body></html>`;

function eventsPage(nendo: number, rows: Array<[string, string, string, string]>): string {
  return (
    `<html><body><table><tr><td>${nendo}年度</td></tr></table><table><tr><td>4月</td><td>5月</td></tr></table>` +
    `<table><tr><td>日</td><td>曜日</td><td>祝祭日</td><td>行事</td></tr>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    `</table></body></html>`
  );
}

describe('tableGrid', () => {
  it('rowspan / colspan を展開して、各行の長さが同じ表にする', () => {
    const t = parseHtml(CREDIT).querySelectorAll('table.txt12')[0];
    expect(tableGrid(t)).toEqual([
      ['要件情報', '要件情報', '成績情報', '成績情報'],
      ['科目区分', '単位区分', '必要単位(A)', '修得単位(C)'],
      ['専門教育科目', '必修', '11', '11'],
      ['専門教育科目', '選択', '7', '7'],
    ]);
  });
});

describe('parseHandoff / parseKyoumuMenu', () => {
  it('引き渡しフォームから action と loginID を取る', () => {
    expect(parseHandoff(HANDOFF)).toEqual({
      action: `${BASE}/kyoumu/portalRedirect.do;JSESSIONID=SESSK.kmap2`,
      loginId: 'x00000',
    });
  });
  it('/kyoumu/ の外や別ホストの action は拒否する', () => {
    expect(() => parseHandoff(HANDOFF.replace('/kyoumu/', '/evil/'))).toThrow(UpstreamError);
    expect(() => parseHandoff(HANDOFF.replace(BASE, 'https://example.com'))).toThrow(UpstreamError);
    expect(() => parseHandoff('<html>不正な操作が行われました</html>')).toThrow(UpstreamError);
  });
  it('メニューは dbLinkClick のリンクだけを表示名で引ける（範囲外のパスは除く）', () => {
    const links = parseKyoumuMenu(MENU);
    expect([...links.keys()]).toEqual(['単位修得情報の参照', 'カリキュラムの参照', '学内スケジュール', 'シラバス参照']);
    expect(links.get('学内スケジュール')).toBe('/kyoumu/schoolEventSchedule.do;jsessionid=SESSK?mainMenuCode=017&parentMenuCode=014');
  });
});

const LOTTERY_HEAD =
  '<tr><td>曜日時限</td><td>ナンバリング</td><td>科目名</td><td>クラスコード</td><td>隔週授業</td><td>科目区分</td><td>単位区分</td><td>単位数</td><td>校舎区分</td><td>定員</td><td>希望順位</td><td>抽選結果</td><td>抽選処理日</td></tr>';
const LOTTERY =
  `<html><body><div>抽選履修登録結果</div>` +
  `<table class="txt12">${LOTTERY_HEAD}<tr><td>火Ⅳ</td><td></td><td>サンプル概論</td><td>A2</td><td></td><td>総合（選択）</td><td>選択</td><td>2</td><td>八草</td><td>3</td><td>1</td><td>当選</td><td>2026/09/18</td></tr></table>` +
  `<table class="txt12">${LOTTERY_HEAD}<tr><td>水Ⅱ</td><td></td><td>別科目</td><td>B2</td><td></td><td>総合（選択）</td><td>選択</td><td>2</td><td>八草</td><td>0</td><td>2</td><td></td><td></td></tr></table>` +
  `</body></html>`;

describe('parse pages', () => {
  it('単位修得情報: タブ・見出し行数・展開済みの表・注記', () => {
    const c = parseCreditStatus(CREDIT);
    expect(c.tabs).toEqual(['卒業進級用１年', '卒業進級用２年']);
    expect(c.headerRows).toBe(2);
    expect(c.rows[3]).toEqual(['専門教育科目', '選択', '7', '7']);
    expect(c.note).toBe('総修得単位数 35 単位以上');
    expect(() => parseCreditStatus('<html>別画面</html>')).toThrow(UpstreamError);
  });

  it('抽選履修登録結果: 曜日時限ごとの表を平らに読む（処理前は当落・処理日が空）', () => {
    const r = parseLotteryResults(LOTTERY);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      slot: '火Ⅳ', subject: 'サンプル概論', classCode: 'A2', biweekly: '', category: '総合（選択）', creditType: '選択',
      credits: 2, campus: '八草', capacity: 3, preference: 1, result: '当選', processedAt: '2026/09/18',
    });
    expect([r[1].result, r[1].processedAt]).toEqual(['', '']);
    expect(parseLotteryResults('<html><body>抽選履修登録結果</body></html>')).toEqual([]);
    expect(() => parseLotteryResults('<html>別画面</html>')).toThrow(UpstreamError);
  });

  it('カリキュラム: 見出し行を除いて科目を読む', () => {
    expect(parseCurriculum(CURRICULUM)).toEqual([
      { code: 'A2103000', name: '微分方程式', category: '専門（他学科等）', creditType: '選択', credits: 2, grade: '' },
      { code: 'B0101000', name: '英語１', category: '総合（必修）', creditType: '必修', credits: 1, grade: 'A' },
    ]);
  });

  it('学内スケジュール: 月の表を日付つきで読む。1〜3 月は翌年', () => {
    const html = eventsPage(2026, [['1', '火', '', ''], ['4', '金', '', '卒業判定通知発送'], ['23', '水', '秋分の日', '']]);
    expect(parseNendo(html)).toBe(2026);
    expect(parseSchoolEventMonth(html, 9, 2026).days).toEqual([
      { date: '2026-09-01', weekday: '火', holiday: '', event: '' },
      { date: '2026-09-04', weekday: '金', holiday: '', event: '卒業判定通知発送' },
      { date: '2026-09-23', weekday: '水', holiday: '秋分の日', event: '' },
    ]);
    expect(parseSchoolEventMonth(html, 2, 2026).days[0].date).toBe('2027-02-01');
  });
});

// ---- 遷移の検証 ----

afterEach(() => vi.unstubAllGlobals());

interface Call { method: string; url: string; headers: Record<string, string>; body: string }

function stub(pages: Record<string, string>, menuBody: string = MENU): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const u = String(url);
    calls.push({ method: String(init.method ?? 'GET'), url: u, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? '') });
    const path = u.replace(BASE, '');
    if (path === '/portalv2/smartphone/smartPhoneHome/nextPage/timeTable') return new Response(`<input type="hidden" name="${T}" value="SP">`);
    if (path === '/portalv2/common/generalPurpose/') {
      return new Response(`<form name="home_systemCooperationLink" action="/portalv2/home/systemCooperationLink/"><input type="hidden" name="${T}" value="H1"></form>`);
    }
    if (path.startsWith('/portalv2/home/systemCooperationLink/initialize')) return new Response(HANDOFF);
    if (path.startsWith('/kyoumu/portalRedirect.do')) {
      const h = new Headers();
      h.append('set-cookie', 'JSESSIONID=SESSK.kmap2; Path=/kyoumu; HttpOnly');
      return new Response(menuBody, { headers: h });
    }
    if ((init.headers as Record<string, string>)?.Cookie !== 'JSESSIONID=SESSK.kmap2') return new Response('error', { status: 500 });
    for (const [key, html] of Object.entries(pages)) if (path.includes(key)) return new Response(html);
    return new Response('not found', { status: 404 });
  });
  return calls;
}

describe('openKyoumu / fetch*', () => {
  it('ホームのフォームの token → 引き渡し → loginID を POST（LCAM の Cookie は送らない）→ 学事の Cookie で GET', async () => {
    const calls = stub({ taniShuutokuJouhouSearchInit: CREDIT });
    const c = await fetchCreditStatus(cookies);
    expect(c.note).toBe('総修得単位数 35 単位以上');
    expect(calls.map((x) => `${x.method} ${x.url.replace(BASE, '').replace(/;.*/, '').replace(/\?.*/, '')}`)).toEqual([
      'GET /portalv2/smartphone/smartPhoneHome/nextPage/timeTable',
      'POST /portalv2/common/generalPurpose/',
      'POST /portalv2/home/systemCooperationLink/initialize',
      'POST /kyoumu/portalRedirect.do',
      'GET /kyoumu/taniShuutokuJouhouSearchInit.do',
    ]);
    expect(new URLSearchParams(calls[2].body).get(T)).toBe('H1');
    expect(new URLSearchParams(calls[3].body).get('loginID')).toBe('x00000');
    expect(calls[3].headers.Cookie).toBeUndefined(); // 本体の Cookie は学事システムに送らない
    expect(calls[4].headers.Cookie).toBe('JSESSIONID=SESSK.kmap2');
    expect(calls[4].url).toContain(';jsessionid=SESSK'); // メニューのリンクをそのまま使う
  });

  it('学内スケジュール all: 12 か月を GET（月の切替は changeTarget=month&targetMonth）', async () => {
    const calls = stub({ schoolEventSchedule: eventsPage(2026, [['1', '火', '', '']]) });
    const ev = await fetchSchoolEvents(cookies, 'all');
    expect(ev.nendo).toBe(2026);
    expect(ev.months.map((m) => m.month)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]);
    const gets = calls.filter((x) => x.url.includes('schoolEventSchedule'));
    // 月の切り替えの前に、通常の表示を 1 回 GET する（切り替えだけだと別の画面が返る。実測）。
    expect(gets).toHaveLength(13);
    expect(gets[0].url).not.toContain('actionStatus');
    expect(gets[1].url).toContain('?mainMenuCode=017&parentMenuCode=014&actionStatus=change&changeTarget=month&targetMonth=4');
  });

  it('メニューの本文が空（アプリ方式のセッション）でも、学事の Cookie があれば既定のリンクで各画面を GET する', async () => {
    const calls = stub({ taniShuutokuJouhouSearchInit: CREDIT }, '');
    const c = await fetchCreditStatus(cookies);
    expect(c.note).toBe('総修得単位数 35 単位以上');
    const last = calls[calls.length - 1];
    expect(last.url).toBe(`${BASE}/kyoumu/taniShuutokuJouhouSearchInit.do?mainMenuCode=009&parentMenuCode=007`);
    expect(last.headers.Cookie).toBe('JSESSIONID=SESSK.kmap2');
  });

  it('メニューの本文が空でなくリンクも無い（エラー画面など）なら、既定のリンクは使わず UpstreamError', async () => {
    stub({}, '<html>エラー</html>');
    await expect(fetchCreditStatus(cookies)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('学事システムの外のパスは取得しない。500（セッション切れ）は UpstreamError', async () => {
    stub({});
    await expect(kyoumuGet({ cookie: 'x', links: new Map(), menuUrl: BASE }, '/portalv2/common/generalPurpose/')).rejects.toBeInstanceOf(UpstreamError);
    await expect(kyoumuGet({ cookie: 'wrong', links: new Map(), menuUrl: BASE }, '/kyoumu/x.do')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('prepareKyoumuHandoff / handoffPage', () => {
  it('引き渡しの手前（フォームの宛先と loginID）で止まる。学事システムには何も POST しない', async () => {
    const calls = stub({});
    const h = await prepareKyoumuHandoff(cookies);
    expect(h).toEqual({ action: `${BASE}/kyoumu/portalRedirect.do;JSESSIONID=SESSK.kmap2`, loginId: 'x00000' });
    expect(calls.some((c) => c.url.includes('/kyoumu/'))).toBe(false);
  });

  it('自動送信フォームのページ: 値をエスケープし、キャッシュ・Referer を止め、送信先・フレームを LCAM に限る。POST は iframe に向け、着地先へ移動する', async () => {
    const res = handoffPage(`${BASE}/kyoumu/portalRedirect.do;JSESSIONID=A"B`, 'x"><script>', '/kyoumu/chuusenRishuuInit.do?mainMenuCode=019');
    const html = await res.text();
    expect(html).toContain('action="https://lcam.aitech.ac.jp/kyoumu/portalRedirect.do;JSESSIONID=A&quot;B"');
    expect(html).toContain('value="x&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain('<script>"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain('form-action https://lcam.aitech.ac.jp');
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://lcam.aitech.ac.jp');
    expect(html).toContain('<iframe name="h" hidden></iframe>');
    expect(html).toContain('method="post" target="h"');
    expect(html).toContain('location.replace("https://lcam.aitech.ac.jp/kyoumu/chuusenRishuuInit.do?mainMenuCode=019")');
    const nonce = /nonce-([^']+)'/.exec(res.headers.get('content-security-policy')!)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
  });
});
