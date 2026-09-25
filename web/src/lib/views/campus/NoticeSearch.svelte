<script lang="ts">
  import { onMount } from 'svelte';
  import {
    api,
    ApiError,
    type PcNoticeItem,
    type PcNoticeDetail,
    type PcNoticeKind,
    type PcNoticeQuery,
    type PcFileLink,
  } from '$lib/api';
  import { isTauri } from '$lib/platform';
  import Sheet from '$lib/components/Sheet.svelte';

  // 年度は今年から過去 3 年。'' は「今の年度」（year を送らず、上流の初期表示に任せる）。
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, i) => thisYear - i);

  let kind = $state<PcNoticeKind>('campus');
  let keyword = $state('');
  let category = $state('');
  let subject = $state('');
  let year = $state('');
  let semester = $state('');
  let from = $state('');
  let to = $state('');
  let unreadOnly = $state(false);
  let todoOnly = $state(false);
  let attachmentOnly = $state(false);
  let filtersOpen = $state(false);

  // 絞り込みの候補（表示名）。kind ごとに、最初に取得できたときの categories / subjects を持つ。
  let candidates = $state<
    Record<PcNoticeKind, { categories: string[]; subjects: string[] } | null>
  >({ campus: null, class: null });

  let items = $state<PcNoticeItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  // 一覧を取得したときの kind と条件。詳細・添付の取得にも同じものを付ける
  // （上流の一覧の行番号を使うため。検索後に条件欄を触っても、開いた一覧の条件で呼ぶ）。
  let listKind = $state<PcNoticeKind>('campus');
  let listQuery = $state<PcNoticeQuery>({});
  // 古い応答が新しい結果を上書きしないよう、最新の要求だけ採用する。
  let listSeq = 0;

  let detail = $state<PcNoticeDetail | null>(null);
  // 開いた詳細を取得したときの kind と条件（添付リンクに使う）。
  let detailKind = $state<PcNoticeKind>('campus');
  let detailQuery = $state<PcNoticeQuery>({});
  let detailOpen = $state(false);
  let detailLoading = $state(false);
  let detailError = $state('');
  let detailSeq = 0;
  let openError = $state('');

  function currentQuery(): PcNoticeQuery {
    const q: PcNoticeQuery = {};
    const kw = keyword.trim();
    if (kw) q.keyword = kw;
    if (category) q.category = category;
    if (from) q.from = from;
    if (to) q.to = to;
    if (unreadOnly) q.unreadOnly = true;
    if (todoOnly) q.todoOnly = true;
    if (attachmentOnly) q.attachmentOnly = true;
    if (kind === 'class') {
      if (subject) q.subject = subject;
      if (year) q.year = Number(year);
      if (semester === '1' || semester === '2') q.semester = Number(semester) as 1 | 2;
    }
    return q;
  }

  // 入力欄のうち、いま値が入っている絞り込み（キーワード以外）の数。折りたたみの見出しに出す。
  const activeFilters = $derived(
    [
      category,
      kind === 'class' ? subject : '',
      kind === 'class' ? year : '',
      kind === 'class' ? semester : '',
      from,
      to,
      unreadOnly,
      todoOnly,
      attachmentOnly,
    ].filter(Boolean).length,
  );

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  async function load(k: PcNoticeKind, query: PcNoticeQuery) {
    const seq = ++listSeq;
    loading = true;
    error = '';
    try {
      const res = await api.pcNotices(k, query);
      if (seq !== listSeq) return;
      listKind = k;
      listQuery = query;
      items = res.list.items;
      if (!candidates[k]) {
        candidates[k] = { categories: res.list.categories, subjects: res.list.subjects };
      }
    } catch (err) {
      if (seq !== listSeq) return;
      items = [];
      error = errorText(err, '連絡の取得に失敗しました');
    } finally {
      if (seq === listSeq) loading = false;
    }
  }

  function search(e?: Event) {
    e?.preventDefault();
    void load(kind, currentQuery());
  }

  // 学内連絡/授業連絡の切り替え。条件欄は種別ごとに意味が違うのですべて空に戻し、条件なしで取得し直す。
  function switchKind(k: PcNoticeKind) {
    if (kind === k) return;
    kind = k;
    keyword = '';
    category = '';
    subject = '';
    year = '';
    semester = '';
    from = '';
    to = '';
    unreadOnly = false;
    todoOnly = false;
    attachmentOnly = false;
    void load(k, {});
  }

  // 画面を開いたら条件なしで 1 回取得して、絞り込みの候補を得る。
  onMount(() => {
    void load('campus', {});
  });

  async function openDetail(id: string) {
    const seq = ++detailSeq;
    const k = listKind;
    const q = listQuery;
    detail = null;
    detailError = '';
    openError = '';
    detailLoading = true;
    detailOpen = true;
    try {
      const res = await api.pcNoticeDetail(k, id, q);
      if (seq === detailSeq) {
        detailKind = k;
        detailQuery = q;
        detail = res.detail;
      }
    } catch (err) {
      if (seq === detailSeq) detailError = errorText(err, '詳細の取得に失敗しました');
    } finally {
      if (seq === detailSeq) detailLoading = false;
    }
  }

  // desktop版はブラウザの<a target=_blank>が使えない(Workerと別サイト扱いのためcookieが
  // 送れない)ので、一時ファイルへ保存しOS既定アプリで開く(Reports.svelte と同じ体験)。
  async function openFile(e: MouseEvent, id: string, f: PcFileLink) {
    if (!isTauri) return;
    e.preventDefault();
    openError = '';
    try {
      await api.openPcNoticeFile(detailKind, id, f.no, f.name, detailQuery);
    } catch (err) {
      openError = errorText(err, 'ファイルを開けませんでした');
    }
  }

  // 本文中の URL をリンク化する。HTML には変換せず、テキストと URL の並びに分けて描く
  // （上流由来の文字列を {@html} に渡さない）。全角文字・空白で URL を切り、末尾の句読点は含めない。
  type Piece = { text: string; url?: string };
  function linkify(body: string): Piece[] {
    const pieces: Piece[] = [];
    const re = /https?:\/\/[\x21-\x7e]+/g;
    let last = 0;
    for (const m of body.matchAll(re)) {
      const start = m.index ?? 0;
      const url = m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
      if (start > last) pieces.push({ text: body.slice(last, start) });
      pieces.push({ text: url, url });
      last = start + url.length;
    }
    if (last < body.length) pieces.push({ text: body.slice(last) });
    return pieces;
  }
</script>

<div class="tabs">
  <button class:active={kind === 'campus'} aria-pressed={kind === 'campus'} onclick={() => switchKind('campus')}>
    学内連絡
  </button>
  <button class:active={kind === 'class'} aria-pressed={kind === 'class'} onclick={() => switchKind('class')}>
    授業連絡
  </button>
</div>

<form class="search" onsubmit={search}>
  <input
    type="search"
    placeholder={kind === 'class' ? 'タイトル・本文・教員名・科目名' : 'タイトル・本文'}
    aria-label="キーワード"
    bind:value={keyword}
  />
  <button type="submit" class="go" disabled={loading}>検索</button>
</form>

<button
  class="fold"
  type="button"
  aria-expanded={filtersOpen}
  onclick={() => (filtersOpen = !filtersOpen)}
>
  絞り込み{#if activeFilters > 0}（{activeFilters}）{/if}
  <span class="caret" class:open={filtersOpen}>▾</span>
</button>

{#if filtersOpen}
  <div class="panel">
    <div class="filters">
      <label>
        <span>{kind === 'class' ? '連絡種別' : 'カテゴリ'}</span>
        <select bind:value={category}>
          <option value="">すべて</option>
          {#each candidates[kind]?.categories ?? [] as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>
      {#if kind === 'class'}
        <label>
          <span>科目</span>
          <select bind:value={subject}>
            <option value="">すべて</option>
            {#each candidates.class?.subjects ?? [] as s (s)}
              <option value={s}>{s}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>年度</span>
          <select bind:value={year}>
            <option value="">今の年度</option>
            {#each years as y (y)}
              <option value={String(y)}>{y}年度</option>
            {/each}
          </select>
        </label>
        <label>
          <span>学期</span>
          <select bind:value={semester}>
            <option value="">今の学期</option>
            <option value="1">前期</option>
            <option value="2">後期</option>
          </select>
        </label>
      {/if}
      <label>
        <span>連絡日（開始）</span>
        <input type="date" bind:value={from} />
      </label>
      <label>
        <span>連絡日（終了）</span>
        <input type="date" bind:value={to} />
      </label>
    </div>
    <div class="toggles">
      <label class="toggle"><input type="checkbox" bind:checked={unreadOnly} /><span>未読のみ</span></label>
      <label class="toggle"><input type="checkbox" bind:checked={todoOnly} /><span>ToDo のみ</span></label>
      <label class="toggle">
        <input type="checkbox" bind:checked={attachmentOnly} /><span>添付のみ</span>
      </label>
    </div>
    <p class="note">条件を変えたら「検索」を押してください。</p>
  </div>
{/if}

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={() => search()}>再試行</button>
  </div>
{:else if items.length === 0}
  <p class="muted">
    {Object.keys(listQuery).length > 0 ? '条件に合う連絡はありません。' : '連絡はありません。'}
  </p>
{:else}
  <p class="count">{items.length} 件</p>
  <ul class="list">
    {#each items as n (n.id)}
      <li>
        <button class="item" onclick={() => openDetail(n.id)}>
          <div class="title-row">
            {#if n.important}<span class="badge important">重要</span>{/if}
            <span class="title">{n.title}</span>
          </div>
          <div class="meta">
            {#if n.category}<span class="badge cat">{n.category}</span>{/if}
            {n.kind === 'class' && n.subject ? `${n.subject}${n.term ? ` · ${n.term}` : ''} · ` : ''}{n.sender}
          </div>
          <div class="meta">{n.startAt} ～ {n.endAt}</div>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<Sheet bind:open={detailOpen} title="連絡" tall>
  {#if detailLoading}
    <p class="muted">詳細を取得中…</p>
  {:else if detailError}
    <p class="error">{detailError}</p>
  {:else if detail}
    {@const id = detail.id}
    <div class="title-row">
      {#if detail.important}<span class="badge important">重要</span>{/if}
      <h3 class="d-title">{detail.title}</h3>
    </div>
    <dl class="fields">
      {#if detail.category}
        <dt>{detailKind === 'class' ? '連絡種別' : 'カテゴリ'}</dt>
        <dd>{detail.category}</dd>
      {/if}
      {#if detail.sender}
        <dt>{detailKind === 'class' ? '担当教員' : '連絡元'}</dt>
        <dd>{detail.sender}</dd>
      {/if}
      {#if detail.period}<dt>連絡日時</dt><dd>{detail.period}</dd>{/if}
      {#if detail.reply}<dt>返信</dt><dd>{detail.reply}</dd>{/if}
    </dl>
    <hr />
    <!-- 本文はテキスト。改行を保ち、URL だけ <a> にする。 -->
    <p class="text">{#each linkify(detail.body) as p}{#if p.url}<a href={p.url} target="_blank" rel="noreferrer noopener">{p.text}</a>{:else}{p.text}{/if}{/each}</p>
    {#if detail.referenceUrls.length > 0}
      <h4>参考 URL</h4>
      <ul class="links">
        {#each detail.referenceUrls as u}
          <li><a href={u} target="_blank" rel="noreferrer noopener">{u}</a></li>
        {/each}
      </ul>
    {/if}
    {#if detail.files.length > 0}
      <h4>添付ファイル</h4>
      <ul class="links">
        {#each detail.files as f (`${f.prefix}-${f.no}`)}
          <li>
            <a
              href={isTauri ? '#' : api.pcNoticeFileUrl(detailKind, id, f.no, detailQuery)}
              target="_blank"
              rel="noreferrer"
              onclick={(e) => openFile(e, id, f)}
            >
              {f.name}
            </a>{#if f.size}<span class="size"> （{f.size}）</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if openError}<p class="error">{openError}</p>{/if}
  {/if}
</Sheet>

<style>
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
    margin-bottom: 10px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
  }
  .go {
    flex: 0 0 auto;
    padding: 8px 18px;
    border: none;
    background: var(--primary);
    color: #fff;
    border-radius: 12px;
    font-size: 0.9rem;
  }
  .go:disabled {
    opacity: 0.5;
  }
  .fold {
    border: none;
    background: none;
    padding: 4px 0;
    margin-bottom: 8px;
    color: var(--primary);
    font-size: 0.85rem;
  }
  .caret {
    display: inline-block;
    transition: transform var(--dur, 0.18s) var(--ease, ease);
  }
  .caret.open {
    transform: rotate(180deg);
  }
  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    margin-bottom: 12px;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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
  input[type='date'] {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
    min-width: 0;
  }
  .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
  }
  .note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 8px 0 0;
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
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.72rem;
  }
  .badge.important {
    background: var(--important);
    color: #fff;
  }
  .badge.cat {
    background: var(--primary-bg);
    color: var(--primary);
    margin-right: 4px;
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
  /* 本文は上流の改行をそのまま見せる。 */
  .text {
    margin: 0 0 6px;
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
    margin: 6px 0 0;
    padding-left: 18px;
  }
  /* 長い URL・ファイル名は単語区切りが無いので、どこでも折り返す。 */
  .links li {
    overflow-wrap: anywhere;
    word-break: break-all;
  }
  .size {
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
