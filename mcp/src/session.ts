// ローカルセッションキャッシュ。worker の session cookie 値だけを保存する
// （password は保存しない。password は起動時の環境変数から都度読むのみ）。
// 直列化・keep-alive・自動復旧は行わない。

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CachedSession {
  portalId: string;
  cookie: string;
}

const CACHE_DIR = join(homedir(), '.config', 'aitapp-mcp');
const CACHE_FILE = join(CACHE_DIR, 'session.json');

export async function loadCachedCookie(portalId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CachedSession;
    if (parsed.portalId === portalId && parsed.cookie) return parsed.cookie;
  } catch {
    // キャッシュなし/壊れている場合は再ログインに任せる。
  }
  return undefined;
}

export async function saveCachedCookie(portalId: string, cookie: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ portalId, cookie } satisfies CachedSession), {
    mode: 0o600,
  });
  await chmod(CACHE_FILE, 0o600);
}
