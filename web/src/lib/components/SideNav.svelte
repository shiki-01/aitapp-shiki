<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  import { TAB_PATH, type Tab } from '$lib/tabs';
  import { resetTab } from '$lib/stores/tabReset.svelte';

  let { tab }: { tab: Tab | undefined } = $props();

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
    <a
      class="item"
      class:active={tab === it.key}
      aria-current={tab === it.key ? 'page' : undefined}
      href={TAB_PATH[it.key]}
      onclick={(e) => {
        if (tab !== it.key) return;
        e.preventDefault();
        resetTab(it.key);
      }}
    >
      <span class="ico"><Icon name={it.icon} size={22} color={tab === it.key ? '#fff' : 'var(--navy)'} /></span>
      <span class="label">{it.label}</span>
    </a>
  {/each}
</nav>

<style>
  .side-nav {
    position: fixed;
    top: 0;
    left: 0;
    width: 220px;
    height: 100%;
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
    text-decoration: none;
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
