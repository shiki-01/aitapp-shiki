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
    return { uid: AITAPP_ID, internal: true, allowWrites: true };
  }

  // ユーザー別トークン。uid は state の所在を決めるだけで、認証は保存済みハッシュとの
  // 一致で行う（uid 部分を改竄するとハッシュが一致しなくなる）。
  const uid = parseUserMcpTokenUid(token);
  if (!uid) return null;
  const state = await readState(env, uid);
  if (!state?.mcpTokenHash) return null;
  const hash = await hashMcpToken(token);
  if (!(await safeEqual(hash, state.mcpTokenHash))) return null;
  return { uid, internal: false, allowWrites: state.mcpAllowWrites === true };
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
    // 401 は返さない: Claude のカスタムコネクタは 401 を「OAuth サインインが必要」と
    // 解釈して動的クライアント登録を試み、OAuth 非対応の本サーバーでは
    // 「サインインサービスに登録できませんでした」という無関係なエラーになる。
    // 認証はトークン URL のみで、サインインしても解決しないため 403 が正しい。
    // 発行/再発行直後は KV の伝播遅延（最大 1 分程度）で新トークンが未反映のことが
    // あるため、メッセージで再試行を案内する。
    return c.json(
      {
        error: 'invalid_token',
        message:
          'MCP トークンが無効です。発行直後の場合は反映まで最大 1 分ほどかかることがあるため、少し待ってから再試行してください。再発行した場合は新しい URL に更新してください。',
      },
      403,
    );
  }

  const server = createAitappServer(new SelfClient(c.env, dispatch, selfAuth));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
}
