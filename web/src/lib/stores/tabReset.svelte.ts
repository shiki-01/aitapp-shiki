// 表示中のタブのボタンをもう一度押したとき、そのタブを最初の状態へ戻すための合図。
// n は押すたびに増える。views は onTabReselect で購読する。

import type { Tab } from '$lib/tabs';

export const tabReset = $state<{ tab: Tab | undefined; n: number }>({ tab: undefined, n: 0 });

export function resetTab(tab: Tab): void {
  tabReset.tab = tab;
  tabReset.n++;
}
