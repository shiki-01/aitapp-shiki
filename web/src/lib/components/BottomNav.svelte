<script lang="ts">
  import { onMount } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import { TAB_PATH, type Tab } from '$lib/tabs';

  let { tab }: { tab: Tab | undefined } = $props();

  const ITEMS: { key: Tab; icon: IconName; label: string }[] = [
    { key: 'notices', icon: 'notification', label: 'お知らせ' },
    { key: 'calendar', icon: 'calendar', label: 'カレンダー' },
    { key: 'home', icon: 'home', label: 'ホーム' },
    { key: 'assignments', icon: 'task', label: '課題' },
    { key: 'more', icon: 'grid', label: 'その他' },
  ];

  // 青い丸(.pill)は 1 つだけ持ち、選択中の項目へ移動させる。
  const PILL_W = 56;
  const PILL_H = 44;

  let bar: HTMLElement;
  let items = $state<HTMLElement[]>([]);
  let pos = $state<{ x: number; y: number } | null>(null);
  // 初回配置は移動させず、以降の変化だけアニメーションさせる。
  let animate = $state(false);

  function measure() {
    const el = tab ? items[ITEMS.findIndex((it) => it.key === tab)] : undefined;
    pos = el
      ? {
          x: el.offsetLeft + (el.offsetWidth - PILL_W) / 2,
          y: el.offsetTop + (el.offsetHeight - PILL_H) / 2 - 1,
        }
      : null;
  }

  $effect(() => {
    void tab;
    measure();
  });

  onMount(() => {
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    const raf = requestAnimationFrame(() => (animate = true));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  });
</script>

<nav class="bottom-nav" aria-label="メインナビゲーション">
  <div class="bar" bind:this={bar}>
    <span
      class="pill"
      class:animate
      style:opacity={pos ? 1 : 0}
      style:transform={pos ? `translate(${pos.x}px, ${pos.y}px)` : undefined}
      aria-hidden="true"
    ></span>
    {#each ITEMS as it, i (it.key)}
      <a
        bind:this={items[i]}
        class="item"
        class:active={tab === it.key}
        aria-label={it.label}
        aria-current={tab === it.key ? 'page' : undefined}
        href={TAB_PATH[it.key]}
      >
        <span class="ico"><Icon name={it.icon} size={26} color="#fff" /></span>
      </a>
    {/each}
  </div>
</nav>

<style>
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-width: var(--app-max);
    margin: 0 auto;
    padding: 0 16px var(--nav-bottom);
    z-index: 50;
    pointer-events: none;
  }
  .bar {
    pointer-events: auto;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    background: var(--primary-light);
    border-radius: 40px;
    padding: 10px 18px;
    box-shadow: 0 8px 24px rgba(0, 111, 255, 0.28);
  }
  .item {
    border: none;
    background: none;
    padding: 0;
    flex: 1;
    display: grid;
    place-items: center;
    height: 56px;
    text-decoration: none;
    color: inherit;
    position: relative;
    z-index: 1;
  }
  .pill {
    position: absolute;
    top: 0;
    left: 0;
    width: 56px;
    height: 44px;
    border-radius: 24px;
    background: var(--primary);
    pointer-events: none;
  }
  .pill.animate {
    transition:
      transform 0.32s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.18s ease;
  }
  .ico {
    display: grid;
    place-items: center;
    width: 56px;
    height: 44px;
    border-radius: 24px;
  }
  .item:not(.active) .ico {
    opacity: 0.92;
  }
  @media (prefers-reduced-motion: reduce) {
    .pill.animate {
      transition: none;
    }
  }
</style>
