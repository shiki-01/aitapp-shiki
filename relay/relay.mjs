// LCAM 専用の透過フォワード relay。
//
// 目的: LCAM (lcam.aitech.ac.jp) の WAF (Zenedge) は Cloudflare の egress IP を拒否する
// （MIGRATION_NOTES §13.1）。非 Cloudflare の固定 IP（Oracle Cloud Always Free VM）から
// この relay を通すことで LCAM へ到達させる。Worker → relay → LCAM の 1 ホップだけを担う。
//
// 設計方針:
//   - ダムな中継。CSRF/Cookie 取り回し・失効検知・再ログインは Worker 側に残す。
//   - Cookie / Origin / Referer / Sec-Fetch-* はブラウザが送れない「禁止ヘッダ」だが、
//     Worker(CF) はこれらを送れる。relay も同様に LCAM へ素通しする必要があるため、
//     仕様 fetch() ではなく node:https（ヘッダ検閲なし・verbatim 送出）で転送する。
//   - 依存ゼロ（Node 標準モジュールのみ）。npm install 不要。
//
// 環境変数:
//   RELAY_TOKEN  必須。Worker が Authorization: Bearer で送る共有トークン。
//   PORT         省略時 8090。127.0.0.1 側に公開し cloudflared 経由で受ける。
//
// 認証・制限:
//   - Authorization: Bearer <RELAY_TOKEN> 一致（定数時間比較）。不一致は 401。
//   - X-Aitapp-Target は https://lcam.aitech.ac.jp/ 前置のみ許可。外れたら 403。
//   - GET / POST のみ。その他は 405。
//   - body はログに残さない（ログイン POST に平文資格情報が通るため）。

import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.RELAY_TOKEN;
const PORT = Number(process.env.PORT ?? 8090);
const TARGET_PREFIX = 'https://lcam.aitech.ac.jp/';
const UPSTREAM_TIMEOUT_MS = 60_000;

if (!TOKEN) {
  console.error('RELAY_TOKEN is required');
  process.exit(1);
}

// Worker → relay へ渡ってくる制御ヘッダと、転送時に外すべきヘッダ。
const STRIP_REQUEST_HEADERS = new Set([
  'host', // 転送先は target の host を node:https が自動設定する
  'authorization', // relay 認証用。LCAM へは送らない
  'x-aitapp-target', // 宛先指定用
  'accept-encoding', // 圧縮は要求しない（identity で受けて素通し。§2）
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'cf-connecting-ip', // CF トンネル由来の内部ヘッダは剥がす
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

// LCAM → Worker へ返す際に外す hop-by-hop ヘッダ（node が再計算/管理する）。
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-connection',
]);

function bearerOk(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(TOKEN);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';

  if (method !== 'GET' && method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  if (!bearerOk(req.headers['authorization'])) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const target = req.headers['x-aitapp-target'];
  if (typeof target !== 'string' || !target.startsWith(TARGET_PREFIX)) {
    res.writeHead(403).end('forbidden target');
    return;
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(400).end('bad target');
    return;
  }

  // 転送ヘッダを組み立て（制御ヘッダを除く全ヘッダを verbatim で渡す）。
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (v !== undefined) headers[k] = v;
  }

  const upstream = https.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (up) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        outHeaders[k] = v; // set-cookie は配列のまま渡せば複数ヘッダで出力される
      }
      res.writeHead(up.statusCode ?? 502, outHeaders);
      up.pipe(res);
      console.log(`${method} ${url.pathname} -> ${up.statusCode}`);
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
    console.error(`upstream error: ${e.message}`);
  });

  // 受信 body を上流へストリーム（GET は即 end）。
  req.pipe(upstream);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`lcam relay listening on :${PORT}`);
});
