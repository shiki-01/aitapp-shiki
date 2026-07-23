/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// version はビルドごとに変わるため、デプロイのたびに新しいキャッシュ名になる。
const CACHE = `aitapp-${version}`;
// `_headers` 等の Cloudflare Pages 設定ファイルは配信されない(404)ため precache から除外。
const ASSETS = [...build, ...files.filter((f) => !f.startsWith('/_'))];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      // SPA fallback の shell('/')は $service-worker のリストに含まれないため個別に取得。
      // 失敗してもインストールは継続する(オフライン時の fallback が無くなるだけ)。
      await cache.add('/').catch(() => {});
      // 新バージョンを待機させず即有効化する。ページ側が controllerchange で1回 reload する。
      await sw.skipWaiting();
    })()
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // API(browser 版は別オリジンの Worker)や外部リソースには介入しない。
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // ビルド資産(ハッシュ付き)と static ファイルは cache-first。
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) void (await caches.open(CACHE)).put(request, res.clone());
        return res;
      })()
    );
    return;
  }

  // ナビゲーションは network-first。オフライン時のみキャッシュ済み shell を返す。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (err) {
          const cached = await caches.match('/');
          if (cached) return cached;
          throw err;
        }
      })()
    );
  }
});
