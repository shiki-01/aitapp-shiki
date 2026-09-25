// 学事システムへの自動送信フォームのページ。Worker が得た宛先（action）と loginID を、ブラウザにそのまま POST させる。
// 本人の情報（loginID）を含むため、キャッシュさせず、Referer も送らない。CSP でフォームの宛先を LCAM に限る。

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function handoffPage(action: string, loginId: string): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>学事システムへ移動します</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>` +
    `<p>学事システムへ移動します…</p>` +
    `<form id="f" method="post" action="${esc(action)}"><input type="hidden" name="loginID" value="${esc(loginId)}">` +
    `<noscript><button type="submit">学事システムを開く</button></noscript></form>` +
    `<script nonce="${nonce}">document.getElementById('f').submit();</script></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://lcam.aitech.ac.jp; base-uri 'none'`,
    },
  });
}
