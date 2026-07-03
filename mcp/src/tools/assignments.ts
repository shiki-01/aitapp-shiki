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
      description: 'Moodle上の未提出/提出済みを問わず全課題を締切等の情報とともに取得する。',
    },
    async () => {
      const res = await client.request<{ assignments: Assignment[] }>('/api/assignments');
      return json(res.assignments);
    },
  );
}
