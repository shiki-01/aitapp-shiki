import { describe, it, expect } from 'vitest';
import { encryptCredential, decryptCredential } from '../src/crypto/aes';
import type { Credential } from '../src/types';

const SECRET = 'test-cred-key-0123456789';

const cred: Credential = {
  id: 's4200001',
  password: 'p@ssw0rd!',
  moodleOrigin: 'cms.aitech.ac.jp',
};

describe('AES-GCM credential 暗号化', () => {
  it('encrypt→decrypt で元の credential が復元される', async () => {
    const enc = await encryptCredential(SECRET, cred);
    // 暗号文のみが保持され、平文は含まれない。
    expect(enc.iv).toBeTruthy();
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.ciphertext).not.toContain(cred.password);

    const dec = await decryptCredential(SECRET, enc);
    expect(dec).toEqual(cred);
  });

  it('IV は毎回ランダムなので同じ入力でも暗号文が変わる', async () => {
    const a = await encryptCredential(SECRET, cred);
    const b = await encryptCredential(SECRET, cred);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('ciphertext/GCM タグが改竄されると復号に失敗する', async () => {
    const enc = await encryptCredential(SECRET, cred);
    // base64 ciphertext の末尾（GCM タグを含む領域）を書き換える。
    const bytes = atob(enc.ciphertext).split('');
    const last = bytes.length - 1;
    bytes[last] = bytes[last] === 'A' ? 'B' : 'A';
    const tampered = { iv: enc.iv, ciphertext: btoa(bytes.join('')) };
    await expect(decryptCredential(SECRET, tampered)).rejects.toThrow();
  });

  it('別の鍵では復号できない', async () => {
    const enc = await encryptCredential(SECRET, cred);
    await expect(decryptCredential('wrong-key', enc)).rejects.toThrow();
  });
});
