import { describe, it, expect } from 'vitest';
import { parseLcamCookies, sameLcamCookies } from '../src/upstream/lcam/cookies';

describe('parseLcamCookies', () => {
  it('Cookie ヘッダ形式を受け付ける', () => {
    const r = parseLcamCookies('JSESSIONID=abc.poap2; LiveApps-Cookie=20260924093958');
    expect(r).toEqual({
      ok: true,
      cookies: { jsessionid: 'JSESSIONID=abc.poap2', liveApps: 'LiveApps-Cookie=20260924093958' },
    });
  });

  it('1 行 1 Cookie と "Cookie: " 接頭辞を受け付ける', () => {
    const r = parseLcamCookies('Cookie: JSESSIONID=abc\nLiveApps-Cookie=1');
    expect(r.ok).toBe(true);
  });

  it('DevTools の表（タブ区切り＋ヘッダ行）を受け付ける', () => {
    const table =
      'Name\tValue\tDomain\tPath\n' +
      'JSESSIONID\tabc.poap2\tlcam.aitech.ac.jp\t/portalv2\n' +
      'LiveApps-Cookie\t2026\tlcam.aitech.ac.jp\t/portalv2';
    const r = parseLcamCookies(table);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cookies.jsessionid).toBe('JSESSIONID=abc.poap2');
  });

  it('Set-Cookie の属性は無視する', () => {
    const r = parseLcamCookies('JSESSIONID=abc; path=/portalv2; HttpOnly; Secure; SameSite=None; LiveApps-Cookie=1');
    expect(r.ok).toBe(true);
  });

  it('mellon 系だけ追加 Cookie として保持する', () => {
    const r = parseLcamCookies('JSESSIONID=a; LiveApps-Cookie=b; mellon-cookie=c');
    expect(r).toEqual({
      ok: true,
      cookies: { jsessionid: 'JSESSIONID=a', liveApps: 'LiveApps-Cookie=b', extra: ['mellon-cookie=c'] },
    });
  });

  it('Microsoft 側の Cookie は拒否し、名前だけをエラーに出す（値は出さない）', () => {
    const r = parseLcamCookies('JSESSIONID=a; LiveApps-Cookie=b; ESTSAUTHPERSISTENT=secretvalue');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('ESTSAUTHPERSISTENT');
      expect(r.error).not.toContain('secretvalue');
    }
  });

  it('必須 Cookie が欠けていれば拒否', () => {
    expect(parseLcamCookies('JSESSIONID=a').ok).toBe(false);
    expect(parseLcamCookies('').ok).toBe(false);
  });

  it('ヘッダ注入になり得る値（改行・空白・引用符）は拒否', () => {
    expect(parseLcamCookies('JSESSIONID=a b; LiveApps-Cookie=1').ok).toBe(false);
    expect(parseLcamCookies('JSESSIONID="a"; LiveApps-Cookie=1').ok).toBe(false);
    expect(parseLcamCookies('JSESSIONID=a\u0000; LiveApps-Cookie=1').ok).toBe(false);
  });

  it('同名で値が違う重複は拒否、同値の重複は許容', () => {
    expect(parseLcamCookies('JSESSIONID=a; JSESSIONID=b; LiveApps-Cookie=1').ok).toBe(false);
    expect(parseLcamCookies('JSESSIONID=a; JSESSIONID=a; LiveApps-Cookie=1').ok).toBe(true);
  });
});

describe('sameLcamCookies', () => {
  const a = { jsessionid: 'J=1', liveApps: 'L=1' };
  it('同一・相違・null を判定する', () => {
    expect(sameLcamCookies(a, { ...a })).toBe(true);
    expect(sameLcamCookies(a, { ...a, jsessionid: 'J=2' })).toBe(false);
    expect(sameLcamCookies(a, { ...a, extra: ['mellon-cookie=x'] })).toBe(false);
    expect(sameLcamCookies(a, null)).toBe(false);
  });
});
