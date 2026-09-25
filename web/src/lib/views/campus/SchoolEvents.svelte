<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError, type SchoolEventMonth } from '$lib/api';
  import { WEEKDAY_LABELS } from '$lib/date';

  // 年度の並び順（4 月始まり）。前月/翌月はこの順で動き、年度をまたがない
  // （上流は今の年度の表を返すので、3 月の「翌月」に来年度の 4 月は出せない）。
  const FISCAL_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

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

  // YYYY-MM-DD の曜日（0=日）。不正な値は null。
  function weekdayOf(date: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  }

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  const today = jstToday();

  let month = $state(jstNow().getUTCMonth() + 1);
  // 取得済みの月（再読込ボタンで取り直す）。
  let cache = $state<Record<number, SchoolEventMonth>>({});
  let nendo = $state(0);
  let loadingMonth = $state<number | null>(null);
  let error = $state<{ month: number; text: string } | null>(null);
  // 月ごとに最新の要求だけ採用する（連打・月の切り替えで古い応答が上書きしない）。
  const seqs: Record<number, number> = {};

  async function load(m: number) {
    const my = (seqs[m] = (seqs[m] ?? 0) + 1);
    loadingMonth = m;
    if (error?.month === m) error = null;
    try {
      const res = await api.schoolEvents(m);
      if (my !== seqs[m]) return;
      nendo = res.events.nendo;
      const found = res.events.months.find((x) => x.month === m);
      cache[m] = found ?? { month: m, days: [] };
    } catch (err) {
      if (my !== seqs[m]) return;
      error = { month: m, text: errorText(err, '年間行事の取得に失敗しました') };
    } finally {
      if (my === seqs[m] && loadingMonth === m) loadingMonth = null;
    }
  }

  // 月を変えたとき、取得済みでなければ取得する（初回表示も兼ねる）。
  $effect(() => {
    const m = month;
    // load が読む state（error など）を依存に含めない。含めると、エラーで自動再取得が回り続ける。
    untrack(() => {
      if (!cache[m]) void load(m);
    });
  });

  const idx = $derived(FISCAL_MONTHS.indexOf(month));
  const data = $derived(cache[month]);
  const loading = $derived(loadingMonth === month);
  const shownError = $derived(error?.month === month ? error.text : '');

  // 4〜12 月は年度と同じ年、1〜3 月は翌年。年度が分かるまでは年を出さない。
  const title = $derived.by(() => {
    if (!nendo) return `${month}月`;
    return `${month >= 4 ? nendo : nendo + 1}年${month}月`;
  });

  // 行事または祝祭日のある日だけ。
  const days = $derived((data?.days ?? []).filter((d) => d.event !== '' || d.holiday !== ''));

  function step(delta: number) {
    const next = FISCAL_MONTHS[idx + delta];
    if (next !== undefined) month = next;
  }

  // 土日・祝日の色は MonthCalendar に合わせる（日曜・祝日=--red、土曜=--primary、平日=--navy）。
  function dayClass(date: string, holiday: string): string {
    const w = weekdayOf(date);
    if (holiday !== '' || w === 0) return 'sun';
    if (w === 6) return 'sat';
    return '';
  }

  function dayNumber(date: string): string {
    return String(parseInt(date.slice(8, 10), 10));
  }

  function weekdayLabel(date: string, fallback: string): string {
    const w = weekdayOf(date);
    return w === null ? fallback : WEEKDAY_LABELS[w];
  }
</script>

<div class="nav">
  <button class="step" aria-label="前の月" disabled={idx <= 0} onclick={() => step(-1)}>‹</button>
  <div class="center">
    <select aria-label="月" bind:value={month}>
      {#each FISCAL_MONTHS as m (m)}
        <option value={m}>{m}月</option>
      {/each}
    </select>
    <span class="title">{title}</span>
  </div>
  <button
    class="step"
    aria-label="次の月"
    disabled={idx >= FISCAL_MONTHS.length - 1}
    onclick={() => step(1)}>›</button
  >
</div>
<div class="bar">
  {#if nendo}<span class="nendo">{nendo}年度</span>{/if}
  <button class="reload" onclick={() => load(month)} disabled={loading}>再読込</button>
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if shownError}
  <div class="error-box">
    <p class="error">{shownError}</p>
    <button class="retry" onclick={() => load(month)}>再試行</button>
  </div>
{:else if !data}
  <p class="muted">読み込み中…</p>
{:else if days.length === 0}
  <p class="muted">この月の行事・祝祭日はありません。</p>
{:else}
  <ul class="list">
    {#each days as d (d.date)}
      <li class="row" class:today={d.date === today}>
        <span class="date {dayClass(d.date, d.holiday)}">
          <span class="num">{dayNumber(d.date)}</span>
          <span class="wd">（{weekdayLabel(d.date, d.weekday)}）</span>
        </span>
        <span class="body">
          {#if d.date === today}<span class="today-mark">今日</span>{/if}
          {#if d.holiday}<span class="holiday">{d.holiday}</span>{/if}
          {#if d.event}<span class="event">{d.event}</span>{/if}
        </span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .nav {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .step {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-size: 1.4rem;
    line-height: 1;
  }
  .step:disabled {
    opacity: 0.35;
  }
  .center {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  select {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    background: var(--card);
  }
  .title {
    color: var(--navy);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .nendo {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .reload {
    margin-left: auto;
    padding: 6px 14px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-size: 0.85rem;
  }
  .reload:disabled {
    opacity: 0.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
  }
  .row.today {
    background: var(--primary-bg);
    border-color: var(--primary-light);
  }
  .date {
    flex: 0 0 auto;
    min-width: 4.4em;
    color: var(--navy);
    font-variant-numeric: tabular-nums;
  }
  .date.sun {
    color: var(--red);
  }
  .date.sat {
    color: var(--primary);
  }
  .num {
    font-weight: 700;
    font-size: 1.05rem;
  }
  .wd {
    font-size: 0.8rem;
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }
  .today-mark {
    background: var(--primary);
    color: #fff;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.72rem;
  }
  .holiday {
    color: var(--red);
    font-size: 0.85rem;
  }
  .event {
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
</style>
