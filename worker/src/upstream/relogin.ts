// 透過再ログイン共通ラッパ（要件 §8）。
// 失効検知 → 保存済み credential で再ログイン → 同一処理を1回だけリトライ →
// 再失効でエラー。直列化・即時失効・keep-alive・自動復旧はしない。

import type { Env, UserState, LcamCookies } from '../types';
import { decryptCredential } from '../crypto/aes';
import { writeState } from '../store/kv';
import { getCookie, loginLcam } from './lcam/access';
import { parseHtml } from '../html/parser';
import { isLoginSuccess } from './lcam/detect';
import { LcamExpiredError, AuthFailedError } from './errors';

/** 保存済み credential で LCAM(SP) に再ログインし、state.lcamCookies を更新・永続化する。 */
async function reloginLcam(
  env: Env,
  userId: string,
  state: UserState,
): Promise<void> {
  const cred = await decryptCredential(env.CRED_KEY, state.credential);
  const initial = await getCookie();
  const { body, cookies } = await loginLcam(cred.id, cred.password, initial);
  if (!isLoginSuccess(parseHtml(body))) {
    throw new AuthFailedError('LCAM re-login rejected (password change / MFA?)');
  }
  state.lcamCookies = cookies;
  // 再ログイン時のみ KV 書き込み（last-write-wins、直列化なし）。
  await writeState(env, userId, state);
}

/**
 * LCAM 操作を透過再ログイン付きで実行する。
 * op は失効を検知したら LcamExpiredError を投げること。
 */
export async function withLcamRelogin<T>(
  env: Env,
  userId: string,
  state: UserState,
  op: (cookies: LcamCookies) => Promise<T>,
): Promise<T> {
  if (!state.lcamCookies) {
    await reloginLcam(env, userId, state);
  }
  try {
    return await op(state.lcamCookies!);
  } catch (e) {
    if (!(e instanceof LcamExpiredError)) throw e;
    // 失効 → 再ログイン → 1回だけリトライ。
    await reloginLcam(env, userId, state);
    try {
      return await op(state.lcamCookies!);
    } catch (e2) {
      if (e2 instanceof LcamExpiredError) {
        throw new AuthFailedError('LCAM re-login failed twice');
      }
      throw e2;
    }
  }
}
