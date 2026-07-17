// node 環境で Web Crypto（crypto.subtle）が未定義の場合に備え、
// node:crypto の webcrypto を globalThis.crypto に割り当てる。
// Node 20+ では標準で存在するため通常は何もしない。
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  // @ts-expect-error テスト環境用の polyfill 代入
  globalThis.crypto = webcrypto;
}
