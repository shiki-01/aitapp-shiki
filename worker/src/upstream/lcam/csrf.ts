// Apache Struts CSRF トークン抽出。移植元: lcam_parse.dart lCamStrutsToken。
// node-html-parser は :nth-child / 子結合子に対応するため Dart のセレクタを直接使う。

import { type HTMLElement } from '../../html/parser';

const SELECTORS = [
  '#header > form > div > input',
  '#smartPhoneCommonContactList > form:nth-child(3) > div:nth-child(1) > input',
  '#smartPhoneClassContactList > form:nth-child(3) > div:nth-child(1) > input',
];

/** 先頭に見つかった input の value を返す。無ければ null。 */
export function extractStrutsToken(root: HTMLElement): string | null {
  for (const sel of SELECTORS) {
    const els = root.querySelectorAll(sel);
    if (els.length > 0) {
      const value = els[0].getAttribute('value');
      if (value != null) return value;
    }
  }
  return null;
}

/**
 * 指定した name の `<form>` 以降にある最初の Struts token の value を返す（汎用版）。
 * アンケート系画面はページごとに複数の form/token を持つため、固定セレクタでは
 * 狙った form を拾えない。さらに実機観測（smartPhoneClassEnqAnswer/initialize）では
 * 対象 form 内に閉じられていない `<div>` があり node-html-parser のツリーが壊れて
 * `form[name=...]` セレクタ自体がヒットしない（form 内の id/name 要素は個別に拾えるのに
 * form 要素だけ見えなくなる）。DOM セレクタに依存せず、生 HTML への正規表現で
 * `name="{formName}"` の直後に現れる TOKEN を抽出する（tbody/script 同様、壊れた
 * ページ向けの生テキストフォールバック。MIGRATION_NOTES §9, §11 参照）。
 */
export function extractStrutsTokenByForm(
  html: string,
  formName: string,
): string | null {
  const formIdx = html.indexOf(`name="${formName}"`);
  if (formIdx < 0) return null;
  const m = /org\.apache\.struts\.taglib\.html\.TOKEN"\s+value="([^"]+)"/.exec(
    html.slice(formIdx),
  );
  return m ? m[1] : null;
}
