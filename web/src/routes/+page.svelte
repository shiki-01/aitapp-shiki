<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api';
  import { isDesktop } from '$lib/platform';
  import BottomNav, { type Tab } from '$lib/components/BottomNav.svelte';
  import SideNav from '$lib/components/SideNav.svelte';
  import Home from '$lib/views/Home.svelte';
  import Notices from '$lib/views/Notices.svelte';
  import Calendar from '$lib/views/Calendar.svelte';
  import Assignments from '$lib/views/Assignments.svelte';
  import More from '$lib/views/More.svelte';

  let checking = $state(true);
  let userId = $state('');
  let tab = $state<Tab>('home');

  onMount(async () => {
    try {
      const me = await api.me();
      userId = me.userId;
      checking = false;
    } catch (err) {
      // 401 でも通信不能でもログイン画面へ。
      void err;
      await goto('/login');
    }
  });

  async function logout() {
    try {
      await api.logout();
    } finally {
      await goto('/login');
    }
  }

  function navigate(t: Tab) {
    tab = t;
  }
</script>

{#if checking}
  <div class="center"><p class="muted">読み込み中…</p></div>
{:else}
  <div class="shell" class:desktop={isDesktop}>
    {#if isDesktop}
      <SideNav bind:tab />
    {/if}
    <!-- カレンダーはビュー内で縦スクロール領域を持つため main をフル高にする。
         それ以外は通常スクロール。 -->
    <main class:full={tab === 'calendar'}>
      {#if tab === 'home'}
        <Home {userId} onNavigate={navigate} />
      {:else if tab === 'notices'}
        <Notices />
      {:else if tab === 'calendar'}
        <Calendar onMore={() => (tab = 'more')} />
      {:else if tab === 'assignments'}
        <Assignments />
      {:else if tab === 'more'}
        <More {userId} onLogout={logout} />
      {/if}
    </main>

    {#if !isDesktop}
      <BottomNav bind:tab />
    {/if}
  </div>
{/if}

<style>
  .shell.desktop {
    display: flex;
    align-items: stretch;
  }
  main {
    padding: 18px 16px calc(var(--nav-h) + 12px);
    min-height: 100dvh;
  }
  .shell.desktop main {
    padding: 24px 32px;
    margin-left: 220px;
    width: 100%;
  }
  /* カレンダー: 画面を縦に使い切り、内部でスクロールさせる。 */
  main.full {
    padding: 0;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  main.full :global(.page) {
    flex: 1;
    min-height: 0;
  }
  .center {
    min-height: 100dvh;
    display: grid;
    place-items: center;
  }
  .muted {
    color: var(--muted);
  }
</style>
