<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  import type { Tab } from './BottomNav.svelte';

  let { tab = $bindable() }: { tab: Tab } = $props();

  const ITEMS: { key: Tab; icon: IconName; label: string }[] = [
    { key: 'home', icon: 'home', label: 'ホーム' },
    { key: 'notices', icon: 'notification', label: 'お知らせ' },
    { key: 'calendar', icon: 'calendar', label: 'カレンダー' },
    { key: 'assignments', icon: 'task', label: '課題' },
    { key: 'more', icon: 'grid', label: 'その他' },
  ];
</script>

<nav class="side-nav" aria-label="メインナビゲーション">
  {#each ITEMS as it (it.key)}
    <button
      class="item"
      class:active={tab === it.key}
      aria-current={tab === it.key ? 'page' : undefined}
      onclick={() => (tab = it.key)}
    >
      <span class="ico"><Icon name={it.icon} size={22} color={tab === it.key ? '#fff' : 'var(--navy)'} /></span>
      <span class="label">{it.label}</span>
    </button>
  {/each}
</nav>

<style>
  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 24px 12px;
    border-right: 1px solid var(--border);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    border: none;
    background: none;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    text-align: left;
    color: var(--navy);
  }
  .item:hover {
    background: var(--primary-bg);
  }
  .item.active {
    background: var(--primary);
    color: #fff;
  }
  .ico {
    display: grid;
    place-items: center;
  }
  .label {
    font-size: 0.95rem;
  }
</style>
