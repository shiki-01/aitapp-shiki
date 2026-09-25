<script lang="ts">
  import type { Component } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import CommonFiles from './campus/CommonFiles.svelte';

  let { onBack }: { onBack?: () => void } = $props();

  // 「学内サービス」の項目。新しい機能は campus/ にサブ画面(props なしの Svelte コンポーネント)を
  // 作り、ここへ 1 件足すだけでハブに並ぶ。タイトル・戻るボタンはハブ側が描くのでサブ画面は本体だけ持つ。
  interface CampusItem {
    id: string;
    label: string;
    description: string;
    icon: 'note' | 'book' | 'calendar' | 'grid';
    component: Component;
  }
  const ITEMS: CampusItem[] = [
    {
      id: 'commonfiles',
      label: '学内共有ファイル',
      description: '大学が共有している配布資料・様式など',
      icon: 'note',
      component: CommonFiles,
    },
  ];

  let currentId = $state<string | null>(null);
  const current = $derived(ITEMS.find((i) => i.id === currentId));
</script>

<header class="head">
  <button
    class="back"
    aria-label={current ? '学内サービスへ戻る' : '戻る'}
    onclick={() => (current ? (currentId = null) : onBack?.())}
  >
    <Icon name="chevron-left" size={22} color="var(--primary)" />
  </button>
  <h1>{current ? current.label : '学内サービス'}</h1>
</header>

{#if current}
  {@const Screen = current.component}
  <Screen />
{:else}
  <ul class="list">
    {#each ITEMS as item (item.id)}
      <li>
        <button class="item" onclick={() => (currentId = item.id)}>
          <Icon name={item.icon} size={20} color="var(--primary)" />
          <span class="text">
            <span class="label">{item.label}</span>
            <span class="desc">{item.description}</span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--muted)" />
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
  }
  .head h1 {
    margin: 0;
    font-size: 1.4rem;
    color: var(--navy);
  }
  .back {
    border: none;
    background: none;
    padding: 4px;
    margin-left: -6px;
    display: grid;
    place-items: center;
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
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 13px 14px;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .label {
    font-weight: 600;
  }
  .desc {
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
