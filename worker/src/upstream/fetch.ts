// 上流 fetch 共通ラッパ。全ての上流アクセスにタイムアウトを付与する。
// 上流のハング/低速応答が Workers の subrequest/CPU 上限や切断へ波及するのを防ぐ。
// タイムアウト/中断は失効（AuthFailedError/LcamExpiredError）と混同せず、必ず
// UpstreamError（502 相当）にマップする。

import { UpstreamError } from './errors';

/** 上流 fetch のデフォルトタイムアウト（ms）。通常のデータ取得（HTML/JSON）向け。 */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** ファイルダウンロード等、body ストリームが長時間になり得る呼び出し向けの延長タイムアウト（ms）。 */
export const UPSTREAM_FILE_TIMEOUT_MS = 60_000;

/**
 * エラー文・ログに出す接続先の表記。クエリは除く（Moodle のファイル取得は URL に
 * `token=` を付けるため、そのまま出すと認証用の値がログに残る）。
 */
function describeTarget(input: string | URL | Request): string {
  try {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

/**
 * fetch に AbortSignal.timeout を付与する共通ラッパ。
 * タイムアウト/中断時は UpstreamError を投げる（失効判定と分離するため）。
 * ストリーム proxy 用途では body 読み切りまで signal が生きるため、
 * ファイル取得は timeoutMs を延長して渡すこと。
 */
export async function fetchUpstream(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new UpstreamError(`upstream timeout (${timeoutMs}ms): ${describeTarget(input)}`);
    }
    throw e;
  }
}
