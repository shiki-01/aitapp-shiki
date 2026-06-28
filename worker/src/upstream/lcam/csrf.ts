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
