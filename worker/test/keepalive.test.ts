import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Env, UserState } from '../src/types';
import { writeState, readState } from '../src/store/kv';
import {
  runKeepAlive,
  shardOf,
  currentShard,
  KEEPALIVE_SHARDS,
  CRON_INTERVAL_MS,
  MAX_PER_RUN,
} from '../src/keepalive';

afterEach(() => vi.unstubAllGlobals());

function makeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
  return { USER_KV: kv } as unknown as Env;
}

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const state = (over: Partial<UserState> = {}): UserState => ({
  lcamCookies: cookies,
  lcamSession: { registeredAt: 1000 },
  moodleToken: null,
  credential: { iv: '', ciphertext: '' },
  ...over,
});

/** 指定 shard に属する userId を n 個作る。 */
function idsInShard(shard: number, n: number, prefix = 'u'): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const id = `${prefix}${i}`;
    if (shardOf(id, KEEPALIVE_SHARDS) === shard) out.push(id);
  }
  return out;
}

const aliveBody = '<input name="org.apache.struts.taglib.html.TOKEN" value="t">個人時間割';
const staleBody = '<body id="login">ログインされていないためシステムを利用できません。</body>';

describe('shard', () => {
  it('同じ userId は常に同じ shard、範囲は 0..shards-1', () => {
    for (const id of ['a', 'b', '26049xx', 'x'.repeat(50)]) {
      const s = shardOf(id, KEEPALIVE_SHARDS);
      expect(s).toBe(shardOf(id, KEEPALIVE_SHARDS));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(KEEPALIVE_SHARDS);
    }
  });

  it('cron 10 分刻みで shard が 0,1,2 と巡回する', () => {
    const t0 = 1_000_000 * CRON_INTERVAL_MS;
    const seq = [0, 1, 2, 3].map((i) => currentShard(t0 + i * CRON_INTERVAL_MS));
    expect(new Set(seq.slice(0, 3)).size).toBe(3);
    expect(seq[3]).toBe(seq[0]);
  });
});

describe('runKeepAlive', () => {
  it('担当 shard のユーザーだけ ping し、他 shard・Cookie 未登録は触らない', async () => {
    const env = makeEnv();
    const t = 7 * CRON_INTERVAL_MS;
    const shard = currentShard(t);
    const [mine] = idsInShard(shard, 1);
    const [other] = idsInShard((shard + 1) % KEEPALIVE_SHARDS, 1, 'o');
    const [noCookie] = idsInShard(shard, 1, 'n');
    await writeState(env, mine, state());
    await writeState(env, other, state());
    await writeState(env, noCookie, state({ lcamCookies: null, lcamSession: null }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(String(u));
      return new Response(aliveBody, { status: 200 });
    });
    const r = await runKeepAlive(env, t);
    expect(urls).toHaveLength(1);
    expect(r).toMatchObject({ targets: 1, alive: 1, expired: 0, skipped: 1 });
  });

  it('失効を検知したら Cookie を破棄して expiredAt を記録する', async () => {
    const env = makeEnv();
    const t = 3 * CRON_INTERVAL_MS;
    const [uid] = idsInShard(currentShard(t), 1);
    await writeState(env, uid, state());
    vi.stubGlobal('fetch', async () => new Response(staleBody, { status: 200 }));
    const r = await runKeepAlive(env, t);
    expect(r).toMatchObject({ targets: 1, alive: 0, expired: 1 });
    const saved = await readState(env, uid);
    expect(saved?.lcamCookies).toBeNull();
    expect(saved?.lcamSession?.expiredAt).toBeGreaterThan(0);
    // 失効済みは次回以降 ping しない（Cookie が無いので skipped）。
    const r2 = await runKeepAlive(env, t);
    expect(r2).toMatchObject({ targets: 0, skipped: 1 });
  });

  it('上流エラー（500 等）は失効扱いにせず errors に数え、Cookie を残す', async () => {
    const env = makeEnv();
    const t = 5 * CRON_INTERVAL_MS;
    const [uid] = idsInShard(currentShard(t), 1);
    await writeState(env, uid, state());
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    const r = await runKeepAlive(env, t);
    expect(r).toMatchObject({ errors: 1, expired: 0 });
    expect((await readState(env, uid))?.lcamCookies).not.toBeNull();
  });

  it('1 回の実行の人数は MAX_PER_RUN で頭打ち', async () => {
    const env = makeEnv();
    const t = 2 * CRON_INTERVAL_MS;
    for (const id of idsInShard(currentShard(t), MAX_PER_RUN + 5)) await writeState(env, id, state());
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(aliveBody, { status: 200 });
    });
    await runKeepAlive(env, t);
    expect(calls).toBe(MAX_PER_RUN);
  });
});
