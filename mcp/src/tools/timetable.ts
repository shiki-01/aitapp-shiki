import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { TimetableEntry, ScheduleDay } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerTimetableTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_get_timetable',
    {
      title: 'LCAM時間割の取得',
      description: 'LCAMに登録済みの週間時間割を取得する。',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const res = await client.request<{ timetable: TimetableEntry[] }>('/api/timetable');
      return json(res.timetable);
    },
  );

  server.registerTool(
    'lcam_get_schedule',
    {
      title: 'LCAM個人予定（休講・補講・学校行事等）の取得',
      description:
        'LCAMのPCホーム画面のカレンダーから、休講・補講・学校行事など時間割には載らない個人の予定を取得する' +
        '（参照のみ）。通常の毎週の授業予定はlcam_get_timetableを使う。' +
        'Worker側でPC画面を週ごとにたどるため取得は重く、広い範囲は複数回に分けて呼ぶこと。',
      inputSchema: {
        weeks: z.number().int().min(1).max(14).optional().describe('取得する週数（1〜14、省略時6）'),
        month: z
          .number()
          .int()
          .min(-8)
          .max(8)
          .optional()
          .describe(
            '今月から何か月ずらすか（-8〜8）。指定時はその月の1日を含む週（月曜始まり）からweeks週分を取る。省略時は今日からweeks週分。',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ weeks, month }) => {
      const params = new URLSearchParams();
      if (weeks !== undefined) params.set('weeks', String(weeks));
      if (month !== undefined) params.set('month', String(month));
      const qs = params.toString();
      const res = await client.request<{ schedule: ScheduleDay[] }>(
        `/api/schedule${qs ? `?${qs}` : ''}`,
      );
      return json(res.schedule);
    },
  );
}
