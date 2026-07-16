// 不可逆/取り消しにくい書き込みツール共通の out-of-band 確認値ヘルパ。
//
// 確認値(confirm)はモデルに見えるツール引数ではなく、人間が MCP ホストの設定
// （stdio 実行は env `AITAPP_CONFIRM_SECRET`、`/mcp` 実行は worker の `CONFIRM_SECRET`）に
// 入れた秘密で、worker の `CONFIRM_SECRET` と一致したときだけ worker 側が実行を許可する。
// ツールはこの値を config/env から読み取って worker へ転送するだけで、LLM 由来の
// 文字列（プロンプトインジェクションで注入された指示を含む）は決して使わない。
// 未設定のときは worker を呼ばずに、人間による設定を促すエラーを返す。

import type { ToolClient } from '../tool-client';

export type ConfirmGate = { ok: true; confirm: string } | { ok: false; message: string };

export function resolveConfirm(client: ToolClient): ConfirmGate {
  const confirm = client.confirmSecret;
  if (!confirm) {
    return {
      ok: false,
      message:
        'confirm_secret_unset: この不可逆操作を実行するには、人間が事前に設定する out-of-band の' +
        '確認秘密が必要です。MCP ホストの環境変数 AITAPP_CONFIRM_SECRET（/mcp 経由の実行時は ' +
        'worker の CONFIRM_SECRET）を設定してください。この確認値はツール引数ではなく、モデルからは' +
        '参照も指定もできません（ユーザーの明示的な同意を得た上で人間が設定します）。',
    };
  }
  return { ok: true, confirm };
}
