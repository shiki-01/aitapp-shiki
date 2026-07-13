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

// session cookie は worker が署名し worker の KV に紐づくため、接続先 worker ごとに
// キャッシュファイルを分ける。同一ポータルIDでも別 worker（例: 本番用 8787 と
// サンドボックス用 8788）を同時に使うと、単一ファイルでは互いの cookie を上書きし
// 不要な再ログインを招くため、workerUrl をファイル名に含めて完全に分離する。
function cacheFileFor(workerUrl: string): string {
  const scope = workerUrl.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
  return join(CACHE_DIR, `session-${scope}.json`);
}

export async function loadCachedCookie(
  portalId: string,
  workerUrl: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(cacheFileFor(workerUrl), 'utf8');
    const parsed = JSON.parse(raw) as CachedSession;
    if (parsed.portalId === portalId && parsed.cookie) return parsed.cookie;
  } catch {
    // キャッシュなし/壊れている場合は再ログインに任せる。
  }
  return undefined;
}

export async function saveCachedCookie(
  portalId: string,
  workerUrl: string,
  cookie: string,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = cacheFileFor(workerUrl);
  await writeFile(file, JSON.stringify({ portalId, cookie } satisfies CachedSession), {
    mode: 0o600,
  });
  await chmod(file, 0o600);
}
