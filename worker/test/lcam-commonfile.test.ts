import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCommonFileList,
  parseCommonFileDetail,
  downloadPath,
  fetchCommonFileDetail,
  downloadCommonFile,
} from '../src/upstream/lcam/commonfile';
import { LcamExpiredError, NotFoundError, UpstreamError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp/portalv2';
const TOKEN = 'org.apache.struts.taglib.html.TOKEN';

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML（先頭の空の列・末尾の並べ替え用の列も実物どおり）。個人情報・実ファイルは含めない。
function listPage(token: string, rows: Array<[string, string, string, string, string]>): string {
  const trs = rows
    .map(
      (r, i) =>
        `<tr class="even"><td></td><td>${r[0]}</td><td><a href="javascript:moveToDetail(${i})">${r[1]}</a></td>` +
        `<td class="right">${r[2]}</td><td class="right">${r[3]}</td><td>${r[4]}</td><td>1マニュアル</td><td>825582</td></tr>`,
    )
    .join('');
  const ids = rows.map((_, i) => `<input type="hidden" name="detailCommonFileId" value="${100 + i}">`).join('');
  return (
    `<html><body><form name="commonfile_commonFileActionForm" method="post" action="/portalv2/commonfile/commonFile/">` +
    `<input type="hidden" name="${TOKEN}" value="${token}">` +
    `<table id="tbl_commonFileList" class="display tr-color"><thead><tr><th></th><th>カテゴリ（タグ）</th><th>タイトル</th><th>DL数</th><th>サイズ</th><th>更新日時</th><th></th><th></th></tr></thead>` +
    `<tbody>${trs}</tbody></table>${ids}<input type="hidden" name="prevPageId" value="backToList"></form></body></html>`
  );
}

const ROWS: Array<[string, string, string, string, string]> = [
  ['教務グループ （マニュアル）', '成績の参照方法について', '215', '1.58 MB', '2024/08/23 11:57'],
  ['教務グループ （マニュアル）', '履修の手引き', '320', '7.96 MB', '2026/03/27 14:53'],
];

function detailPage(token: string): string {
  return (
    `<html><body><form name="commonfile_commonFileDetailActionForm" method="post" action="/portalv2/commonfile/commonFileDetail/">` +
    `<input type="hidden" name="${TOKEN}" value="${token}"><input type="hidden" name="hiddenCommonFileId" value="101">` +
    `<input type="hidden" name="prevPageId" value="backToDetail"></form>` +
    `<table class="ttb_entry"><tbody>` +
    `<tr><th class="wid180">タイトル</th><td>履修の手引き</td></tr>` +
    `<tr><th>カテゴリ（タグ）</th><td>教務グループ (マニュアル)</td></tr>` +
    `<tr><th>ファイル</th><td><div id="fileList_COMMON_FILE_FILE">` +
    `<div id="fileList_COMMON_FILE_FILE_1"><a href="javascript:void(0);" onclick="fileDownLoad('COMMON_FILE_FILE', '1', '履修の手引き2026.pdf');"> 履修の手引き2026.pdf </a> &nbsp;&nbsp;(3.43 MB)</div>` +
    `<div id="fileList_COMMON_FILE_FILE_2"><a href="javascript:void(0);" onclick="fileDownLoad('COMMON_FILE_FILE', '2', '【Word版】履修の手引き.v2.docx');"> 【Word版】履修の手引き.v2.docx </a> &nbsp;&nbsp;(4.53 MB)</div>` +
    `</div></td></tr>` +
    `<tr><th>ファイル説明</th><td>履修登録・削除方法について<br>記載しています。</td></tr>` +
    `<tr><th>公開期間</th><td>2026/03/27 &nbsp;～&nbsp; 2027/03/31 </td></tr>` +
    `</tbody></table></body></html>`
  );
}

describe('parseCommonFileList', () => {
  it('行の並びと detailCommonFileId の並びを対応づけて読む', () => {
    const items = parseCommonFileList(listPage('T1', ROWS));
    expect(items).toEqual([
      { id: '100', category: '教務グループ （マニュアル）', title: '成績の参照方法について', downloadCount: 215, size: '1.58 MB', updatedAt: '2024/08/23 11:57' },
      { id: '101', category: '教務グループ （マニュアル）', title: '履修の手引き', downloadCount: 320, size: '7.96 MB', updatedAt: '2026/03/27 14:53' },
    ]);
  });

  it('0 件（表は在るが行が無い）は空配列', () => {
    expect(parseCommonFileList(listPage('T1', []))).toEqual([]);
  });

  it('一覧の form が無ければ UpstreamError（構造変化を空配列にしない）', () => {
    expect(() => parseCommonFileList('<html><body>別の画面</body></html>')).toThrow(UpstreamError);
  });
});

describe('parseCommonFileDetail', () => {
  it('タイトル・カテゴリ・説明・公開期間・ファイルを読む', () => {
    const d = parseCommonFileDetail(detailPage('T2'), '101');
    expect(d.title).toBe('履修の手引き');
    expect(d.category).toBe('教務グループ (マニュアル)');
    expect(d.description).toBe('履修登録・削除方法について\n記載しています。');
    expect(d.publicPeriod).toBe('2026/03/27 ～ 2027/03/31');
    expect(d.files).toEqual([
      { prefix: 'COMMON_FILE_FILE', no: 1, name: '履修の手引き2026.pdf', size: '3.43 MB' },
      { prefix: 'COMMON_FILE_FILE', no: 2, name: '【Word版】履修の手引き.v2.docx', size: '4.53 MB' },
    ]);
  });
});

describe('downloadPath', () => {
  it('拡張子があれば fileDownLoad2/{拡張子除き・ドット除去}（画面の fileDownLoad() と同じ）', () => {
    expect(downloadPath('/x/y', { prefix: 'P', no: 2, name: '【Word版】履修の手引き.v2.docx' })).toBe(
      `/x/y/fileDownLoad2/${encodeURIComponent('【Word版】履修の手引きv2')}?EXCLUDE_SET=&prefix=P&no=2`,
    );
  });
  it('拡張子が無ければ fileDownLoad', () => {
    expect(downloadPath('/x/y', { prefix: 'P', no: 1, name: 'README' })).toBe('/x/y/fileDownLoad?EXCLUDE_SET=&prefix=P&no=1');
  });
});

// ---- 遷移の検証 ----

afterEach(() => vi.unstubAllGlobals());

interface Call {
  method: string;
  path: string;
  body: URLSearchParams;
}

function stub(opts: { download?: () => Response; list?: string; detail?: string } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(BASE, '');
    calls.push({ method: String(init.method ?? 'GET'), path, body: new URLSearchParams(String(init.body ?? '')) });
    if (path === '/smartphone/smartPhoneHome/nextPage/timeTable') {
      return new Response(`<form><input type="hidden" name="${TOKEN}" value="SP"></form>`, { status: 200 });
    }
    if (path === '/common/generalPurpose/') return new Response(opts.list ?? listPage('T1', ROWS), { status: 200 });
    if (path === '/commonfile/commonFileDetail/initialize') return new Response(opts.detail ?? detailPage('T2'), { status: 200 });
    if (path.startsWith('/commonfile/commonFileDetail/fileDownLoad')) {
      return opts.download?.() ?? new Response('%PDF', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('fetchCommonFileDetail', () => {
  it('SP の token → メニュー B08 → 詳細（最小フィールド）の順にたどる', async () => {
    const calls = stub();
    const d = await fetchCommonFileDetail(cookies, '101');
    expect(d.title).toBe('履修の手引き');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /smartphone/smartPhoneHome/nextPage/timeTable',
      'POST /common/generalPurpose/',
      'POST /commonfile/commonFileDetail/initialize',
    ]);
    expect(calls[1].body.get(TOKEN)).toBe('SP');
    expect(calls[1].body.get('menuCode')).toBe('B08');
    expect(calls[1].body.get('nextPath')).toBe('/commonfile/commonFile/initialize');
    expect(calls[2].body.get(TOKEN)).toBe('T1');
    expect(calls[2].body.get('hiddenCommonFileId')).toBe('101');
    expect(calls[2].body.get('prevPageId')).toBe('backToList');
  });

  it('一覧に無い ID は NotFoundError（詳細へは進まない）', async () => {
    const calls = stub();
    await expect(fetchCommonFileDetail(cookies, '999')).rejects.toBeInstanceOf(NotFoundError);
    expect(calls.some((c) => c.path.includes('commonFileDetail'))).toBe(false);
  });

  it('メニューがログイン画面なら LcamExpiredError', async () => {
    stub({ list: '<html>ログインされていないため</html>' });
    await expect(fetchCommonFileDetail(cookies, '101')).rejects.toBeInstanceOf(LcamExpiredError);
  });

  it('「不正な操作」は UpstreamError（再ログインしない）', async () => {
    stub({ list: '<html>不正な操作が行われました</html>' });
    const p = fetchCommonFileDetail(cookies, '101');
    await expect(p).rejects.toBeInstanceOf(UpstreamError);
    await expect(p).rejects.not.toBeInstanceOf(LcamExpiredError);
  });
});

describe('downloadCommonFile', () => {
  it('詳細の token・ID を付けて fileDownLoad2 へ POST し、body をそのまま返す', async () => {
    const calls = stub();
    const res = await downloadCommonFile(cookies, '101', 1);
    expect(await res.text()).toBe('%PDF');
    const dl = calls.at(-1)!;
    expect(dl.method).toBe('POST');
    expect(dl.path).toBe(`/commonfile/commonFileDetail/fileDownLoad2/${encodeURIComponent('履修の手引き2026')}?EXCLUDE_SET=&prefix=COMMON_FILE_FILE&no=1`);
    expect(dl.body.get(TOKEN)).toBe('T2');
    expect(dl.body.get('hiddenCommonFileId')).toBe('101');
    expect(dl.body.get('prevPageId')).toBe('backToDetail');
  });

  it('詳細に無い番号は NotFoundError（クライアントの名前は使わない）', async () => {
    stub();
    await expect(downloadCommonFile(cookies, '101', 9)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ファイルの代わりにログイン画面（HTML）が返ったら LcamExpiredError', async () => {
    stub({
      download: () => new Response('<html>ログインされていないため</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(downloadCommonFile(cookies, '101', 1)).rejects.toBeInstanceOf(LcamExpiredError);
  });
});
