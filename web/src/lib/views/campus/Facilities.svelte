<script lang="ts">
  import { untrack } from 'svelte';
  import {
    api,
    ApiError,
    type FacilityItem,
    type FacilityEvent,
    type FacilityRoomWeek,
    type FacilityWeek,
  } from '$lib/api';
  import { WEEKDAY_LABELS } from '$lib/date';
  import Sheet from '$lib/components/Sheet.svelte';
  import { PERIODS, freeRooms, busyEvents } from '../../../../../shared/facility';

  // schedule API が受け付ける、今週からの週数の範囲。
  const WEEK_MIN = -4;
  const WEEK_MAX = 8;
  // schedule API が 1 回で受け付ける施設数の上限。
  const MAX_IDS = 60;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // 端末のタイムゾーンによらず JST の「今」を UTC getter で読める Date にする。
  function jstNow(): Date {
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
  }

  function jstToday(): string {
    const n = jstNow();
    const m = String(n.getUTCMonth() + 1).padStart(2, '0');
    const d = String(n.getUTCDate()).padStart(2, '0');
    return `${n.getUTCFullYear()}-${m}-${d}`;
  }

  // 今の時刻を含む時限。授業時間外（休み時間・夜間）は Ⅰ限。
  function currentPeriod(): number {
    const n = jstNow();
    const now = n.getUTCHours() * 60 + n.getUTCMinutes();
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':');
      return parseInt(h, 10) * 60 + parseInt(m, 10);
    };
    const hit = PERIODS.find((p) => toMin(p.start) <= now && now < toMin(p.end));
    return hit ? hit.period : 1;
  }

  // YYYY-MM-DD を UTC 0 時のミリ秒へ。不正な値は null。
  function dayMs(date: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  // date が今週（JST・月曜始まり）から何週先か。不正な日付は null。
  function weekOffset(date: string): number | null {
    const target = dayMs(date);
    if (target === null) return null;
    const n = jstNow();
    const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS;
    return Math.round((monday(target) - monday(today)) / (7 * DAY_MS));
  }

  function weekdayLabel(date: string): string {
    const t = dayMs(date);
    return t === null ? '' : WEEKDAY_LABELS[new Date(t).getUTCDay()];
  }

  // 'YYYY-MM-DD' → 'M/D（曜）'
  function dayLabel(date: string): string {
    const t = dayMs(date);
    if (t === null) return date;
    const d = new Date(t);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${weekdayLabel(date)}）`;
  }

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  // ---- 条件 ----
  let buildingCode = $state('');
  let date = $state(jstToday());
  let period = $state(currentPeriod());
  // type=number の bind は number（空欄は null）になる。
  let minCapacity = $state<number | null>(null);

  // ---- 施設一覧（初回に 1 度だけ取得） ----
  let facilities = $state<FacilityItem[]>([]);
  let facilitiesLoading = $state(true);
  let facilitiesError = $state('');
  let facilitiesSeq = 0;

  async function loadFacilities() {
    const seq = ++facilitiesSeq;
    facilitiesLoading = true;
    facilitiesError = '';
    try {
      const res = await api.facilities();
      if (seq !== facilitiesSeq) return;
      facilities = res.facilities;
    } catch (err) {
      if (seq !== facilitiesSeq) return;
      facilities = [];
      facilitiesError = errorText(err, '施設一覧の取得に失敗しました');
    } finally {
      if (seq === facilitiesSeq) facilitiesLoading = false;
    }
  }

  // 建物は上流のコードで重複を除く（一覧の並び順を保つ）。
  const buildings = $derived.by(() => {
    const seen = new Map<string, string>();
    for (const f of facilities) if (!seen.has(f.buildingCode)) seen.set(f.buildingCode, f.building);
    return [...seen].map(([code, name]) => ({ code, name }));
  });
  const facilityById = $derived(new Map(facilities.map((f) => [f.id, f])));

  // ---- 使用状況（建物・日付の変更で再取得） ----
  let schedule = $state<FacilityWeek | null>(null);
  // schedule を取得したときの日付。入力欄を変えてから再取得が終わるまでの間も、表示は取得済みの日付で揃える。
  let resultDate = $state('');
  let truncatedFrom = $state(0);
  let loading = $state(false);
  let error = $state('');
  let rangeError = $state('');
  // 連続操作で古い応答が新しい選択を上書きしないよう、最新の要求だけ採用する。
  let seqNo = 0;

  async function loadSchedule(code: string, day: string) {
    const seq = ++seqNo;
    error = '';
    rangeError = '';
    schedule = null;
    truncatedFrom = 0;
    if (!code || !day) {
      loading = false;
      return;
    }
    const week = weekOffset(day);
    if (week === null || week < WEEK_MIN || week > WEEK_MAX) {
      loading = false;
      rangeError = `この日付は表示できません（今週の ${WEEK_MIN}〜+${WEEK_MAX} 週）`;
      return;
    }
    const all = untrack(() => facilities).filter((f) => f.buildingCode === code);
    if (all.length === 0) {
      loading = false;
      return;
    }
    const ids = all.slice(0, MAX_IDS).map((f) => f.id);
    loading = true;
    try {
      const res = await api.facilitySchedule(ids, week);
      if (seq !== seqNo) return;
      schedule = res.schedule;
      resultDate = day;
      truncatedFrom = all.length > MAX_IDS ? all.length : 0;
    } catch (err) {
      if (seq !== seqNo) return;
      error = errorText(err, '使用状況の取得に失敗しました');
    } finally {
      if (seq === seqNo) loading = false;
    }
  }

  $effect(() => {
    void loadFacilities();
  });

  $effect(() => {
    const code = buildingCode;
    const day = date;
    void loadSchedule(code, day);
  });

  // ---- 表示用の算出 ----
  const periodInfo = $derived(PERIODS.find((p) => p.period === period) ?? PERIODS[0]);

  // 「N 人以上」。空・不正な値は絞り込まない。定員 0 は未登録なので、絞り込み中は除く。
  const capacityFloor = $derived.by(() => {
    return typeof minCapacity === 'number' && Number.isFinite(minCapacity) && minCapacity > 0
      ? minCapacity
      : 0;
  });

  const candidates = $derived.by(() => {
    if (!schedule) return [];
    return schedule.rooms.filter((r) => {
      if (capacityFloor === 0) return true;
      return (facilityById.get(r.id)?.capacity ?? 0) >= capacityFloor;
    });
  });

  const free = $derived(
    freeRooms(candidates, resultDate, periodInfo.start, periodInfo.end),
  );
  const busy = $derived(
    candidates
      .map((room) => ({ room, events: busyEvents(room, resultDate, periodInfo.start, periodInfo.end) }))
      .filter((b) => b.events.length > 0 && b.room.days.some((d) => d.date === resultDate)),
  );

  // ---- 施設の 1 週間の予定（取得済みの schedule から出す） ----
  let selectedId = $state('');
  let sheetOpen = $state(false);

  const selectedRoom = $derived(schedule?.rooms.find((r) => r.id === selectedId) ?? null);
  const selectedFacility = $derived(facilityById.get(selectedId) ?? null);

  function openRoom(room: FacilityRoomWeek) {
    selectedId = room.id;
    sheetOpen = true;
  }

  function timeText(e: FacilityEvent): string {
    return e.start && e.end ? `${e.start}–${e.end}` : '終日';
  }

  // 時刻順。時刻の無い予定（終日）は先頭。
  function sortedEvents(events: FacilityEvent[]): FacilityEvent[] {
    return [...events].sort((a, b) => a.start.localeCompare(b.start));
  }

  function capacityText(f: FacilityItem | undefined): string {
    if (!f || f.capacity <= 0) return '定員 未登録';
    return `定員 ${f.capacity}人`;
  }
</script>

<div class="filters">
  <label>
    <span>建物</span>
    <select bind:value={buildingCode} disabled={facilitiesLoading || !!facilitiesError}>
      <option value="">選んでください</option>
      {#each buildings as b (b.code)}
        <option value={b.code}>{b.name}</option>
      {/each}
    </select>
  </label>
  <label>
    <span>日付</span>
    <input type="date" bind:value={date} />
  </label>
  <label>
    <span>時間帯</span>
    <select bind:value={period}>
      {#each PERIODS as p (p.period)}
        <option value={p.period}>{p.label}（{p.start}–{p.end}）</option>
      {/each}
    </select>
  </label>
  <label>
    <span>収容人数 N 人以上</span>
    <input
      type="number"
      inputmode="numeric"
      min="0"
      step="1"
      placeholder="指定なし"
      bind:value={minCapacity}
    />
  </label>
</div>

<p class="note">
  授業・予約が登録されている情報から算出しています。登録の無い利用は反映されません。
</p>

{#if facilitiesLoading}
  <p class="muted">施設一覧を読み込み中…</p>
{:else if facilitiesError}
  <div class="error-box">
    <p class="error">{facilitiesError}</p>
    <button class="retry" onclick={loadFacilities}>再試行</button>
  </div>
{:else if !buildingCode}
  <p class="muted">建物を選ぶと、空いている教室を表示します。</p>
{:else if !date}
  <p class="muted">日付を選んでください。</p>
{:else if rangeError}
  <p class="muted">{rangeError}</p>
{:else if loading}
  <p class="muted">使用状況を取得中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={() => loadSchedule(buildingCode, date)}>再試行</button>
  </div>
{:else if schedule}
  {#if truncatedFrom > 0}
    <p class="note">
      この建物には {truncatedFrom} 件の施設があります。先頭 {MAX_IDS} 件のみ表示しています。
    </p>
  {/if}
  {#if capacityFloor > 0}
    <p class="note">定員が未登録の施設は、人数で絞り込むと表示されません。</p>
  {/if}
  <h2 class="section">
    空いている教室（{free.length}）
    <span class="section-sub">{dayLabel(resultDate)} {periodInfo.label}</span>
  </h2>
  {#if candidates.length === 0}
    <p class="muted">該当する施設はありません。</p>
  {:else if free.length === 0}
    <p class="muted">この時間帯に空いている教室はありません。</p>
  {:else}
    <ul class="list">
      {#each free as room (room.id)}
        {@const f = facilityById.get(room.id)}
        <li>
          <button class="item" onclick={() => openRoom(room)}>
            <div class="name">{room.name}</div>
            <div class="meta">
              {capacityText(f)}{#if f && f.examCapacity > 0} · 試験時 {f.examCapacity}人{/if}
            </div>
            {#if f && f.equipment.length > 0}
              <div class="tags">
                {#each f.equipment as eq}<span class="tag">{eq}</span>{/each}
              </div>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if busy.length > 0}
    <details class="busy">
      <summary>使用中の教室（{busy.length}）</summary>
      <ul class="list">
        {#each busy as b (b.room.id)}
          <li>
            <button class="item busy-item" onclick={() => openRoom(b.room)}>
              <div class="name">{b.room.name}</div>
              {#each b.events as e}
                <div class="meta">
                  {timeText(e)} {e.title}{#if e.teacher} · {e.teacher}{/if}
                </div>
              {/each}
            </button>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
{/if}

<Sheet bind:open={sheetOpen} title="施設の予定" tall>
  {#if selectedRoom && schedule}
    <h3 class="d-title">{selectedRoom.name}</h3>
    <div class="meta">
      {capacityText(selectedFacility ?? undefined)}{#if selectedFacility && selectedFacility.examCapacity > 0}
        · 試験時 {selectedFacility.examCapacity}人{/if}
    </div>
    {#if selectedFacility && selectedFacility.equipment.length > 0}
      <div class="tags">
        {#each selectedFacility.equipment as eq}<span class="tag">{eq}</span>{/each}
      </div>
    {/if}
    {#each selectedRoom.days as d (d.date)}
      <h4 class="day" class:today={d.date === resultDate}>{dayLabel(d.date)}</h4>
      {#if d.events.length === 0}
        <p class="empty-day">予定なし</p>
      {:else}
        <ul class="events">
          {#each sortedEvents(d.events) as e}
            <li>
              <span class="time">{timeText(e)}</span>
              <span class="ev-body">
                <span class="ev-title">{e.title}</span>
                {#if e.teacher}<span class="meta">{e.teacher}</span>{/if}
                {#if e.note}<span class="meta">{e.note}</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
    <p class="note">授業・予約が登録されている情報です。登録の無い利用は反映されません。</p>
  {:else}
    <p class="muted">この施設の予定は取得済みのデータにありません。</p>
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
  select,
  input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
    min-width: 0;
  }
  .note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 12px;
  }
  .section {
    margin: 4px 0 8px;
    font-size: 1rem;
    color: var(--navy);
  }
  .section-sub {
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 400;
    margin-left: 6px;
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
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .tag {
    background: var(--primary-bg);
    color: var(--navy);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.72rem;
  }
  .busy {
    margin-top: 16px;
  }
  .busy summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.9rem;
    margin-bottom: 8px;
  }
  .busy-item {
    background: var(--bg);
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
  .day {
    margin: 16px 0 6px;
    font-size: 0.9rem;
    color: var(--navy);
    font-variant-numeric: tabular-nums;
  }
  .day.today {
    color: var(--primary);
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
    font-size: 0.82rem;
    color: var(--primary);
    font-variant-numeric: tabular-nums;
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
