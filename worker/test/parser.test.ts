import { describe, it, expect } from 'vitest';
import { parseHtml, selAll, selOne, nodeText, textLines } from '../src/html/parser';

describe('html/parser', () => {
  describe('nbsp のデコード', () => {
    it('nodeText は &nbsp; を実体デコードして \\u00a0 にする（生の "&nbsp;" ではない）', () => {
      const root = parseHtml('<td>&nbsp;</td>');
      const td = root.querySelector('td')!;
      const t = nodeText(td.childNodes[0]);
      expect(t).toBe(' ');
      expect(t).not.toBe('&nbsp;');
    });

    it('textLines は &nbsp; のみのセルを空として捨てる（幽霊エントリ化しない）', () => {
      const root = parseHtml('<td>&nbsp;</td>');
      expect(textLines(root.querySelector('td'))).toEqual([]);
    });

    it('textLines はタブ除去・改行分割・空行除去を行う', () => {
      const root = parseHtml('<td>\t月1\n\n数学\n</td>');
      expect(textLines(root.querySelector('td'))).toEqual(['月1', '数学']);
    });
  });

  describe('tbody フォールバック', () => {
    const html = '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>';

    it('selAll は tbody 付きセレクタを tbody 無しにフォールバックして行を拾う', () => {
      const root = parseHtml(html);
      // ブラウザと違い tbody は自動補完されないため直クエリは 0 件。
      expect(root.querySelectorAll('table > tbody > tr').length).toBe(0);
      // selAll はフォールバックして 2 行取得する。
      expect(selAll(root, 'table > tbody > tr').length).toBe(2);
    });

    it('selOne も tbody 無しにフォールバックする', () => {
      const root = parseHtml(html);
      expect(root.querySelector('table > tbody > tr')).toBeNull();
      expect(selOne(root, 'table > tbody > tr')).not.toBeNull();
    });

    it('tbody を含まないセレクタはフォールバックせずそのまま', () => {
      const root = parseHtml(html);
      expect(selAll(root, 'table > tr').length).toBe(2);
    });
  });
});
