import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { TimetableEntry } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerTimetableTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_get_timetable',
    {
      title: 'LCAM時間割の取得',
      description: 'LCAMに登録済みの週間時間割を取得する。',
    },
    async () => {
      const res = await client.request<{ timetable: TimetableEntry[] }>('/api/timetable');
      return json(res.timetable);
    },
  );
}
