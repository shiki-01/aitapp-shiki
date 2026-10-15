// スクロールしている要素。モバイルはタブの <main> の内側だけをスクロールさせ（iOS の WKWebView で文書ごと
// スクロールすると、慣性・バウンスに引きずられて固定の下部ナビが上下にずれるため）、それ以外は文書。
export function scrollRoot(): Element {
  return document.querySelector('[data-scroll-root]') ?? document.scrollingElement ?? document.documentElement;
}
