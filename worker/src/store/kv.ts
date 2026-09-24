// UserState の read/write（要件 §6）。
// 1 ユーザー 1 key（`user:{id}`）に集約し、1 read で全状態を取得する。
// 書き込みは無料枠（KV write 1000/日）を浪費しないよう、ログイン時・上流 cookie
// 更新時・moodle token 更新時のみに限定する。

import type { Env, UserState } from '../types';

/**
 * KV エントリの TTL（秒）。90 日。書き込みのたびに更新する sliding 方式なので、
 * ログイン・上流 cookie 更新・moodle token 更新のある能動ユーザーの state は
 * 都度延命され、卒業・退学等で使われなくなった state（孤児 state）は自動失効する。
 * 別 key を分けず 1 key に集約している都合上、明示的な delete パスの代わりに使う。
 */
const STATE_TTL_SECONDS = 60 * 60 * 24 * 90;

function key(userId: string): string {
  return `user:${userId}`;
}

export async function readState(
  env: Env,
  userId: string,
): Promise<UserState | null> {
  const raw = await env.USER_KV.get(key(userId));
  if (raw === null) return null;
  return JSON.parse(raw) as UserState;
}

export async function writeState(
  env: Env,
  userId: string,
  state: UserState,
): Promise<void> {
  await env.USER_KV.put(key(userId), JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

/**
 * user state を持つ userId を列挙する（keep-alive の cron 用）。
 * KV list は無料枠 1000/日。呼び出し側は 1 回の cron につき 1 回だけ使うこと。
 */
export async function listUserIds(env: Env): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page: KVNamespaceListResult<unknown> = await env.USER_KV.list({ prefix: 'user:', cursor });
    for (const k of page.keys) ids.push(k.name.slice('user:'.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

// user state を削除する。logout で session を実効失効させるために使う
// （暗号化 credential・上流 cookie・moodle token を1 read で消す＝1 key 削除）。
// 削除後はデータ系ミドルウェアと /api/auth/me がともに state 不在で 401 を返すため、
// 盗まれた cookie も logout 後は無効になる。
export async function deleteState(env: Env, userId: string): Promise<void> {
  await env.USER_KV.delete(key(userId));
}
