import { describe, it, expect } from 'vitest';
import {
  signSession,
  verifySession,
  type SessionPayload,
} from '../src/session/cookie';

const SECRET = 'session-secret-abcdef';

// iat は現在時刻にする（#7 の iat 期限検証で 30 日超は失効するため、
// 固定の過去時刻だと round-trip 検証が失効扱いになってしまう）。
const payload: SessionPayload = { uid: 's4200001', iat: Date.now() };

describe('session cookie の署名/検証', () => {
  it('sign→verify で payload が復元される', async () => {
    const token = await signSession(SECRET, payload);
    expect(token).toContain('.');
    const verified = await verifySession(SECRET, token);
    expect(verified).toEqual(payload);
  });

  it('別の秘密鍵では検証に失敗し null を返す', async () => {
    const token = await signSession(SECRET, payload);
    const verified = await verifySession('another-secret', token);
    expect(verified).toBeNull();
  });

  it('payload 部が改竄されると null を返す', async () => {
    const token = await signSession(SECRET, payload);
    const [, sig] = token.split('.');
    // payload を別ユーザーに差し替えても署名が合わない。
    const forgedBody = btoa(JSON.stringify({ uid: 'attacker', iat: 1 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const forged = `${forgedBody}.${sig}`;
    expect(await verifySession(SECRET, forged)).toBeNull();
  });

  it('undefined / 不正形式トークンは null', async () => {
    expect(await verifySession(SECRET, undefined)).toBeNull();
    expect(await verifySession(SECRET, 'no-dot-token')).toBeNull();
  });
});
