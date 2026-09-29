<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, ApiError, type SyllabusListItem } from '$lib/api';
  import { syllabusSearch as st } from '$lib/stores/syllabus.svelte';

  let loadingFilters = $state(false);
  let searching = $state(false);
  let error = $state('');

  const filters = $derived(st.filters);

  function entries(map: Record<string, string> | undefined): [string, string][] {
    return map ? Object.entries(map) : [];
  }
  function num(v: string): number | undefined {
    if (v === '') return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  async function loadFilters() {
    if (st.filters) return;
    loadingFilters = true;
    error = '';
    try {
      const res = await api.syllabusFilters();
      st.filters = res.filters;
      const years = Object.values(res.filters.year);
      if (years.length > 0 && st.year === '') st.year = years[0];
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'フィルタの取得に失敗しました';
    } finally {
      loadingFilters = false;
    }
  }

  async function search() {
    if (!st.year) {
      error = '年度を選択してください';
      return;
    }
    searching = true;
    error = '';
    try {
      const res = await api.syllabusSearch({
        year: st.year,
        word: st.word.trim() || undefined,
        campus: num(st.campus),
        semester: num(st.semester),
        week: num(st.week),
        hour: num(st.hour),
        folder: st.folder || undefined,
      });
      st.results = res.results;
    } catch (err) {
      st.results = [];
      error = err instanceof ApiError ? err.message : '検索に失敗しました';
    } finally {
      st.searched = true;
      searching = false;
    }
  }

  // 詳細は別ページ。サーバー状態（同一セッションでの検索）を要するため、検索条件も URL で渡す。
  function openDetail(r: SyllabusListItem) {
    const q = new URLSearchParams({ url: r.url, year: st.year, from: 'search' });
    if (st.word.trim()) q.set('word', st.word.trim());
    for (const k of ['campus', 'semester', 'week', 'hour', 'folder'] as const) {
      if (st[k]) q.set(k, st[k]);
    }
    void goto(`/syllabus/detail?${q}`);
  }

  $effect(() => {
    loadFilters();
  });
</script>

{#if loadingFilters && !filters}
  <p class="muted">フィルタを読み込み中…</p>
{:else if filters}
  <div class="filters">
    <label>
      <span>年度</span>
      <select bind:value={st.year}>
        {#each entries(filters.year) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>フォルダ</span>
      <select bind:value={st.folder}>
        <option value="">指定なし</option>
        {#each entries(filters.folder) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>校舎</span>
      <select bind:value={st.campus}>
        <option value="">指定なし</option>
        {#each entries(filters.campus) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>学期</span>
      <select bind:value={st.semester}>
        <option value="">指定なし</option>
        {#each entries(filters.semester) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>曜日</span>
      <select bind:value={st.week}>
        <option value="">指定なし</option>
        {#each entries(filters.week) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>時限</span>
      <select bind:value={st.hour}>
        <option value="">指定なし</option>
        {#each entries(filters.hour) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label class="word">
      <span>キーワード</span>
      <input type="text" bind:value={st.word} placeholder="科目名など" />
    </label>
  </div>
  <button class="search" onclick={search} disabled={searching}>
    {searching ? '検索中…' : '検索'}
  </button>
{/if}

{#if error}
  <p class="error">{error}</p>
{/if}

{#if st.results.length > 0}
  <ul class="list">
    {#each st.results as r (r.url + r.subject)}
      <li>
        <button class="item" onclick={() => openDetail(r)}>
          <div class="title">{r.subject}</div>
          <div class="meta">
            {r.teacher} · {r.classification} · {r.unitsNumber}単位
          </div>
        </button>
      </li>
    {/each}
  </ul>
{/if}

{#if st.searched && !searching && st.results.length === 0 && !error}
  <p class="muted">該当するシラバスはありません。</p>
{/if}

<style>
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  select,
  input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
  }
  .word {
    grid-column: 1 / -1;
  }
  .search {
    padding: 10px 20px;
    border: none;
    border-radius: 10px;
    background: var(--primary);
    color: #fff;
    margin-bottom: 16px;
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
    width: 100%;
    text-align: left;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
  }
  .title {
    font-weight: 600;
  }
  .meta {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
