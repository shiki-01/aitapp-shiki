import { describe, expect, it as test } from 'vitest';
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
  test('実機形式: onclick の fileDownLoad(prefix, no, name) から組み立てる', () => {
    const html = `<a href="javascript:void(0);" onclick="fileDownLoad('classEnqFile', '1', '2026\\u5FAE\\u5206\\u7A4D\\u52062\\u8AB2\\u984C2.pdf');">2026微分積分2課題2.pdf</a>`;
    expect(parseEnqueteFiles(html)).toEqual({
      '2026微分積分2課題2.pdf': `/portalv2/common/fileUploadDownload/fileDownLoad2/${encodeURI('2026微分積分2課題2')}/?EXCLUDE_SET=&prefix=classEnqFile&no=1`,
    });
  });
  test('添付が無ければ空', () => {
    expect(parseEnqueteFiles('<a href="/x">a</a>')).toEqual({});
  });
});
