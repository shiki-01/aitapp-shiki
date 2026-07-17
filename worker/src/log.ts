// 構造化ログの最小ユーティリティ（外部依存なし）。
// level + correlationId + message + 任意 fields を1行の JSON として出力する。
// correlationId でユーザー報告のエラーとサーバーログを突き合わせられる。

export type LogLevel = 'error' | 'warn' | 'info';

/**
 * 構造化ログを1行出力する。詳細（例外メッセージ等）はここにのみ出し、
 * client には返さない（内部情報の透過を防ぐ）。
 */
export function log(
  level: LogLevel,
  correlationId: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    correlationId,
    message,
    ...fields,
    time: new Date().toISOString(),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
