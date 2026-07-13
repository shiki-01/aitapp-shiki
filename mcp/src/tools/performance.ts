import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { PerformanceEntry } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerPerformanceTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_get_grades',
    {
      title: 'LCAM成績情報の取得',
      description:
        'LCAMの成績情報(科目名・教員・年度・学期・単位数・評価)を取得する。' +
        '履修中で未評価の科目はinProgress=trueでgradeは空になる。',
    },
    async () => {
      const res = await client.request<{ performance: PerformanceEntry[] }>('/api/performance');
      return json(res.performance);
    },
  );
}
