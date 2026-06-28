// signed session cookie の発行/検証（要件 §7）。
// cookie 値 = base64url(payload).base64url(HMAC-SHA256(payload))
// payload = { uid, iat }。認証情報は一切含めない。

const enc = new TextEncoder();

export const SESSION_COOKIE_NAME = 'aitapp_session';

export interface SessionPayload {
  /** userId（= 愛工大 ID）。 */
  uid: string;
  /** 発行時刻（ms）。 */
  iat: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** session cookie の値（payload.signature）を生成する。 */
export async function signSession(
  secret: string,
  payload: SessionPayload,
): Promise<string> {
  const key = await hmacKey(secret);
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** session cookie を検証し、有効なら payload を返す。改竄/不正なら null。 */
export async function verifySession(
  secret: string,
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig),
      enc.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body)),
    ) as SessionPayload;
    if (typeof payload.uid !== 'string' || typeof payload.iat !== 'number') {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Set-Cookie ヘッダ値を生成する。HttpOnly; Secure; SameSite=Strict。 */
export function buildSessionCookie(value: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    // 30 日。即時失効は要件外。
    `Max-Age=${60 * 60 * 24 * 30}`,
  ].join('; ');
}

/** session cookie を破棄する Set-Cookie ヘッダ値。 */
export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

/** Cookie ヘッダから session cookie 値を取り出す。 */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}
