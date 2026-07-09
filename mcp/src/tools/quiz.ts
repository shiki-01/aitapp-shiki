import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
import type { MoodleQuizInfo, MoodleQuizStart } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerQuizTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'get_quiz_info',
    {
      title: 'Moodleクイズ一覧・受験可否の取得',
      description:
        '指定したcourseIdのMoodleクイズ一覧を、受験可否(canAttempt)・受験不可の理由' +
        '(preventAccessReasons)・制限時間(timeLimitSeconds)・許容試行回数(attemptsAllowed)' +
        'とともに取得する（参照のみ）。',
      inputSchema: { courseId: z.number().int() },
    },
    async ({ courseId }) => {
      const res = await client.request<{ quizzes: MoodleQuizInfo[] }>(
        `/api/moodle/quiz/info?courseId=${courseId}`,
      );
      return json(res.quizzes);
    },
  );

  server.registerTool(
    'start_quiz_attempt',
    {
      title: 'クイズ受験の開始（実書き込み・試行回数を消費）',
      description:
        '【注意】これは実際にMoodle上でクイズの新規受験(attempt)を開始する書き込み操作。' +
        '呼び出した時点で許容試行回数(attemptsAllowed)を1回消費し、取り消せない。' +
        'get_quiz_infoでcanAttemptがtrueであることを確認し、ユーザーが受験を開始する意思を' +
        '明示的に示した場合のみ呼び出すこと。成功すると設問一覧(questions、各要素にHTML)が' +
        '返るので、内容を解析してanswer_quiz_questionで回答する。',
      inputSchema: { quizId: z.number().int() },
    },
    async ({ quizId }) => {
      const res = await client.request<MoodleQuizStart>('/api/moodle/quiz/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'answer_quiz_question',
    {
      title: 'クイズ回答の一時保存（実書き込み）',
      description:
        '【注意】これは実際にMoodle上でクイズ回答を一時保存(mod_quiz_save_attempt)する書き込み操作。' +
        '本提出(finish_quiz_attempt)はしないため、何度でも上書き保存・修正できる。' +
        'attemptIdはstart_quiz_attemptが返したattempt.idを使う。answersは、' +
        'start_quiz_attemptが返した各questionのhtmlに含まれるinput/select要素のname属性を' +
        'キー、選択・入力する値を値とするオブジェクト（例: ラジオボタンなら選択肢のvalue、' +
        'テキストならその内容）。',
      inputSchema: {
        attemptId: z.number().int(),
        answers: z
          .record(z.string(), z.string())
          .describe('設問HTML中のinput/select要素のname属性 → 回答値'),
      },
    },
    async ({ attemptId, answers }) => {
      const res = await client.request<{ ok: boolean }>('/api/moodle/quiz/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, answers }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'finish_quiz_attempt',
    {
      title: 'クイズ受験の確定（実書き込み・取り消し不可）',
      description:
        '【重要な注意】これはMoodle上でクイズの受験を確定(mod_quiz_process_attempt, ' +
        'finishattempt=1)する最終操作であり、取り消し不可。事前にanswer_quiz_questionで' +
        '保存した回答が対象になる（このツール自体には回答データを渡さない）。' +
        '必ず: (1) answer_quiz_questionで全設問への回答を保存済みであることを確認し、' +
        '(2) 回答内容をユーザーに明示的に見せて、(3) 「このまま受験を確定してよいか」の' +
        '同意を得た上で、confirmに厳密に"CONFIRM_FINISH_ATTEMPT"という文字列を渡した' +
        'ときのみ実行すること。それ以外のconfirm値ではAPIを呼ばずエラーを返す。',
      inputSchema: {
        attemptId: z.number().int(),
        confirm: z
          .string()
          .describe(
            '実行するには厳密に "CONFIRM_FINISH_ATTEMPT" を渡す。取り消し不可の書き込み操作のため、' +
              'ユーザーの明示的な同意なしに渡さないこと。',
          ),
      },
    },
    async ({ attemptId, confirm }) => {
      if (confirm !== 'CONFIRM_FINISH_ATTEMPT') {
        return json({
          ok: false,
          error:
            'confirmed_required: ユーザーの明示的な同意を得た上で confirm="CONFIRM_FINISH_ATTEMPT" ' +
            'を渡してください。取り消し不可の書き込み操作のため、同意なしには実行しません。',
        });
      }
      const res = await client.request<{ state: string }>('/api/moodle/quiz/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, confirm }),
      });
      return json(res);
    },
  );
}
