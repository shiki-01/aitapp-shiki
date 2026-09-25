<script lang="ts">
  import { onMount } from 'svelte';
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
