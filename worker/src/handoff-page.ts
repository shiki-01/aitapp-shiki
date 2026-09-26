// 学事システムへの自動送信フォームのページ。Worker が得た宛先（action）と loginID を、ブラウザにそのまま POST させる。
// 本人の情報（loginID）を含むため、キャッシュさせず、Referer も送らない。CSP でフォームの宛先・フレーム・遷移先を LCAM に限る。
//
// アプリ方式（lamyapp:// の key）のセッションでは、この POST は本文の無い 200 と学事システムの Cookie だけを返す
// （実測 2026-09-25。PC 画面ログインのときはメニューが返る）。そのまま開くと空白のページになるため、POST は非表示の
// iframe に向け、Cookie が入ったあとに着地先の画面へ移動する。

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** landing: 引き渡しのあとに開く学事システムの画面（`/kyoumu/…` のパス）。 */
export function handoffPage(action: string, loginId: string, landing: string): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const next = `https://lcam.aitech.ac.jp${landing}`;
  const html =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>学事システムへ移動します</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>` +
    `<p>学事システムへ移動します…</p>` +
    `<iframe name="h" hidden></iframe>` +
    `<form id="f" method="post" target="h" action="${esc(action)}"><input type="hidden" name="loginID" value="${esc(loginId)}"></form>` +
    `<p id="m" hidden><a href="${esc(next)}">移動しない場合はこちら</a></p>` +
    // 引き渡しが終わったら（iframe の load）着地先へ。応答が来ないときも 8 秒で移動する。
    `<script nonce="${nonce}">` +
    `var go=function(){location.replace(${JSON.stringify(next)})};` +
    `document.querySelector('iframe').addEventListener('load',go);setTimeout(go,8000);` +
    `document.getElementById('f').submit();</script></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://lcam.aitech.ac.jp; ` +
        `frame-src https://lcam.aitech.ac.jp; base-uri 'none'`,
    },
  });
}
