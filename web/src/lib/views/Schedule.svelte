<script lang="ts">
  import { api, ApiError, type ScheduleDay } from '$lib/api';

  let days = $state<ScheduleDay[]>([]);
  let loading = $state(false);
  let error = $state('');

  function fmtTime(iso: string): string {
    const t = iso.split('T')[1];
    return t ?? '';
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await api.schedule();
      days = res.schedule.filter((d) => d.events.length > 0);
    } catch (err) {
      days = [];
      error =
        err instanceof ApiError
          ? err.message
          : 'スケジュールの取得に失敗しました';
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
  <span class="hint">PC 経路で取得（時間がかかります）</span>
</div>

{#if loading}
  <p class="muted">読み込み中…（最大数十秒）</p>
{:else if error}
  <p class="error">{error}</p>
{:else if days.length === 0}
  <p class="muted">予定はありません。</p>
{:else}
  <div class="days">
    {#each days as day (day.date)}
      <div class="day">
        <div class="date">{day.date}</div>
        <ul>
          {#each day.events as ev}
            <li>
              <div class="ev-title">{ev.title}</div>
              <div class="ev-meta">
                {fmtTime(ev.startTime)}–{fmtTime(ev.endTime)}
                {#if ev.location}· {ev.location}{/if}
                {#if ev.teacher}· {ev.teacher}{/if}
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toolbar {
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .toolbar button {
    padding: 8px 14px;
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 20px;
  }
  .hint {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .days {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .day {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
  }
  .date {
    font-weight: 700;
    margin-bottom: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ev-title {
    font-weight: 600;
  }
  .ev-meta {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
