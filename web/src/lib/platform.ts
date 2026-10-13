// ビルド時のプラットフォームフラグ（ランタイム判定ではなく、構造的な違いの分岐にのみ使う）。
//   - ブラウザ版/PWA:        VITE_PLATFORM 未設定
//   - Tauri デスクトップ版:  `vite build --mode desktop`（.env.desktop）
//   - Tauri スマホ版(iOS等): `vite build --mode mobile`（.env.mobile）
const platform = import.meta.env.VITE_PLATFORM;

/** Tauri アプリ（デスクトップ/スマホ）か。API 経路（fetch ではなく invoke 経由）や PWA 無効化の分岐に使う。 */
// ブラウザ上で desktop/mobile ビルドが配信された場合（Pages のビルド環境変数 VITE_PLATFORM の設定ミス等）に
// invoke が使えず全 API が失敗するのを避けるため、Tauri 実行環境の実在（__TAURI_INTERNALS__）も要求する。
export const isTauri =
  (platform === 'desktop' || platform === 'mobile') &&
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in window;

/** PC 用レイアウト（SideNav 等）か。スマホアプリは Tauri だが、レイアウトはスマホ用（BottomNav）。 */
export const isDesktop = platform === 'desktop';
