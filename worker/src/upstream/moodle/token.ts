// Moodle token の確保・失効時リトライ共通ラッパ。
// upstream/relogin.ts の LCAM 版と同じ方針: 失効検知 → password で再取得 →
// 同一処理を1回だけリトライ。直列化・keep-alive・自動復旧はしない。

import type { Env, UserState } from '../../types';
import { decryptCredential } from '../../crypto/aes';
import { writeState } from '../../store/kv';
import { UpstreamError } from '../errors';
import { getMoodleToken, MoodleTokenError } from './access';

/** Moodle 操作を token 確保＋失効時リトライ付きで実行する。 */
export async function withMoodleToken<T>(
  env: Env,
  userId: string,
  state: UserState,
  op: (token: string, moodleOrigin: string) => Promise<T>,
): Promise<T> {
  const cred = await decryptCredential(env.CRED_KEY, state.credential);
  if (!cred.moodleOrigin) {
    throw new UpstreamError('Moodle origin not configured for this user');
  }
  const moodleOrigin = cred.moodleOrigin;

  async function refreshToken(): Promise<string> {
    // Moodle 専用資格情報があればそちらを、なければ LCAM と同じ id/password を使う。
    const useMoodleCred = Boolean(cred.moodleId && cred.moodlePassword);
    const token = await getMoodleToken(
      moodleOrigin,
      useMoodleCred ? cred.moodleId! : cred.id,
      useMoodleCred ? cred.moodlePassword! : cred.password,
    );
    state.moodleToken = token;
    await writeState(env, userId, state);
    return token;
  }

  const token = state.moodleToken ?? (await refreshToken());
  try {
    return await op(token, moodleOrigin);
  } catch (e) {
    if (!(e instanceof MoodleTokenError)) throw e;
    const fresh = await refreshToken();
    return op(fresh, moodleOrigin);
  }
}
