import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type {
  MoodleQuizAttemptResult,
  MoodleQuizInfoResponse,
  MoodleQuizQuestionHtml,
  MoodleQuizStart,
  QuizStatusResponse,
} from '../types';
import { CONFIRM_FINISH_ATTEMPT } from '../../../shared/contract';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerQuizTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'moodle_get_quiz_submission_status',
    {
      title: 'Moodleテスト（小テスト/クイズ）の受験状況・締切の確認',
      description:
        'Moodleのテスト（小テスト・クイズ、mod_quiz）を受験済みかどうかを受験期限とともに' +
        '確認する（参照のみ）。「未受験のテストがあるか」「今日・今週締切のテストはどれか」の' +
        '確認・定期チェックにはこれを使う。テストは課題(mod_assign)とは別物なので、課題側は' +
        'moodle_get_assignment_submission_statusで確認する（両方の確認を求められたら両方呼ぶ）。' +
        'デフォルトで全受講コースが対象（courseId不要）。finished=trueで受験完了' +
        '(finishedAttempts回)、inProgressAttempts>0は開始したが未確定の受験あり' +
        '（そのattemptはinProgressAttemptIdをmoodle_answer_quiz_question / ' +
        'moodle_finish_quiz_attemptに渡して再開・確定できる。進行中があるときに' +
        'moodle_start_quiz_attemptで新規開始するとエラーになる）。' +
        '期限はtimeClose（nullは期限なし）。timeOpenが未来のテストはまだ受験開始できない。' +
        'デフォルトでは受験期限超過済みのテストは含まれない（includeClosed=trueで含める）。' +
        '対象テストが多いと statusIncluded=false で受験状況がnullのまま返るので、その場合は ' +
        'courseId / nameFilter / closeWithinDays / quizId で絞り込んで再取得する。',
      inputSchema: {
        quizId: z.number().int().optional().describe('特定テストのIDで絞り込む'),
        courseId: z.number().int().optional().describe('コースIDで絞り込む'),
        nameFilter: z
          .string()
          .optional()
          .describe('テスト名の部分一致で絞り込む（大文字小文字を区別しない）'),
        closeWithinDays: z
          .number()
          .int()
          .optional()
          .describe('受験期限(timeClose)が今からN日以内のテストのみ（期限なしのテストは除外される）'),
        includeClosed: z
          .boolean()
          .optional()
          .describe('trueで受験期限超過済みのテストも含める（デフォルトfalse）'),
      },
    },
    async ({ quizId, courseId, nameFilter, closeWithinDays, includeClosed }) => {
      const params = new URLSearchParams();
      if (quizId !== undefined) params.set('quizId', String(quizId));
      if (courseId !== undefined) params.set('courseId', String(courseId));
      if (nameFilter !== undefined) params.set('nameFilter', nameFilter);
      if (closeWithinDays !== undefined) params.set('closeWithinDays', String(closeWithinDays));
      if (includeClosed) params.set('includeClosed', '1');
      const qs = params.toString();
      const res = await client.request<QuizStatusResponse>(
        `/api/moodle/quiz/status${qs ? `?${qs}` : ''}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'moodle_get_quiz_info',
    {
      title: 'Moodleクイズ一覧・受験可否の取得',
      description:
        '指定したcourseIdのMoodleクイズ一覧を、受験可否(canAttempt)・受験不可の理由' +
        '(preventAccessReasons)・制限時間(timeLimitSeconds)・許容試行回数(attemptsAllowed)' +
        'とともに取得する（参照のみ）。クイズ数が多い科目では受験可否は取得されず' +
        'canAttemptがnullになる(accessInfoIncluded: false)ので、その場合は一覧から対象を見つけ、' +
        'quizIdまたはnameFilter(クイズ名の部分一致)で絞り込んで再取得する。',
      inputSchema: {
        courseId: z.number().int(),
        quizId: z.number().int().optional().describe('特定クイズのIDで絞り込む'),
        nameFilter: z
          .string()
          .optional()
          .describe('クイズ名の部分一致で絞り込む（大文字小文字を区別しない）'),
      },
    },
    async ({ courseId, quizId, nameFilter }) => {
      const params = new URLSearchParams({ courseId: String(courseId) });
      if (quizId !== undefined) params.set('quizId', String(quizId));
      if (nameFilter !== undefined) params.set('nameFilter', nameFilter);
      const res = await client.request<MoodleQuizInfoResponse>(
        `/api/moodle/quiz/info?${params.toString()}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'moodle_start_quiz_attempt',
    {
      title: 'Moodleクイズ受験の開始（実書き込み・試行回数を消費）',
      description:
        '【注意】これは実際にMoodle上でクイズの新規受験(attempt)を開始する書き込み操作。' +
        '呼び出した時点で許容試行回数(attemptsAllowed)を1回消費し、取り消せない。' +
        'moodle_get_quiz_infoでcanAttemptがtrueであることを確認し、ユーザーが受験を開始する意思を' +
        '明示的に示した場合のみ呼び出すこと。成功すると要約済みの設問一覧(questions)が返る。' +
        '各設問は text(設問文)と inputs(回答入力欄のnameと選択肢等)を持ち、そのまま' +
        'moodle_answer_quiz_questionの回答作成に使える。要約パーサ未対応の設問形式では' +
        'inputsが汎用フィールド列挙(kind: "generic")になり、htmlに元の設問HTML全文が付くので' +
        'それを読んで回答する。全設問の生HTMLが必要ならmoodle_get_quiz_questions_htmlで取り直せる' +
        '(試行回数は消費しない)。',
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
    'moodle_answer_quiz_question',
    {
      title: 'Moodleクイズ回答の一時保存（実書き込み）',
      description:
        '【注意】これは実際にMoodle上でクイズ回答を一時保存(mod_quiz_save_attempt)する書き込み操作。' +
        '本提出(moodle_finish_quiz_attempt)はしないため、何度でも上書き保存・修正できる。' +
        'attemptIdはmoodle_start_quiz_attemptが返したattempt.idを使う。answersは、' +
        '各設問の inputs にある name をキー、選択・入力する値を値とするオブジェクト。' +
        'kind別の値の作り方: multichoice は inputs.name に options[].value を; ' +
        'match は各 rows[].name にその行の options[].value を; ' +
        'ordering は inputs.name に、正しい順序の items[].id (ordering_item_{hash}) を' +
        'カンマ区切りで連結した文字列を指定する。generic(要約パーサ未対応)は併記のhtmlを読んで' +
        'fields[].name に対する値を組み立てる。' +
        '`_:sequencecheck` はサーバ側が自動付与するので渡さなくてよい。1回のcallで回答する設問は、' +
        'その設問の入力欄を全て(match の全行 rows[].name 等)含めること。' +
        '返り値の unsavedSlots が空でなければ、その slot は保存に失敗している(name/valueが不正)ので見直す。',
      inputSchema: {
        attemptId: z.number().int(),
        answers: z
          .record(z.string(), z.string())
          .describe('設問HTML中のinput/select要素のname属性 → 回答値'),
      },
    },
    async ({ attemptId, answers }) => {
      const res = await client.request<{
        ok: boolean;
        answeredSlots: number[];
        unsavedSlots: number[];
      }>('/api/moodle/quiz/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, answers }),
      });
      return json(res);
    },
  );

  server.registerTool(
    'moodle_finish_quiz_attempt',
    {
      title: 'Moodleクイズ受験の確定（実書き込み・取り消し不可）',
      description:
        '【重要な注意】これはMoodle上でクイズの受験を確定(mod_quiz_process_attempt, ' +
        'finishattempt=1)する最終操作であり、取り消し不可。事前にmoodle_answer_quiz_questionで' +
        '保存した回答が対象になる（このツール自体には回答データを渡さない）。' +
        '必ず: (1) moodle_answer_quiz_questionで全設問への回答を保存済みであることを確認し、' +
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
      if (confirm !== CONFIRM_FINISH_ATTEMPT) {
        return json({
          ok: false,
          error:
            `confirmed_required: ユーザーの明示的な同意を得た上で confirm="${CONFIRM_FINISH_ATTEMPT}" ` +
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

  server.registerTool(
    'moodle_get_quiz_questions_html',
    {
      title: '開始済みクイズattemptの設問HTML全文の取得',
      description:
        '開始済み(進行中)のattemptの設問一覧を、Moodleが返す生HTMLのまま全件取得する' +
        '(参照のみ・試行回数は消費しない)。attemptIdはmoodle_start_quiz_attemptが返した' +
        'attempt.id。moodle_start_quiz_attemptの要約(inputs)で情報が足りないときや、' +
        '要約パーサ未対応の設問形式を精査するときのフォールバック。結果は設問数によっては' +
        '非常に大きい(実測: 20問で約29万文字)ので、まず要約で足りるか確認してから使うこと。',
      inputSchema: { attemptId: z.number().int() },
    },
    async ({ attemptId }) => {
      const res = await client.request<{ questions: MoodleQuizQuestionHtml[] }>(
        `/api/moodle/quiz/questions?attemptId=${attemptId}`,
      );
      return json(res);
    },
  );

  server.registerTool(
    'moodle_get_quiz_attempt_result',
    {
      title: 'Moodleクイズ採点結果の取得',
      description:
        '確定済み(finished)のattemptの採点結果を取得する(参照のみ)。クイズ全体の評点' +
        '(grade/sumGrades)と、設問ごとの正誤ステータス(status)・得点(mark/maxMark)・' +
        '設問文(text)・正答(rightAnswer。教員がレビューでの正答表示を許可している場合のみ、' +
        'それ以外はnull)を返す。moodle_finish_quiz_attemptで確定した後の点数確認や、' +
        '再受験前の誤答箇所の特定に使う。進行中(inprogress)のattemptには使えず、' +
        'Moodle側がエラーを返す。',
      inputSchema: { attemptId: z.number().int() },
    },
    async ({ attemptId }) => {
      const res = await client.request<MoodleQuizAttemptResult>(
        `/api/moodle/quiz/result?attemptId=${attemptId}`,
      );
      return json(res);
    },
  );
}
