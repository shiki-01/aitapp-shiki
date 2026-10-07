// LCAM の高レベル操作。move元: get_lcam_data.dart のフロー。
// 各 op は失効を検知したら LcamExpiredError を投げ、relogin ラッパに委ねる。

import type { LcamCookies } from '../../types';
import { parseHtml } from '../../html/parser';
import { extractStrutsToken, extractStrutsTokenByForm } from './csrf';
import { looksLikeLoginPage } from './detect';
import { LcamExpiredError, NotFoundError, UpstreamError, ValidationError } from '../errors';
import {
  getStrutsTokenBody,
  getNoticeBody,
  getNoticeBodyNext,
  getNoticeDetailBody,
  getClassTimeTableBody,
  getFile,
  getPerformanceBody,
  postPcHomeInitialize,
  postHomeReload,
  postScheduleMove,
  getEnqueteBody,
  getEnqueteDetailBody,
  getEnqueteAnswerFormBody,
  postEnqueteTempSave,
  postEnqueteConfirm,
  postEnqueteFinalize,
  type EnqueteType,
} from './access';
import {
  parseUnivNotice,
  parseClassNotice,
  parseUnivNoticeDetail,
  parseClassNoticeDetail,
  parseClassTimeTable,
  parsePerformance,
  parseSchedule,
  parseEnqueteList,
  parseEnqueteAnswerForm,
  parseEnqueteConfirm,
  type UnivNotice,
  type ClassNotice,
  type NoticeDetail,
  type TimetableEntry,
  type PerformanceEntry,
  type ScheduleDay,
  type EnqueteList,
  type EnqueteAnswerForm,
} from './parse';

/** ログインページ（失効）なら LcamExpiredError を投げる。 */
function assertNotExpired(html: string): void {
  if (looksLikeLoginPage(html)) throw new LcamExpiredError();
}

/**
 * HTML から token を抽出。認証済みの SP ページには必ず Struts token フィールドが
 * 存在するため、無い場合はセッション喪失（PC ログイン等で無効化されたケース含む）
 * とみなして LcamExpiredError を投げ、透過再ログインに繋げる。
 */
function tokenOrThrow(html: string): string {
  const t = extractStrutsToken(parseHtml(html));
  if (t != null) return t;
  throw new LcamExpiredError();
}

/** 認証済み SP ページは必ず Struts token フィールドを含む。無ければ session 喪失。 */
function assertSpSessionAlive(html: string): void {
  if (!html.includes('org.apache.struts.taglib.html.TOKEN')) {
    throw new LcamExpiredError();
  }
}

/**
 * 連絡一覧（common/class）。count は累積表示件数（上流 listPageNo）。
 * 上流は先頭から count 件をまとめて返し、index は全件通しの 0..N-1。
 * 移植元 (load_noticelist_usecase.dart) は 10,20,30… と件数を増やして毎回全件を
 * 取り直す方式のため、ページ番号方式にはしない。
 */
export async function fetchNotices(
  cookies: LcamCookies,
  isCommon: boolean,
  count: number,
): Promise<UnivNotice[] | ClassNotice[]> {
  const tokenBody = await getStrutsTokenBody(cookies, isCommon);
  assertNotExpired(tokenBody);
  const tempToken = tokenOrThrow(tokenBody);

  const listBody = await getNoticeBody(cookies, tempToken, isCommon);
  assertNotExpired(listBody);
  const token = tokenOrThrow(listBody);

  const body = await getNoticeBodyNext(cookies, token, count, isCommon);
  assertNotExpired(body);

  return isCommon ? parseUnivNotice(body) : parseClassNotice(body);
}

/** 連絡詳細。一覧と同じ token bootstrap を行ってから goDetail。 */
export async function fetchNoticeDetail(
  cookies: LcamCookies,
  isCommon: boolean,
  index: number,
): Promise<NoticeDetail> {
  // token を一覧経由で確立（in-memory 完結）。
  const tokenBody = await getStrutsTokenBody(cookies, isCommon);
  assertNotExpired(tokenBody);
  const tempToken = tokenOrThrow(tokenBody);
  const listBody = await getNoticeBody(cookies, tempToken, isCommon);
  assertNotExpired(listBody);
  const listToken = tokenOrThrow(listBody);

  // goDetail/{index} の index はサーバー側の「現在ロード済み累積リスト」に対する通し番号。
  // select（listPageNo=1, 先頭約10件）だけでは index が範囲外だと詳細テーブルが空になり
  // NotFoundError → 404 になる。一覧取得と同様に nextSelect で index を含む深さまで
  // リストを読み込んでから goDetail する（listPageNo は累積表示件数）。token は各応答から
  // 再抽出する（nextSelect 応答の TOKEN を goDetail に渡す）。
  const depth = Math.ceil((index + 1) / 10) * 10;
  const nextBody = await getNoticeBodyNext(cookies, listToken, depth, isCommon);
  assertNotExpired(nextBody);
  const detailToken = tokenOrThrow(nextBody);

  const body = await getNoticeDetailBody(index, cookies, detailToken, isCommon);
  assertNotExpired(body);
  return isCommon ? parseUnivNoticeDetail(body) : parseClassNoticeDetail(body);
}

/** 時間割（SP）。 */
export async function fetchTimetable(
  cookies: LcamCookies,
): Promise<TimetableEntry[]> {
  const body = await getClassTimeTableBody(cookies);
  assertSpSessionAlive(body); // stub（セッション喪失）なら再ログインへ
  return parseClassTimeTable(body);
}

/**
 * 登録された Cookie が SP 画面で有効かを 1 回の GET で確認する（Cookie 登録時の検証用）。
 * 無効なら LcamExpiredError。
 */
export async function probeSpSession(cookies: LcamCookies): Promise<void> {
  const body = await getClassTimeTableBody(cookies);
  assertNotExpired(body);
  assertSpSessionAlive(body);
}

/** ファイル取得。content-type が text/html ならログイン画面=失効とみなす。 */
export async function fetchFile(
  cookies: LcamCookies,
  fileUrl: string,
): Promise<Response> {
  const res = await getFile(cookies, fileUrl);
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/html')) {
    // ボディは読み捨て（stream を消費しておく）。
    await res.text().catch(() => undefined);
    throw new LcamExpiredError();
  }
  return res;
}

/** 成績情報。認証済み SP ページと同様、Struts token の有無でセッション生存を判定する。 */
export async function fetchPerformance(
  cookies: LcamCookies,
): Promise<PerformanceEntry[]> {
  const body = await getPerformanceBody(cookies);
  assertSpSessionAlive(body);
  return parsePerformance(body);
}

/** アンケート一覧（授業アンケート/授業評価アンケート/学内アンケート）。 */
export async function fetchEnqueteList(
  cookies: LcamCookies,
  type: EnqueteType,
): Promise<EnqueteList> {
  const body = await getEnqueteBody(cookies, type);
  assertSpSessionAlive(body);
  return parseEnqueteList(body);
}

/**
 * アンケート一覧のトップから goDetail(index) → 回答フォーム初期表示まで進み、設問を返す。
 * サーバー側が「選択中のアンケート」をセッションで保持するため、この一連の遷移を
 * 毎回やり直す必要がある（classEnqId 等をパラメータで直接指定する経路は無い）。
 * 参照のみで書き込みは発生しない。
 */
export async function fetchEnqueteQuestions(
  cookies: LcamCookies,
  index: number,
): Promise<EnqueteAnswerForm> {
  const { detailBody, answerBody } = await openEnquete(cookies, index);
  return parseEnqueteAnswerForm(answerBody, detailBody);
}

/** list → goDetail(index) → answer/initialize と辿り、サーバー側に「選択中のアンケート」を確立する。 */
async function openEnquete(
  cookies: LcamCookies,
  index: number,
): Promise<{ detailBody: string; answerBody: string }> {
  const listBody = await getEnqueteBody(cookies, 'class');
  assertSpSessionAlive(listBody);
  const listToken = extractStrutsTokenByForm(
    listBody,
    'classenq_student_searchListActionForm',
  );
  if (listToken == null) throw new LcamExpiredError();

  const detailBody = await getEnqueteDetailBody(cookies, listToken, index);
  assertSpSessionAlive(detailBody);

  const answerBody = await getEnqueteAnswerFormBody(cookies);
  assertSpSessionAlive(answerBody);
  return { detailBody, answerBody };
}

/**
 * 授業アンケートの添付（問題ファイル）をダウンロードする。
 * ダウンロード URL（no=N）は「選択中のアンケート」に依存するため、
 * 同一セッションで goDetail まで辿り直したうえで、設問取得で得た path を取得する。
 * path は parseEnqueteFiles が抽出した値（questions の files）のみ許可する。
 */
export async function fetchEnqueteFile(
  cookies: LcamCookies,
  index: number,
  path: string,
): Promise<Response> {
  const { detailBody, answerBody } = await openEnquete(cookies, index);
  const files = parseEnqueteAnswerForm(answerBody, detailBody).files;
  if (!Object.values(files).includes(path)) {
    throw new NotFoundError('[fetchEnqueteFile]指定された添付ファイルが見つかりません');
  }
  return fetchFile(cookies, path);
}

interface PreparedEnqueteAnswer {
  token: string;
  classEnqId: string;
  fields: Record<string, string>;
}

/**
 * list → goDetail(index) → answer/initialize を辿って token・classEnqId を取得し、
 * answers（設問index→回答文字列）を実際の value{i} フィールドへ変換する共通処理。
 * tempSave/confirm どちらの書き込みからも使う。
 */
async function prepareEnqueteAnswer(
  cookies: LcamCookies,
  index: number,
  answers: Record<number, string>,
): Promise<PreparedEnqueteAnswer> {
  const listBody = await getEnqueteBody(cookies, 'class');
  assertSpSessionAlive(listBody);
  const listToken = extractStrutsTokenByForm(
    listBody,
    'classenq_student_searchListActionForm',
  );
  if (listToken == null) throw new LcamExpiredError();

  const detailBody = await getEnqueteDetailBody(cookies, listToken, index);
  assertSpSessionAlive(detailBody);

  const answerBody = await getEnqueteAnswerFormBody(cookies);
  assertSpSessionAlive(answerBody);
  const form = parseEnqueteAnswerForm(answerBody);
  const token = extractStrutsTokenByForm(
    answerBody,
    'smartphone_smartPhoneClassEnqAnswerActionForm',
  );
  if (token == null) throw new LcamExpiredError();

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    const qIndex = Number(key);
    const question = form.questions.find((q) => q.index === qIndex);
    if (!question) {
      throw new ValidationError(`設問 ${qIndex} は存在しません（全 ${form.questions.length} 問）`);
    }
    if (question.answerType !== 'text') {
      throw new ValidationError(
        `設問 ${qIndex}（${question.label}）はテキストボックス形式以外のため未対応です`,
      );
    }
    fields[question.fieldName] = value;
  }

  return { token, classEnqId: form.classEnqId, fields };
}

/** 応答 HTML にエラー表示（#_errorInformation）が無いことを成功の目安とする。 */
function looksLikeSuccess(html: string): boolean {
  return (
    parseHtml(html).querySelectorAll('#_errorInformation > ul > li:nth-child(1)').length === 0
  );
}

/**
 * 授業アンケートへの回答を一時保存する（tempSaveAction）。
 *
 * ユーザー許可のもと実データで動作検証済み（保存後に value1〜3 が入力値のまま
 * 返ってくることを確認した。MIGRATION_NOTES §11）。
 * テキストボックス形式以外の設問（テキストエリア/日付/コンボボックス/ラジオボタン/
 * チェックボックス/添付ファイル）への回答は ValidationError で拒否する
 * （実データを観測できておらず、誤ったフィールド形式で送信することを避けるため）。
 */
export async function submitEnqueteAnswer(
  cookies: LcamCookies,
  index: number,
  answers: Record<number, string>,
): Promise<{ ok: boolean }> {
  const { token, classEnqId, fields } = await prepareEnqueteAnswer(cookies, index, answers);
  const resultBody = await postEnqueteTempSave(cookies, token, classEnqId, fields);
  return { ok: looksLikeSuccess(resultBody) };
}

/**
 * 授業アンケートへの回答を最終提出する（確認画面を経由した本登録）。
 *
 * フロー: answer/initialize（token・classEnqId 取得）→
 * smartPhoneClassEnqAnswer/confirmAction（value{i} を送信し「登録確認」画面を取得）→
 * 確認画面自身のフォーム（smartphone_smartPhoneClassEnqAnswerConfirmActionForm、SP フロー実測）で
 * smartPhoneClassEnqAnswerConfirm/confirmAction へ最終 POST（本登録）。
 * 当初ユーザーから提供された実 HTML は PC 版フローのフォーム名
 * （classenq_student_answerConfirmActionForm）だったが、本実装が使う SP フローでは
 * 実際には異なるフォーム名/遷移先だったため実機再現で修正した（MIGRATION_NOTES §11.5）。
 * 回答取消 (`answerCancel`) は未実装。
 */
export async function finalizeEnqueteAnswer(
  cookies: LcamCookies,
  index: number,
  answers: Record<number, string>,
): Promise<{ ok: boolean }> {
  const { token, classEnqId, fields } = await prepareEnqueteAnswer(cookies, index, answers);

  const confirmBody = await postEnqueteConfirm(cookies, token, classEnqId, fields);
  assertSpSessionAlive(confirmBody);
  const confirmForm = parseEnqueteConfirm(confirmBody);
  const confirmToken = extractStrutsTokenByForm(
    confirmBody,
    'smartphone_smartPhoneClassEnqAnswerConfirmActionForm',
  );
  if (confirmToken == null) throw new LcamExpiredError();

  const finalBody = await postEnqueteFinalize(
    cookies,
    confirmToken,
    confirmForm.classEnqId,
    confirmForm.backPath,
  );
  return { ok: looksLikeSuccess(finalBody) };
}

/** 直近何週ぶんのスケジュールを取るか。subrequest（無料プランは 1 リクエスト 50）を守る上限。 */
export const MAX_SCHEDULE_WEEKS = 14;
/** 月送りの上限（1 回の呼び出しで動かす回数を抑える）。 */
export const MAX_SCHEDULE_MONTH_OFFSET = 8;

/**
 * 個人スケジュール（PC ホームのカレンダー）を weeks 週ぶん取得する。month 省略時は今日から、
 * 指定時は「今月から month か月ずらした月」の 1 日を含む週（月曜始まり）から。
 * PC 画面に入るための最初の Struts token は、認証済み SP ページ（時間割）の token を使う
 * （直接 GET で PC 画面へ入ると「不正な操作」でセッションが破棄されるため。§14.4）。
 * 入口は PC のメニュー「ホーム」と同じ generalPurpose への POST（実測済み。reload を直接呼ぶと「システムエラー」）。
 * 拒否された場合は LcamExpiredError にせず UpstreamError にする（資格情報の破棄・無駄な再ログインを避ける）。
 */
export async function fetchSchedule(
  cookies: LcamCookies,
  weeks: number,
  month?: number,
): Promise<ScheduleDay[]> {
  const n = Math.min(Math.max(Math.trunc(weeks), 1), MAX_SCHEDULE_WEEKS);

  const spBody = await getClassTimeTableBody(cookies);
  assertSpSessionAlive(spBody);
  let token = anyStrutsToken(spBody);
  if (token == null) throw new LcamExpiredError();

  // PC ホームを開く（メニュー遷移）。表示位置はセッションに残る（前回の続きになり得る）ため、「今日」に揃える。
  let body = await postPcHomeInitialize(cookies, token);
  token = nextTokenOrThrow(body);
  await postScheduleMove(cookies, 4);

  // 月送り（実測）: 「今月」から ±1 か月ずつ、その月の 1 日を含む週（月曜始まり）へ飛ぶ。
  // month=0 は今月の 1 日を含む週（前月→翌月の 2 回で戻る）。
  if (month !== undefined) {
    const m = Math.min(Math.max(Math.trunc(month), -MAX_SCHEDULE_MONTH_OFFSET), MAX_SCHEDULE_MONTH_OFFSET);
    if (m === 0) {
      await postScheduleMove(cookies, 2);
      await postScheduleMove(cookies, 6);
    } else {
      for (let i = 0; i < Math.abs(m); i++) await postScheduleMove(cookies, m < 0 ? 2 : 6);
    }
  }

  // 見出しの年を決める基準日: 取得範囲のおおよその中心。
  const center = new Date(
    Date.now() + ((month ?? 0) * 30 + (month === undefined ? 0 : n * 3.5)) * 24 * 60 * 60 * 1000,
  );
  const byDate = new Map<string, ScheduleDay>();
  for (let i = 0; i < n; i++) {
    body = await postHomeReload(cookies, token);
    for (const day of parseSchedule(body, center)) byDate.set(day.date, day);
    if (i < n - 1) {
      token = nextTokenOrThrow(body);
      await postScheduleMove(cookies, 5);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 生 HTML から最初の Struts token の value を取る（SP・PC どちらのページにも使える）。 */
function anyStrutsToken(html: string): string | null {
  const m = /<input[^>]*org\.apache\.struts\.taglib\.html\.TOKEN[^>]*>/.exec(html);
  if (!m) return null;
  const v = /value="([^"]+)"/.exec(m[0]);
  return v ? v[1] : null;
}

/** PC ホームの再描画結果から次の token を取る。取れなければ PC 画面が拒否したとみなす。 */
function nextTokenOrThrow(html: string): string {
  const t = anyStrutsToken(html);
  if (t != null && html.includes('calendar-body')) return t;
  if (html.includes('不正な操作')) {
    throw new UpstreamError('LCAM がスケジュール画面へのアクセスを拒否しました（不正な操作）');
  }
  throw new UpstreamError('LCAM のスケジュール画面を取得できませんでした（想定外の応答）');
}
