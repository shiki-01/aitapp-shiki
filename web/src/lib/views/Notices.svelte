<script lang="ts">
  import { api, ApiError, type Notice, type NoticeDetail } from '$lib/api';
  import { toEnqueteView, isPending, type EnqueteView } from '$lib/enquete';
  import { isTauri } from '$lib/platform';
  import Sheet from '$lib/components/Sheet.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    FULL_NOTICE_INDEX,
    fullUnivNotice,
    fullClassNotice,
    fullNoticeDetail,
  } from '$lib/dummy';

  // レイアウト確認用: 一覧先頭に全項目入りの通知を強制挿入する。確認が済んだら false にする。
  const DEBUG_FORCE_FULL_NOTICE = false;

  // desktop版はブラウザの<a target=_blank>が使えない(Workerと別サイト扱いの
  // ためcookieが送れない)ので、一時ファイルへ保存しOS既定アプリで開く。
  function openAttachment(e: MouseEvent, path: string) {
    if (!isTauri) return;
    e.preventDefault();
    void api.openFile(path);
  }

  const STEP = 10;

  // アンケートは別 API のため、連絡系の API に渡す種別は common / class のどちらかに絞る。
  const noticeType = (): 'common' | 'class' => (type === 'class' ? 'class' : 'common');

  let type = $state<'common' | 'class' | 'enquete'>('common');
  let loaded = $state<Notice[]>([]);
  // 累積表示件数（上流 listPageNo）。上流は先頭から count 件を返すため、
  // append ではなく毎回全件を取り直して置き換える。
  let count = $state(STEP);
  let query = $state('');
  let loading = $state(false);
  let loadingMore = $state(false);
  let noMore = $state(false);
  let error = $state('');

  let detail = $state<NoticeDetail | null>(null);
  let detailOpen = $state(false);
  let detailLoading = $state(false);

  // 授業アンケート（LCAM の一覧は先頭のまとまりだけで、件数は少ない。ページングなし）。
  let enquetes = $state<EnqueteView[]>([]);
  let enqueteLoaded = $state(false);
  let enqueteOpen = $state(false);
  let enqueteSel = $state<EnqueteView | null>(null);
  const pendingCount = $derived(enquetes.filter(isPending).length);
  const shownEnquetes = $derived(
    enquetes.filter((e) => {
      const q = query.trim().toLowerCase();
      return !q || [e.title, e.subject].join(' ').toLowerCase().includes(q);
    }),
  );

  async function loadEnquetes() {
    loading = true;
    error = '';
    try {
      const res = await api.enquetes();
      enquetes = res.items.map(toEnqueteView);
      enqueteLoaded = true;
    } catch (err) {
      enquetes = [];
      error = err instanceof ApiError ? err.message : 'アンケートの取得に失敗しました';
    } finally {
      loading = false;
    }
  }

  function openEnquete(e: EnqueteView) {
    enqueteSel = e;
    enqueteOpen = true;
  }

  function matchQuery(n: Notice): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [n.title, n.sender, n.type === 'class' ? n.subject : ''].join(' ').toLowerCase();
    return hay.includes(q);
  }

  const withForced = $derived<Notice[]>(
    DEBUG_FORCE_FULL_NOTICE
      ? [type === 'common' ? fullUnivNotice : fullClassNotice, ...loaded]
      : loaded,
  );
  const shown = $derived(withForced.filter(matchQuery));

  async function load() {
    if (type === 'enquete') return loadEnquetes();
    loading = true;
    error = '';
    count = STEP;
    noMore = false;
    try {
      const res = await api.notices(noticeType(), count);
      loaded = res.notices;
      // 要求件数に満たなければ末尾に到達している。
      noMore = res.notices.length < count;
    } catch (err) {
      loaded = [];
      error = err instanceof ApiError ? err.message : '取得に失敗しました';
    } finally {
      loading = false;
    }
  }

  async function more() {
    // 累積件数を増やして全件を取り直す。件数が伸びなければ末尾。
    if (loadingMore || noMore) return;
    loadingMore = true;
    const next = count + STEP;
    try {
      const res = await api.notices(noticeType(), next);
      if (res.notices.length <= loaded.length || res.notices.length < next) {
        noMore = true;
      }
      loaded = res.notices;
      count = next;
    } catch {
      noMore = true;
    } finally {
      loadingMore = false;
    }
  }

  function switchType(t: 'common' | 'class' | 'enquete') {
    if (type === t) return;
    type = t;
    load();
  }

  async function openDetail(index: number) {
    detailOpen = true;
    detail = null;
    detailLoading = true;
    if (DEBUG_FORCE_FULL_NOTICE && index === FULL_NOTICE_INDEX) {
      detail =
        type === 'class'
          ? { ...fullNoticeDetail, sender: fullClassNotice.sender, title: fullClassNotice.title }
          : { ...fullNoticeDetail, subject: undefined };
      detailLoading = false;
      return;
    }
    try {
      const res = await api.noticeDetail(noticeType(), index);
      detail = res.detail;
    } catch (err) {
      error = err instanceof ApiError ? err.message : '詳細の取得に失敗しました';
      detailOpen = false;
    } finally {
      detailLoading = false;
    }
  }

  $effect(() => {
    load();
    // アンケートの未回答数をタブのバッジに出すため、最初に一度だけ取っておく。
    if (type !== 'enquete' && !enqueteLoaded) {
      api
        .enquetes()
        .then((res) => {
          enquetes = res.items.map(toEnqueteView);
          enqueteLoaded = true;
        })
        .catch(() => {});
    }
  });
</script>

<header class="head">
  <h1>お知らせ</h1>
</header>

<div class="tabs">
  <button class:active={type === 'common'} onclick={() => switchType('common')}>学内連絡</button>
  <button class:active={type === 'class'} onclick={() => switchType('class')}>授業連絡</button>
  <button class:active={type === 'enquete'} onclick={() => switchType('enquete')}>
    アンケート{#if pendingCount > 0}<span class="tab-badge">{pendingCount}</span>{/if}
  </button>
</div>

<div class="search">
  <Icon name="search" size={18} color="var(--muted)" />
  <input type="search" placeholder="タイトル・送信者で絞り込み" bind:value={query} />
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <p class="error">{error}</p>
{:else if type === 'enquete'}
  {#if shownEnquetes.length === 0}
    <p class="muted">{query ? '一致するアンケートはありません。' : '授業アンケートはありません。'}</p>
  {:else}
    <ul class="list">
      {#each shownEnquetes as e (e.index)}
        <li>
          <button class="item" onclick={() => openEnquete(e)}>
            <div class="title-row">
              {#if isPending(e)}
                <span class="badge">未回答</span>
              {:else if e.done}
                <span class="badge done">回答済み</span>
              {:else if e.closed}
                <span class="badge muted-badge">受付終了</span>
              {/if}
              <span class="title">{e.title}</span>
            </div>
            <div class="meta">
              {e.subject}{#if e.period} · 提出期間 {e.period}{/if}
            </div>
          </button>
        </li>
      {/each}
    </ul>
    <p class="end">回答は L-Cam（授業アンケート）から行えます。</p>
  {/if}
{:else if shown.length === 0}
  <p class="muted">{query ? '一致するお知らせはありません。' : 'お知らせはありません。'}</p>
{:else}
  <ul class="list">
    {#each shown as n (n.type + n.index)}
      <li>
        <button class="item" onclick={() => openDetail(n.index)}>
          <div class="title-row">
            {#if n.isImportant}<span class="badge">重要</span>{/if}
            <span class="title">{n.title}</span>
          </div>
          <div class="meta">
            {#if n.type === 'class'}{n.subject} · {/if}{n.sender}{#if n.type === 'common'} · {n.sendAt}{/if}{#if n.type === 'class' && n.makeupClassAt} · 補講 {n.makeupClassAt}{/if}
          </div>
        </button>
      </li>
    {/each}
  </ul>

  {#if !noMore}
    <button class="more" onclick={more} disabled={loadingMore}>
      {loadingMore ? '読み込み中…' : 'もっと見る'}
    </button>
  {:else if !query}
    <p class="end">これ以上はありません</p>
  {/if}
{/if}

<Sheet bind:open={enqueteOpen} title="授業アンケート">
  {#if enqueteSel}
    <h3 class="d-title">{enqueteSel.title}</h3>
    <dl class="fields">
      {#if enqueteSel.subject}<dt>授業科目</dt><dd>{enqueteSel.subject}</dd>{/if}
      {#if enqueteSel.status}<dt>状態</dt><dd>{enqueteSel.status}</dd>{/if}
      {#if enqueteSel.period}<dt>提出期間</dt><dd>{enqueteSel.period}</dd>{/if}
      {#if enqueteSel.submission}<dt>提出状況</dt><dd>{enqueteSel.submission}</dd>{/if}
      {#each enqueteSel.extra as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}
    </dl>
  {/if}
</Sheet>

<Sheet bind:open={detailOpen} title="お知らせ" tall>
  {#if detailLoading}
    <p class="muted">詳細を取得中…</p>
  {:else if detail}
    <h3 class="d-title">{detail.title}</h3>
    <div class="meta">{detail.sender} · {detail.sendAt}</div>
    {#if detail.subject}<div class="meta">科目: {detail.subject}</div>{/if}
    <!-- 本文 HTML は上流由来。Worker 側で allowlist サニタイズ済み(script/iframe/
         on*/javascript: 等を除去)。CSP(_headers)を多層防御の backstop とする。 -->
    <div class="content">{@html detail.content}</div>
    {#if detail.url.length > 0}
      <hr>
      <h4>参考URL</h4>
      <ul class="links">
        {#each detail.url as u}
          <li><a href={u} target="_blank" rel="noreferrer noopener">{u}</a></li>
        {/each}
      </ul>
    {/if}
    {#if Object.keys(detail.files).length > 0}
      <hr>
      <h4>添付ファイル</h4>
      <ul class="links">
        {#each Object.entries(detail.files) as [name, path]}
          <li>
            <a
              href={isTauri ? '#' : api.fileUrl(path)}
              target="_blank"
              rel="noreferrer"
              onclick={(e) => openAttachment(e, path)}
            >
              {name}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</Sheet>

<style>
  .head h1 {
    margin: 0 0 12px;
    font-size: 1.4rem;
    color: var(--navy);
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .tabs button {
    padding: 7px 16px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 20px;
    font-size: 0.86rem;
  }
  .tabs button.active {
    background: var(--primary);
    border-color: var(--primary);
    color: #fff;
  }
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
  }
  .tab-badge {
    margin-left: 6px;
    background: var(--important);
    color: #fff;
    border-radius: 10px;
    padding: 0 6px;
    font-size: 0.72rem;
  }
  .tabs button.active .tab-badge {
    background: #fff;
    color: var(--important);
  }
  .badge.done {
    background: var(--primary-light);
  }
  .badge.muted-badge {
    background: var(--muted);
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
  .badge {
    flex: 0 0 auto;
    background: var(--important);
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
  .more {
    display: block;
    width: 100%;
    margin: 14px 0 4px;
    padding: 11px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-weight: 500;
  }
  .more:disabled {
    opacity: 0.6;
  }
  .end,
  .muted {
    color: var(--muted);
    text-align: center;
    margin: 14px 0;
    font-size: 0.85rem;
  }
  .error {
    color: var(--danger);
  }
  .d-title {
    margin: 0 0 4px;
  }
  .content {
    margin-top: 12px;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  /* 本文は上流由来の {@html} なのでスコープ外から当てる。最低限の体裁のみ。 */
  .content :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 0.86rem;
  }
  .content :global(caption) {
    caption-side: top;
    text-align: left;
    font-weight: 600;
    padding-bottom: 4px;
  }
  .content :global(th),
  .content :global(td) {
    border: 1px solid var(--border);
    padding: 6px 10px;
    vertical-align: top;
    text-align: left;
  }
  .content :global(th) {
    background: var(--primary-bg);
    white-space: nowrap;
  }
  .content :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 14px 0;
  }
  .content :global(blockquote) {
    margin: 10px 0;
    padding: 4px 12px;
    border-left: 3px solid var(--primary-light);
    color: var(--muted);
  }
  .content :global(pre) {
    white-space: pre-wrap;
    background: var(--primary-bg);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.84rem;
  }
  .content :global(ul),
  .content :global(ol) {
    padding-left: 20px;
  }
  .content :global(dt) {
    font-weight: 600;
    margin-top: 6px;
  }
  .content :global(dd) {
    margin-left: 12px;
  }
  .content :global(h1),
  .content :global(h2),
  .content :global(h3),
  .content :global(h4) {
    font-size: 1rem;
    margin: 14px 0 6px;
  }
  .content :global(a) {
    color: var(--primary);
    text-decoration: underline;
  }
  hr {
    width: 100%;
    height: 1px;
    background-color: var(--border);
    margin: 18px 0;
  }
  .links {
    padding-left: 18px;
  }
  /* 長い URL・ファイル名は単語区切りが無いので、どこでも折り返す。 */
  .links li {
    overflow-wrap: anywhere;
    word-break: break-all;
  }
</style>
