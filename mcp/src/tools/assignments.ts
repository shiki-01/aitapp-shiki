import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import { resolveConfirm } from './confirm';
import type { Assignment, AssignmentStatusResponse } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function registerAssignmentTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'moodle_list_assignments',
    {
      title: 'Moodle課題一覧の取得',
      description:
        'Moodle上の未提出/提出済みを問わず全課題を締切等の情報とともに取得する。' +
        'LCAMの授業連絡(lcam_list_notices type=class)にも「課題」として告知が載ることがあり、' +
        'それはこれとは別システム。' +
        '出典を指定せず単に「課題」と聞かれた場合は、こちらとlcam_list_notices(type=class)の' +
        '両方を確認し、どちらの結果かを明示して両方提示する。' +
        '「Moodleの」等と出典を指定された場合はこちらのみを使う。',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const res = await client.request<{ assignments: Assignment[] }>('/api/assignments');
      return json(res.assignments);
    },
  );

  server.registerTool(
    'moodle_get_assignment_submission_status',
    {
      title: 'Moodle課題の提出状況・締切の確認',
      description:
        'Moodle課題(mod_assign)が提出済みかどうかを締切とともに確認する（参照のみ）。' +
        '「未提出の課題があるか」「今日・今週締切の課題はどれか」の確認・定期チェックにはこれを使う。' +
        'テスト（小テスト・クイズ、mod_quiz）は課題とは別物でここには含まれないため、' +
        'テストの受験状況はmoodle_get_quiz_submission_statusで確認する' +
        '（未提出物の総点検では両方呼ぶ）。' +
        'submissionStatusは submitted(提出済) / new(未提出) / draft(下書きのみ・本提出はまだ) / ' +
        'reopened(再提出要求)。締切は dueDate、cutoffDate(提出受付終了)があればそちらが最終期限。' +
        'stateは課題の分類: submitted(提出済) / upcoming(提出受付開始前＝まだ提出できない、openDateが開始日時) / ' +
        'open(受付中の未提出) / closed(締切超過の未提出)。stateパラメータで絞り込める（指定時は締切超過済みも対象）。' +
        'Moodleの仕様上、教員が非表示にした課題は学生には返らず、upcomingは受付開始日が未来のものを指す。' +
        'デフォルトでは締切超過済みの課題は含まれない（includePastDue=trueまたはstate指定で含める）。' +
        '対象課題が多いと statusIncluded=false で提出状況がnullのまま返るので、その場合は ' +
        'courseId / nameFilter / dueWithinDays / assignmentId で絞り込んで再取得する。',
      inputSchema: {
        assignmentId: z
          .number()
          .int()
          .optional()
          .describe('特定課題のID（moodle_list_assignmentsが返すid）で絞り込む'),
        courseId: z.number().int().optional().describe('コースIDで絞り込む'),
        nameFilter: z
          .string()
          .optional()
          .describe('課題名の部分一致で絞り込む（大文字小文字を区別しない）'),
        dueWithinDays: z
          .number()
          .int()
          .optional()
          .describe('締切(dueDate)が今からN日以内の課題のみ（締切なしの課題は除外される）'),
        state: z
          .array(z.enum(['submitted', 'upcoming', 'open', 'closed']))
          .optional()
          .describe('分類で絞り込む（複数指定可）。例: ["open","upcoming"]、["closed"]'),
        includePastDue: z
          .boolean()
          .optional()
          .describe('trueで締切超過済みの課題も含める（デフォルトfalse）'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ assignmentId, courseId, nameFilter, dueWithinDays, includePastDue, state }) => {
      const params = new URLSearchParams();
      if (assignmentId !== undefined) params.set('assignmentId', String(assignmentId));
      if (courseId !== undefined) params.set('courseId', String(courseId));
      if (nameFilter !== undefined) params.set('nameFilter', nameFilter);
      if (dueWithinDays !== undefined) params.set('dueWithinDays', String(dueWithinDays));
      if (includePastDue) params.set('includePastDue', '1');
      if (state?.length) params.set('state', state.join(','));
      const qs = params.toString();
      const res = await client.request<AssignmentStatusResponse>(
        `/api/moodle/assignment/status${qs ? `?${qs}` : ''}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'moodle_save_assignment_draft',
    {
      title: 'Moodle課題のテキスト下書き保存（実書き込み）',
      description:
        '【注意】これは実際にMoodle上で課題のオンラインテキスト提出を下書き保存' +
        '(mod_assign_save_submission、ファイル指定なし)する書き込み操作。' +
        '本提出(moodle_submit_assignment)はしないため、何度でも上書き保存・修正できるが、' +
        'submissiondrafts=0 の課題では下書き段階が無く、この保存が即時の本提出扱いになりうる。' +
        'assignmentIdはmoodle_list_assignmentsが返すidを使う。' +
        'ユーザーの明示的な同意を得た上で呼び出すこと。実行の可否は、人間が MCP ホストに設定した' +
        'out-of-band の確認秘密を worker が検証して決める（このツールに確認用の引数は無く、' +
        'モデルからは秘密を指定できない。秘密が未設定なら実行前にエラーになる）。',
      inputSchema: {
        assignmentId: z.number().int(),
        text: z.string().describe('提出するテキスト本文'),
      },
      // 「下書き」だが submissiondrafts=0 の課題では即時の本提出扱いになりうる(issue #9)ため destructive 扱い。
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ assignmentId, text }) => {
      // 確認秘密は config/env（out-of-band）から取り、LLM 引数からは取らない。
      const gate = resolveConfirm(client);
      if (!gate.ok) return json({ ok: false, error: gate.message });
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId, text, confirm: gate.confirm }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'moodle_upload_assignment_file',
    {
      title: 'Moodle課題へのファイル添付（実書き込み）',
      description:
        '【注意】これは実際にMoodle上で課題のファイル提出用draft areaにファイルを' +
        'アップロードし、提出物として紐付ける(mod_assign_save_submission)書き込み操作。' +
        '本提出(moodle_submit_assignment)はしないため、再度呼び出せばファイルを差し替えられるが、' +
        'submissiondrafts=0 の課題では下書き段階が無く、このアップロードが即時の本提出扱いになりうる。' +
        'ユーザーの明示的な同意を得た上で呼び出すこと。実行の可否は、人間が MCP ホストに設定した' +
        'out-of-band の確認秘密を worker が検証して決める（このツールに確認用の引数は無く、' +
        'モデルからは秘密を指定できない。秘密が未設定なら実行前にエラーになる）。' +
        'ローカル(stdio)実行時はfilePath(MCPサーバーが動作しているマシン上のパス)を使う。' +
        'リモート(HTTP)実行時はfilePathは使えないため、fileBase64とfileNameで内容を直接渡す。' +
        `usermaxuploadfilesize(約128MB)を超えるファイルはアップロードできない。`,
      inputSchema: {
        assignmentId: z.number().int(),
        filePath: z
          .string()
          .optional()
          .describe('アップロードするローカルファイルの絶対パス（ローカル実行時のみ）'),
        fileBase64: z
          .string()
          .optional()
          .describe('ファイル内容のbase64（filePathが使えないリモート実行時に使う）'),
        fileName: z.string().optional().describe('fileBase64使用時のファイル名（拡張子を含める）'),
      },
      // アップロードだが submissiondrafts=0 の課題では即時の本提出扱いになりうる(issue #9)ため destructive 扱い。
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ assignmentId, filePath, fileBase64, fileName }) => {
      // 確認秘密は config/env（out-of-band）から取り、LLM 引数からは取らない。
      const gate = resolveConfirm(client);
      if (!gate.ok) return json({ ok: false, error: gate.message });
      let bytes: Uint8Array;
      let name: string;
      if (filePath) {
        if (!client.readLocalFile) {
          return json({
            ok: false,
            error:
              'unsupported: リモート(HTTP)実行ではfilePathを読めません。' +
              'fileBase64とfileNameでファイル内容を直接渡してください。',
          });
        }
        ({ bytes, name } = await client.readLocalFile(filePath));
      } else if (fileBase64 && fileName) {
        bytes = fromBase64(fileBase64);
        name = fileName;
      } else {
        return json({
          ok: false,
          error: 'filePath か、fileBase64+fileName のどちらかを指定してください。',
        });
      }
      const form = new FormData();
      form.append('assignmentId', String(assignmentId));
      form.append('confirm', gate.confirm);
      // Uint8Array の generics(ArrayBufferLike)が BlobPart と合わないため ArrayBuffer に切り出す。
      const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.append('file', new Blob([part]), name);
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/upload', {
        method: 'POST',
        body: form,
      });
      return json(res);
    },
  );

  server.registerTool(
    'moodle_submit_assignment',
    {
      title: 'Moodle課題の最終提出（実書き込み・取り消し不可）',
      description:
        '【重要な注意】これはMoodle上で課題を採点対象として最終提出する' +
        '(mod_assign_submit_for_grading)操作であり、取り消し不可。' +
        '事前にmoodle_save_assignment_draft / moodle_upload_assignment_fileで保存した内容が対象になる' +
        '（このツール自体には提出内容を渡さない）。' +
        '必ず: (1) 提出内容を保存済みであることを確認し、(2) 内容をユーザーに明示的に見せて、' +
        '(3) 「このまま最終提出してよいか」の同意を得た上で呼び出すこと。実行の可否は、' +
        '人間が MCP ホストに設定した out-of-band の確認秘密を worker が検証して決める' +
        '（このツールに確認用の引数は無く、モデルからは秘密を指定できない。' +
        '秘密が未設定なら実行前にエラーになる）。',
      inputSchema: {
        assignmentId: z.number().int(),
      },
      // 採点対象としての最終提出。取り消し不可。
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ assignmentId }) => {
      // 確認秘密は config/env（out-of-band）から取り、LLM 引数からは取らない。
      const gate = resolveConfirm(client);
      if (!gate.ok) return json({ ok: false, error: gate.message });
      const res = await client.request<{ warnings: unknown[] }>('/api/moodle/assignment/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId, confirm: gate.confirm }),
      });
      return json(res);
    },
  );
}
