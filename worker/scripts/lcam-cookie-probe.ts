// 登録する Cookie が SP 画面で通るかを確認するローカル用スクリプト（読み取り専用）。
//
//   read -s LCAM_COOKIES; export LCAM_COOKIES     # 貼り付けて Enter（画面には出ない）
//   bun run scripts/lcam-cookie-probe.ts
//
// SP 時間割ページへの GET を組み合わせごとに 1 回（最大 4 リクエスト）。寿命の探査目的の
// 反復アクセスはしない。Cookie の値は出力しない。relay を使わず実行マシンから直接アクセスする。
//
// 【禁止】PC 画面（common/generalPurpose/ 等）へ GET で直接アクセスしないこと。実測（2026-09-24）で
// 「不正な操作が行われました」となりセッションが破棄される（MIGRATION_NOTES §14.4）。

import { parseLcamCookies } from '../src/upstream/lcam/cookies';
import { probeSpSession } from '../src/upstream/lcam/client';
import { LcamExpiredError } from '../src/upstream/errors';
import type { LcamCookies } from '../src/types';

const parsed = parseLcamCookies(process.env.LCAM_COOKIES ?? '');
if (!parsed.ok) {
  console.error(`LCAM_COOKIES が不正: ${parsed.error}`);
  process.exit(1);
}
const full = parsed.cookies;

const combos: Array<[string, LcamCookies]> = [
  ['JSESSIONID のみ', { jsessionid: full.jsessionid, liveApps: '' }],
  ['JSESSIONID + LiveApps-Cookie', { jsessionid: full.jsessionid, liveApps: full.liveApps }],
];
if (full.extra?.length) {
  combos.push(['JSESSIONID + LiveApps-Cookie + mellon*', full]);
}

for (const [label, cookies] of combos) {
  try {
    await probeSpSession(cookies);
    console.log(`OK    ${label}`);
  } catch (e) {
    const why = e instanceof LcamExpiredError ? `拒否（${e.message}）` : `エラー（${(e as Error).message}）`;
    console.log(`NG    ${label}: ${why}`);
  }
}
