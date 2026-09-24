// LCAM セッションの keep-alive（Cron Trigger から呼ばれる）。
//
// LCAM のセッションは「無操作 1 時間 30 分」で切れる（操作でリセットされる。ユーザー実測。
// MIGRATION_NOTES §14.4）。登録済みの Cookie を持つユーザーごとに、軽い SP ページ
// （時間割）へ定期的に 1 回 GET して無操作時間が伸びないようにする。
// 絶対時間の上限があれば失効を検知して expiredAt を記録するだけ（自動再ログインはしない。
// LCAM は MFA のため不可能）。
//
// 無料枠に収めるための設計:
//   - Cron は 10 分ごと、ユーザーを userId のハッシュで 3 グループ（shard）に分け、
//     1 回の実行では 1 グループだけを処理する（各ユーザーは 30 分ごと）。
//     1 回の実行で扱う人数を減らし、CPU 時間（無料 10ms/実行）と subrequest 上限（無料 50）を守る。
//   - 1 回の実行の上限人数は MAX_PER_RUN。超過分は warn ログを出して次回以降に回さない
//     （その shard の後方ユーザーは維持されない。人数が増えたら shard 数を増やすこと）。
//   - KV は list 1 回 + 対象ユーザーの read のみ。書き込みは失効検知時と lastOkAt 更新（3 時間に 1 回）のみ。

import type { Env } from './types';
import { listUserIds, readState } from './store/kv';
import { configureLcamRelay } from './upstream/lcam/access';
import { probeSpSession } from './upstream/lcam/client';
import { withLcamSession } from './upstream/lcam/session';
import { LcamReauthRequiredError } from './upstream/errors';
import { log } from './log';

/** wrangler.toml の cron 間隔（分）と一致させる。 */
export const CRON_INTERVAL_MS = 10 * 60 * 1000;
/** 各ユーザーを ping する周期 = CRON_INTERVAL_MS × KEEPALIVE_SHARDS（30 分）。 */
export const KEEPALIVE_SHARDS = 3;
/** 1 回の実行で処理する最大人数。 */
export const MAX_PER_RUN = 20;

/** userId を 0..shards-1 に振り分ける（FNV-1a）。同じ userId は常に同じ shard。 */
export function shardOf(userId: string, shards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** この実行（scheduledTime）が担当する shard。 */
export function currentShard(scheduledTime: number): number {
  return Math.floor(scheduledTime / CRON_INTERVAL_MS) % KEEPALIVE_SHARDS;
}

export interface KeepAliveResult {
  shard: number;
  targets: number;
  alive: number;
  expired: number;
  errors: number;
  skipped: number;
}

export async function runKeepAlive(env: Env, scheduledTime: number): Promise<KeepAliveResult> {
  configureLcamRelay(env);
  const correlationId = crypto.randomUUID();
  const shard = currentShard(scheduledTime);
  const result: KeepAliveResult = { shard, targets: 0, alive: 0, expired: 0, errors: 0, skipped: 0 };

  const ids = (await listUserIds(env)).filter((id) => shardOf(id, KEEPALIVE_SHARDS) === shard);
  ids.sort();
  if (ids.length > MAX_PER_RUN) {
    log('warn', correlationId, 'keepalive capped', { shard, users: ids.length, max: MAX_PER_RUN });
  }

  for (const uid of ids.slice(0, MAX_PER_RUN)) {
    try {
      const state = await readState(env, uid);
      if (!state?.lcamCookies) {
        result.skipped++;
        continue;
      }
      result.targets++;
      await withLcamSession(env, uid, state, (cookies) => probeSpSession(cookies));
      result.alive++;
    } catch (e) {
      if (e instanceof LcamReauthRequiredError) {
        // 失効を検知（withLcamSession が expiredAt を記録し Cookie を破棄済み）。
        result.expired++;
      } else {
        result.errors++;
        // uid・Cookie は出さない。例外名とメッセージのみ。
        log('warn', correlationId, 'keepalive failed', {
          errorName: (e as Error).name,
          detail: (e as Error).message,
        });
      }
    }
  }
  log('info', correlationId, 'keepalive done', { ...result });
  return result;
}
