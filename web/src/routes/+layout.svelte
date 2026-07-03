<script lang="ts">
  import { isDesktop } from '$lib/platform';
  let { children } = $props();
</script>

<div class="app-shell" class:desktop={isDesktop}>
  {@render children()}
</div>

<style>
  :global(:root) {
    /* ---- ブランドカラー（Figma 由来） ---- */
    --primary: #006fff; /* アクティブ・リンク・土曜日 */
    --primary-light: #83b9ff; /* ナビバー背景・時限ラベル・タグ */
    --primary-pale: #9fc9ff; /* 隣月の日付・淡色 */
    --primary-bg: #e2eeff; /* 行背景・メモ背景 */
    --navy: #003a87; /* 平日日付・見出し */
    --red: #ff0051; /* 日曜・祝日 */
    --orange: #ff8000; /* 予定ありドット */

    /* ---- 中立色 ---- */
    --bg: #f4f7fb;
    --card: #ffffff;
    --fg: #1a2433;
    --muted: #6b7a90;
    --border: #e2e8f0;
    --danger: #dc2626;
    --important: #ff8000;

    /* ---- レイアウト ---- */
    --app-max: 480px;
    --nav-h: 84px;
    --radius: 14px;
    --radius-sm: 8px;
    --shadow: 0 6px 24px rgba(16, 64, 140, 0.08);
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
  }
  :global(body) {
    font-family:
      'Noto Sans JP',
      system-ui,
      -apple-system,
      'Segoe UI',
      'Hiragino Sans',
      sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  :global(button) {
    font: inherit;
    cursor: pointer;
  }
  :global(a) {
    color: var(--primary);
  }

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
