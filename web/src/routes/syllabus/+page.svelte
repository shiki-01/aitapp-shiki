<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import { isTauri } from '$lib/platform';
  import { session } from '$lib/stores/session.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import Syllabus from '$lib/views/Syllabus.svelte';

  let checking = $state(!session.userId);

  onMount(async () => {
    try {
      const me = await api.me();
      session.userId = me.userId;
      checking = false;
    } catch (err) {
      // 401 でも通信不能でもログイン画面へ。
      void err;
      await goto('/login');
    }
  });
</script>

<svelte:head><title>シラバス検索</title></svelte:head>

{#if checking}
  <div class="center"><p class="muted">読み込み中…</p></div>
{:else}
  <main>
    <header class="head">
      <!-- Tauri は新規タブが無く同一ウィンドウで遷移してくるため、戻る導線を出す。 -->
      {#if isTauri}
        <button class="back" aria-label="戻る" onclick={() => history.back()}>
          <Icon name="chevron-left" size={20} color="var(--primary)" />
        </button>
      {/if}
      <h1>シラバス検索</h1>
    </header>
    <Syllabus />
  </main>
{/if}

<style>
  main {
    padding: calc(18px + env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom));
    min-height: 100dvh;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 14px;
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
  }
  .back {
    border: none;
    background: none;
    padding: 4px;
    display: grid;
    place-items: center;
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
