import { describe, expect, it } from 'vitest';
import { applyInlineView } from '../src/inline-view';

const h = (cd: string | null, ct: string) => {
  const headers = new Headers({ 'content-type': ct });
  if (cd) headers.set('content-disposition', cd);
  return headers;
};

describe('applyInlineView', () => {
  it('pdf は octet-stream でも拡張子から inline にする', () => {
    const headers = h('attachment; filename="a.pdf"', 'application/octet-stream');
    expect(applyInlineView(headers)).toBe(true);
    expect(headers.get('content-type')).toBe('application/pdf');
    expect(headers.get('content-disposition')).toBe('inline; filename="a.pdf"');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('filename* の日本語ファイル名でも拡張子を読む', () => {
    const headers = h("attachment; filename*=UTF-8''%E6%99%82%E9%96%93%E5%89%B2.PNG", 'application/octet-stream');
    expect(applyInlineView(headers)).toBe(true);
    expect(headers.get('content-type')).toBe('image/png');
  });
  it('html/svg/docx は inline にしない', () => {
    for (const [cd, ct] of [
      ['attachment; filename="x.html"', 'text/html'],
      ['attachment; filename="x.svg"', 'image/svg+xml'],
      ['attachment; filename="x.docx"', 'application/octet-stream'],
    ] as const) {
      const headers = h(cd, ct);
      expect(applyInlineView(headers)).toBe(false);
      expect(headers.get('content-disposition')).toBe(cd);
    }
  });
});
