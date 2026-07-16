// UserState の read/write（要件 §6）。
// 1 ユーザー 1 key（`user:{id}`）に集約し、1 read で全状態を取得する。
// 書き込みは無料枠（KV write 1000/日）を浪費しないよう、ログイン時・上流 cookie
// 更新時・moodle token 更新時のみに限定する。

import type { Env, UserState } from '../types';

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
  await env.USER_KV.put(key(userId), JSON.stringify(state));
}

// user state を削除する。logout で session を実効失効させるために使う
// （暗号化 credential・上流 cookie・moodle token を1 read で消す＝1 key 削除）。
// 削除後はデータ系ミドルウェアと /api/auth/me がともに state 不在で 401 を返すため、
// 盗まれた cookie も logout 後は無効になる。
export async function deleteState(env: Env, userId: string): Promise<void> {
  await env.USER_KV.delete(key(userId));
}
