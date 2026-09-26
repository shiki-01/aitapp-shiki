<script lang="ts">
  import {
    monthGrid,
    dateKey,
    sameDay,
    WEEKDAY_LABELS,
    fmtMonthTitle,
  } from '$lib/date';

  let {
    selected = $bindable(),
    marked = new Set<string>(),
    monthsBefore = 6,
    monthsAfter = 6,
  }: {
    selected: Date;
    marked?: Set<string>;
    monthsBefore?: number;
    monthsAfter?: number;
  } = $props();

  const today = new Date();

  // 表示する月のリスト（今月を基準に前後）。縦スクロールで連続表示する。
  const baseMonths = (() => {
    const list: { year: number; month0: number }[] = [];
    const base = new Date(today.getFullYear(), today.getMonth(), 1);
    for (let i = -monthsBefore; i <= monthsAfter; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      list.push({ year: d.getFullYear(), month0: d.getMonth() });
    }
    return list;
  })();

  // 初回マウント時に今日を含む月までスクロールする（デフォルトは過去ではなく当月）。
  let scrollEl: HTMLDivElement | undefined = $state();
  let monthEls: (HTMLElement | undefined)[] = $state([]);
  let scrolled = false;
  const todayIdx = baseMonths.findIndex(
    (m) => m.year === today.getFullYear() && m.month0 === today.getMonth(),
  );

  $effect(() => {
    if (scrolled) return;
    const el = monthEls[todayIdx];
    if (scrollEl && el) {
      scrollEl.scrollTop = el.offsetTop - scrollEl.offsetTop;
      scrolled = true;
    }
  });

  function isCurrentMonth(d: Date, month0: number): boolean {
    return d.getMonth() === month0;
  }

  function dayColor(d: Date, month0: number): string {
    if (!isCurrentMonth(d, month0)) return 'var(--primary-pale)';
    const w = d.getDay();
    if (w === 0) return 'var(--red)';
    if (w === 6) return 'var(--primary)';
    return 'var(--navy)';
  }
</script>

<div class="cal">
  <div class="weekdays">
    {#each WEEKDAY_LABELS as w, i}
      <span class:sun={i === 0} class:sat={i === 6}>{w}</span>
    {/each}
  </div>

  <div class="scroll" bind:this={scrollEl}>
    {#each baseMonths as m, mi (m.year + '-' + m.month0)}
      <section class="month" bind:this={monthEls[mi]}>
        <h3 class="month-title">{fmtMonthTitle(m.year, m.month0)}</h3>
        <div class="grid">
          {#each monthGrid(m.year, m.month0) as d (dateKey(d) + '@' + m.month0)}
            {@const isToday = sameDay(d, today)}
            {@const isSel = sameDay(d, selected)}
            <button
              class="cell"
              class:today={isToday}
              class:selected={isSel}
              onclick={() => (selected = new Date(d.getFullYear(), d.getMonth(), d.getDate()))}
            >
              <span class="num" style="color: {isToday || isSel ? '#fff' : dayColor(d, m.month0)}">
                {d.getDate()}
              </span>
              {#if marked.has(dateKey(d)) && isCurrentMonth(d, m.month0)}
                <span class="dot" class:on-fill={isToday || isSel}></span>
              {/if}
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>

<style>
  .cal {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    text-align: center;
    font-size: 0.78rem;
    color: var(--muted);
    padding: 4px 8px 6px;
  }
  .weekdays .sun {
    color: var(--red);
  }
  .weekdays .sat {
    color: var(--primary);
  }
  .scroll {
    overflow-y: auto;
    scroll-snap-type: y proximity;
    -webkit-overflow-scrolling: touch;
  }
  .month {
    scroll-snap-align: start;
    padding: 2px 8px 10px;
    display: flex;
    flex-direction: column;
  }
  .month-title {
    margin: 6px 0 8px;
    text-align: center;
    font-size: 1rem;
    font-weight: 500;
    color: var(--navy);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
  }
  .cell {
    position: relative;
    border: none;
    background: none;
    aspect-ratio: 1 / 1;
    display: grid;
    place-items: center;
    padding: 0;
  }
  .num {
    display: grid;
    place-items: center;
    width: 2em;
    height: 2em;
    border-radius: 50%;
    font-size: 1.05rem;
  }
  .cell.today .num {
    background: var(--primary-light);
  }
  .cell.selected:not(.today) .num {
    background: var(--primary);
  }
  .dot {
    position: absolute;
    bottom: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--orange);
  }
  .dot.on-fill {
    background: #fff;
  }

  @media (--mobile) {
    .cell {
      aspect-ratio: 3 / 2;
    }
    /* 月がスクロール領域に収まる幅では、必ず月の頭で止め、1 回の操作で複数の月を飛ばさない。
       PC 幅は 1 月がスクロール領域より高くなり得るため、proximity のまま。 */
    .scroll {
      scroll-snap-type: y mandatory;
    }
    .month {
      scroll-snap-stop: always;
    }
  }
</style>
