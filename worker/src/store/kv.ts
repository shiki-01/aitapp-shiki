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
