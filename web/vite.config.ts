import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// `@media (--desktop)` / `@media (--mobile)` を実際のメディアクエリへ置換する(依存なし)。
// ブラウザ/PWA は 768px で判別。Tauri 版はウィンドウ幅ではなくビルド種別で固定する。
const ALWAYS = '(min-width: 0px)';
const NEVER = '(min-width: 1px) and (max-width: 0px)';
function customMedia(platform?: string) {
  const [desktop, mobile] =
    platform === 'desktop'
      ? [ALWAYS, NEVER]
      : platform === 'mobile'
        ? [NEVER, ALWAYS]
        : ['(min-width: 768px)', '(max-width: 767.98px)'];
  return {
    postcssPlugin: 'custom-media-layout',
    AtRule: {
      media(rule: { params: string }) {
        rule.params = rule.params.replaceAll('(--desktop)', desktop).replaceAll('(--mobile)', mobile);
      },
    },
  };
}
customMedia.postcss = true;

export default defineConfig(({ mode }) => ({
  plugins: [sveltekit()],
  css: { postcss: { plugins: [customMedia(mode)] } },
  // tauri.conf.json の devUrl (http://localhost:5173) と一致させる
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // 契約型の単一情報源 ../shared/contract.ts（web/ の外）を dev サーバーから
    // 読めるように許可する（build/svelte-check には影響しない）。
    fs: {
      allow: ['..'],
    },
  },
}));
