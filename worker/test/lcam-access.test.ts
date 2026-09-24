import { describe, it, expect, vi, afterEach } from 'vitest';
import { getClassTimeTableBody, getFile } from '../src/upstream/lcam/access';
import { LcamExpiredError } from '../src/upstream/errors';

const cookies = { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b' };
const TT = 'https://lcam.aitech.ac.jp/portalv2/smartphone/smartPhoneHome/nextPage/timeTable';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

describe('LCAM リダイレクトの扱い', () => {
  it('SSO への 303 は LcamExpiredError。追従せず、Cookie を他ホストへ送らない', async () => {
    const calls = stubFetch(
      () =>
        new Response(null, {
          status: 303,
          headers: { location: '/mellon/login?ReturnTo=x&IdP=https://sts.windows.net/t/' },
        }),
    );
    await expect(getClassTimeTableBody(cookies)).rejects.toBeInstanceOf(LcamExpiredError);
    expect(calls.map((c) => c.url)).toEqual([TT]);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('同一オリジンの通常リダイレクトは追従して本文を返す', async () => {
    const calls = stubFetch((url) =>
      url === TT
        ? new Response(null, { status: 302, headers: { location: '/portalv2/other' } })
        : new Response('<html>ok</html>', { status: 200 }),
    );
    expect(await getClassTimeTableBody(cookies)).toBe('<html>ok</html>');
    expect(calls.map((c) => c.url)).toEqual([TT, 'https://lcam.aitech.ac.jp/portalv2/other']);
  });

  it('添付ファイル取得でも SSO 誘導は LcamExpiredError', async () => {
    stubFetch(
      () => new Response(null, { status: 302, headers: { location: '/mellon/login?x=1' } }),
    );
    await expect(
      getFile(cookies, '/portalv2/common/fileUploadDownload/x'),
    ).rejects.toBeInstanceOf(LcamExpiredError);
  });
});
