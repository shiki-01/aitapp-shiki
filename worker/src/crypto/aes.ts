// AES-GCM による credential の暗号化/復号。
// 鍵は env.CRED_KEY を SHA-256 で 32byte に正規化して使う。
// KV には暗号文のみを置く（要件 §6 / §13）。

import type { Credential, Encrypted } from '../types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** 任意の型を JSON に暗号化する。IV は毎回ランダム生成。 */
export async function encryptJson<T>(
  secret: string,
  value: T,
): Promise<Encrypted> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ct)),
  };
}

/** 暗号文から JSON を復号する。 */
export async function decryptJson<T>(
  secret: string,
  payload: Encrypted,
): Promise<T> {
  const key = await deriveKey(secret);
  const iv = fromBase64(payload.iv);
  const ct = fromBase64(payload.ciphertext);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt)) as T;
}

/** 認証情報を暗号化する。IV は毎回ランダム生成。 */
export async function encryptCredential(
  secret: string,
  cred: Credential,
): Promise<Encrypted> {
  return encryptJson(secret, cred);
}

/** 暗号文を復号する。復号は再ログインの瞬間のみ呼ぶ。 */
export async function decryptCredential(
  secret: string,
  payload: Encrypted,
): Promise<Credential> {
  return decryptJson(secret, payload);
}
