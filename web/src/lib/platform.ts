// PC(Tauri)版とブラウザ版を判別するビルド時フラグ。
// `vite build --mode desktop`（.env.desktop）でのみ true になる。
// ウィンドウ幅などのランタイム判定ではなく、ナビゲーション様式やAPI経路
// (fetch vs invoke)のような構造的な違いの分岐にのみ使う。
export const isDesktop = import.meta.env.VITE_PLATFORM === 'desktop';
