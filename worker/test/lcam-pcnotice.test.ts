import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCampusNoticeList,
  parseClassNoticeList,
  parseNoticeDetail,
  fetchPcNotices,
  fetchPcNoticeDetail,
  downloadPcNoticeFile,
} from '../src/upstream/lcam/pcnotice';
import { formDefaults, decodeJsEscapes } from '../src/upstream/lcam/pc';
import { LcamExpiredError, NotFoundError, ValidationError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const BASE = 'https://lcam.aitech.ac.jp/portalv2';
const T = 'org.apache.struts.taglib.html.TOKEN';

// 実 LCAM（2026-09-25）の構造に合わせた合成 HTML。
function campusList(token: string, rows: Array<{ id: string; title: string; important?: boolean }>): string {
  const trs = rows
    .map(
      (r, i) =>
        `<tr><td>お知らせ</td><td class="left">${r.important ? '<span class="red">【重要】</span>' : ''}` +
        `<a href="javascript:void(0)" onclick="dtlScreen('${r.id}', '${i}', 'initializeRcv', '1');return dbClick();">${r.title} </a></td>` +
        `<td>教務グループ</td><td> 2026/09/24 11:00 </td><td>1</td><td> 2026/10/02 00:00 </td></tr>`,
    )
    .join('');
  return (
    `<form name="commoncontact_commonContactActionForm" action="/portalv2/commoncontact/commonContact/"><input type="hidden" name="${T}" value="${token}"></form>` +
    `<form name="commoncontact_commonContactRcvListActionForm" method="post" action="/portalv2/commoncontact/commonContactRcvList/">` +
    `<input type="hidden" name="${T}" value="${token}">` +
    `<select name="commonContactCateIdRcv"><option value="" selected>▼</option><option value="32">お知らせ</option><option value="7">奨学金</option></select>` +
    `<input type="text" name="searchKeywordRcv" value="">` +
    `<input type="checkbox" name="checkSearchKeywordTitleRcv" value="on" checked>` +
    `<input type="checkbox" name="checkSearchKeywordExplanationRcv" value="on">` +
    `<input type="text" name="reportDateFromRcv" value=""><input type="text" name="reportDateStartSysRcv" value="2026/09/25">` +
    `<select name="rcvConfirmDivideRcv"><option value="" selected>▼</option><option value="1">返信可</option></select>` +
    `<input type="checkbox" name="contactConfirmNoLookRcv" value="1"><input type="checkbox" name="onlyTodoRcvFlag" value="1">` +
    `</form><table id="tbl_commoncontact_rcv"><thead><tr><th>カテゴリ</th></tr></thead><tbody>${trs}</tbody></table>`
  );
}

function classList(token: string, rows: Array<{ id: string; title: string }>): string {
  const trs = rows
    .map(
      (r, i) =>
        `<tr><td class="colCheck"><input type="checkbox" name="classContactIdCheck" value="${r.id}" disabled="disabled"></td>` +
        `<td>[八]サンプル科目(A2)<br> …後期/金5, 後期/金5, 後期/金5 </td><td> 井上 智之 </td>` +
        `<td><span class="red">【重要】</span> <a href="javascript:void(0);" id="linkDetail" onclick="return showClassContactDetail(${i});">${r.title}</a></td>` +
        `<td> 連絡・呼出 </td><td></td><td>2026/09/18<br>13:36</td><td> 2026/10/18 <br>13:30 </td><td> 通知済 </td><td>G2821000</td></tr>`,
    )
    .join('');
  return (
    `<form name="classcontact_classContactListActionForm" method="post" action="/portalv2/classcontact/classContactList/">` +
    `<input type="hidden" name="${T}" value="${token}"><input type="hidden" name="teacherCode" value="">` +
    `<select name="schoolYear"><option value="2025">2025</option><option value="2026" selected="selected">2026</option></select>` +
    `<select name="semesterCode"><option value=""></option><option value="1">前期</option><option value="2" selected="selected">後期</option></select>` +
    `<select name="subjectDispCode"><option value="" selected>▼</option><option value="G2821000_A2">[八]サンプル科目(A2)</option></select>` +
    `<input type="text" name="searchKeyWord" value="">` +
    `<input type="checkbox" name="checkSearchKeywordTeacherUserName" value="on" checked><input type="checkbox" name="checkSearchKeywordTitle" value="on" checked>` +
    `<input type="checkbox" name="checkSearchKeywordComment" value="on">` +
    `<select name="contactKindCode"><option value="" selected>▼</option><option value="1">休講</option><option value="5">連絡・呼出</option></select>` +
    `<input type="text" name="reportDateStart" value=""><input type="checkbox" name="onlyUnRead" value="on"></form>` +
    `<table id="tbl_A01_01"><thead><tr><th></th></tr></thead><tbody>${trs}</tbody></table>`
  );
}

const CAMPUS_DETAIL =
  `<form name="common_fileUploadActionForm" action="/portalv2/common/fileUpload/"><input type="hidden" name="${T}" value="D1">` +
  `<input type="hidden" name="prefix" value="default"><input type="hidden" name="sequence" value=""></form>` +
  `<table class="ttb_entry mt15"><tbody>` +
  `<tr><th> カテゴリ </th><td> お知らせ </td></tr><tr><th> タイトル </th><td> 抽選後の履修登録の再開について </td></tr>` +
  `<tr><th> 連絡内容 </th><td><div class="rich_area"><div>1 行目<br><br>2 行目</div><div>&nbsp;</div><div>3 行目</div></div></td></tr>` +
  `<tr><th> 連絡元 </th><td> 教務グループ </td></tr>` +
  `<tr><th> 添付ファイル </th><td class="center"><div id="fileList_no1"><div id="fileList_no1_1">` +
  `<a href="javascript:void(0);" onclick="fileDownLoad('no1', '1', '\\u5C65\\u4FEE\\u306E\\u624B\\u5F15\\u304D2026.pdf');"> 履修の手引き2026.pdf </a> &nbsp;&nbsp;(3.43 MB)</div></div>` +
  `<script type="text/javascript"> var x = "fileDownLoad('no1', '9', 'evil.exe')"; </script></td></tr>` +
  `<tr><th> 参考URL </th><td><a href="https://example.com/a">https://example.com/a</a><a href="/portalv2/live">内部</a></td></tr>` +
  `<tr><th> 重要度 </th><td> 通常 </td></tr><tr><th> 連絡日時 </th><td> 2026/09/24 11:00 ～ 2026/10/02 00:00 </td></tr>` +
  `<tr><th> 管理所属 </th><td> 教務グループ </td></tr></tbody></table>`;

const CLASS_DETAIL =
  `<form name="common_fileUploadActionForm" action="/portalv2/common/fileUpload/"><input type="hidden" name="${T}" value="D2"></form>` +
  `<table class="ttb_entry"><tbody><tr><th>連絡種別</th><td>連絡・呼出</td></tr><tr><th>タイトル</th><td>講義資料</td></tr>` +
  `<tr><th>内容</th><td>資料を添付します。</td></tr><tr><th>ファイル</th><td><a onclick="fileDownLoad('no1', '1', 'a.pdf');">a.pdf</a> (1.01 MB)</td></tr>` +
  `<tr><th>参考URL</th><td></td></tr><tr><th>重要度</th><td>重要</td></tr>` +
  `<tr><th>連絡日時</th><td>2026/09/18 13:36 ～ 2026/10/18 13:30</td></tr><tr><th>返信</th><td>返信不可</td></tr></tbody></table>`;

describe('parse lists', () => {
  it('学内連絡: ID・行番号・重要・連絡元・期間', () => {
    const rows = parseCampusNoticeList(campusList('T1', [{ id: '333345', title: '被災状況の届出', important: true }, { id: '331966', title: '再開' }]));
    expect(rows[0]).toMatchObject({
      kind: 'campus', id: '333345', index: 0, kindDivision: '1', title: '被災状況の届出', category: 'お知らせ',
      sender: '教務グループ', important: true, startAt: '2026/09/24 11:00', endAt: '2026/10/02 00:00',
    });
    expect(rows[1]).toMatchObject({ id: '331966', index: 1, important: false });
  });

  it('授業連絡: 科目・重複した学期表記の整理・ID（チェックボックス）・行番号', () => {
    const [r] = parseClassNoticeList(classList('T1', [{ id: '62437', title: '講義資料' }]));
    expect(r).toMatchObject({
      kind: 'class', id: '62437', index: 0, title: '講義資料', category: '連絡・呼出', sender: '井上 智之',
      subject: '[八]サンプル科目(A2)', term: '後期/金5', important: true,
      startAt: '2026/09/18 13:36', endAt: '2026/10/18 13:30',
    });
  });

  it('0 件は空配列、画面が違えば UpstreamError', () => {
    expect(parseCampusNoticeList(campusList('T1', []))).toEqual([]);
    expect(() => parseClassNoticeList('<html>別画面</html>')).toThrow();
  });
});

describe('parseNoticeDetail', () => {
  it('学内連絡: 本文の改行・添付（\\u エスケープの名前を戻す）・外部 URL だけ・script 内の偽リンクは無視', () => {
    const d = parseNoticeDetail(CAMPUS_DETAIL, 'campus', '331966');
    expect(d).toMatchObject({
      category: 'お知らせ', title: '抽選後の履修登録の再開について', sender: '教務グループ', important: false,
      period: '2026/09/24 11:00 ～ 2026/10/02 00:00', referenceUrls: ['https://example.com/a'],
    });
    expect(d.body).toBe('1 行目\n\n2 行目\n\n3 行目');
    expect(d.files).toEqual([{ prefix: 'no1', no: 1, name: '履修の手引き2026.pdf', size: '3.43 MB' }]);
  });
  it('授業連絡: 見出しの違い（連絡種別/内容/ファイル/返信）を吸収し、連絡元は一覧の教員で補う', () => {
    const d = parseNoticeDetail(CLASS_DETAIL, 'class', '62437', '井上 智之');
    expect(d).toMatchObject({ category: '連絡・呼出', body: '資料を添付します。', sender: '井上 智之', important: true, reply: '返信不可' });
    expect(d.files[0]).toMatchObject({ no: 1, name: 'a.pdf' });
  });
});

describe('formDefaults / decodeJsEscapes', () => {
  it('チェック済みだけ・select は選択中（無ければ先頭）・disabled は除く', () => {
    const f = formDefaults(classList('T9', []), 'classcontact_classContactListActionForm');
    expect(f).toMatchObject({
      [T]: 'T9', schoolYear: '2026', semesterCode: '2', subjectDispCode: '', searchKeyWord: '',
      checkSearchKeywordTeacherUserName: 'on', checkSearchKeywordTitle: 'on', contactKindCode: '',
    });
    expect(f.checkSearchKeywordComment).toBeUndefined();
    expect(f.onlyUnRead).toBeUndefined();
  });
  it('\\uXXXX を戻す', () => {
    expect(decodeJsEscapes('\\u5C65\\u4FEE.pdf')).toBe('履修.pdf');
  });
});

// ---- 遷移の検証 ----

afterEach(() => vi.unstubAllGlobals());

interface Call { method: string; path: string; body: URLSearchParams }
function stub(opts: { menuHtml?: (code: string) => string; download?: () => Response } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(BASE, '');
    const call = { method: String(init.method ?? 'GET'), path, body: new URLSearchParams(String(init.body ?? '')) };
    calls.push(call);
    if (path === '/smartphone/smartPhoneHome/nextPage/timeTable') return new Response(`<input type="hidden" name="${T}" value="SP">`);
    if (path === '/common/generalPurpose/') {
      const code = call.body.get('menuCode')!;
      return new Response(opts.menuHtml?.(code) ?? (code === 'B01' ? campusList('C1', [{ id: '100', title: 'A' }, { id: '200', title: 'B' }]) : classList('K1', [{ id: '62437', title: '講義資料' }])));
    }
    if (path.endsWith('/searchCommoncontactRcvList')) return new Response(campusList('C2', [{ id: '200', title: 'B' }]));
    if (path.endsWith('/selectClassContactList')) return new Response(classList('K2', [{ id: '62437', title: '講義資料' }]));
    if (path === '/commoncontact/commonContact/dtlEdit') return new Response(CAMPUS_DETAIL);
    if (path.startsWith('/classcontact/classContactList/goDetail/')) return new Response(CLASS_DETAIL);
    if (path.startsWith('/common/fileUploadDownload/fileDownLoad')) return opts.download?.() ?? new Response('%PDF', { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

describe('fetchPcNotices', () => {
  it('条件なしは検索せずメニューの一覧。候補（カテゴリ・科目）も返す', async () => {
    const calls = stub();
    const list = await fetchPcNotices(cookies, 'campus');
    expect(list.items.map((i) => i.id)).toEqual(['100', '200']);
    expect(list.categories).toEqual(['お知らせ', '奨学金']);
    expect(calls.map((c) => c.path)).toEqual(['/smartphone/smartPhoneHome/nextPage/timeTable', '/common/generalPurpose/']);
    expect(calls[1].body.get('menuCode')).toBe('B01');
    const cls = await fetchPcNotices(cookies, 'class');
    expect(cls.subjects).toEqual(['[八]サンプル科目(A2)']);
    expect(cls.categories).toEqual(['休講', '連絡・呼出']);
  });

  it('学内連絡の検索: 画面の初期値 + 指定した項目だけ上書き（カテゴリは表示名から値へ）', async () => {
    const calls = stub();
    await fetchPcNotices(cookies, 'campus', { keyword: '履修', category: '奨学金', unreadOnly: true, from: '2026/09/01' });
    const s = calls.at(-1)!;
    expect(s.path).toBe('/commoncontact/commonContactRcvList/searchCommoncontactRcvList');
    expect(s.body.get(T)).toBe('C1');
    expect(Object.fromEntries(s.body)).toMatchObject({
      searchKeywordRcv: '履修', checkSearchKeywordTitleRcv: 'on', checkSearchKeywordExplanationRcv: 'on',
      commonContactCateIdRcv: '7', contactConfirmNoLookRcv: '1', reportDateFromRcv: '2026/09/01', reportDateStartSysRcv: '2026/09/25',
    });
    expect(s.body.has('onlyTodoRcvFlag')).toBe(false);
  });

  it('授業連絡の検索: 年度・学期・科目・キーワード（4 つの対象を on）', async () => {
    const calls = stub();
    await fetchPcNotices(cookies, 'class', { keyword: '資料', year: 2025, semester: 1, subject: '[八]サンプル科目(A2)' });
    const s = calls.at(-1)!;
    expect(s.path).toBe('/classcontact/classContactList/selectClassContactList');
    expect(Object.fromEntries(s.body)).toMatchObject({
      schoolYear: '2025', semesterCode: '1', subjectDispCode: 'G2821000_A2', searchKeyWord: '資料',
      checkSearchKeywordComment: 'on', checkSearchKeywordSubjectName: 'on',
    });
  });

  it('知らないカテゴリは ValidationError（検索へは進まない）', async () => {
    const calls = stub();
    await expect(fetchPcNotices(cookies, 'campus', { category: '存在しない' })).rejects.toBeInstanceOf(ValidationError);
    expect(calls.some((c) => c.path.includes('search'))).toBe(false);
  });

  it('メニューがログイン画面なら LcamExpiredError', async () => {
    stub({ menuHtml: () => '<html>ログインされていないため</html>' });
    await expect(fetchPcNotices(cookies, 'campus')).rejects.toBeInstanceOf(LcamExpiredError);
  });
});

describe('fetchPcNoticeDetail / downloadPcNoticeFile', () => {
  it('学内連絡: 一覧の行から dtlEdit へ（mode・selectIndex・ID・kindDivision）', async () => {
    const calls = stub();
    const d = await fetchPcNoticeDetail(cookies, 'campus', '200');
    expect(d.title).toBe('抽選後の履修登録の再開について');
    const c = calls.at(-1)!;
    expect(c.path).toBe('/commoncontact/commonContact/dtlEdit');
    expect(c.body.get(T)).toBe('C1');
    expect(Object.fromEntries(c.body)).toMatchObject({ mode: 'initializeRcv', selectIndex: '1', commonContactId: '200', commonContactKindDivision: '1' });
  });

  it('授業連絡: goDetail/{行番号} へ TOKEN だけで POST', async () => {
    const calls = stub();
    const d = await fetchPcNoticeDetail(cookies, 'class', '62437');
    expect(d.sender).toBe('井上 智之');
    const c = calls.at(-1)!;
    expect(c.path).toBe('/classcontact/classContactList/goDetail/0');
    expect([...c.body.keys()]).toEqual([T]);
  });

  it('一覧に無い ID は NotFoundError', async () => {
    stub();
    await expect(fetchPcNoticeDetail(cookies, 'campus', '999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('添付: 詳細のフォームの項目を送る。名前は詳細の onclick（\\u を戻したもの）から', async () => {
    const calls = stub();
    const res = await downloadPcNoticeFile(cookies, 'campus', '200', 1);
    expect(await res.text()).toBe('%PDF');
    const dl = calls.at(-1)!;
    expect(dl.path).toBe(`/common/fileUploadDownload/fileDownLoad2/${encodeURIComponent('履修の手引き2026')}?EXCLUDE_SET=&prefix=no1&no=1`);
    expect(Object.fromEntries(dl.body)).toEqual({ [T]: 'D1', prefix: 'default', sequence: '' });
  });

  it('詳細に無い番号（script 内の偽リンクを含む）は NotFoundError', async () => {
    stub();
    await expect(downloadPcNoticeFile(cookies, 'campus', '200', 9)).rejects.toBeInstanceOf(NotFoundError);
  });
});
