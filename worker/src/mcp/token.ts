// ユーザー別 MCP トークン（マルチユーザー /mcp 用）。
//
// 形式: `u.<base64url(uid)>.<hex 乱数32byte>`
//   - `u.` プレフィックスでオーナー用 MCP_TOKEN（env シークレット）と判別する。
//   - uid を埋め込むことで、検証時に KV を token→uid の索引なしで 1 read
//     （`user:{uid}`）だけで引ける（要件 §6 の key 分割禁止に適合）。
//   - KV には平文トークンを置かず、SHA-256 ハッシュのみを UserState.mcpTokenHash に
//     保存する（KV が漏れてもトークンを逆算できない）。
//   - 失効: 再発行でハッシュが置き換わる／revoke で null／logout で state ごと削除。
//     即時失効の作り込みはしない（KV の結果整合性の範囲で伝播する）。

const enc = new TextEncoder();

/** ユーザー別トークンのプレフィックス。 */
const USER_TOKEN_PREFIX = 'u';

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** トークン全体の SHA-256（hex）。KV にはこの値だけを保存する。 */
export async function hashMcpToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return toHex(new Uint8Array(digest));
}

/** ユーザー別 MCP トークンを新規生成する。平文 token は発行時の応答でのみ返す。 */
export async function mintUserMcpToken(
  uid: string,
): Promise<{ token: string; hash: string }> {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const token = `${USER_TOKEN_PREFIX}.${b64urlEncode(enc.encode(uid))}.${toHex(secret)}`;
  return { token, hash: await hashMcpToken(token) };
}

/**
 * ユーザー別トークンから uid を取り出す。形式不正なら null。
 * これは「どの user state を読むか」を決めるだけで、認証ではない。
 * 認証は呼び出し側が state.mcpTokenHash と hashMcpToken(token) の一致で行う。
 */
export function parseUserMcpTokenUid(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== USER_TOKEN_PREFIX) return null;
  const uidBytes = b64urlDecode(parts[1]);
  if (!uidBytes || uidBytes.length === 0) return null;
  if (!/^[0-9a-f]{64}$/.test(parts[2])) return null;
  try {
    const uid = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(uidBytes);
    return uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

/** タイミング攻撃を避けるため、SHA-256 ダイジェスト同士を比較する。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
