// /mcp が、未対応の mcp-protocol-version に 500 ではなく JSON-RPC エラー入りの 4xx を返すこと。
// クライアント（Claude）はこの応答を見て対応バージョンへ切り替える。500 だと切り替えが起きず、
// コネクタの接続が断続的に失敗する（app.onError が HTTPException を潰していた不具合の回帰テスト）。

import { describe, it, expect } from 'vitest';
import app from '../src/router';
import type { Env } from '../src/types';

const TOKEN = 'owner-token-for-test';
const env = {
  USER_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  MCP_TOKEN: TOKEN,
  AITAPP_ID: 'x00000xx',
  AITAPP_PASSWORD: 'dummy',
  CRED_KEY: 'dummy-cred-key',
  SESSION_SECRET: 'dummy-session-secret',
} as unknown as Env;

function post(protocolVersion: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  return Promise.resolve(
    app.fetch(
      new Request('https://example.test/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      env,
    ),
  );
}

describe('/mcp の mcp-protocol-version', () => {
  it('未対応のバージョンは 500 ではなく、JSON-RPC エラー入りの 4xx を返す', async () => {
    const res = await post('2099-01-01');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('Unsupported protocol version');
  });

  it('トークンが無効なら従来どおり 403', async () => {
    const res = await app.fetch(
      new Request('https://example.test/mcp/wrong-token', { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(403);
  });
});
