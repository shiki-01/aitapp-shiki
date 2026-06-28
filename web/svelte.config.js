import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA: 全ルートを index.html にフォールバック。Cloudflare Pages で配信する。
    adapter: adapter({ fallback: 'index.html' }),
  },
};

export default config;
