<script lang="ts">
  import {
    api,
    ApiError,
    type SyllabusFilters,
    type SyllabusListItem,
    type SyllabusDetail,
  } from '$lib/api';

  let filters = $state<SyllabusFilters | null>(null);
  let loadingFilters = $state(false);
  let error = $state('');

  let year = $state('');
  let folder = $state('');
  let campus = $state('');
  let semester = $state('');
  let week = $state('');
  let hour = $state('');
  let word = $state('');

  let results = $state<SyllabusListItem[]>([]);
  let searching = $state(false);
  let detail = $state<SyllabusDetail | null>(null);
  let detailLoading = $state(false);

  function entries(map: Record<string, string> | undefined): [string, string][] {
    return map ? Object.entries(map) : [];
  }
  function num(v: string): number | undefined {
    if (v === '') return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  async function loadFilters() {
    loadingFilters = true;
    error = '';
    try {
      const res = await api.syllabusFilters();
      filters = res.filters;
      const years = Object.values(res.filters.year);
      if (years.length > 0 && year === '') year = years[0];
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'フィルタの取得に失敗しました';
    } finally {
      loadingFilters = false;
    }
  }

  async function search() {
    if (!year) {
      error = '年度を選択してください';
      return;
    }
    searching = true;
    error = '';
    detail = null;
    try {
      const res = await api.syllabusSearch({
        year,
        word: word.trim() || undefined,
        campus: num(campus),
        semester: num(semester),
        week: num(week),
        hour: num(hour),
        folder: folder || undefined,
      });
      results = res.results;
    } catch (err) {
      results = [];
      error = err instanceof ApiError ? err.message : '検索に失敗しました';
    } finally {
      searching = false;
    }
  }

  async function openDetail(url: string) {
    detailLoading = true;
    try {
      // 詳細はサーバー状態（同一セッションでの検索）を要するため、検索条件も渡す。
      const res = await api.syllabusDetail(url, {
        year,
        word: word.trim() || undefined,
        campus: num(campus),
        semester: num(semester),
        week: num(week),
        hour: num(hour),
        folder: folder || undefined,
      });
      detail = res.detail;
    } catch (err) {
      error = err instanceof ApiError ? err.message : '詳細の取得に失敗しました';
    } finally {
      detailLoading = false;
    }
  }

  $effect(() => {
    loadFilters();
  });
</script>

{#if loadingFilters}
  <p class="muted">フィルタを読み込み中…</p>
{:else if filters}
  <div class="filters">
    <label>
      <span>年度</span>
      <select bind:value={year}>
        {#each entries(filters.year) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>フォルダ</span>
      <select bind:value={folder}>
        <option value="">指定なし</option>
        {#each entries(filters.folder) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>校舎</span>
      <select bind:value={campus}>
        <option value="">指定なし</option>
        {#each entries(filters.campus) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>学期</span>
      <select bind:value={semester}>
        <option value="">指定なし</option>
        {#each entries(filters.semester) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>曜日</span>
      <select bind:value={week}>
        <option value="">指定なし</option>
        {#each entries(filters.week) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>時限</span>
      <select bind:value={hour}>
        <option value="">指定なし</option>
        {#each entries(filters.hour) as [label, value]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>
    <label class="word">
      <span>キーワード</span>
      <input type="text" bind:value={word} placeholder="科目名など" />
    </label>
  </div>
  <button class="search" onclick={search} disabled={searching}>
    {searching ? '検索中…' : '検索'}
  </button>
{/if}

{#if error}
  <p class="error">{error}</p>
{/if}

{#if results.length > 0}
  <ul class="list">
    {#each results as r (r.url + r.subject)}
      <li>
        <button class="item" onclick={() => openDetail(r.url)}>
          <div class="title">{r.subject}</div>
          <div class="meta">
            {r.teacher} · {r.classification} · {r.unitsNumber}単位
          </div>
        </button>
      </li>
    {/each}
  </ul>
{/if}

{#if detailLoading}
  <p class="muted">詳細を取得中…</p>
{/if}

{#if detail}
  <div class="detail">
    <button class="close" onclick={() => (detail = null)}>× 閉じる</button>
    <h3>{detail.subject}</h3>
    <div class="meta">
      {detail.teachers.map((t) => t.name).join(', ')} · {detail.semester} ·
      {detail.classPeriod} · {detail.classRoom}
    </div>
    {@render Section('概要', detail.content)}
    {@render Section('学習到達目標', [detail.learningGoal])}
    {@render Section('方法と特徴', [detail.features])}
    {@render Section('成績評価の方法', [detail.records])}
    {@render Section('計画', detail.plan)}
    {@render Section('教科書', [detail.textBook])}
    {@render Section('参考書', [detail.referenceBook])}
    {@render Section('教員からのメッセージ', [detail.teachersMessage])}
  </div>
{/if}

{#snippet Section(title: string, lines: string[])}
  {#if lines.some((l) => l && l !== '不明')}
    <h4>{title}</h4>
    {#each lines as l}
      {#if l && l !== '不明'}<p>{l}</p>{/if}
    {/each}
  {/if}
{/snippet}

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
  .detail {
    margin-top: 16px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .detail h3 {
    margin: 8px 0 4px;
  }
  .detail h4 {
    margin: 14px 0 4px;
  }
  .detail p {
    margin: 0 0 6px;
    white-space: pre-wrap;
  }
  .close {
    float: right;
    border: none;
    background: none;
    color: var(--muted);
  }
</style>
