<script lang="ts">
  import { api, ApiError, type LotteryResult } from '$lib/api';

  let rows = $state<LotteryResult[]>([]);
  let loading = $state(true);
  let error = $state('');
  // 再読込の連打で古い応答が新しい結果を上書きしないよう、最新の要求だけ採用する。
  let seq = 0;

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  // 学事システムは入るたびに数リクエスト要るので、開いたときの 1 回と再読込ボタンでだけ取得する。
  async function load() {
    const my = ++seq;
    loading = true;
    error = '';
    try {
      const res = await api.lottery();
      if (my !== seq) return;
      rows = res.lottery;
    } catch (err) {
      if (my !== seq) return;
      rows = [];
      error = errorText(err, '抽選結果の取得に失敗しました');
    } finally {
      if (my === seq) loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  type Outcome = 'won' | 'lost' | 'pending';
  function outcome(r: LotteryResult): Outcome {
    const v = r.result.trim();
    if (v === '当選') return 'won';
    if (v === '落選') return 'lost';
    return 'pending';
  }
  const OUTCOME_LABEL: Record<Outcome, string> = {
    won: '当選',
    lost: '落選',
    pending: '抽選前',
  };

  // 同じ曜日時限の行をまとめる。並びは上流の出現順。
  const groups = $derived.by(() => {
    const map = new Map<string, LotteryResult[]>();
    for (const r of rows) {
      const g = map.get(r.slot);
      if (g) g.push(r);
      else map.set(r.slot, [r]);
    }
    return [...map].map(([slot, list]) => ({ slot, list }));
  });

  const summary = $derived({
    won: rows.filter((r) => outcome(r) === 'won').length,
    lost: rows.filter((r) => outcome(r) === 'lost').length,
    pending: rows.filter((r) => outcome(r) === 'pending').length,
  });
</script>

<div class="bar">
  <button class="reload" onclick={load} disabled={loading}>再読込</button>
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={load}>再試行</button>
  </div>
{:else if rows.length === 0}
  <p class="muted">抽選履修登録の申し込みはありません。</p>
{:else}
  <p class="count">
    {rows.length} 件（当選 {summary.won} / 落選 {summary.lost} / 抽選前 {summary.pending}）
  </p>
  {#each groups as g (g.slot)}
    <section class="group">
      <h3 class="slot">{g.slot}</h3>
      <ul class="list">
        {#each g.list as r (`${r.classCode}-${r.preference}`)}
          {@const o = outcome(r)}
          <li class="item {o}">
            <div class="title-row">
              <span class="badge {o}">{OUTCOME_LABEL[o]}</span>
              <span class="title">{r.subject}</span>
            </div>
            <div class="meta">
              希望 {r.preference} 位 · 定員 {r.capacity} · {r.credits} 単位
            </div>
            <div class="meta">
              {r.category}{#if r.creditType} · {r.creditType}{/if}{#if r.campus} · {r.campus}{/if}{#if r.biweekly} · {r.biweekly}{/if}
            </div>
            <div class="meta">
              {r.classCode}{#if r.processedAt} · 抽選処理日 {r.processedAt}{/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  .bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 10px;
  }
  .reload {
    padding: 6px 14px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-size: 0.85rem;
  }
  .reload:disabled {
    opacity: 0.5;
  }
  .count {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 8px;
  }
  .group {
    margin-bottom: 14px;
  }
  .slot {
    margin: 0 0 6px;
    font-size: 0.95rem;
    color: var(--navy);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .item {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  /* 当選は強調、落選は控えめに。抽選前は既定の見た目。 */
  .item.won {
    background: var(--success-bg);
    border-color: var(--success);
  }
  .item.lost {
    background: var(--card);
  }
  .item.lost .title {
    color: var(--muted);
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .badge {
    flex: 0 0 auto;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.72rem;
  }
  .badge.won {
    background: var(--success);
    color: #fff;
  }
  .badge.lost {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .badge.pending {
    background: var(--border);
    color: var(--muted);
  }
  .meta {
    color: var(--muted);
    font-size: 0.8rem;
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
    text-align: center;
    margin: 14px 0;
    font-size: 0.85rem;
  }
  .error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .error-box {
    text-align: center;
  }
  .retry {
    padding: 9px 22px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-weight: 500;
  }
</style>
