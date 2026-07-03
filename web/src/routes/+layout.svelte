<script lang="ts">
  import { isDesktop } from '$lib/platform';
  import "@master/normal.css";
  import "../app.css";
  
  let { children } = $props();
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
  @media (min-width: 600px) {
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
