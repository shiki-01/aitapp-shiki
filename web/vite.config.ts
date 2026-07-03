import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // tauri.conf.json の devUrl (http://localhost:5173) と一致させる
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
