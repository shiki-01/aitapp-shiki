<script lang="ts">
  import { api, ApiError, type CommonFileItem, type CommonFileDetail, type PcFileLink } from '$lib/api';
  import { isTauri } from '$lib/platform';
  import Sheet from '$lib/components/Sheet.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let files = $state<CommonFileItem[]>([]);
  let query = $state('');
  let loading = $state(true);
  let error = $state('');

  let detail = $state<CommonFileDetail | null>(null);
  let detailOpen = $state(false);
  let detailLoading = $state(false);
  let detailError = $state('');
  // 古い詳細リクエストの結果が新しい選択を上書きしないよう、最新の要求だけ採用する。
  let detailSeq = 0;
  let openError = $state('');

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => `${f.title} ${f.category}`.toLowerCase().includes(q));
  });

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      files = (await api.commonFiles()).files;
    } catch (err) {
      files = [];
      error = errorText(err, '学内共有ファイルの取得に失敗しました');
    } finally {
      loading = false;
    }
  }

  async function openDetail(id: string) {
    const seq = ++detailSeq;
    detail = null;
    detailError = '';
    openError = '';
    detailLoading = true;
    detailOpen = true;
    try {
      const res = await api.commonFileDetail(id);
      if (seq === detailSeq) detail = res.detail;
    } catch (err) {
      if (seq === detailSeq) detailError = errorText(err, '詳細の取得に失敗しました');
    } finally {
      if (seq === detailSeq) detailLoading = false;
    }
  }

  // desktop版はブラウザの<a target=_blank>が使えない(Workerと別サイト扱いのためcookieが
  // 送れない)ので、一時ファイルへ保存しOS既定アプリで開く(Notices.svelte の添付と同じ体験)。
  async function openFile(e: MouseEvent, id: string, f: PcFileLink) {
    if (!isTauri) return;
    e.preventDefault();
    openError = '';
    try {
      await api.openCommonFile(id, f.no, f.name);
    } catch (err) {
      openError = errorText(err, 'ファイルを開けませんでした');
    }
  }

  $effect(() => {
    void load();
  });
</script>

<div class="search">
  <Icon name="search" size={18} color="var(--muted)" />
  <input type="search" placeholder="タイトル・カテゴリで絞り込み" bind:value={query} />
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={load}>再試行</button>
  </div>
{:else if shown.length === 0}
  <p class="muted">{query ? '一致するファイルはありません。' : '共有ファイルはありません。'}</p>
{:else}
  <ul class="list">
    {#each shown as f (f.id)}
      <li>
        <button class="item" onclick={() => openDetail(f.id)}>
          <div class="title-row">
            {#if f.category}<span class="badge">{f.category}</span>{/if}
            <span class="title">{f.title}</span>
          </div>
          <div class="meta">
            更新 {f.updatedAt}{#if f.size} · {f.size}{/if} · DL {f.downloadCount.toLocaleString('ja-JP')}
          </div>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<Sheet bind:open={detailOpen} title="学内共有ファイル" tall>
  {#if detailLoading}
    <p class="muted">詳細を取得中…</p>
  {:else if detailError}
    <p class="error">{detailError}</p>
  {:else if detail}
    {@const id = detail.id}
    <h3 class="d-title">{detail.title}</h3>
    <dl class="fields">
      {#if detail.category}<dt>カテゴリ</dt><dd>{detail.category}</dd>{/if}
      {#if detail.publicPeriod}<dt>公開期間</dt><dd>{detail.publicPeriod}</dd>{/if}
    </dl>
    {#if detail.description}
      <h4>説明</h4>
      <p class="desc">{detail.description}</p>
    {/if}
    <hr />
    <h4>ファイル</h4>
    {#if detail.files.length === 0}
      <p class="muted">ファイルはありません。</p>
    {:else}
      <ul class="links">
        {#each detail.files as f (f.no)}
          <li>
            <a
              href={isTauri ? '#' : api.commonFileDownloadUrl(id, f.no)}
              target="_blank"
              rel="noreferrer"
              onclick={(e) => openFile(e, id, f)}
            >
              {f.name}
            </a>
            {#if f.size}<span class="meta"> ({f.size})</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if openError}<p class="error">{openError}</p>{/if}
  {/if}
</Sheet>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--primary-bg);
    border-radius: 12px;
    padding: 8px 12px;
    margin-bottom: 14px;
  }
  .search input {
    border: none;
    background: none;
    outline: none;
    flex: 1;
    font-size: 0.92rem;
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
    background: var(--primary-light);
    color: #fff;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.72rem;
  }
  .meta {
    color: var(--muted);
    font-size: 0.8rem;
    margin-top: 2px;
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
  .d-title {
    margin: 0 0 4px;
    overflow-wrap: anywhere;
  }
  .fields {
    margin: 12px 0 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
  }
  .fields dt {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .fields dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .desc {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  hr {
    width: 100%;
    height: 1px;
    border: none;
    background-color: var(--border);
    margin: 18px 0;
  }
  .links {
    padding-left: 18px;
  }
  /* 長いファイル名は単語区切りが無いので、どこでも折り返す。 */
  .links li {
    overflow-wrap: anywhere;
    word-break: break-all;
  }
</style>
