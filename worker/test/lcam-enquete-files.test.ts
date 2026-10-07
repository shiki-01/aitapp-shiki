import { describe, expect, test } from 'bun:test';
import { parseEnqueteFiles } from '../src/upstream/lcam/parse';

describe('parseEnqueteFiles', () => {
  test('href / onclick の fileUploadDownload パスを拾う', () => {
    const html = `
      <a href="/portalv2/common/fileUploadDownload/fileDownLoad2/part/?EXCLUDE_SET=&amp;prefix=no1&amp;no=1">問題.pdf</a>
      <a href="#" onclick="go('/portalv2/common/fileUploadDownload/fileDownLoad/?EXCLUDE_SET=&prefix=no1&no=2')">解説</a>
      <a href="/other">無関係</a>`;
    expect(parseEnqueteFiles(html)).toEqual({
      '問題.pdf': '/portalv2/common/fileUploadDownload/fileDownLoad2/part/?EXCLUDE_SET=&prefix=no1&no=1',
      解説: '/portalv2/common/fileUploadDownload/fileDownLoad/?EXCLUDE_SET=&prefix=no1&no=2',
    });
  });
  test('添付が無ければ空', () => {
    expect(parseEnqueteFiles('<a href="/x">a</a>')).toEqual({});
  });
});
