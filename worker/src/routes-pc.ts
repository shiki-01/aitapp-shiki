// LCAM PC 版の機能の API（docs/LCAM_FEATURES.md）。router.ts から registerPcRoutes で登録する。
// 認証・CORS・相関ID のミドルウェアは router.ts 側の app.use が先に適用される。
// 上流の失効は withLcamSession が透過再ログインする。PC 画面は Struts の token を順にたどる必要があり、
// 1 リクエストの中で直列に処理する（並列にしない）。

import type { Hono } from 'hono';
import type { Env, UserState } from './types';
import { withLcamSession } from './upstream/lcam/session';
import {
  fetchCommonFileList,
  fetchCommonFileDetail,
  downloadCommonFile,
} from './upstream/lcam/commonfile';
import {
  fetchReportList,
  fetchReportDetail,
  downloadReportFile,
  type ReportQuery,
} from './upstream/lcam/report';
import { fetchFacilityList, fetchFacilityWeek } from './upstream/lcam/facility';
import { fetchCreditStatus, fetchCurriculum, fetchSchoolEvents } from './upstream/lcam/kyoumu';
import { ValidationError } from './upstream/errors';
import { applyInlineView } from './inline-view';

type App = Hono<{
  Bindings: Env;
  Variables: { userId: string; state: UserState; correlationId: string };
}>;

/** 上流の数値 ID（1〜12 桁）。上流のフォームへそのまま入れるため、数字以外は受け付けない。 */
function numericId(raw: string | undefined, name: string): string {
  if (!raw || !/^\d{1,12}$/.test(raw)) throw new ValidationError(`${name} is invalid`);
  return raw;
}

function positiveInt(raw: string | undefined, name: string): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) throw new ValidationError(`${name} is invalid`);
  return parseInt(raw, 10);
}

/** レポートの絞り込み（year=年度, semester=1|2, unsubmitted=1）。指定が無ければ上流の初期表示。 */
function reportQuery(q: (name: string) => string | undefined): ReportQuery {
  const query: ReportQuery = {};
  const year = q('year');
  if (year !== undefined) {
    if (!/^20\d{2}$/.test(year)) throw new ValidationError('year is invalid');
    query.year = parseInt(year, 10);
  }
  const semester = q('semester');
  if (semester !== undefined) {
    if (semester !== '1' && semester !== '2') throw new ValidationError('semester is invalid');
    query.semester = semester === '1' ? 1 : 2;
  }
  if (q('unsubmitted') === '1') query.unsubmittedOnly = true;
  return query;
}

/** 上流のダウンロード応答を、body を溜めずにそのまま返す。 */
function streamDownload(upstream: Response, inline: boolean): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition', 'content-length']) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (inline) applyInlineView(headers);
  // 認証済みファイルをブラウザのディスクキャッシュに残さない。
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function registerPcRoutes(app: App): void {
  // ---- 学内共有ファイル（キャンパスライフ > 学内共有ファイル） ----
  app.get('/api/commonfiles', async (c) => {
    const files = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchCommonFileList(cookies),
    );
    return c.json({ files });
  });

  app.get('/api/commonfiles/detail', async (c) => {
    const id = numericId(c.req.query('id'), 'id');
    const detail = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchCommonFileDetail(cookies, id),
    );
    return c.json({ detail });
  });

  // ファイルは stream proxy（バッファリングしない）。名前は上流の詳細画面から引くため id と no だけ受ける。
  app.get('/api/commonfiles/download', async (c) => {
    const id = numericId(c.req.query('id'), 'id');
    const no = positiveInt(c.req.query('no'), 'no');
    const upstream = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      downloadCommonFile(cookies, id, no),
    );
    return streamDownload(upstream, c.req.query('inline') === '1');
  });

  // ---- レポート（授業サポート > レポート。参照のみ） ----
  app.get('/api/reports', async (c) => {
    const query = reportQuery((n) => c.req.query(n));
    const reports = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchReportList(cookies, query),
    );
    return c.json({ reports });
  });

  app.get('/api/reports/detail', async (c) => {
    const id = numericId(c.req.query('id'), 'id');
    const query = reportQuery((n) => c.req.query(n));
    const detail = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchReportDetail(cookies, id, query),
    );
    return c.json({ detail });
  });

  // 提出履歴のファイル。提出物は詳細画面にあるものだけ取れる（submitNo・fileNo で指定）。
  app.get('/api/reports/download', async (c) => {
    const id = numericId(c.req.query('id'), 'id');
    const submitNo = positiveInt(c.req.query('submitNo'), 'submitNo');
    const fileNo = positiveInt(c.req.query('fileNo'), 'fileNo');
    const query = reportQuery((n) => c.req.query(n));
    const upstream = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      downloadReportFile(cookies, id, submitNo, fileNo, query),
    );
    return streamDownload(upstream, c.req.query('inline') === '1');
  });

  // ---- 施設（キャンパスライフ > 施設。参照のみ） ----
  app.get('/api/facilities', async (c) => {
    const facilities = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchFacilityList(cookies),
    );
    return c.json({ facilities });
  });

  // ids=施設コードのカンマ区切り（この順に行が並ぶ）、week=今週からの週数（-4〜8。省略は今週）。
  app.get('/api/facilities/schedule', async (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean);
    const weekRaw = c.req.query('week');
    if (weekRaw !== undefined && !/^-?\d{1,2}$/.test(weekRaw)) throw new ValidationError('week is invalid');
    const week = weekRaw === undefined ? 0 : parseInt(weekRaw, 10);
    const schedule = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchFacilityWeek(cookies, ids, week),
    );
    return c.json({ schedule });
  });

  // ---- 学事システム（/kyoumu/。参照のみ）。入るたびに LCAM から引き渡しを行う（3〜4 リクエスト） ----
  app.get('/api/credits', async (c) => {
    const credits = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchCreditStatus(cookies),
    );
    return c.json({ credits });
  });

  app.get('/api/curriculum', async (c) => {
    const curriculum = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchCurriculum(cookies),
    );
    return c.json({ curriculum });
  });

  // month=1〜12 の月、または all（12 か月。上流へ 12 回）。省略は今の月（JST）。
  app.get('/api/schoolevents', async (c) => {
    const raw = c.req.query('month');
    let month: number | 'all';
    if (raw === 'all') month = 'all';
    else if (raw === undefined) month = new Date(Date.now() + 9 * 3600 * 1000).getUTCMonth() + 1;
    else if (/^(1[0-2]|[1-9])$/.test(raw)) month = parseInt(raw, 10);
    else throw new ValidationError('month is invalid');
    const events = await withLcamSession(c.env, c.get('userId'), c.get('state'), (cookies) =>
      fetchSchoolEvents(cookies, month),
    );
    return c.json({ events });
  });
}
