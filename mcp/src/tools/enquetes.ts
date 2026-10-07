import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import { resolveConfirm } from './confirm';
import { downloadedFileContent } from './download-content';
import type { EnqueteList, EnqueteAnswerForm } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerEnqueteTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_list_enquetes',
    {
      title: 'LCAMアンケート一覧の取得',
      description:
        'LCAMのアンケート一覧をtypeで指定して取得する(提出状況・提出期間など)。' +
        'type=class: 授業アンケート（各授業内で回答する小規模な調査）。' +
        'type=evaluation: 授業評価アンケート（学期末に行う授業への評価）。' +
        'type=campus: 学内アンケート（全学向け、特定の授業に紐づかない調査）。' +
        '出典を指定せず単に「アンケート」と聞かれた場合は3種類とも確認し、' +
        'どのtypeの結果かを明示して提示する。',
      inputSchema: {
        type: z.enum(['class', 'evaluation', 'campus']).default('class'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ type }) => {
      const res = await client.request<EnqueteList>(`/api/enquetes?type=${type}`);
      return json(res);
    },
  );

  server.registerTool(
    'lcam_get_enquete_questions',
    {
      title: 'LCAM授業アンケートの設問を取得',
      description:
        'lcam_list_enquetesが返す授業アンケート(type=class)の設問一覧と添付された問題ファイル(files)を取得する（参照のみ、送信は行わない）。' +
        'indexはlcam_list_enquetesの結果内での0始まりの並び順。answerTypeが"text"の設問のみ' +
        'lcam_save_class_enquete_answer_draftで回答できる。',
      inputSchema: {
        index: z.number().int().min(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }) => {
      const res = await client.request<EnqueteAnswerForm>(
        `/api/enquetes/questions?index=${index}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'lcam_debug_enquete_structure',
    {
      title: 'LCAM授業アンケート画面のHTML構造要約（診断用）',
      description:
        '授業アンケートの詳細/回答画面にあるリンク・form・input の構造要約を返す（参照のみ、本文は含まない）。' +
        '添付ファイルのリンクが取得できないときの原因調査用。',
      inputSchema: { index: z.number().int().min(0) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }) => json(await client.request(`/api/enquetes/structure?index=${index}`)),
  );

  server.registerTool(
    'lcam_download_class_enquete_file',
    {
      title: 'LCAM授業アンケートの問題ファイルをダウンロード',
      description:
        'lcam_get_enquete_questionsのfilesに含まれる、授業アンケートに添付された問題ファイルを取得する（参照のみ）。' +
        'indexはlcam_get_enquete_questionsに渡したものと同じ値。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す。リモート(HTTP)実行時はファイル内容を直接返す。',
      inputSchema: {
        index: z.number().int().min(0).describe('lcam_list_enquetesの結果内での0始まりの並び順'),
        path: z.string().describe('lcam_get_enquete_questionsのfilesの値'),
        fileName: z.string().describe('lcam_get_enquete_questionsのfilesのキー（保存時のファイル名に使う）'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, path, fileName }) => {
      const res = await client.downloadApi(
        `/api/enquetes/file?index=${index}&path=${encodeURIComponent(path)}`,
        fileName,
      );
      return downloadedFileContent(res);
    },
  );

  server.registerTool(
    'lcam_save_class_enquete_answer_draft',
    {
      title: 'LCAM授業アンケートの回答を一時保存（実書き込み）',
      description:
        '【注意】これは大学のLCAMシステムに実際に回答を一時保存(tempSaveAction)する書き込み操作。' +
        '実データでの動作は確認済みだが、誤って実行すると本物の課題/アンケートに下書きが残る。' +
        'lcam_get_enquete_questionsで設問(answerType="text"のもの)を確認し、' +
        'ユーザーから明示的な同意を得た上で呼び出すこと。実行の可否は、人間が MCP ホストに設定した' +
        'out-of-band の確認秘密を worker が検証して決める（このツールに確認用の引数は無く、' +
        'モデルからは秘密を指定できない。秘密が未設定なら実行前にエラーになる）。' +
        '最終提出(確認画面を経由した提出)には未対応で、一時保存までしか行わない' +
        '(一時保存は取り消し・再保存が可能)。',
      inputSchema: {
        index: z.number().int().min(0).describe('lcam_list_enquetesの結果内での0始まりの並び順'),
        answers: z
          .record(z.string(), z.string())
          .describe('設問index(文字列、lcam_get_enquete_questionsのindexと対応)→回答文字列'),
      },
      // 一時保存は上書き・再保存が可能な可逆書き込み（最終提出ではない）。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ index, answers }) => {
      // 確認秘密は config/env（out-of-band）から取り、LLM 引数からは取らない。
      const gate = resolveConfirm(client);
      if (!gate.ok) return json({ ok: false, error: gate.message });
      const res = await client.request<{ ok: boolean }>('/api/enquetes/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, answers, confirm: gate.confirm }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'lcam_submit_class_enquete_final',
    {
      title: 'LCAM授業アンケートの最終提出（実書き込み・取り消し困難）',
      description:
        '【重要な注意】これは大学のLCAMシステムに授業アンケートの回答を本登録（最終提出）する操作。' +
        'lcam_save_class_enquete_answer_draft(一時保存)と違い、確認画面を経由した本登録であり、' +
        '取り消しには別途LCAM上での「回答取消」操作が必要になる(自動では取り消さない)。' +
        '実データで動作確認済み。' +
        '必ず: (1) lcam_get_enquete_questionsで設問を確認し、(2) 回答内容をユーザーに明示的に見せて、' +
        '(3) 「最終提出してよいか」の同意を都度得た上で呼び出すこと。' +
        'lcam_save_class_enquete_answer_draftで過去に同意を得ていても、このツールの実行には' +
        '改めて同意を得ること（一時保存と最終提出は別の同意が必要）。' +
        '実行の可否は、人間が MCP ホストに設定した out-of-band の確認秘密を worker が検証して決める' +
        '（このツールに確認用の引数は無く、モデルからは秘密を指定できない。' +
        '秘密が未設定なら実行前にエラーになる）。',
      inputSchema: {
        index: z.number().int().min(0).describe('lcam_list_enquetesの結果内での0始まりの並び順'),
        answers: z
          .record(z.string(), z.string())
          .describe('設問index(文字列、lcam_get_enquete_questionsのindexと対応)→回答文字列'),
      },
      // 本登録（最終提出）。取り消しにはLCAM上の別操作が必要で、実質的に破壊的。
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ index, answers }) => {
      // 確認秘密は config/env（out-of-band）から取り、LLM 引数からは取らない。
      const gate = resolveConfirm(client);
      if (!gate.ok) return json({ ok: false, error: gate.message });
      const res = await client.request<{ ok: boolean }>('/api/enquetes/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, answers, confirm: gate.confirm }),
      });
      return json(res);
    },
  );
}
