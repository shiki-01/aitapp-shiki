import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA: 全ルートを index.html にフォールバック。Cloudflare Pages で配信する。
    adapter: adapter({ fallback: 'index.html' }),
    // service worker は $lib/pwa.ts で手動登録する(更新検知と reload 制御のため)。
    serviceWorker: { register: false },
  },
};

export default config;
