import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
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
});
