<script lang="ts">
  import { api, ApiError, type StaffMember, type ScheduleDay, type ScheduleEvent } from '$lib/api';
  import { WEEKDAY_LABELS } from '$lib/date';
  import Sheet from '$lib/components/Sheet.svelte';
  import { PERIODS } from '../../../../../shared/facility';

  // schedule API が受け付ける、今週からの週数の範囲。
  const WEEK_MIN = -4;
  const WEEK_MAX = 8;
  const NAME_MAX = 30;

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  // YYYY-MM-DD を UTC 0 時のミリ秒へ。不正な値は null。
  function dayMs(date: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  // 'YYYY-MM-DD' → 'M/D（曜）'
  function dayLabel(date: string): string {
    const t = dayMs(date);
    if (t === null) return date;
    const d = new Date(t);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY_LABELS[d.getUTCDay()]}）`;
  }

  // 'YYYY-MM-DD' → 'M月D日'
  function monthDay(date: string): string {
    const t = dayMs(date);
    if (t === null) return date;
    const d = new Date(t);
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  }

  // 'YYYY-MM-DDTHH:MM' → 'HH:MM'
  function hhmm(dateTime: string): string {
    return dateTime.slice(11, 16);
  }

  function periodLabel(period: number | undefined): string {
    if (period === undefined) return '';
    return PERIODS.find((p) => p.period === period)?.label ?? `${period}限`;
  }

  // 時刻順（同時刻は元の並びを保つ）。
  function sortedEvents(events: ScheduleEvent[]): ScheduleEvent[] {
    return [...events].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  // ---- 氏名の検索 ----
  let query = $state('');
  // 候補を得たときの検索語。スケジュール取得（name パラメータ）にも同じものを渡す
  // （入力欄を触っても、開いた候補の検索語で呼ぶ）。
  let searchedName = $state('');
  let candidates = $state<StaffMember[]>([]);
  let searched = $state(false);
  let searching = $state(false);
  let searchError = $state('');
  // 古い応答が新しい結果を上書きしないよう、最新の要求だけ採用する。
  let searchSeq = 0;

  async function search(e?: Event) {
    e?.preventDefault();
    const name = query.trim();
    if (!name || searching) return;
    const seq = ++searchSeq;
    searching = true;
    searchError = '';
    try {
      const res = await api.staff(name);
      if (seq !== searchSeq) return;
      searchedName = name;
      candidates = res.staff;
      searched = true;
    } catch (err) {
      if (seq !== searchSeq) return;
      candidates = [];
      searched = false;
      searchError = errorText(err, '教職員の検索に失敗しました');
    } finally {
      if (seq === searchSeq) searching = false;
    }
  }

  // ---- スケジュール ----
  let sheetOpen = $state(false);
  let selected = $state<StaffMember | null>(null);
  // 0 は「今日から 7 日」。±1 は今週の月曜を起点にした週。
  let week = $state(0);
  let days = $state<ScheduleDay[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state('');
  let seqNo = 0;

  async function loadSchedule(member: StaffMember, w: number) {
    const seq = ++seqNo;
    loading = true;
    loaded = false;
    error = '';
    try {
      const res = await api.staffSchedule(searchedName, member.code, w);
      if (seq !== seqNo) return;
      days = res.schedule.days;
      loaded = true;
    } catch (err) {
      if (seq !== seqNo) return;
      days = [];
      error = errorText(err, 'スケジュールの取得に失敗しました');
    } finally {
      if (seq === seqNo) loading = false;
    }
  }

  function pick(member: StaffMember) {
    selected = member;
    week = 0;
    days = [];
    sheetOpen = true;
    void loadSchedule(member, 0);
  }

  function moveWeek(w: number) {
    if (!selected || w < WEEK_MIN || w > WEEK_MAX) return;
    week = w;
    void loadSchedule(selected, w);
  }

  const rangeLabel = $derived(
    week === 0
      ? '今日から 7 日'
      : days.length > 0
        ? `${monthDay(days[0].date)}〜の週`
        : week < 0
          ? `${-week} 週前`
          : `${week} 週後`,
  );
</script>

<form class="search" onsubmit={search}>
  <input
    type="search"
    placeholder="氏名（姓だけでも可）"
    aria-label="氏名"
    maxlength={NAME_MAX}
    bind:value={query}
  />
  <button type="submit" class="go" disabled={searching || query.trim() === ''}>検索</button>
</form>

<p class="note">登録されている授業・予定から表示しています。在室状況ではありません。</p>

{#if searching}
  <p class="muted">検索中…</p>
{:else if searchError}
  <div class="error-box">
    <p class="error">{searchError}</p>
    <button class="retry" onclick={() => search()}>再試行</button>
  </div>
{:else if !searched}
  <p class="muted">氏名を入力して検索してください。</p>
{:else if candidates.length === 0}
  <p class="muted">「{searchedName}」に該当する教職員はいません。</p>
{:else}
  <p class="count">{candidates.length} 人</p>
  <ul class="list">
    {#each candidates as m (m.code)}
      <li>
        <button class="item" onclick={() => pick(m)}>
          <div class="dept">{m.department || '所属の登録なし'}</div>
          <div class="name">{m.name}</div>
          {#if m.kana}<div class="meta">{m.kana}</div>{/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<Sheet bind:open={sheetOpen} title="教職員スケジュール" tall>
  {#if selected}
    <div class="dept">{selected.department || '所属の登録なし'}</div>
    <h3 class="d-title">{selected.name}</h3>
    {#if selected.kana}<div class="meta">{selected.kana}</div>{/if}

    <div class="nav">
      <button
        type="button"
        disabled={loading || week <= WEEK_MIN}
        onclick={() => moveWeek(week - 1)}
      >
        前週
      </button>
      <button type="button" disabled={loading || week === 0} onclick={() => moveWeek(0)}>
        今週
      </button>
      <button
        type="button"
        disabled={loading || week >= WEEK_MAX}
        onclick={() => moveWeek(week + 1)}
      >
        翌週
      </button>
    </div>
    <p class="range">{rangeLabel}</p>

    {#if loading}
      <div class="loading" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <p>スケジュールを取得しています。数秒かかることがあります。</p>
      </div>
    {:else if error}
      <div class="error-box">
        <p class="error">{error}</p>
        <button class="retry" onclick={() => selected && loadSchedule(selected, week)}>
          再試行
        </button>
      </div>
    {:else if loaded && days.length === 0}
      <p class="muted">この期間のスケジュールはありません。</p>
    {:else}
      {#each days as d (d.date)}
        <h4 class="day">{dayLabel(d.date)}</h4>
        {#if d.events.length === 0}
          <p class="empty-day">予定なし</p>
        {:else}
          <ul class="events">
            {#each sortedEvents(d.events) as e}
              <li>
                <span class="time">
                  {#if e.period !== undefined}<span class="period">{periodLabel(e.period)}</span>{/if}
                  {hhmm(e.startTime)}–{hhmm(e.endTime)}
                </span>
                <span class="ev-body">
                  <span class="ev-title">{e.title}</span>
                  {#if e.location}<span class="meta">{e.location}</span>{/if}
                  {#if e.teacher}<span class="meta">{e.teacher}</span>{/if}
                  {#if e.note}<span class="meta">{e.note}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
    {/if}
    <p class="note foot">登録されている授業・予定から表示しています。在室状況ではありません。</p>
  {/if}
</Sheet>

<style>
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
  .note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 12px;
  }
  .note.foot {
    margin: 16px 0 0;
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
  /* 同姓が複数出るので、所属を氏名より先に目立たせる。 */
  .dept {
    display: inline-block;
    background: var(--primary-bg);
    color: var(--primary);
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 4px;
    overflow-wrap: anywhere;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
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
  .nav {
    display: flex;
    gap: 8px;
    margin: 14px 0 6px;
  }
  .nav button {
    flex: 1;
    padding: 8px 0;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-size: 0.88rem;
  }
  .nav button:disabled {
    opacity: 0.4;
  }
  .range {
    margin: 0 0 4px;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--navy);
  }
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin: 28px 0;
    color: var(--muted);
    font-size: 0.85rem;
    text-align: center;
  }
  .loading p {
    margin: 0;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--border);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .day {
    margin: 16px 0 6px;
    font-size: 0.9rem;
    color: var(--navy);
    font-variant-numeric: tabular-nums;
  }
  .empty-day {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .events li {
    display: flex;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    padding: 8px 10px;
  }
  .time {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    font-size: 0.82rem;
    color: var(--primary);
    font-variant-numeric: tabular-nums;
  }
  .period {
    font-weight: 600;
  }
  .ev-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .ev-title {
    overflow-wrap: anywhere;
  }
</style>
