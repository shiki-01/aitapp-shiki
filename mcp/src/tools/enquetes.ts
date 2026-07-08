import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
import type { EnqueteList, EnqueteAnswerForm } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerEnqueteTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'list_enquetes',
    {
      title: 'アンケート一覧の取得',
      description:
        'LCAMの授業アンケート(class)/授業評価アンケート(evaluation)/学内アンケート(campus)の' +
        '一覧(提出状況・提出期間など)を取得する。',
      inputSchema: {
        type: z.enum(['class', 'evaluation', 'campus']).default('class'),
      },
    },
    async ({ type }) => {
      const res = await client.request<EnqueteList>(`/api/enquetes?type=${type}`);
      return json(res);
    },
  );

  server.registerTool(
    'get_enquete_questions',
    {
      title: '授業アンケートの設問を取得',
      description:
        'list_enquetesが返す授業アンケート(type=class)の設問一覧を取得する（参照のみ、送信は行わない）。' +
        'indexはlist_enquetesの結果内での0始まりの並び順。answerTypeが"text"の設問のみ' +
        'save_class_enquete_answer_draftで回答できる。',
      inputSchema: {
        index: z.number().int().min(0),
      },
    },
    async ({ index }) => {
      const res = await client.request<EnqueteAnswerForm>(
        `/api/enquetes/questions?index=${index}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'save_class_enquete_answer_draft',
    {
      title: '授業アンケートの回答を一時保存（実書き込み）',
      description:
        '【注意】これは大学のLCAMシステムに実際に回答を一時保存(tempSaveAction)する書き込み操作。' +
        '実データでの動作は確認済みだが、誤って実行すると本物の課題/アンケートに下書きが残る。' +
        'get_enquete_questionsで設問(answerType="text"のもの)を確認し、' +
        'ユーザーから明示的な同意を得てから、confirmに厳密に"CONFIRM_SUBMIT"という文字列を' +
        '渡したときのみ実行される。それ以外の値ではAPIを呼ばずエラーを返す。' +
        '最終提出(確認画面を経由した提出)には未対応で、一時保存までしか行わない' +
        '(一時保存は取り消し・再保存が可能)。',
      inputSchema: {
        index: z.number().int().min(0).describe('list_enquetesの結果内での0始まりの並び順'),
        answers: z
          .record(z.string(), z.string())
          .describe('設問index(文字列、get_enquete_questionsのindexと対応)→回答文字列'),
        confirm: z
          .string()
          .describe('実行するには厳密に "CONFIRM_SUBMIT" を渡す。ユーザーの明示的な同意なしに渡さないこと。'),
      },
    },
    async ({ index, answers, confirm }) => {
      if (confirm !== 'CONFIRM_SUBMIT') {
        return json({
          ok: false,
          error:
            'confirmed_required: ユーザーの明示的な同意を得た上で confirm="CONFIRM_SUBMIT" を渡してください。' +
            '未検証の書き込み操作のため、同意なしには実行しません。',
        });
      }
      const res = await client.request<{ ok: boolean }>('/api/enquetes/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, answers }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'submit_class_enquete_final',
    {
      title: '授業アンケートの最終提出（実書き込み・取り消し困難）',
      description:
        '【重要な注意】これは大学のLCAMシステムに授業アンケートの回答を本登録（最終提出）する操作。' +
        'save_class_enquete_answer_draft(一時保存)と違い、確認画面を経由した本登録であり、' +
        '取り消しには別途LCAM上での「回答取消」操作が必要になる(自動では取り消さない)。' +
        '実データで動作確認済み。' +
        '必ず: (1) get_enquete_questionsで設問を確認し、(2) 回答内容をユーザーに明示的に見せて、' +
        '(3) 「最終提出してよいか」の同意を都度得た上で、confirmに厳密に' +
        '"CONFIRM_FINAL_SUBMIT"という文字列を渡したときのみ実行すること。' +
        'save_class_enquete_answer_draftで過去に同意を得ていても、このツールの実行には' +
        '改めて同意を得ること（一時保存と最終提出は別の同意が必要）。' +
        'それ以外のconfirm値ではAPIを呼ばずエラーを返す。',
      inputSchema: {
        index: z.number().int().min(0).describe('list_enquetesの結果内での0始まりの並び順'),
        answers: z
          .record(z.string(), z.string())
          .describe('設問index(文字列、get_enquete_questionsのindexと対応)→回答文字列'),
        confirm: z
          .string()
          .describe(
            '実行するには厳密に "CONFIRM_FINAL_SUBMIT" を渡す。' +
              'save_class_enquete_answer_draftのCONFIRM_SUBMITとは別物であり、' +
              'このツール専用に改めてユーザーの明示的な同意を得てから渡すこと。',
          ),
      },
    },
    async ({ index, answers, confirm }) => {
      if (confirm !== 'CONFIRM_FINAL_SUBMIT') {
        return json({
          ok: false,
          error:
            'confirmed_required: ユーザーから最終提出について改めて明示的な同意を得た上で ' +
            'confirm="CONFIRM_FINAL_SUBMIT" を渡してください。取り消しが難しい書き込み操作のため、' +
            '同意なしには実行しません。',
        });
      }
      const res = await client.request<{ ok: boolean }>('/api/enquetes/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, answers, confirm }),
      });
      return json(res);
    },
  );
}
