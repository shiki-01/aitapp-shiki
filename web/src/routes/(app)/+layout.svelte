<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import { isDesktop, isTauri } from '$lib/platform';
  import { session } from '$lib/stores/session.svelte';
  import { notices } from '$lib/stores/notices.svelte';
  import { DESKTOP_TAB_ORDER, MOBILE_TAB_ORDER, TAB_PATH, pathToTab, type Tab } from '$lib/tabs';
  import BottomNav from '$lib/components/BottomNav.svelte';
  import SideNav from '$lib/components/SideNav.svelte';
  import Home from '$lib/views/Home.svelte';
  import Notices from '$lib/views/Notices.svelte';
  import Calendar from '$lib/views/Calendar.svelte';
  import Assignments from '$lib/views/Assignments.svelte';
  import More from '$lib/views/More.svelte';

  // タブの中身はパスごとの +page ではなくここで描画する。開いたタブは破棄せず保持し(読み込み済みの
  // データや入力状態を残す)、切替時は隣り合うパネルを左右にスライドさせる。URL は表示するタブを決める。
  // 認証済みで戻ってきたとき(シラバス詳細から戻る等)は読み込み表示を挟まず、確認は裏で行う。
  let checking = $state(!session.userId);

  // スマホ版(Tauri)は、デスクトップ版のようなバックグラウンドの自動再接続ができない。
  // 代わりにアプリが前面に出たとき、LCAM が未登録/失効なら自動で接続処理(lcamConnect)を
  // 始め、毎回「LCAM に接続」を押さなくて済むようにする(設定スイッチは不要。スマホ版は常に有効)。
  const LCAM_AUTO_COOLDOWN_MS = 30 * 60 * 1000;
  let lcamAutoAt = 0;
  let lcamAutoBusy = false;

  async function autoReconnectLcam() {
    if (!isTauri || isDesktop || !api.lcamConnect) return;
    if (lcamAutoBusy || Date.now() - lcamAutoAt < LCAM_AUTO_COOLDOWN_MS) return;
    lcamAutoBusy = true;
    try {
      if ((await api.lcamSession()).registered) return;
      lcamAutoAt = Date.now();
      await api.lcamConnect();
    } catch {
      // 失敗・対話が必要な場合は手動の「LCAM に接続」に任せる(クールダウン中は再試行しない)
    } finally {
      lcamAutoBusy = false;
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void autoReconnectLcam();
  }

  onMount(() => {
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  onMount(async () => {
    try {
      const me = await api.me();
      session.userId = me.userId;
      checking = false;
      void autoReconnectLcam();
    } catch (err) {
      // 401 でも通信不能でもログイン画面へ。
      void err;
      await goto('/login');
    }
  });

  async function logout() {
    notices.clear();
    try {
      await api.logout();
    } finally {
      await goto('/login');
    }
  }

  const tab = $derived(pathToTab(page.url.pathname));
  const order = isDesktop ? DESKTOP_TAB_ORDER : MOBILE_TAB_ORDER;

  const SLIDE_MS = 300;
  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 一度でも開いたタブ。
  let visited = $state<Partial<Record<Tab, true>>>({});
  // スライド中のタブ(退場側 / 入場側)と方向(1: 右のタブへ = 左へ流れる、-1: その逆)。
  let leaving = $state<Tab | null>(null);
  let entering = $state<Tab | null>(null);
  let dir = $state(1);
  // 退場パネルを、スクロール位置が変わっても見た目の位置に留めるための補正。
  let leaveTop = $state(0);

  let prev: Tab | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scrolls: Partial<Record<Tab, number>> = {};

  $effect.pre(() => {
    const cur = tab;
    if (!cur) return;
    visited[cur] = true;
    if (prev && prev !== cur) {
      const y = window.scrollY;
      scrolls[prev] = y;
      if (!reduceMotion) {
        dir = order.indexOf(cur) > order.indexOf(prev) ? 1 : -1;
        leaveTop = (scrolls[cur] ?? 0) - y;
        leaving = prev;
        entering = cur;
        clearTimeout(timer);
        timer = setTimeout(() => {
          leaving = null;
          entering = null;
        }, SLIDE_MS + 30);
      }
    }
    prev = cur;
  });

  // 切替後、そのタブで最後に見ていたスクロール位置へ戻す。
  $effect(() => {
    const cur = tab;
    if (!cur) return;
    untrack(() => window.scrollTo({ top: scrolls[cur] ?? 0, behavior: 'instant' }));
  });
</script>

{#if checking}
  <div class="center"><p class="muted">読み込み中…</p></div>
{:else}
  <div class="shell" class:desktop={isDesktop}>
    {#if isDesktop}
      <SideNav {tab} />
    {/if}
    <main style:--dir={dir} style:--slide-ms="{SLIDE_MS}ms">
      {#each order as t (t)}
        {#if visited[t]}
          <!-- カレンダーはビュー内で縦スクロール領域を持つため、フル高にする。 -->
          <section
            class="panel"
            class:full={t === 'calendar'}
            class:active={t === tab}
            class:leaving={t === leaving}
            class:entering={t === entering && t === tab}
            style:top={t === leaving ? `${leaveTop}px` : undefined}
          >
            {#if t === 'home'}
              <Home
                userId={session.userId}
                active={tab === 'home'}
                onNavigate={(to) => void goto(TAB_PATH[to])}
              />
            {:else if t === 'notices'}
              <Notices active={tab === 'notices'} />
            {:else if t === 'calendar'}
              <Calendar active={tab === 'calendar'} onMore={() => void goto(TAB_PATH.more)} />
            {:else if t === 'assignments'}
              <Assignments active={tab === 'assignments'} />
            {:else if t === 'more'}
              <More userId={session.userId} active={tab === 'more'} onLogout={logout} />
            {/if}
          </section>
        {/if}
      {/each}
    </main>

    {#if !isDesktop}
      <BottomNav {tab} />
    {/if}
  </div>
{/if}

<style>
  .shell.desktop {
    display: flex;
    align-items: stretch;
  }
  main {
    position: relative;
    /* スライド中に隣のパネルがはみ出して横スクロールが出ないようにする。 */
    overflow-x: clip;
    min-height: 100dvh;
  }
  .shell.desktop main {
    margin-left: 220px;
    width: 100%;
  }
  .panel {
    display: none;
    padding: 18px 16px calc(var(--nav-h) + 12px);
    min-height: 100dvh;
  }
  .shell.desktop .panel {
    padding: 24px 32px;
  }
  .panel.active,
  .panel.leaving {
    display: block;
  }
  /* カレンダー: 画面を縦に使い切り、内部でスクロールさせる。 */
  .panel.full {
    padding: 0;
    height: 100dvh;
    flex-direction: column;
    overflow: hidden;
  }
  .panel.full.active,
  .panel.full.leaving {
    display: flex;
  }
  .panel.full :global(.page) {
    flex: 1;
    min-height: 0;
  }
  .panel.leaving {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
    animation: slide-out var(--slide-ms) cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
  .panel.entering {
    animation: slide-in var(--slide-ms) cubic-bezier(0.4, 0, 0.2, 1);
  }
  @keyframes slide-in {
    from {
      transform: translateX(calc(var(--dir) * 100%));
    }
  }
  @keyframes slide-out {
    to {
      transform: translateX(calc(var(--dir) * -100%));
    }
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
