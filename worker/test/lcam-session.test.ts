import { describe, it, expect } from 'vitest';
import type { Env, LcamCookies, UserState } from '../src/types';
import { withLcamSession } from '../src/upstream/lcam/session';
import { resolveRedirect } from '../src/upstream/lcam/access';
import { readState, writeState } from '../src/store/kv';
import {
  LcamExpiredError,
  LcamReauthRequiredError,
  UpstreamError,
} from '../src/upstream/errors';

function makeEnv(): { env: Env; puts: () => number } {
  const store = new Map<string, string>();
  let puts = 0;
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      puts++;
      store.set(k, v);
    },
    delete: async (k: string) => void store.delete(k),
  };
  return { env: { USER_KV: kv } as unknown as Env, puts: () => puts };
}

const cookies: LcamCookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const baseState = (over: Partial<UserState> = {}): UserState => ({
  lcamCookies: cookies,
  lcamSession: { registeredAt: 1000 },
  moodleToken: null,
  credential: { iv: '', ciphertext: '' },
  ...over,
});

describe('withLcamSession', () => {
  it('Cookie 未登録なら not_registered', async () => {
    const { env } = makeEnv();
    await expect(
      withLcamSession(env, 'u', baseState({ lcamCookies: null, lcamSession: null }), async () => 1),
    ).rejects.toMatchObject({ name: 'LcamReauthRequiredError', reason: 'not_registered' });
  });

  it('失効検知後（expiredAt あり・Cookie なし）は expired', async () => {
    const { env } = makeEnv();
    const s = baseState({ lcamCookies: null, lcamSession: { registeredAt: 1, expiredAt: 5 } });
    await expect(withLcamSession(env, 'u', s, async () => 1)).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('成功時は結果を返し、lastOkAt を間引いて記録する', async () => {
    const { env, puts } = makeEnv();
    const s = baseState();
    await writeState(env, 'u', s);
    const before = puts();
    expect(await withLcamSession(env, 'u', s, async () => 'ok')).toBe('ok');
    expect(puts()).toBe(before + 1);
    const saved = await readState(env, 'u');
    expect(saved?.lcamSession?.lastOkAt).toBeGreaterThan(0);

    // 直後の 2 回目は間引かれて書き込まない。
    const s2 = { ...saved!, };
    await withLcamSession(env, 'u', s2, async () => 'ok');
    expect(puts()).toBe(before + 1);
  });

  it('失効検知で Cookie を破棄し expiredAt を記録、再試行はしない', async () => {
    const { env } = makeEnv();
    const s = baseState();
    await writeState(env, 'u', s);
    let calls = 0;
    await expect(
      withLcamSession(env, 'u', s, async () => {
        calls++;
        throw new LcamExpiredError();
      }),
    ).rejects.toBeInstanceOf(LcamReauthRequiredError);
    expect(calls).toBe(1);
    const saved = await readState(env, 'u');
    expect(saved?.lcamCookies).toBeNull();
    expect(saved?.lcamSession?.registeredAt).toBe(1000);
    expect(saved?.lcamSession?.expiredAt).toBeGreaterThan(0);
  });

  it('失効検知の間に再登録されていたら、新しい Cookie を破棄しない', async () => {
    const { env } = makeEnv();
    const fresh = baseState({
      lcamCookies: { jsessionid: 'JSESSIONID=NEW', liveApps: 'LiveApps-Cookie=NEW' },
      lcamSession: { registeredAt: 2000 },
    });
    await writeState(env, 'u', fresh);
    await expect(
      withLcamSession(env, 'u', baseState(), async () => {
        throw new LcamExpiredError();
      }),
    ).rejects.toBeInstanceOf(LcamReauthRequiredError);
    const saved = await readState(env, 'u');
    expect(saved?.lcamCookies?.jsessionid).toBe('JSESSIONID=NEW');
    expect(saved?.lcamSession?.expiredAt).toBeUndefined();
  });

  it('LcamExpiredError 以外のエラーは素通しで状態も変えない', async () => {
    const { env, puts } = makeEnv();
    const s = baseState();
    const before = puts();
    await expect(
      withLcamSession(env, 'u', s, async () => {
        throw new UpstreamError('boom');
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(puts()).toBe(before);
  });
});

describe('resolveRedirect', () => {
  it('SSO への誘導は LcamExpiredError', () => {
    expect(() =>
      resolveRedirect(
        '/mellon/login?ReturnTo=x',
        'https://lcam.aitech.ac.jp/portalv2/smartphone/x',
      ),
    ).toThrow(LcamExpiredError);
    expect(() =>
      resolveRedirect('https://login.microsoftonline.com/t', 'https://lcam.aitech.ac.jp/portalv2/'),
    ).toThrow(LcamExpiredError);
  });

  it('同一オリジンの相対・絶対 URL は解決して返す', () => {
    expect(resolveRedirect('/portalv2/home', 'https://lcam.aitech.ac.jp/portalv2/')).toBe(
      'https://lcam.aitech.ac.jp/portalv2/home',
    );
  });

  it('LCAM 以外のホストへは追従せず UpstreamError（Cookie を送らない）', () => {
    expect(() => resolveRedirect('https://evil.example/x', 'https://lcam.aitech.ac.jp/')).toThrow(
      UpstreamError,
    );
  });
});
