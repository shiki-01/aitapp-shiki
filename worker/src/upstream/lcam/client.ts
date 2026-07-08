// LCAM の高レベル操作。move元: get_lcam_data.dart のフロー。
// 各 op は失効を検知したら LcamExpiredError を投げ、relogin ラッパに委ねる。

import type { LcamCookies, Credential } from '../../types';
import { parseHtml } from '../../html/parser';
import { extractStrutsToken, extractStrutsTokenByForm } from './csrf';
import { looksLikeLoginPage } from './detect';
import { LcamExpiredError, UpstreamError, ValidationError } from '../errors';
import {
  getStrutsTokenBody,
  getNoticeBody,
  getNoticeBodyNext,
  getNoticeDetailBody,
  getClassTimeTableBody,
  getFile,
  pcGetCookie,
  preAccess,
  initLogin,
  reload,
  getScheduleNext,
  getPerformanceBody,
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
  parseSchedule,
  parsePerformance,
  parseEnqueteList,
  parseEnqueteAnswerForm,
  parseEnqueteConfirm,
  type UnivNotice,
  type ClassNotice,
  type NoticeDetail,
  type TimetableEntry,
  type ScheduleDay,
  type PerformanceEntry,
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
  const token = tokenOrThrow(listBody);

  const body = await getNoticeDetailBody(index, cookies, token, isCommon);
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
  return parseEnqueteAnswerForm(answerBody);
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

/**
 * スケジュール（PC 経路・ステートレス）。リクエストごとに PC ログインし、
 * reload を weeks 回まわして週送りしながら集計する。
 * 透過再ログインのラップ対象外（毎回フレッシュにログインするため）。
 */
export async function fetchSchedule(
  cred: Credential,
  weeks: number,
): Promise<ScheduleDay[]> {
  let cookies = await pcGetCookie();
  const newJsession = await preAccess(cookies);
  cookies = { jsessionid: newJsession, liveApps: cookies.liveApps };

  const loginBody = await initLogin(cred.id, cred.password, cookies);
  let token = extractStrutsToken(parseHtml(loginBody));
  if (token == null) {
    throw new UpstreamError('PC login failed (token not found)');
  }

  const days: ScheduleDay[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < weeks; i++) {
    const body = await reload(cookies, token);
    token = extractStrutsToken(parseHtml(body)) ?? token;
    let part: ScheduleDay[] = [];
    try {
      part = parseSchedule(body);
    } catch {
      break; // カレンダーが取れなくなったら終了
    }
    for (const d of part) {
      if (!seen.has(d.date)) {
        seen.add(d.date);
        days.push(d);
      }
    }
    await getScheduleNext(cookies); // 次週へ送る
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}
