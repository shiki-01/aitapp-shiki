// /mcp エンドポイント（MCP Streamable HTTP, stateless）。
// 認証: Authorization: Bearer <token>、またはカスタムヘッダを設定できない
// クライアント（スマホの Claude アプリのカスタムコネクタ等）向けに URL パスへの
// トークン埋め込み（/mcp/<token>）。トークンは 2 種類:
//   - owner トークン（env.MCP_TOKEN）: 資格情報は worker のシークレット（AITAPP_ID 等）。
//     従来の単一ユーザー運用。env が未設定なら無効。
//   - ユーザー別トークン（`u.` プレフィックス。/api/auth/mcp-token で自己発行）:
//     資格情報は本人が Web ログイン時に KV へ暗号化保存したものを使う。
//     KV の UserState.mcpTokenHash と SHA-256 ハッシュの一致で認証する。
// リクエストごとに McpServer を生成する stateless 運用
// （Durable Objects 不使用の制約に適合）。

import type { Context } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { createAitappServer } from '../../../mcp/src/register';
import type { Env } from '../types';
import { readState } from '../store/kv';
import { SelfClient, type Dispatch, type SelfAuth } from './self-client';
import { hashMcpToken, parseUserMcpTokenUid, safeEqual } from './token';

/** トークンを検証し、成立したら SelfClient の認証コンテキストを返す。 */
async function authenticate(env: Env, token: string): Promise<SelfAuth | null> {
  if (!token) return null;

  // owner トークン（従来方式）。env が揃っているときのみ有効。
  const { MCP_TOKEN, AITAPP_ID, AITAPP_PASSWORD } = env;
  if (MCP_TOKEN && AITAPP_ID && AITAPP_PASSWORD && (await safeEqual(token, MCP_TOKEN))) {
    return { uid: AITAPP_ID, internal: true };
  }

  // ユーザー別トークン。uid は state の所在を決めるだけで、認証は保存済みハッシュとの
  // 一致で行う（uid 部分を改竄するとハッシュが一致しなくなる）。
  const uid = parseUserMcpTokenUid(token);
  if (!uid) return null;
  const state = await readState(env, uid);
  if (!state?.mcpTokenHash) return null;
  const hash = await hashMcpToken(token);
  if (!(await safeEqual(hash, state.mcpTokenHash))) return null;
  return { uid, internal: false };
}

export async function handleMcpRequest<E extends { Bindings: Env }>(
  c: Context<E>,
  dispatch: Dispatch,
  pathToken?: string,
): Promise<Response> {
  const auth = c.req.header('Authorization') ?? '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const token = headerToken || pathToken || '';
  const selfAuth = await authenticate(c.env, token);
  if (!selfAuth) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const server = createAitappServer(new SelfClient(c.env, dispatch, selfAuth));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
}
