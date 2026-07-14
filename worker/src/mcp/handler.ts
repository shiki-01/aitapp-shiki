// /mcp エンドポイント（MCP Streamable HTTP, stateless）。
// 認証: Authorization: Bearer <MCP_TOKEN>、またはカスタムヘッダを設定できない
// クライアント（スマホの Claude アプリのカスタムコネクタ等）向けに URL パスへの
// トークン埋め込み（/mcp/<MCP_TOKEN>）。単一ユーザー前提で、資格情報は
// worker のシークレット（AITAPP_ID 等）から取る。リクエストごとに McpServer を
// 生成する stateless 運用（Durable Objects 不使用の制約に適合）。

import type { Context } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { createAitappServer } from '../../../mcp/src/register';
import type { Env } from '../types';
import { SelfClient, type Dispatch } from './self-client';

/** タイミング攻撃を避けるため、SHA-256 ダイジェスト同士を比較する。 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function handleMcpRequest<E extends { Bindings: Env }>(
  c: Context<E>,
  dispatch: Dispatch,
  pathToken?: string,
): Promise<Response> {
  const { MCP_TOKEN, AITAPP_ID, AITAPP_PASSWORD } = c.env;
  // 未設定なら機能ごと無効（存在も明かさない）。
  if (!MCP_TOKEN || !AITAPP_ID || !AITAPP_PASSWORD) {
    return c.json({ error: 'not found' }, 404);
  }
  const auth = c.req.header('Authorization') ?? '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const token = headerToken || pathToken || '';
  if (!token || !(await safeEqual(token, MCP_TOKEN))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const server = createAitappServer(new SelfClient(c.env, dispatch));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
}
