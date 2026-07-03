import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
import type { TimetableEntry, ScheduleDay } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerTimetableTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'get_timetable',
    {
      title: '時間割の取得',
      description: '登録済みの週間時間割を取得する。',
    },
    async () => {
      const res = await client.request<{ timetable: TimetableEntry[] }>('/api/timetable');
      return json(res.timetable);
    },
  );

  server.registerTool(
    'get_schedule',
    {
      title: '予定（休講・補講等）の取得',
      description: '今後数週間分の授業予定（休講・補講・行事等）を日付ごとに取得する。',
    },
    async () => {
      const res = await client.request<{ schedule: ScheduleDay[] }>('/api/schedule');
      return json(res.schedule);
    },
  );
}
