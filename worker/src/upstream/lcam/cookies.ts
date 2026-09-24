// ユーザーが貼り付けた LCAM の Cookie 文字列のパースと検証。
// 入力形式（いずれも可）:
//   - Cookie ヘッダ形式:   JSESSIONID=xxx; LiveApps-Cookie=yyy
//   - 1 行 1 Cookie:       JSESSIONID=xxx⏎LiveApps-Cookie=yyy
//   - DevTools の Cookie 表をコピーしたタブ区切り行（先頭 2 列が Name / Value）
// 受け付けるのは JSESSIONID / LiveApps-Cookie と、mod_auth_mellon の `mellon*` のみ。
// Microsoft（Entra）側の Cookie は大学アカウント全体のセッションになるため、名前で拒否する
// （保存しない方針。MIGRATION_NOTES §14）。値はヘッダに連結するので RFC 6265 の
// cookie-octet に限定し、CR/LF 等によるヘッダ注入を防ぐ。

import type { LcamCookies } from '../../types';

export type ParseCookiesResult =
  | { ok: true; cookies: LcamCookies }
  | { ok: false; error: string };

/** Set-Cookie の属性名（貼り付けに紛れ込んでも無視する）。 */
const ATTRIBUTE_NAMES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
  'priority',
  'partitioned',
]);

/** RFC 6265 cookie-octet（空白・二重引用符・カンマ・セミコロン・バックスラッシュを除く可視 ASCII）。 */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const MAX_EXTRA = 4;
const MAX_VALUE_LENGTH = 512;

function pairsOf(input: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^cookie:\s*/i, '');
    if (!line) continue;
    if (line.includes('\t')) {
      // DevTools の表: Name<TAB>Value<TAB>Domain...
      const cols = line.split('\t');
      if ((cols[0] ?? '').trim().toLowerCase() === 'name') continue; // 表のヘッダ行
      pairs.push([(cols[0] ?? '').trim(), (cols[1] ?? '').trim()]);
      continue;
    }
    for (const token of line.split(';')) {
      const t = token.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq < 0) {
        if (ATTRIBUTE_NAMES.has(t.toLowerCase())) continue;
        pairs.push([t, '']);
        continue;
      }
      pairs.push([t.slice(0, eq).trim(), t.slice(eq + 1).trim()]);
    }
  }
  return pairs;
}

export function parseLcamCookies(input: string): ParseCookiesResult {
  let jsessionid: string | undefined;
  let liveApps: string | undefined;
  const extra = new Map<string, string>();
  const unknown: string[] = [];

  for (const [name, value] of pairsOf(input)) {
    const lower = name.toLowerCase();
    if (ATTRIBUTE_NAMES.has(lower)) continue;
    if (!COOKIE_NAME.test(name)) {
      return { ok: false, error: 'Cookie 名に使えない文字が含まれています。' };
    }
    if (!value || value.length > MAX_VALUE_LENGTH || !COOKIE_VALUE.test(value)) {
      return { ok: false, error: `Cookie「${name}」の値が空または不正です。` };
    }
    const pair = `${name}=${value}`;
    if (lower === 'jsessionid') {
      if (jsessionid && jsessionid !== pair) {
        return { ok: false, error: 'JSESSIONID が異なる値で複数あります。1 つだけ貼り付けてください。' };
      }
      jsessionid = pair;
    } else if (lower === 'liveapps-cookie') {
      if (liveApps && liveApps !== pair) {
        return { ok: false, error: 'LiveApps-Cookie が異なる値で複数あります。1 つだけ貼り付けてください。' };
      }
      liveApps = pair;
    } else if (lower.startsWith('mellon')) {
      const prev = extra.get(lower);
      if (prev && prev !== pair) {
        return { ok: false, error: `${name} が異なる値で複数あります。1 つだけ貼り付けてください。` };
      }
      extra.set(lower, pair);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `受け付けない Cookie が含まれています: ${unknown.join(', ')}。` +
        'lcam.aitech.ac.jp の JSESSIONID（あれば LiveApps-Cookie。必要なら mellon で始まるもの）だけを貼り付けてください。' +
        'Microsoft 側の Cookie は保存しません。',
    };
  }
  // 実測（MIGRATION_NOTES §14.4）: SP 画面は JSESSIONID だけで通るため、LiveApps-Cookie は任意。
  if (!jsessionid) {
    return { ok: false, error: 'JSESSIONID が必要です。' };
  }
  if (extra.size > MAX_EXTRA) {
    return { ok: false, error: `追加 Cookie は最大 ${MAX_EXTRA} 個までです。` };
  }
  const cookies: LcamCookies = { jsessionid, liveApps: liveApps ?? '' };
  if (extra.size > 0) cookies.extra = [...extra.values()];
  return { ok: true, cookies };
}

/** 2 つの Cookie 組が同一か（失効・更新時の競合ガードに使う）。 */
export function sameLcamCookies(a: LcamCookies | null | undefined, b: LcamCookies | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.jsessionid === b.jsessionid &&
    a.liveApps === b.liveApps &&
    (a.extra ?? []).join(';') === (b.extra ?? []).join(';')
  );
}
