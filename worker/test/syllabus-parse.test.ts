import { describe, it, expect } from 'vitest';
import { parseSearchList } from '../src/upstream/syllabus/parse';
import { NotFoundError, UpstreamError } from '../src/upstream/errors';

// 検索一覧の 1 行（td 12 個）を組み立てる。
// extractRowTexts の索引: [3]=科目名, [5]=教員, [10]=単位区分, [11]=単位数。
function row(subject: string, teacher: string, classification: string, units: string): string {
  const cells: string[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 0) {
      // 先頭セルは詳細リンク（onclick に URL）。
      cells.push(`<td><a onclick="detail('/syllabus/detail?id=1')">link</a></td>`);
    } else if (i === 3) cells.push(`<td>${subject}</td>`);
    else if (i === 5) cells.push(`<td>${teacher}</td>`);
    else if (i === 10) cells.push(`<td>${classification}</td>`);
    else if (i === 11) cells.push(`<td>${units}</td>`);
    else cells.push('<td>x</td>');
  }
  return `<tr>${cells.join('')}</tr>`;
}

function listHtml(rows: string[]): string {
  // parseSearchList のセレクタ:
  // body > form > table:nth-child(2) > tbody > tr > td > table > tbody > tr
  // 先頭行はヘッダとしてスキップされるためダミーを 1 行足す。
  const header = row('見出し', '見出し', '見出し', '見出し');
  return `<body><form>
    <table>先頭ダミー</table>
    <table>
      <tr><td>
        <table>${header}${rows.join('')}</table>
      </td></tr>
    </table>
  </form></body>`;
}

describe('syllabus parse: 単位区分の分類', () => {
  it('選必/選択/必修/その他 を正しく分類する', () => {
    const html = listHtml([
      row('データ構造', '愛工太郎', '選必', '2'),
      row('線形代数', '愛工花子', '選択', '2'),
      row('体育', '愛工次郎', '必修', '1'),
      row('特別講義', '愛工三郎', '情報', '2'),
    ]);
    const items = parseSearchList(html);
    expect(items.map((i) => i.classification)).toEqual([
      'requiredElective',
      'choice',
      'required',
      'unknown',
    ]);
  });

  it('科目名・教員・単位数・URL を抽出する', () => {
    const items = parseSearchList(listHtml([row('データ構造', '愛工太郎', '選必', '2')]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subject: 'データ構造',
      teacher: '愛工太郎',
      unitsNumber: 2,
      classification: 'requiredElective',
      url: '/syllabus/detail?id=1',
    });
  });

  it('該当行が無く errorTag があれば NotFoundError', () => {
    const html = `<body><form>
      <table>x</table>
      <table><tr><td><table></table></td></tr></table>
      <ul id="errorTag"><li>該当なし</li></ul>
    </form></body>`;
    expect(() => parseSearchList(html)).toThrow(NotFoundError);
  });

  it('該当行も errorTag も無ければ UpstreamError', () => {
    const html = `<body><form>
      <table>x</table>
      <table><tr><td><table></table></td></tr></table>
    </form></body>`;
    expect(() => parseSearchList(html)).toThrow(UpstreamError);
  });
});
