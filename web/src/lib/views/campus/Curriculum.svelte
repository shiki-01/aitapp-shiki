<script lang="ts">
  import { api, ApiError, type CurriculumItem } from '$lib/api';

  let items = $state<CurriculumItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  // 再読込の連打で古い応答が新しい結果を上書きしないよう、最新の要求だけ採用する。
  let seq = 0;

  let keyword = $state('');
  let category = $state('');
  let ungradedOnly = $state(false);

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
      const res = await api.curriculum();
      if (my !== seq) return;
      items = res.curriculum;
    } catch (err) {
      if (my !== seq) return;
      items = [];
      error = errorText(err, 'カリキュラムの取得に失敗しました');
    } finally {
      if (my === seq) loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function graded(i: CurriculumItem): boolean {
    return i.grade.trim() !== '';
  }

  // 科目区分は出現順で重複を除く。
  const categories = $derived([...new Set(items.map((i) => i.category).filter((c) => c !== ''))]);

  const filtered = $derived.by(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((i) => {
      if (category && i.category !== category) return false;
      if (ungradedOnly && graded(i)) return false;
      if (kw && !i.name.toLowerCase().includes(kw) && !i.code.toLowerCase().includes(kw)) {
        return false;
      }
      return true;
    });
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
{:else if items.length === 0}
  <p class="muted">カリキュラムの科目はありません。</p>
{:else}
  <div class="filters">
    <label>
      <span>キーワード（科目名・コード）</span>
      <input type="search" placeholder="例: 線形" bind:value={keyword} />
    </label>
    <label>
      <span>科目区分</span>
      <select bind:value={category}>
        <option value="">すべて</option>
        {#each categories as c (c)}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </label>
  </div>
  <label class="toggle">
    <input type="checkbox" bind:checked={ungradedOnly} />
    <span>未評価のみ</span>
  </label>

  <p class="count">{filtered.length} 件（全 {items.length} 件）</p>

  {#if filtered.length === 0}
    <p class="muted">条件に合う科目はありません。</p>
  {:else}
    <ul class="list">
      {#each filtered as i}
        <li class="item">
          <div class="title-row">
            {#if graded(i)}
              <span class="badge graded">{i.grade}</span>
            {:else}
              <span class="badge ungraded">未評価</span>
            {/if}
            <span class="title">{i.name}</span>
          </div>
          <div class="meta">
            {i.code}{#if i.category} · {i.category}{/if}{#if i.creditType} · {i.creditType}{/if} · {i.credits} 単位
          </div>
        </li>
      {/each}
    </ul>
  {/if}
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
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  select,
  input[type='search'] {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
    min-width: 0;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    margin-bottom: 10px;
  }
  .count {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 8px;
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
  .badge.graded {
    background: var(--primary);
    color: #fff;
  }
  .badge.ungraded {
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
