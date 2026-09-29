import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { MoodleCourseFile } from '../types';
import { downloadedFileContent } from './download-content';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerMoodleFileTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'moodle_get_course_files',
    {
      title: 'Moodleコース内「ファイル」リソース一覧の取得',
      description:
        '指定したcourseIdのMoodleコースに置かれている「ファイル」リソース' +
        '（課題やクイズの参考資料として案内されることが多い、例: 単語帳・配布資料）の' +
        '一覧をfileUrlとともに取得する（参照のみ）。fileUrlはmoodle_download_fileへ渡せる。',
      inputSchema: { courseId: z.number().int() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ courseId }) => {
      const res = await client.request<{ files: MoodleCourseFile[] }>(
        `/api/moodle/resources?courseId=${courseId}`,
      );
      return json(res.files);
    },
  );

  server.registerTool(
    'moodle_download_file',
    {
      title: 'Moodle上のファイルをダウンロード',
      description:
        'moodle_get_course_filesが返すfileUrl、またはmoodle_get_quiz_info/moodle_start_quiz_attempt/' +
        'moodle_answer_quiz_questionが返す設問HTML中に含まれる音声・動画・添付ファイルの' +
        'URL（pluginfile.php/file.php等の絶対URL）を取得する。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す（Read等でそのまま開ける）。' +
        'リモート(HTTP)実行時はファイル内容を直接返す。' +
        'LCAM連絡の添付ファイルはlcam_download_notice_attachmentを使う（このツールはMoodle専用）。',
      inputSchema: {
        fileUrl: z.string().describe('cms.aitech.ac.jp配下のファイルの絶対URL'),
        fileName: z.string().describe('保存時のファイル名（拡張子を含める）'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ fileUrl, fileName }) => {
      const res = await client.downloadMoodleFile(fileUrl, fileName);
      return downloadedFileContent(res);
    },
  );
}
