// 添付ファイルをブラウザ標準ビューアで開くための Content-Disposition / Content-Type 調整。
// 上流は attachment を返すためそのままだとダウンロードになる。同一オリジンで配信する
// ため、スクリプトを実行し得る型(html/svg 等)は inline にしない。安全な型のみ許可する。

const INLINE_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
};
const INLINE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

function extFromDisposition(cd: string | null): string {
  if (!cd) return '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
  if (!m) return '';
  let name = m[1];
  try {
    name = decodeURIComponent(name);
  } catch {
    // 生バイト等はそのまま拡張子だけ見る。
  }
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).trim().toLowerCase();
}

/**
 * 安全な型なら inline 表示用にヘッダを書き換える。対象外の型は何もせず false を返す
 * (従来どおりダウンロードになる)。
 */
export function applyInlineView(headers: Headers): boolean {
  const cd = headers.get('content-disposition');
  const ct = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const mime = INLINE_MIME_BY_EXT[extFromDisposition(cd)] ?? (INLINE_MIME.has(ct) ? ct : '');
  if (!mime) return false;
  headers.set('content-type', mime);
  headers.set(
    'content-disposition',
    cd ? cd.replace(/^\s*attachment/i, 'inline') : 'inline',
  );
  // 型の再推測を禁止する（許可型以外へ化けさせない）。
  headers.set('x-content-type-options', 'nosniff');
  return true;
}
