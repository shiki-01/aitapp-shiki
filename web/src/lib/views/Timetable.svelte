<script lang="ts">
  import { api, ApiError, type TimetableEntry } from '$lib/api';

  let entries = $state<TimetableEntry[]>([]);
  let loading = $state(false);
  let error = $state('');

  const DAYS: { key: string; label: string }[] = [
    { key: 'monday', label: '月' },
    { key: 'tuesday', label: '火' },
    { key: 'wednesday', label: '水' },
    { key: 'thurstay', label: '木' },
    { key: 'friday', label: '金' },
  ];
  const PERIODS = [1, 2, 3, 4, 5, 6];

  function cell(day: string, period: number): TimetableEntry | undefined {
    return entries.find((e) => e.day === day && e.period === period);
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await api.timetable();
      entries = res.timetable;
    } catch (err) {
      entries = [];
      error = err instanceof ApiError ? err.message : '取得に失敗しました';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });
</script>

<div class="toolbar">
  <button onclick={load} disabled={loading}>再読み込み</button>
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <p class="error">{error}</p>
{:else}
  <div class="grid-wrap">
    <table class="grid">
      <thead>
        <tr>
          <th></th>
          {#each DAYS as d}<th>{d.label}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each PERIODS as p}
          <tr>
            <th class="period">{p}</th>
            {#each DAYS as d}
              {@const c = cell(d.key, p)}
              <td>
                {#if c}
                  <div class="subject">{c.title}</div>
                  <div class="room">{c.classRoom}</div>
                  <div class="teacher">{c.teacher}</div>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .toolbar {
    margin-bottom: 12px;
  }
  .toolbar button {
    padding: 8px 14px;
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 20px;
  }
  .grid-wrap {
    overflow-x: auto;
  }
  .grid {
    border-collapse: collapse;
    width: 100%;
    min-width: 520px;
    background: var(--card);
  }
  .grid th,
  .grid td {
    border: 1px solid var(--border);
    padding: 6px;
    vertical-align: top;
    text-align: center;
  }
  .grid thead th {
    background: #fafafa;
  }
  .period {
    width: 32px;
    background: #fafafa;
  }
  td {
    height: 64px;
    font-size: 0.8rem;
  }
  .subject {
    font-weight: 600;
  }
  .room,
  .teacher {
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
