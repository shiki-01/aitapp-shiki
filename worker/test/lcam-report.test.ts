import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseReportList,
  parseReportDetail,
  fetchReportList,
  fetchReportDetail,
  downloadReportFile,
} from '../src/upstream/lcam/report';
import { LcamExpiredError, NotFoundError, UpstreamError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp/portalv2';
const T = 'org.apache.struts.taglib.html.TOKEN';

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML。個人情報・実際の課題文は含めない。
function listPage(
  token: string,
  rows: Array<{ id: string; ops?: string; status?: string }>,
  sel = { year: '2026', sem: '2' },
): string {
  const trs = rows
    .map(
      (r) =>
        `<tr class="odd"><td class="left">[八]サンプル科目(1A)<br> 後期/木1 </td>` +
        `<td class="left"><a href="javascript:void(0);" onclick="formSubmit('forwardSubmitRef', '${r.id}','');">課題${r.id}</a></td>` +
        `<td class="left">${r.status ?? '受付中'}</td><td class="left">2026/09/23 18:00 ～ 2026/09/24 23:00</td>` +
        `<td class="left">2026/09/24 22:25</td><td class="left">Web</td><td class="center"><!-- 注釈 -->${r.ops ?? ''}</td>` +
        `<td style="display:none">2</td><td style="display:none">${r.id}</td></tr>`,
    )
    .join('');
  return (
    `<form name="report_student_searchListActionForm" method="post" action="/portalv2/report/student/searchList/">` +
    `<input type="hidden" name="${T}" value="${token}"><input type="hidden" name="reportId" value="">` +
    `<select name="schoolYear"><option value="2025">2025</option><option value="${sel.year}" selected>${sel.year}</option></select>` +
    `<select name="semesterCode"><option value="">▼</option><option value="1">前期</option><option value="${sel.sem}" selected>後期</option></select>` +
    `<table id="searchList" class="display"><thead><tr><th>授業科目</th><th>タイトル</th></tr></thead><tbody>${trs}</tbody></table></form>`
  );
}

function refPage(token: string): string {
  return (
    `<form name="classsupport_fileDownloadActionForm"><input type="hidden" name="${T}" value="${token}"><input type="hidden" name="prefix" value=""></form>` +
    `<form name="report_student_submitReportReferenceActionForm" method="post" action="/portalv2/report/student/submitReportReference/initialize">` +
    `<input type="hidden" name="${T}" value="${token}"><input type="hidden" name="reportId" value="13193">` +
    `<input type="hidden" name="submitStatusCode" value="null"><input type="hidden" name="studentName" value="テスト 太郎">` +
    `<input type="hidden" name="studentCode" value="X00000"><input type="hidden" name="submitNo" value=""><input type="hidden" name="fileNo" value="">` +
    `<input type="hidden" name="backPath" value="/report/student/searchList/initialize"><input type="hidden" name="operationFormatCode" value="1"></form>` +
    `<table class="ttb_entry"><tbody>` +
    `<tr><th class="center th_summary" rowspan="6">締切</th><th class="center">タイトル</th><td class="left">サンプル課題</td></tr>` +
    `<tr><th class="center">提出期間</th><td class="left">2026/09/23 18:00 ～ 2026/09/24 23:00</td></tr>` +
    `<tr><th class="center">評価方法</th><td class="left">点数（上限 200点）</td></tr>` +
    `<tr><th class="center">説明</th><td class="left">1 行目<br>2 行目</td></tr>` +
    `<tr><th class="center">参考資料</th><td class="left">&nbsp;</td></tr>` +
    `<tr><th class="center">伝達事項</th><td class="left">連絡です<br></td></tr>` +
    `</tbody></table>` +
    `<div align="left"><h3 class="h3_bg"><span class="h3-txt">催促通知</span></h3><br><div class="noData">登録されていません。</div><br><br>` +
    `<h3 class="h3_bg"><span class="h3-txt">評価結果</span></h3><div>得点 180 点</div>` +
    `<h3 class="h3_bg"><span class="h3-txt">レポート提出履歴</span></h3><br>` +
    `<table class="ttb_entry"><tbody><tr><td><table class="ttb_entry_inner"><tbody>` +
    `<tr><td class="cell02"><label>1.comment by&nbsp;テスト 太郎&nbsp;2026/09/24 22:25</label></td></tr>` +
    `<tr><td class="cell02"><label>提出しました</label></td></tr>` +
    `<tr><td class="cell02"><a href="javascript:void(0);" onclick="historyFileDownload('X00000','1','1')">IMG_0001.jpg</a><br>` +
    `<a href="javascript:void(0);" onclick="historyFileDownload('X00000','1','2')">IMG_0002.jpg</a></td></tr>` +
    `</tbody></table></td></tr></tbody></table></div>`
  );
}

describe('parseReportList', () => {
  it('7 列の表示列と、提出/提出取消ボタン・隠し列の無視', () => {
    const items = parseReportList(
      listPage('T1', [{ id: '1', status: '締切' }, { id: '2', ops: '<a>提出</a>' }, { id: '3', ops: '<a>提出取消</a>' }]),
    );
    expect(items[0]).toEqual({
      id: '1', subject: '[八]サンプル科目(1A)', term: '後期/木1', title: '課題1', status: '締切',
      period: '2026/09/23 18:00 ～ 2026/09/24 23:00', lastSubmittedAt: '2026/09/24 22:25', format: 'Web',
      canSubmit: false, canCancel: false,
    });
    expect([items[1].canSubmit, items[1].canCancel]).toEqual([true, false]);
    expect([items[2].canSubmit, items[2].canCancel]).toEqual([false, true]);
  });
  it('0 件は空配列、画面が違えば UpstreamError', () => {
    expect(parseReportList(listPage('T1', []))).toEqual([]);
    expect(() => parseReportList('<html>別画面</html>')).toThrow(UpstreamError);
  });
});

describe('parseReportDetail', () => {
  it('項目・状態・提出履歴（本文行とファイル）・催促通知を読む', () => {
    const d = parseReportDetail(refPage('T2'), '13193');
    expect(d).toMatchObject({
      id: '13193', status: '締切', title: 'サンプル課題', period: '2026/09/23 18:00 ～ 2026/09/24 23:00',
      evaluation: '点数（上限 200点）', description: '1 行目\n2 行目', notice: '連絡です', reminder: '登録されていません。', result: ['得点 180 点'],
    });
    expect(d.submissions).toEqual([
      {
        heading: '1.comment by テスト 太郎 2026/09/24 22:25',
        lines: ['提出しました'],
        files: [
          { studentCode: 'X00000', submitNo: 1, fileNo: 1, name: 'IMG_0001.jpg' },
          { studentCode: 'X00000', submitNo: 1, fileNo: 2, name: 'IMG_0002.jpg' },
        ],
      },
    ]);
  });
});

afterEach(() => vi.unstubAllGlobals());

interface Call { method: string; path: string; body: URLSearchParams }
function stub(opts: { list?: (c: Call) => string; download?: () => Response } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(BASE, '');
    const call = { method: String(init.method ?? 'GET'), path, body: new URLSearchParams(String(init.body ?? '')) };
    calls.push(call);
    if (path === '/smartphone/smartPhoneHome/nextPage/timeTable') return new Response(`<input type="hidden" name="${T}" value="SP">`);
    if (path === '/common/generalPurpose/') return new Response(opts.list?.(call) ?? listPage('T1', [{ id: '13193' }]));
    if (path === '/report/student/searchList/search') return new Response(listPage('T1S', [{ id: '13193' }], { year: '2025', sem: '1' }));
    if (path === '/report/student/searchList/forwardSubmitRef') return new Response(refPage('T2'));
    if (path.startsWith('/report/student/submitReportReference/fileDownload')) {
      return opts.download?.() ?? new Response('JPEG', { headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('fetchReportList', () => {
  it('既定は検索せずメニュー A02 の一覧を返す', async () => {
    const calls = stub();
    const items = await fetchReportList(cookies);
    expect(items.map((i) => i.id)).toEqual(['13193']);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /smartphone/smartPhoneHome/nextPage/timeTable',
      'POST /common/generalPurpose/',
    ]);
    expect(calls[1].body.get('menuCode')).toBe('A02');
    expect(calls[1].body.get('nextPath')).toBe('/report/student/searchList/initialize');
  });

  it('年度・学期を指定すると search へ POST（指定しない方は画面の選択中の値、実施形式は両方）', async () => {
    const calls = stub();
    await fetchReportList(cookies, { year: 2025 });
    const search = calls.at(-1)!;
    expect(search.path).toBe('/report/student/searchList/search');
    expect(search.body.get(T)).toBe('T1');
    expect(search.body.get('schoolYear')).toBe('2025');
    expect(search.body.get('semesterCode')).toBe('2');
    expect(search.body.getAll('operationFormat')).toEqual(['1', '2']);
    expect(search.body.has('submitStatus')).toBe(false);
  });

  it('未提出のみは submitStatus=0', async () => {
    const calls = stub();
    await fetchReportList(cookies, { unsubmittedOnly: true });
    expect(calls.at(-1)!.body.get('submitStatus')).toBe('0');
  });

  it('メニューがログイン画面なら LcamExpiredError', async () => {
    stub({ list: () => '<html>ログインされていないため</html>' });
    await expect(fetchReportList(cookies)).rejects.toBeInstanceOf(LcamExpiredError);
  });
});

describe('fetchReportDetail / downloadReportFile', () => {
  it('一覧 → forwardSubmitRef（TOKEN と reportId のみ）', async () => {
    const calls = stub();
    const d = await fetchReportDetail(cookies, '13193');
    expect(d.title).toBe('サンプル課題');
    const ref = calls.at(-1)!;
    expect(ref.path).toBe('/report/student/searchList/forwardSubmitRef');
    expect(ref.body.get(T)).toBe('T1');
    expect(ref.body.get('reportId')).toBe('13193');
  });

  it('一覧に無い ID は NotFoundError', async () => {
    stub();
    await expect(fetchReportDetail(cookies, '999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ダウンロードは参照画面のフォームの項目を送り、提出物の 3 項目だけ差し替える', async () => {
    const calls = stub();
    const res = await downloadReportFile(cookies, '13193', 1, 2);
    expect(await res.text()).toBe('JPEG');
    const dl = calls.at(-1)!;
    expect(dl.path).toBe('/report/student/submitReportReference/fileDownload?EXCLUDE_SET=');
    expect(Object.fromEntries(dl.body)).toEqual({
      [T]: 'T2', reportId: '13193', submitStatusCode: 'null', studentName: 'テスト 太郎', studentCode: 'X00000',
      submitNo: '1', fileNo: '2', backPath: '/report/student/searchList/initialize', operationFormatCode: '1',
    });
  });

  it('詳細に無い提出物は NotFoundError（クライアントの指定は信用しない）', async () => {
    stub();
    await expect(downloadReportFile(cookies, '13193', 9, 9)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ファイルの代わりにログイン画面が返ったら LcamExpiredError', async () => {
    stub({ download: () => new Response('<html>ログインされていないため</html>', { headers: { 'content-type': 'text/html' } }) });
    await expect(downloadReportFile(cookies, '13193', 1, 1)).rejects.toBeInstanceOf(LcamExpiredError);
  });
});
