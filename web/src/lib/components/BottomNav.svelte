<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';

  export type Tab = 'notices' | 'calendar' | 'home' | 'assignments' | 'more';

  let { tab = $bindable() }: { tab: Tab } = $props();

  const ITEMS: { key: Tab; icon: IconName; label: string }[] = [
    { key: 'notices', icon: 'notification', label: 'お知らせ' },
    { key: 'calendar', icon: 'calendar', label: 'カレンダー' },
    { key: 'home', icon: 'home', label: 'ホーム' },
    { key: 'assignments', icon: 'task', label: '課題' },
    { key: 'more', icon: 'grid', label: 'その他' },
  ];
</script>

<nav class="bottom-nav" aria-label="メインナビゲーション">
  <div class="bar">
    {#each ITEMS as it (it.key)}
      <button
        class="item"
        class:active={tab === it.key}
        aria-label={it.label}
        aria-current={tab === it.key ? 'page' : undefined}
        onclick={() => (tab = it.key)}
      >
        <span class="ico"><Icon name={it.icon} size={26} color="#fff" /></span>
      </button>
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
    padding: 0 16px calc(14px + env(safe-area-inset-bottom));
    z-index: 50;
    pointer-events: none;
  }
  .bar {
    pointer-events: auto;
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
  }
  .ico {
    display: grid;
    place-items: center;
    width: 56px;
    height: 44px;
    border-radius: 24px;
    transition:
      background 0.18s ease,
      transform 0.18s ease;
  }
  .item.active .ico {
    background: var(--primary);
    transform: translateY(-1px);
  }
  .item:not(.active) .ico {
    opacity: 0.92;
  }
</style>
