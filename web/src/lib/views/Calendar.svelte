<script lang="ts">
  import { api, ApiError, type TimetableEntry } from '$lib/api';
  import {
    PERIODS,
    TIMETABLE_DAY_KEYS,
    dateKey,
    sameDay,
    WEEKDAY_LABELS,
  } from '$lib/date';
  import { events, memos } from '$lib/stores/local.svelte';
  import MonthCalendar from '$lib/components/MonthCalendar.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { onMore }: { onMore?: () => void } = $props();

  let selected = $state(new Date());
  let timetable = $state<TimetableEntry[]>([]);
  let ttError = $state('');

  // 予定追加シート
  let sheetOpen = $state(false);
  let form = $state({ title: '', start: '', end: '', note: '' });

  // 時間割を一度だけ取得（曜日×時限）。worker 未起動でも握りつぶす。
  $effect(() => {
    (async () => {
      try {
        const res = await api.timetable();
        timetable = res.timetable;
      } catch (err) {
        ttError = err instanceof ApiError ? err.message : '';
        timetable = [];
      }
    })();
  });

  // カレンダーのドット = カスタム予定のある日。
  const marked = $derived(events.markedDates);

  const selKey = $derived(dateKey(selected));
  const dayKey = $derived(TIMETABLE_DAY_KEYS[selected.getDay()]);

  function classAt(period: number): TimetableEntry | undefined {
    if (!dayKey) return undefined;
    return timetable.find((e) => e.day === dayKey && e.period === period);
  }

  // 当日の時間割に存在する時限のみ表示。
  const dayClasses = $derived(
    dayKey
      ? PERIODS.map((p) => ({ period: p, entry: classAt(p.period) })).filter(
          (r) => r.entry,
        )
      : [],
  );

  const dayEvents = $derived(events.forDate(selKey));

  function openAdd(prefill?: { start: string; end: string; title: string }) {
    form = {
      title: prefill?.title ?? '',
      start: prefill?.start ?? '',
      end: prefill?.end ?? '',
      note: '',
    };
    sheetOpen = true;
  }

  function saveEvent() {
    if (!form.title.trim()) return;
    events.add({
      date: selKey,
      title: form.title.trim(),
      start: form.start || undefined,
      end: form.end || undefined,
      note: form.note.trim() || undefined,
    });
    sheetOpen = false;
  }

  const selLabel = $derived(
    `${selected.getMonth() + 1}月${selected.getDate()}日 (${WEEKDAY_LABELS[selected.getDay()]})`,
  );

  const memoPreview = $derived(memos.sorted.slice(0, 3));
</script>

<div class="page">
  <!-- 上半分: 縦スクロール月カレンダー -->
  <div class="cal-area">
    <MonthCalendar bind:selected {marked} />
  </div>

  <!-- 下半分: 選択日の時間割 + メモプレビュー -->
  <div class="lower">
    <div class="day-head">
      <span class="day-label" class:today={sameDay(selected, new Date())}>{selLabel}</span>
      <button class="add" onclick={() => openAdd()}>
        <Icon name="plus" size={16} color="#fff" /> 予定を追加
      </button>
    </div>

    {#if dayClasses.length === 0 && dayEvents.length === 0}
      <p class="empty">
        この日の予定はありません。
        {#if ttError}<br /><span class="sub">時間割は取得できませんでした。</span>{/if}
      </p>
    {/if}

    <div class="rows">
      {#each dayClasses as row (row.period)}
        <div class="row">
          <div class="time">
            <span>{row.period.start}</span><span>~</span><span>{row.period.end}</span>
          </div>
          <div class="content">
            <div class="topline">
              {#if row.entry?.classRoom}<span class="tag">{row.entry.classRoom}</span>{/if}
              <span class="title">{row.entry?.title}</span>
            </div>
            {#if row.entry?.teacher}<span class="teacher">{row.entry.teacher}</span>{/if}
          </div>
          <button
            class="edit"
            aria-label="この時限に予定を追加"
            onclick={() =>
              openAdd({
                start: row.period.start,
                end: row.period.end,
                title: row.entry?.title ?? '',
              })}
          >
            <Icon name="edit" size={20} color="var(--primary)" />
          </button>
        </div>
      {/each}

      {#each dayEvents as ev (ev.id)}
        <div class="row custom">
          <div class="time alt">
            {#if ev.start}<span>{ev.start}</span>{/if}
            {#if ev.start && ev.end}<span>~</span>{/if}
            {#if ev.end}<span>{ev.end}</span>{/if}
            {#if !ev.start && !ev.end}<span>終日</span>{/if}
          </div>
          <div class="content">
            <span class="title">{ev.title}</span>
            {#if ev.note}<span class="teacher">{ev.note}</span>{/if}
          </div>
          <button class="edit" aria-label="削除" onclick={() => events.remove(ev.id)}>
            <Icon name="close" size={18} color="var(--muted)" />
          </button>
        </div>
      {/each}
    </div>

    <!-- メモプレビュー -->
    <div class="memo-card">
      {#if memoPreview.length === 0}
        <p class="memo-empty">メモはまだありません。「その他」やホームから追加できます。</p>
      {:else}
        <div class="memo-list">
          {#each memoPreview as m (m.id)}
            <div class="memo-item">
              {#if m.title}<span class="memo-title">{m.title}</span>{/if}
              <span class="memo-body">{m.body}</span>
            </div>
          {/each}
        </div>
      {/if}
      <button class="more" onclick={onMore}>もっと見る</button>
    </div>
  </div>
</div>

<Sheet bind:open={sheetOpen} title="{selLabel} の予定を追加">
  <div class="form">
    <label>
      <span>タイトル</span>
      <input type="text" bind:value={form.title} placeholder="例: ゼミ・バイト・締切" />
    </label>
    <div class="row2">
      <label>
        <span>開始</span>
        <input type="time" bind:value={form.start} />
      </label>
      <label>
        <span>終了</span>
        <input type="time" bind:value={form.end} />
      </label>
    </div>
    <label>
      <span>メモ（任意）</span>
      <textarea rows="2" bind:value={form.note}></textarea>
    </label>
    <button class="save" onclick={saveEvent} disabled={!form.title.trim()}>追加する</button>
  </div>
</Sheet>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cal-area {
    flex: 1 1 46%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
  }
  .lower {
    flex: 1 1 54%;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px calc(var(--nav-h) + 8px);
  }
  .day-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .day-label {
    font-weight: 700;
    color: var(--navy);
  }
  .day-label.today {
    color: var(--primary);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: var(--primary);
    color: #fff;
    border-radius: 20px;
    padding: 6px 12px;
    font-size: 0.82rem;
  }
  .empty {
    color: var(--muted);
    text-align: center;
    padding: 18px 0;
    font-size: 0.9rem;
  }
  .empty .sub {
    font-size: 0.8rem;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: stretch;
    background: var(--primary-bg);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .row.custom {
    background: #fff;
    border: 1px solid var(--border);
  }
  .time {
    flex: 0 0 64px;
    background: var(--primary-light);
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 0.72rem;
    line-height: 1.15;
    padding: 6px 2px;
  }
  .time.alt {
    background: var(--primary);
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 8px 10px;
    min-width: 0;
  }
  .topline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .tag {
    flex: 0 0 auto;
    background: var(--primary-light);
    color: #fff;
    font-size: 0.64rem;
    border-radius: 10px;
    padding: 1px 8px;
  }
  .title {
    font-size: 0.86rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .teacher {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .edit {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 0 12px;
    display: grid;
    place-items: center;
  }
  .memo-card {
    position: relative;
    margin-top: 14px;
    background: var(--primary-bg);
    border-radius: var(--radius-sm);
    padding: 14px 14px 30px;
    min-height: 96px;
  }
  .memo-empty {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .memo-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .memo-item {
    display: flex;
    flex-direction: column;
    font-size: 0.76rem;
  }
  .memo-title {
    font-weight: 600;
  }
  .memo-body {
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    position: absolute;
    right: 12px;
    bottom: 8px;
    border: none;
    background: none;
    color: var(--primary);
    font-size: 0.78rem;
    font-weight: 500;
  }

  /* フォーム */
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .row2 {
    display: flex;
    gap: 12px;
  }
  .row2 label {
    flex: 1;
  }
  .form input,
  .form textarea {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 1rem;
    font-family: inherit;
  }
  .save {
    margin-top: 4px;
    border: none;
    border-radius: 10px;
    background: var(--primary);
    color: #fff;
    padding: 12px;
    font-size: 1rem;
  }
  .save:disabled {
    opacity: 0.5;
  }
</style>
