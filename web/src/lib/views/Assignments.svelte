<script lang="ts">
  import { api, ApiError, type Assignment } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';
  import { submissions } from '$lib/stores/submission.svelte';

  type Filter = 'upcoming' | 'overdue' | 'done' | 'all';
  const DONE_KEY = 'aitapp.assignments.done.v1';

  let items = $state<Assignment[]>([]);
  let loading = $state(false);
  let error = $state('');
  let filter = $state<Filter>('upcoming');
  let done = $state<Set<number>>(loadDone());

  function loadDone(): Set<number> {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(DONE_KEY);
      return new Set(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
      return new Set();
    }
  }
  function persistDone() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  }
  // Moodle で提出済みなら、手動チェックがなくても完了扱い。
  function isDoneItem(id: number): boolean {
    return done.has(id) || submissions.submitted(id) === true;
  }

  // 提出状況のバッジ（Moodle の mod_assign_get_submission_status の値）。
  function badge(a: Assignment): { text: string; kind: 'ok' | 'warn' | 'bad' | 'plain' } | null {
    const s = submissions.get(a.id);
    if (!s) return submissions.failed ? null : { text: '確認中…', kind: 'plain' };
    const overdue = a.dueEpochMs !== 0 && a.dueEpochMs < Date.now();
    if (s.submitted) {
      return s.gradingStatus === 'graded'
        ? { text: '提出済み・採点済み', kind: 'ok' }
        : { text: '提出済み', kind: 'ok' };
    }
    switch (s.submissionStatus) {
      case 'draft':
        return { text: '下書きのみ（未提出）', kind: 'warn' };
      case 'reopened':
        return { text: '再提出待ち', kind: 'warn' };
      case 'new':
        return { text: overdue ? '未提出（期限切れ）' : '未提出', kind: overdue ? 'bad' : 'plain' };
      default:
        return s.submissionStatus ? { text: s.submissionStatus, kind: 'plain' } : null;
    }
  }

  function fmtSubmitted(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} に提出`;
  }

  function toggleDone(id: number) {
    if (submissions.submitted(id) === true) return; // 提出済みは変更できない。
    const next = new Set(done);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    done = next;
    persistDone();
  }

  function fmt(iso: string | null): string {
    if (!iso) return '締切なし';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function remaining(epoch: number): string {
    const diff = epoch - Date.now();
    if (diff < 0) return '期限切れ';
    const h = Math.floor(diff / 3_600_000);
    if (h < 24) return `あと${h}時間`;
    return `あと${Math.floor(h / 24)}日`;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await api.assignments();
      items = [...res.assignments].sort((a, b) => a.dueEpochMs - b.dueEpochMs);
    } catch (err) {
      items = [];
      error = err instanceof ApiError ? err.message : '課題の取得に失敗しました';
    } finally {
      loading = false;
    }
  }

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'upcoming', label: 'これから' },
    { key: 'overdue', label: '期限切れ' },
    { key: 'done', label: '完了' },
    { key: 'all', label: 'すべて' },
  ];

  const list = $derived.by(() => {
    const now = Date.now();
    return items.filter((a) => {
      const isDone = isDoneItem(a.id);
      switch (filter) {
        case 'upcoming':
          // 締切なし（dueEpochMs=0）は期限切れではないため「これから」に含める。
          return !isDone && (a.dueEpochMs === 0 || a.dueEpochMs >= now);
        case 'overdue':
          return !isDone && a.dueEpochMs !== 0 && a.dueEpochMs < now;
        case 'done':
          return isDone;
        default:
          return true;
      }
    });
  });

  $effect(() => {
    load();
  });

  // 表示中の課題（先頭から 45 件まで）の提出状況を取得する。取得できた分だけ順に反映される。
  $effect(() => {
    // 締切が近い順に、これからの課題 → 期限切れは新しいものから（古い課題より、直近の提出状況が知りたいため）。
    const now = Date.now();
    const ahead = list.filter((a) => a.dueEpochMs === 0 || a.dueEpochMs >= now);
    const past = list.filter((a) => a.dueEpochMs !== 0 && a.dueEpochMs < now).reverse();
    const ids = [...ahead, ...past].slice(0, 45).map((a) => a.id);
    if (ids.length > 0) void submissions.ensure(ids);
  });
</script>

<header class="head">
  <h1>課題</h1>
  <button class="reload" onclick={load} disabled={loading} aria-label="再読み込み">再読み込み</button>
</header>

<div class="filters">
  {#each FILTERS as f (f.key)}
    <button class:active={filter === f.key} onclick={() => (filter = f.key)}>{f.label}</button>
  {/each}
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <p class="error">{error}</p>
{:else if list.length === 0}
  <p class="muted">該当する課題はありません。</p>
{:else}
  <ul class="list">
    {#each list as a (a.id)}
      {@const isDone = isDoneItem(a.id)}
      {@const b = badge(a)}
      {@const overdue = a.dueEpochMs !== 0 && a.dueEpochMs < Date.now()}
      <li class:done={isDone}>
        <button
          class="check"
          class:on={isDone}
          aria-label={isDone ? '未完了に戻す' : '完了にする'}
          onclick={() => toggleDone(a.id)}
        >
          {#if isDone}<Icon name="check" size={16} color="#fff" />{/if}
        </button>
        <div class="body">
          <div class="title">{a.name}</div>
          <div class="course">{a.courseName}</div>
          <div class="due" class:overdue={overdue && !isDone}>
            <Icon name="clock" size={13} color="currentColor" />
            <span>{fmt(a.dueDate)}</span>
            {#if !isDone && a.dueEpochMs !== 0}<span class="rem">{remaining(a.dueEpochMs)}</span>{/if}
          </div>
          {#if b}
            <div class="sub-row">
              <span class="status {b.kind}">{b.text}</span>
              {#if submissions.get(a.id)?.submittedAt}
                <span class="submitted-at">{fmtSubmitted(submissions.get(a.id)?.submittedAt ?? null)}</span>
              {/if}
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .head h1 {
    margin: 0;
    font-size: 1.4rem;
    color: var(--navy);
  }
  .reload {
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 16px;
    padding: 5px 12px;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .filters {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .filters button {
    padding: 6px 14px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 20px;
    font-size: 0.82rem;
  }
  .filters button.active {
    background: var(--primary);
    border-color: var(--primary);
    color: #fff;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  li.done {
    opacity: 0.6;
  }
  li.done .title {
    text-decoration: line-through;
  }
  .check {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 2px solid var(--primary-light);
    background: var(--card);
    display: grid;
    place-items: center;
    padding: 0;
  }
  .check.on {
    background: var(--primary);
    border-color: var(--primary);
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .title {
    font-weight: 600;
  }
  .course {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .due {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 0.8rem;
    margin-top: 3px;
  }
  .due.overdue {
    color: var(--danger);
  }
  .rem {
    margin-left: auto;
    font-weight: 600;
  }
  .sub-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }
  .status {
    border-radius: 10px;
    padding: 1px 9px;
    font-size: 0.72rem;
    font-weight: 600;
    background: var(--primary-bg);
    color: var(--muted);
  }
  .status.ok {
    background: #e6f6ec;
    color: #15803d;
  }
  .status.warn {
    background: #fff7e6;
    color: #8a5300;
  }
  .status.bad {
    background: #fdecec;
    color: var(--danger);
  }
  .submitted-at {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
