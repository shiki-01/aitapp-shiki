<script lang="ts">
  import type { Component } from 'svelte';
  import type { KyoumuTarget } from '$lib/types';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import CommonFiles from './campus/CommonFiles.svelte';
  import Reports from './campus/Reports.svelte';
  import Facilities from './campus/Facilities.svelte';
  import Credits from './campus/Credits.svelte';
  import Curriculum from './campus/Curriculum.svelte';
  import SchoolEvents from './campus/SchoolEvents.svelte';
  import NoticeSearch from './campus/NoticeSearch.svelte';
  import Lottery from './campus/Lottery.svelte';
  import Staff from './campus/Staff.svelte';
  import { api } from '$lib/api';

  let { onBack }: { onBack?: () => void } = $props();

  // 「学内サービス」の項目。新しい機能は campus/ にサブ画面(props なしの Svelte コンポーネント)を
  // 作り、ここへ 1 件足すだけでハブに並ぶ。タイトル・戻るボタンはハブ側が描くのでサブ画面は本体だけ持つ。
  interface CampusItem {
    id: string;
    label: string;
    description: string;
    icon: IconName;
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
    {
      id: 'reports',
      label: 'レポート',
      description: '提出期間・提出履歴の確認（提出は LCAM の PC 版で）',
      icon: 'task',
      component: Reports,
    },
    {
      id: 'facilities',
      label: '空き教室',
      description: '建物・日時から空いている教室を探す（参照のみ）',
      icon: 'clock',
      component: Facilities,
    },
    {
      id: 'credits',
      label: '単位修得',
      description: '学事システムの単位修得状況（参照のみ）',
      icon: 'check',
      component: Credits,
    },
    {
      id: 'curriculum',
      label: 'カリキュラム',
      description: '履修対象の科目と評価の一覧（参照のみ）',
      icon: 'book',
      component: Curriculum,
    },
    {
      id: 'schoolevents',
      label: '年間行事',
      description: '学内スケジュール。月ごとの行事・祝祭日（参照のみ）',
      icon: 'calendar',
      component: SchoolEvents,
    },
    {
      id: 'noticesearch',
      label: '連絡を検索',
      description: '学内連絡・授業連絡をキーワードや期間で探す（参照のみ）',
      icon: 'search',
      component: NoticeSearch,
    },
    {
      id: 'lottery',
      label: '抽選結果',
      description: '抽選履修登録の当落を曜日時限ごとに確認（参照のみ）',
      icon: 'edit',
      component: Lottery,
    },
    {
      id: 'staff',
      label: '教職員スケジュール',
      description: '教職員の授業・予定を氏名から探す（参照のみ）',
      icon: 'calendar',
      component: Staff,
    },
  ];

  let currentId = $state<string | null>(null);
  const current = $derived(ITEMS.find((i) => i.id === currentId));

  // 「本家で行う操作」の行き先。学事システムの画面を新しいタブで開く URL（desktop 版は null）。
  const HONKE_ACTIONS: { label: string; to: KyoumuTarget }[] = [
    { label: '履修登録', to: 'register' },
    { label: '履修取消', to: 'cancel' },
    { label: '抽選履修登録', to: 'lottery' },
  ];
  const kyoumuUrls = HONKE_ACTIONS.map((a) => api.kyoumuOpenUrl(a.to));
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

  <section class="honke">
    <h2>本家で行う操作</h2>
    <p class="honke-desc">
      次の操作は取り消しにくいため、aitapp からは行わず、学事システム（本家）で行います。
    </p>
    {#if kyoumuUrls[0]}
      <ul class="list">
        {#each HONKE_ACTIONS as action, i (action.to)}
          <li>
            <a class="link" href={kyoumuUrls[i]} target="_blank" rel="noopener">
              <Icon name="external" size={18} color="var(--primary)" />
              <span class="link-text">
                <span class="label">{action.label}</span>
                <span class="desc">学事システムを開く</span>
              </span>
              <Icon name="chevron-right" size={16} color="var(--muted)" />
            </a>
          </li>
        {/each}
      </ul>
      <p class="honke-note">学事システムの該当の画面が新しいタブで開きます。学籍情報の更新・教職履修カルテの登録は、LCAM の PC 版で行ってください。</p>
      <p class="honke-note">
        LCAM の PC 版にログインし直すと、aitapp の LCAM 連携が切れることがあります。ここから開けば、LCAM
        本体へはログインし直しません。
      </p>
    {:else}
      <ul class="plain">
        {#each HONKE_ACTIONS as action (action.to)}
          <li>{action.label}</li>
        {/each}
      </ul>
      <p class="honke-note">ブラウザ版の aitapp から開いてください。</p>
    {/if}
    <p class="honke-note">パスワード変更など、LCAM の PC 版でしか行えない操作は、LCAM の PC 版で行ってください。</p>
  </section>
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
  .honke {
    margin-top: 24px;
  }
  .honke h2 {
    margin: 0 0 6px;
    font-size: 1rem;
    color: var(--navy);
  }
  .honke-desc {
    margin: 0 0 10px;
    font-size: 0.85rem;
  }
  .honke-note {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .link {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 13px 14px;
    text-decoration: none;
    color: var(--fg);
  }
  .link-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .plain {
    margin: 0;
    padding-left: 18px;
    font-size: 0.9rem;
  }
</style>
