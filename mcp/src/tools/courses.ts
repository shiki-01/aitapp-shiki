import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { MoodleCourse } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerMoodleCourseTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'moodle_list_courses',
    {
      title: 'Moodle受講中コース一覧の取得',
      description:
        '受講中のMoodleコースの一覧をcourseId・コース名（fullName/shortName）付きで取得する' +
        '（参照のみ）。moodle_get_quiz_info・moodle_get_course_filesが要求するcourseIdは' +
        'このツールで調べる。コース名しか分からない状態からMoodleを操作するときの起点。',
      inputSchema: {},
    },
    async () => {
      const res = await client.request<{ courses: MoodleCourse[] }>('/api/moodle/courses');
      return json(res.courses);
    },
  );
}
