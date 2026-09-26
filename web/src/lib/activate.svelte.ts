// タブのビューは切り替えても破棄せず保持する。そのため「表示された（アクティブになった）とき」に
// 裏で取り直し、変化があったときだけ state を差し替える。

import { untrack } from 'svelte';

/**
 * isActive() が false → true になるたびに fn を呼ぶ（コンポーネント初期化時に呼ぶこと）。
 * 最初からアクティブなら、マウント直後に 1 回呼ばれる。fn 内の state 読み取りは依存に含めない。
 */
export function onActivate(isActive: () => boolean, fn: () => void): void {
  let was = false;
  $effect(() => {
    const now = isActive();
    if (now && !was) untrack(fn);
    was = now;
  });
}

/** 取得結果が現在の値と同じか（JSON で比較）。同じなら state を差し替えず、再描画を避ける。 */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
