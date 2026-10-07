<script lang="ts">
  import { onMount } from 'svelte';
  import { goto, onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { isDesktop, isTauri } from '$lib/platform';
  import { setupPwa } from '$lib/pwa';
  import "@master/normal.css";
  import "../app.css";

  let { children } = $props();

  // Tauri 版はウィンドウ幅ではなくビルド種別でレイアウトを固定する(app.css 参照)。
  // ブラウザ版は未設定のまま、幅(768px)で CSS が自動判別する。
  if (isTauri) {
    document.documentElement.dataset.layout = isDesktop ? 'desktop' : 'mobile';
  }

  // シラバスの画面は「奥へ進むと右から入り、戻ると右へ出る」スライドで移る（View Transitions）。
  // 下部タブ間の切替は (app)/+layout.svelte が別にアニメーションするので対象外。
  const isSyllabus = (p?: string) => !!p && p.startsWith('/syllabus');
  onNavigate((nav) => {
    const from = nav.from?.url.pathname;
    const to = nav.to?.url.pathname;
    if (!document.startViewTransition || (!isSyllabus(from) && !isSyllabus(to))) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const detail = '/syllabus/detail';
    const back = from === detail || (from === '/syllabus' && to !== detail);
    document.documentElement.dataset.nav = back ? 'back' : 'forward';
    return new Promise<void>((resolve) => {
      const vt = document.startViewTransition(async () => {
        resolve();
        await nav.complete;
      });
      void vt.finished.finally(() => delete document.documentElement.dataset.nav);
    });
  });

  // Tauri は初期 URL が /index.html など、どのルートにも当たらないパスになることがある。
  // その場合は空白(404)のままにせず、ホームへ移す。
  $effect(() => {
    if (isTauri && page.status === 404) void goto('/', { replaceState: true });
  });

  onMount(() => {
    setupPwa();
  });
</script>

<div class="app-shell" class:desktop={isDesktop}>
  {@render children()}
</div>

<style>
  /* モバイル幅でセンタリングするアプリシェル。
     広い画面では中央 480px に収め、左右に余白を持たせる。 */
  .app-shell {
    width: 100%;
    max-width: var(--app-max);
    min-height: 100dvh;
    margin: 0 auto;
    background: var(--card);
    position: relative;
  }
  @media (--desktop) {
    .app-shell {
      box-shadow: var(--shadow);
    }
  }
  /* desktop(Tauri)版: サイドナビ+広いコンテンツ幅を使う。
     ウィンドウ幅ではなくビルド時の isDesktop フラグで切り替える
     (Tauriウィンドウを狭めてもモバイル用レイアウトにはしない)。 */
  .app-shell.desktop {
    max-width: none;
    box-shadow: none;
  }
</style>
