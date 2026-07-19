// ユーザー別 MCP トークン（mint / parse / hash）の単体テスト。

import { describe, it, expect } from 'vitest';
import {
  mintUserMcpToken,
  parseUserMcpTokenUid,
  hashMcpToken,
  safeEqual,
} from '../src/mcp/token';

describe('mintUserMcpToken', () => {
  it('u.<b64url(uid)>.<hex64> 形式のトークンと SHA-256 ハッシュを返す', async () => {
    const { token, hash } = await mintUserMcpToken('b12345');
    expect(token).toMatch(/^u\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(hash).toBe(await hashMcpToken(token));
    // URL パスセグメントとして安全な文字のみ。
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('毎回異なるトークンを生成する（再発行で旧トークンのハッシュと一致しない）', async () => {
    const a = await mintUserMcpToken('b12345');
    const b = await mintUserMcpToken('b12345');
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('parseUserMcpTokenUid', () => {
  it('mint したトークンから uid を復元できる', async () => {
    const { token } = await mintUserMcpToken('b12345');
    expect(parseUserMcpTokenUid(token)).toBe('b12345');
  });

  it('形式不正は null（owner トークンや任意文字列を user トークンとして扱わない）', async () => {
    expect(parseUserMcpTokenUid('')).toBeNull();
    expect(parseUserMcpTokenUid('deadbeef')).toBeNull(); // env MCP_TOKEN 風
    expect(parseUserMcpTokenUid('u.only-two')).toBeNull();
    expect(parseUserMcpTokenUid('x.YjEyMzQ1.' + 'a'.repeat(64))).toBeNull();
    expect(parseUserMcpTokenUid('u..' + 'a'.repeat(64))).toBeNull(); // uid 空
    expect(parseUserMcpTokenUid('u.YjEyMzQ1.notahexsecret')).toBeNull();
    expect(parseUserMcpTokenUid('u.%%%.' + 'a'.repeat(64))).toBeNull(); // b64url 不正
  });

  it('uid 部分を改竄するとハッシュが一致しなくなる', async () => {
    const { token, hash } = await mintUserMcpToken('b12345');
    const [p, , secret] = token.split('.');
    // 別 uid（b99999）に付け替えた偽トークン。
    const forged = `${p}.${btoa('b99999').replace(/=+$/, '')}.${secret}`;
    expect(parseUserMcpTokenUid(forged)).toBe('b99999');
    expect(await hashMcpToken(forged)).not.toBe(hash);
  });
});

describe('safeEqual', () => {
  it('一致/不一致を判定する', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('', '')).toBe(true);
  });
});
