import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseAppKey, exchangeAppKey, appLogin } from '../src/upstream/lcam/app-login';
import { probeSpSession } from '../src/upstream/lcam/client';
import {
  LcamAppKeyRejectedError,
  LcamAppCredentialRejectedError,
  LcamExpiredError,
  UpstreamError,
} from '../src/upstream/errors';

// appLogin 内の SP 時間割確認は実 HTML を要するため差し替える（ここでは呼ばれ方だけ見る）。
vi.mock('../src/upstream/lcam/client', () => ({ probeSpSession: vi.fn() }));

describe('parseAppKey', () => {
  it('lamyapp://lcam?key=... の形式を受け付ける', () => {
    const url = 'lamyapp://lcam?key=test123abc';
    expect(parseAppKey(url)).toBe('test123abc');
  });

  it('key の値だけを受け付ける（印字可能 ASCII）', () => {
    expect(parseAppKey('test123')).toBe('test123');
    expect(parseAppKey('!@#$%^&*()')).toBe('!@#$%^&*()');
  });

  it('前後の空白を trim して受け付ける', () => {
    expect(parseAppKey('  test123  ')).toBe('test123');
    expect(parseAppKey('  lamyapp://lcam?key=abc  ')).toBe('abc');
  });

  it('URL の searchParams をデコードして返す', () => {
    const encoded = 'lamyapp://lcam?key=' + encodeURIComponent('test with space');
    expect(parseAppKey(encoded)).toBe('test with space');
  });

  it('空文字は null', () => {
    expect(parseAppKey('')).toBeNull();
    expect(parseAppKey('   ')).toBeNull();
  });

  it('2048 文字超は null', () => {
    const long = 'a'.repeat(2049);
    expect(parseAppKey(long)).toBeNull();
  });

  it('URL フォーマットが不正なら null', () => {
    expect(parseAppKey('lamyapp://lcam')).toBeNull(); // key なし
  });

  it('1 文字は有効', () => {
    expect(parseAppKey('a')).toBe('a');
  });

  it('512 文字は有効', () => {
    const max = 'a'.repeat(512);
    expect(parseAppKey(max)).toBe(max);
  });

  it('513 文字は null', () => {
    const tooLong = 'a'.repeat(513);
    expect(parseAppKey(tooLong)).toBeNull();
  });
});

type Call = { url: string; init: RequestInit };

/** URL ごとの応答を返す fetch モック。呼び出しは calls に記録する。 */
function stubFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(probeSpSession).mockReset();
});

describe('exchangeAppKey', () => {
  it('key を userId、空の password として spAppLogin へ POST し、資格情報を返す', async () => {
    const calls = stubFetch(() => json({ status: 'success', userId: 'u1', password: 'p1', role: 1 }));
    await expect(exchangeAppKey('KEY')).resolves.toEqual({ userId: 'u1', password: 'p1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://lcam.aitech.ac.jp/portalv2/login/login/spAppLogin/');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('userId')).toBe('KEY');
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('password')).toBe('');
  });

  it('status が success 以外なら LcamAppKeyRejectedError', async () => {
    stubFetch(() => json({ status: 'fail' }));
    await expect(exchangeAppKey('KEY')).rejects.toBeInstanceOf(LcamAppKeyRejectedError);
  });

  it('JSON でない応答は LcamAppKeyRejectedError', async () => {
    stubFetch(() => new Response('<html></html>', { status: 200 }));
    await expect(exchangeAppKey('KEY')).rejects.toBeInstanceOf(LcamAppKeyRejectedError);
  });

  it('success でも userId / password が空なら LcamAppKeyRejectedError', async () => {
    stubFetch(() => json({ status: 'success', userId: 'u1', password: '' }));
    await expect(exchangeAppKey('KEY')).rejects.toBeInstanceOf(LcamAppKeyRejectedError);
  });

  it('stop_login（ログイン制限）は資格情報の拒否ではなく UpstreamError', async () => {
    stubFetch(() => json({ status: 'stop_login' }));
    await expect(exchangeAppKey('KEY')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('エラー文言に key を含めない', async () => {
    stubFetch(() => json({ status: 'fail' }));
    const e = await exchangeAppKey('SECRET-KEY-VALUE').catch((x: Error) => x);
    expect((e as Error).message).not.toContain('SECRET-KEY-VALUE');
  });
});

describe('appLogin', () => {
  const cred = { userId: 'u1', password: 'p1' };

  function spResponse(cookies: string[]): Response {
    const h = new Headers();
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response('<html>sp</html>', { status: 200, headers: h });
  }

  function loginFlow(loginBody: Response, cookies = [
    'JSESSIONID=js1; path=/portalv2; HttpOnly; Secure',
    'LiveApps-Cookie=la1; path=/portalv2; HttpOnly; Secure',
  ]): Call[] {
    return stubFetch(({ url }) =>
      url.endsWith('/portalv2/sp') ? spResponse(cookies) : loginBody,
    );
  }

  beforeEach(() => {
    vi.mocked(probeSpSession).mockResolvedValue(undefined);
  });

  it('GET /portalv2/sp → POST smartPhoneLogin/ の順で、アプリ用のヘッダと body を送る', async () => {
    const calls = loginFlow(new Response('<html>home</html>', { status: 200 }));
    await appLogin(cred);
    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /portalv2/sp',
      'POST /portalv2/login/login/smartPhoneLogin/',
    ]);
    const post = calls[1]!;
    const headers = post.init.headers as Record<string, string>;
    expect(headers.Cookie).toBe('JSESSIONID=js1; LiveApps-Cookie=la1; L-CamApp=Y');
    expect(headers.Referer).toBe('https://lcam.aitech.ac.jp/portalv2/sp');
    const body = new URLSearchParams(String(post.init.body));
    expect(Object.fromEntries(body)).toMatchObject({
      userID: 'u1',
      password: 'p1',
      mode: 'sp',
      spAppFlag: '1',
      lCamApp: 'Y',
    });
  });

  it('GET で得た JSESSIONID をそのまま返す（POST 後の rotate は無い）。L-CamApp=Y を extra に含める', async () => {
    loginFlow(new Response('<html>home</html>', { status: 200 }));
    const cookies = await appLogin(cred);
    expect(cookies).toEqual({
      jsessionid: 'JSESSIONID=js1',
      liveApps: 'LiveApps-Cookie=la1',
      extra: ['L-CamApp=Y'],
    });
    expect(probeSpSession).toHaveBeenCalledWith(cookies);
  });

  it('LiveApps-Cookie が無くても動く', async () => {
    loginFlow(new Response('<html>home</html>', { status: 200 }), ['JSESSIONID=js1; path=/portalv2']);
    const cookies = await appLogin(cred);
    expect(cookies.liveApps).toBe('');
  });

  it('JSESSIONID が発行されなければ LcamAppCredentialRejectedError', async () => {
    loginFlow(new Response('<html>home</html>', { status: 200 }), []);
    await expect(appLogin(cred)).rejects.toBeInstanceOf(LcamAppCredentialRejectedError);
  });

  it('status=fail の JSON は LcamAppCredentialRejectedError', async () => {
    loginFlow(json({ status: 'fail' }));
    await expect(appLogin(cred)).rejects.toBeInstanceOf(LcamAppCredentialRejectedError);
  });

  it('status=stop_login の JSON は UpstreamError（資格情報は捨てない）', async () => {
    loginFlow(json({ status: 'stop_login' }));
    const e = await appLogin(cred).catch((x: Error) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e).not.toBeInstanceOf(LcamAppCredentialRejectedError);
  });

  it('ログイン後の SP 時間割確認で失効なら、資格情報の拒否ではなく UpstreamError（並行の再ログインとの競合でも起きるため）', async () => {
    loginFlow(new Response('<html>home</html>', { status: 200 }));
    vi.mocked(probeSpSession).mockRejectedValue(new LcamExpiredError());
    const e = await appLogin(cred).catch((x) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e).not.toBeInstanceOf(LcamAppCredentialRejectedError);
  });

  it('確認中のその他のエラーはそのまま伝播する', async () => {
    loginFlow(new Response('<html>home</html>', { status: 200 }));
    vi.mocked(probeSpSession).mockRejectedValue(new UpstreamError('boom'));
    await expect(appLogin(cred)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('エラー文言に password を含めない', async () => {
    loginFlow(json({ status: 'fail' }));
    const e = await appLogin({ userId: 'u1', password: 'SECRET-PASSWORD' }).catch((x: Error) => x);
    expect((e as Error).message).not.toContain('SECRET-PASSWORD');
  });
});
