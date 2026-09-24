// LCAM セッション共通ラッパ（旧 relogin.ts の置き換え）。
// LCAM は Entra ID の SSO + MFA になり、Worker がパスワードで再ログインすることは
// できない（MFA は自動化しない方針）。Cookie はユーザーがブラウザでログインして
// 登録したものを使い、失効を検知したら再登録を求めるエラー（LcamReauthRequiredError）を
// 返すだけにする。再ログイン・リトライ・keep-alive・寿命探査の反復アクセスはしない。

import type { Env, UserState, LcamCookies } from '../../types';
import { readState, writeState } from '../../store/kv';
import { sameLcamCookies } from './cookies';
import { LcamExpiredError, LcamReauthRequiredError } from '../errors';

/** lastOkAt の更新間隔。KV write（無料枠 1000/日）を消費しすぎないよう間引く。 */
export const LAST_OK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 「使った Cookie が KV 上でまだ同じ」ときだけ state を書き換える。
 * 失効検知・lastOkAt 更新の最中にユーザーが再登録した場合に、新しい Cookie を
 * 古い結果で潰さないための競合ガード（直列化ではなく、last-write-wins の事故防止）。
 */
async function updateIfSameCookies(
  env: Env,
  userId: string,
  used: LcamCookies,
  mutate: (fresh: UserState) => UserState,
): Promise<void> {
  const fresh = await readState(env, userId);
  if (!fresh || !sameLcamCookies(fresh.lcamCookies, used)) return;
  await writeState(env, userId, mutate(fresh));
}

/** 失効を記録し、Cookie を破棄する（以降のリクエストは LCAM へ行かず即エラーになる）。 */
async function markExpired(env: Env, userId: string, used: LcamCookies): Promise<void> {
  await updateIfSameCookies(env, userId, used, (fresh) => ({
    ...fresh,
    lcamCookies: null,
    lcamSession: {
      registeredAt: fresh.lcamSession?.registeredAt ?? 0,
      lastOkAt: fresh.lcamSession?.lastOkAt,
      expiredAt: Date.now(),
    },
  }));
}

/** 成功時刻を間引きつつ記録する（登録時刻が無い旧 state は対象外）。 */
async function touchLastOk(
  env: Env,
  userId: string,
  state: UserState,
  used: LcamCookies,
): Promise<void> {
  const meta = state.lcamSession;
  if (!meta || meta.expiredAt) return;
  const now = Date.now();
  if (meta.lastOkAt !== undefined && now - meta.lastOkAt < LAST_OK_INTERVAL_MS) return;
  await updateIfSameCookies(env, userId, used, (fresh) => ({
    ...fresh,
    lcamSession: { ...(fresh.lcamSession ?? meta), lastOkAt: now },
  }));
}

/**
 * 登録済みの LCAM Cookie で op を実行する。
 * op は失効を検知したら LcamExpiredError を投げること。
 */
export async function withLcamSession<T>(
  env: Env,
  userId: string,
  state: UserState,
  op: (cookies: LcamCookies) => Promise<T>,
): Promise<T> {
  const cookies = state.lcamCookies;
  if (!cookies) {
    throw new LcamReauthRequiredError(state.lcamSession?.expiredAt ? 'expired' : 'not_registered');
  }
  let result: T;
  try {
    result = await op(cookies);
  } catch (e) {
    if (!(e instanceof LcamExpiredError)) throw e;
    await markExpired(env, userId, cookies);
    throw new LcamReauthRequiredError('expired');
  }
  await touchLastOk(env, userId, state, cookies);
  return result;
}
