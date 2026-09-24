import { isTauri } from '$lib/platform';

/**
 * service worker の登録と自動更新。
 * デプロイを検知すると SW 側が即 activate し(skipWaiting/claim)、
 * controllerchange を受けてページを1回だけ再読み込みして新版に切り替える。
 */
export function setupPwa(): void {
  if (isTauri) return; // Tauri 版（デスクトップ/スマホ）は PWA 化しない
  if (!import.meta.env.PROD) return; // dev では SW を使わない
  if (!('serviceWorker' in navigator)) return;

  let hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 初回インストールの claim では reload しない。更新時のみ。
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });

  navigator.serviceWorker
    .register('/service-worker.js')
    .then((reg) => {
      const check = () => reg.update().catch(() => {});
      // インストール済み PWA はページ再読み込みの機会が少ないため、
      // タブ(アプリ)復帰時と1時間ごとに明示的に更新を確認する。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, 60 * 60 * 1000);
    })
    .catch(() => {
      // 登録失敗は致命的でない(通常のブラウザ表示は動く)ため無視する。
    });
}
