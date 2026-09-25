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
}
