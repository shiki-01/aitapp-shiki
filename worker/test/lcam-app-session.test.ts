// withLcamSession のアプリ方式（保存済み資格情報での透過再ログイン）の挙動。
// 旧方式（資格情報なし）の挙動は lcam-session.test.ts。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, LcamAppCredential, LcamCookies, UserState } from '../src/types';
import { withLcamSession } from '../src/upstream/lcam/session';
import { appLogin } from '../src/upstream/lcam/app-login';
import { encryptJson } from '../src/crypto/aes';
import { readState, writeState } from '../src/store/kv';
import {
  LcamAppCredentialRejectedError,
  LcamExpiredError,
  LcamReauthRequiredError,
  UpstreamError,
} from '../src/upstream/errors';

vi.mock('../src/upstream/lcam/app-login', () => ({ appLogin: vi.fn() }));

function makeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return { USER_KV: kv, CRED_KEY: 'test-cred-key' } as unknown as Env;
}

const cred: LcamAppCredential = { userId: 'u1', password: 'p1' };
const oldCookies: LcamCookies = { jsessionid: 'JSESSIONID=old', liveApps: '' };
const newCookies: LcamCookies = { jsessionid: 'JSESSIONID=new', liveApps: '', extra: ['L-CamApp=Y'] };

async function appState(env: Env, over: Partial<UserState> = {}): Promise<UserState> {
  return {
    lcamCookies: oldCookies,
    lcamSession: { registeredAt: 1000 },
    lcamApp: await encryptJson(env.CRED_KEY, cred),
    moodleToken: null,
    credential: { iv: '', ciphertext: '' },
    ...over,
  };
}

const expire = () => {
  throw new LcamExpiredError();
};

beforeEach(() => {
  vi.mocked(appLogin).mockReset();
  vi.mocked(appLogin).mockResolvedValue(newCookies);
});

describe('withLcamSession（アプリ方式）', () => {
  it('Cookie が無くても資格情報があれば再ログインして op を実行し、Cookie と lastOkAt を保存する', async () => {
    const env = makeEnv();
    const s = await appState(env, { lcamCookies: null });
    await writeState(env, 'u', s);
    const op = vi.fn(async (_c: LcamCookies) => 'ok');

    expect(await withLcamSession(env, 'u', s, op)).toBe('ok');

    expect(appLogin).toHaveBeenCalledTimes(1);
    expect(appLogin).toHaveBeenCalledWith(cred); // 復号した資格情報で呼ばれる
    expect(op).toHaveBeenCalledWith(newCookies);
    const saved = await readState(env, 'u');
    expect(saved?.lcamCookies).toEqual(newCookies);
    expect(saved?.lcamSession?.registeredAt).toBe(1000); // 初回登録時刻は保つ
    expect(saved?.lcamSession?.lastOkAt).toBeGreaterThan(0);
    expect(saved?.lcamApp).toEqual(s.lcamApp);
  });

  it('失効を検知したら再ログインし、同じ操作を 1 回だけ再試行する', async () => {
    const env = makeEnv();
    const s = await appState(env);
    await writeState(env, 'u', s);
    const op = vi.fn(async (c: LcamCookies) => {
      if (c === oldCookies) expire();
      return 'ok';
    });

    expect(await withLcamSession(env, 'u', s, op)).toBe('ok');

    expect(appLogin).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
    expect(op).toHaveBeenNthCalledWith(1, oldCookies);
    expect(op).toHaveBeenNthCalledWith(2, newCookies);
    expect((await readState(env, 'u'))?.lcamCookies).toEqual(newCookies);
  });

  it('再試行でも失効なら諦める（再ログインは 1 回、op は 2 回）。資格情報は残す', async () => {
    const env = makeEnv();
    const s = await appState(env);
    await writeState(env, 'u', s);
    const op = vi.fn(async () => expire());

    await expect(withLcamSession(env, 'u', s, op)).rejects.toBeInstanceOf(LcamReauthRequiredError);

    expect(appLogin).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
    const saved = await readState(env, 'u');
    expect(saved?.lcamCookies).toBeNull();
    expect(saved?.lcamSession?.expiredAt).toBeGreaterThan(0);
    expect(saved?.lcamApp).toEqual(s.lcamApp); // 次のリクエストで再ログインできる
  });

  it('再ログイン直後（Cookie 無しからのログイン）に失効したら再試行しない', async () => {
    const env = makeEnv();
    const s = await appState(env, { lcamCookies: null });
    await writeState(env, 'u', s);
    const op = vi.fn(async () => expire());

    await expect(withLcamSession(env, 'u', s, op)).rejects.toBeInstanceOf(LcamReauthRequiredError);

    expect(appLogin).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('他のリクエストが KV の Cookie を更新済みなら、ログインせずそれを採用する', async () => {
    const env = makeEnv();
    const s = await appState(env);
    // 自分が使った Cookie（old）の失効を検知する前に、別リクエストが new を保存していた状況。
    await writeState(env, 'u', { ...s, lcamCookies: newCookies });
    const op = vi.fn(async (c: LcamCookies) => {
      if (c === oldCookies) expire();
      return 'ok';
    });

    expect(await withLcamSession(env, 'u', s, op)).toBe('ok');

    expect(appLogin).not.toHaveBeenCalled();
    expect(op).toHaveBeenNthCalledWith(2, newCookies);
  });

  it('資格情報が拒否されたら lcamApp を破棄し、再登録を求める（拒否を繰り返さない）', async () => {
    const env = makeEnv();
    const s = await appState(env);
    await writeState(env, 'u', s);
    vi.mocked(appLogin).mockRejectedValue(new LcamAppCredentialRejectedError());

    await expect(withLcamSession(env, 'u', s, async () => expire())).rejects.toMatchObject({
      name: 'LcamReauthRequiredError',
      reason: 'expired',
    });

    const saved = await readState(env, 'u');
    expect(saved?.lcamApp).toBeNull();
    expect(saved?.lcamCookies).toBeNull();
    expect(saved?.lcamSession?.expiredAt).toBeGreaterThan(0);
  });

  it('ログイン制限などの上流エラーは資格情報を捨てずに伝播する', async () => {
    const env = makeEnv();
    const s = await appState(env);
    await writeState(env, 'u', s);
    vi.mocked(appLogin).mockRejectedValue(new UpstreamError('restricted'));

    await expect(withLcamSession(env, 'u', s, async () => expire())).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect((await readState(env, 'u'))?.lcamApp).toEqual(s.lcamApp);
  });

  it('失効以外のエラーは再ログインせずそのまま伝播する', async () => {
    const env = makeEnv();
    const s = await appState(env);
    await writeState(env, 'u', s);

    await expect(
      withLcamSession(env, 'u', s, async () => {
        throw new UpstreamError('boom');
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(appLogin).not.toHaveBeenCalled();
  });

  it('資格情報が無ければ従来どおり再ログインしない（失効で Cookie を破棄）', async () => {
    const env = makeEnv();
    const s = await appState(env, { lcamApp: null });
    await writeState(env, 'u', s);
    const op = vi.fn(async () => expire());

    await expect(withLcamSession(env, 'u', s, op)).rejects.toBeInstanceOf(LcamReauthRequiredError);

    expect(appLogin).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
    expect((await readState(env, 'u'))?.lcamCookies).toBeNull();
  });
});
