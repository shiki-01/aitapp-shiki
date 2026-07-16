import { defineConfig } from 'vitest/config';

// worker のユニットテスト（ネット非依存）。workerd は不要なため node 環境で動かす。
// Web Crypto は Node 20+ の globalThis.crypto で利用可能。setup で保険をかける。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
