import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
import type { Assignment } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAssignmentTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'list_assignments',
    {
      title: 'Moodle課題一覧の取得',
      description:
        'Moodle上の未提出/提出済みを問わず全課題を締切等の情報とともに取得する。' +
        'LCAMの授業連絡(list_notices type=class)にも「課題」として告知が載ることがあり、' +
        'それはこれとは別システム。' +
        '出典を指定せず単に「課題」と聞かれた場合は、こちらとlist_notices(type=class)の' +
        '両方を確認し、どちらの結果かを明示して両方提示する。' +
        '「Moodleの」等と出典を指定された場合はこちらのみを使う。',
    },
    async () => {
      const res = await client.request<{ assignments: Assignment[] }>('/api/assignments');
      return json(res.assignments);
    },
  );

  server.registerTool(
    'save_assignment_draft',
    {
      title: 'Moodle課題のテキスト下書き保存（実書き込み）',
      description:
        '【注意】これは実際にMoodle上で課題のオンラインテキスト提出を下書き保存' +
        '(mod_assign_save_submission、ファイル指定なし)する書き込み操作。' +
        '本提出(submit_assignment)はしないため、何度でも上書き保存・修正できる。' +
        'assignmentIdはlist_assignmentsが返すidを使う。',
      inputSchema: {
        assignmentId: z.number().int(),
        text: z.string().describe('提出するテキスト本文'),
      },
    },
    async ({ assignmentId, text }) => {
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId, text }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'upload_assignment_file',
    {
      title: 'Moodle課題へのファイル添付（実書き込み）',
      description:
        '【注意】これは実際にMoodle上で課題のファイル提出用draft areaにファイルを' +
        'アップロードし、提出物として紐付ける(mod_assign_save_submission)書き込み操作。' +
        '本提出(submit_assignment)はしないため、再度呼び出せばファイルを差し替えられる。' +
        'filePathはこのMCPサーバーが動作しているマシン上のローカルファイルパス。' +
        `usermaxuploadfilesize(約128MB)を超えるファイルはアップロードできない。`,
      inputSchema: {
        assignmentId: z.number().int(),
        filePath: z.string().describe('アップロードするローカルファイルの絶対パス'),
      },
    },
    async ({ assignmentId, filePath }) => {
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append('assignmentId', String(assignmentId));
      form.append('file', new Blob([bytes]), basename(filePath));
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/upload', {
        method: 'POST',
        body: form,
      });
      return json(res);
    },
  );

  server.registerTool(
    'submit_assignment',
    {
      title: 'Moodle課題の最終提出（実書き込み・取り消し不可）',
      description:
        '【重要な注意】これはMoodle上で課題を採点対象として最終提出する' +
        '(mod_assign_submit_for_grading)操作であり、取り消し不可。' +
        '事前にsave_assignment_draft / upload_assignment_fileで保存した内容が対象になる' +
        '（このツール自体には提出内容を渡さない）。' +
        '必ず: (1) 提出内容を保存済みであることを確認し、(2) 内容をユーザーに明示的に見せて、' +
        '(3) 「このまま最終提出してよいか」の同意を得た上で、confirmに厳密に' +
        '"CONFIRM_SUBMIT_ASSIGNMENT"という文字列を渡したときのみ実行すること。' +
        'それ以外のconfirm値ではAPIを呼ばずエラーを返す。',
      inputSchema: {
        assignmentId: z.number().int(),
        confirm: z
          .string()
          .describe(
            '実行するには厳密に "CONFIRM_SUBMIT_ASSIGNMENT" を渡す。取り消し不可の書き込み操作のため、' +
              'ユーザーの明示的な同意なしに渡さないこと。',
          ),
      },
    },
    async ({ assignmentId, confirm }) => {
      if (confirm !== 'CONFIRM_SUBMIT_ASSIGNMENT') {
        return json({
          ok: false,
          error:
            'confirmed_required: ユーザーの明示的な同意を得た上で confirm="CONFIRM_SUBMIT_ASSIGNMENT" ' +
            'を渡してください。取り消し不可の書き込み操作のため、同意なしには実行しません。',
        });
      }
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId, confirm }),
      });
      return json(res);
    },
  );
}
