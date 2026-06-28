// node-html-parser のラッパ。
// node-html-parser は CSS の子結合子 `>`(先頭含む)・`:nth-child`・`.class` を
// サポートするため、Dart(universal_html) のセレクタをほぼそのまま使える。

import { parse, HTMLElement, type Node } from 'node-html-parser';

export { HTMLElement };
export type { Node };

export function parseHtml(html: string): HTMLElement {
  // script/style はデフォルトどおり「生テキスト」として扱う。ここを false に
  // すると node-html-parser がスクリプト内の `<` をタグと誤認し、DOM ツリーが
  // 壊れて body や後続テーブルを取りこぼす（時間割ページで再現）。
  return parse(html, {
    comment: false,
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
      pre: true,
    },
  });
}

/**
 * node-html-parser はブラウザと違い `<tbody>` を自動補完しない。大学の生 HTML は
 * tbody を持たないため、`tbody` を含むセレクタは tbody 無し版にフォールバックする。
 * universal_html(Dart) の自動 tbody 挿入による差異を吸収する。
 */
function stripTbody(selector: string): string {
  // `> tbody >` も先頭の `tbody >` も除去する。
  return selector.replace(/(^|>)\s*tbody\s*>/g, '$1 ');
}

/** tbody 有無の両対応版 querySelectorAll。 */
export function selAll(el: HTMLElement, selector: string): HTMLElement[] {
  const r = el.querySelectorAll(selector);
  if (r.length > 0 || !/tbody/.test(selector)) return r;
  return el.querySelectorAll(stripTbody(selector));
}

/** tbody 有無の両対応版 querySelector。 */
export function selOne(el: HTMLElement, selector: string): HTMLElement | null {
  const r = el.querySelector(selector);
  if (r || !/tbody/.test(selector)) return r;
  return el.querySelector(stripTbody(selector));
}

/**
 * テキストノード/要素いずれでもテキストを取り出す（Dart の node.text 相当）。
 * `text` は he で実体参照をデコードした値（`&nbsp;`→` ` 等）。`rawText` は
 * 未デコードの生文字列のため使わない。生だと空セルの `&nbsp;` がリテラル
 * "&nbsp;"（6文字の ASCII）として残り、trim で消えず幽霊エントリ化する。
 */
export function nodeText(n: Node): string {
  const anyNode = n as unknown as { rawText?: string; text?: string };
  return anyNode.text ?? anyNode.rawText ?? '';
}

/**
 * Dart の `text.replaceAll('\t','').trim().split('\n')` 相当。
 * タブを除去し、改行で分割し、空行を捨てたテキスト配列を返す。
 */
export function textLines(el: HTMLElement | null | undefined): string[] {
  if (!el) return [];
  const lines: string[] = [];
  for (const t of el.text.replace(/\t/g, '').trim().split('\n')) {
    const s = t.trim();
    if (s !== '') lines.push(s);
  }
  return lines;
}
