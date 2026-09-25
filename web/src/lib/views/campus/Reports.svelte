<script lang="ts">
  import {
    api,
    ApiError,
    type ReportItem,
    type ReportDetail,
    type ReportQuery,
    type ReportSubmissionFile,
  } from '$lib/api';
  import { isTauri } from '$lib/platform';
  import Sheet from '$lib/components/Sheet.svelte';

  // 年度は今年から過去 3 年。'' は「今の年度」（year を送らず、上流の初期表示に任せる）。
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 4 }, (_, i) => thisYear - i);

  let year = $state('');
  let semester = $state('');
  let unsubmittedOnly = $state(false);

  let reports = $state<ReportItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  // 一覧を取得したときの絞り込み。詳細・ファイル取得にも同じものを付ける
  // （既定の年度・学期以外のレポートを開くため）。
  let listQuery = $state<ReportQuery>({});
  let listSeq = 0;

  let detail = $state<ReportDetail | null>(null);
  let detailOpen = $state(false);
  let detailLoading = $state(false);
  let detailError = $state('');
  // 古い詳細リクエストの結果が新しい選択を上書きしないよう、最新の要求だけ採用する。
  let detailSeq = 0;
  let openError = $state('');

  function currentQuery(): ReportQuery {
    const q: ReportQuery = {};
    if (year) q.year = Number(year);
    if (semester === '1' || semester === '2') q.semester = Number(semester) as 1 | 2;
    if (unsubmittedOnly) q.unsubmittedOnly = true;
    return q;
  }

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  async function load(query: ReportQuery) {
    const seq = ++listSeq;
    loading = true;
    error = '';
    try {
      const res = await api.reports(query);
      if (seq !== listSeq) return;
      listQuery = query;
      reports = res.reports;
    } catch (err) {
      if (seq !== listSeq) return;
      reports = [];
      error = errorText(err, 'レポートの取得に失敗しました');
    } finally {
      if (seq === listSeq) loading = false;
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
      const res = await api.reportDetail(id, listQuery);
      if (seq === detailSeq) detail = res.detail;
    } catch (err) {
      if (seq === detailSeq) detailError = errorText(err, '詳細の取得に失敗しました');
    } finally {
      if (seq === detailSeq) detailLoading = false;
    }
  }

  // desktop版はブラウザの<a target=_blank>が使えない(Workerと別サイト扱いのためcookieが
  // 送れない)ので、一時ファイルへ保存しOS既定アプリで開く(CommonFiles.svelte と同じ体験)。
  async function openFile(e: MouseEvent, id: string, f: ReportSubmissionFile) {
    if (!isTauri) return;
    e.preventDefault();
    openError = '';
    try {
      await api.openReportFile(id, f.submitNo, f.fileNo, f.name, listQuery);
    } catch (err) {
      openError = errorText(err, 'ファイルを開けませんでした');
    }
  }

  // 絞り込みの変更で再取得する（初回表示も兼ねる）。
  $effect(() => {
    const q = currentQuery();
    void load(q);
  });

  function badgeClass(status: string): string {
    if (status.includes('受付中')) return 'open';
    return 'closed';
  }
</script>

<div class="filters">
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
</div>
<label class="toggle">
  <input type="checkbox" bind:checked={unsubmittedOnly} />
  <span>未提出のみ</span>
</label>

<p class="note">提出は LCAM の PC 版で行ってください。</p>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={() => load(currentQuery())}>再試行</button>
  </div>
{:else if reports.length === 0}
  <p class="muted">
    {unsubmittedOnly ? '未提出のレポートはありません。' : 'レポートはありません。'}
  </p>
{:else}
  <ul class="list">
    {#each reports as r (r.id)}
      <li>
        <button class="item" onclick={() => openDetail(r.id)}>
          <div class="title-row">
            <span class="badge {badgeClass(r.status)}">{r.status}</span>
            <span class="title">{r.title}</span>
          </div>
          <div class="meta">{r.subject}{#if r.term} · {r.term}{/if}</div>
          <div class="meta">提出期間 {r.period}</div>
          <div class="meta">
            {r.lastSubmittedAt ? `最終提出 ${r.lastSubmittedAt}` : '未提出'}
          </div>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<Sheet bind:open={detailOpen} title="レポート" tall>
  {#if detailLoading}
    <p class="muted">詳細を取得中…</p>
  {:else if detailError}
    <p class="error">{detailError}</p>
  {:else if detail}
    {@const id = detail.id}
    <h3 class="d-title">{detail.title}</h3>
    <dl class="fields">
      {#if detail.status}
        <dt>状態</dt>
        <dd><span class="badge {badgeClass(detail.status)}">{detail.status}</span></dd>
      {/if}
      {#if detail.period}<dt>提出期間</dt><dd>{detail.period}</dd>{/if}
      {#if detail.evaluation}<dt>評価方法</dt><dd>{detail.evaluation}</dd>{/if}
    </dl>
    {#if detail.description}
      <h4>説明</h4>
      <p class="text">{detail.description}</p>
    {/if}
    {#if detail.notice}
      <h4>伝達事項</h4>
      <p class="text">{detail.notice}</p>
    {/if}
    {#if detail.referenceMaterial}
      <h4>参考資料</h4>
      <p class="text">{detail.referenceMaterial}</p>
    {/if}
    {#if detail.reminder}
      <h4>催促通知</h4>
      <p class="text">{detail.reminder}</p>
    {/if}
    {#if detail.result.length > 0}
      <h4>評価結果</h4>
      {#each detail.result as line}
        <p class="text">{line}</p>
      {/each}
    {/if}
    <hr />
    <h4>提出履歴</h4>
    {#if detail.submissions.length === 0}
      <p class="muted">提出履歴はありません。</p>
    {:else}
      {#each detail.submissions as s}
        <div class="submission">
          <p class="s-heading">{s.heading}</p>
          {#each s.lines as line}
            <p class="text">{line}</p>
          {/each}
          {#if s.files.length > 0}
            <ul class="links">
              {#each s.files as f (`${f.submitNo}-${f.fileNo}`)}
                <li>
                  <a
                    href={isTauri
                      ? '#'
                      : api.reportDownloadUrl(id, f.submitNo, f.fileNo, listQuery)}
                    target="_blank"
                    rel="noreferrer"
                    onclick={(e) => openFile(e, id, f)}
                  >
                    {f.name}
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
    {#if openError}<p class="error">{openError}</p>{/if}
    <p class="note">提出は LCAM の PC 版で行ってください。</p>
  {/if}
</Sheet>

<style>
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
  select {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    margin-bottom: 10px;
  }
  .note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 12px;
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
  .badge.open {
    background: var(--primary);
    color: #fff;
  }
  .badge.closed {
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
  /* 説明・伝達事項などは上流の改行をそのまま見せる。 */
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
  .submission {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .s-heading {
    margin: 0 0 6px;
    font-weight: 600;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .links {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  /* 長いファイル名は単語区切りが無いので、どこでも折り返す。 */
  .links li {
    overflow-wrap: anywhere;
    word-break: break-all;
  }
</style>
