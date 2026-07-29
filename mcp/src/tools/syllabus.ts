import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { SyllabusFilters, SyllabusListItem, SyllabusDetail } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const searchFields = {
  year: z.string().describe('年度（例: "2025"）'),
  word: z.string().optional().describe('検索キーワード'),
  campus: z.number().int().optional(),
  semester: z.number().int().optional(),
  week: z.number().int().optional(),
  hour: z.number().int().optional(),
  folder: z.string().optional(),
};

export function registerSyllabusTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'syllabus_get_filters',
    {
      title: 'シラバス検索用フィルタの取得',
      description:
        'シラバス検索で使えるフィルタ選択肢（年度/キャンパス/学期/曜日/時限/フォルダ）を取得する。' +
        'yearを指定すると、その年度に応じたフィルタ選択肢に絞り込む。',
      inputSchema: { year: z.string().optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ year }) => {
      const res = await client.request<{ filters: SyllabusFilters }>(
        `/api/syllabus/filters${qs({ year })}`,
      );
      return json(res.filters);
    },
  );

  server.registerTool(
    'syllabus_search',
    {
      title: 'シラバス検索',
      description: '条件に合致する科目のシラバス一覧を検索する。detailを見るにはsyllabus_get_detailを使う。',
      inputSchema: searchFields,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const res = await client.request<{ results: SyllabusListItem[] }>(
        `/api/syllabus/search${qs(params)}`,
      );
      return json(res.results);
    },
  );

  server.registerTool(
    'syllabus_get_detail',
    {
      title: 'シラバス詳細の取得',
      description:
        'syllabus_searchの結果に含まれるurlを指定してシラバス詳細を取得する。' +
        '検索状態の再現のためsyllabus_searchと同じ検索条件を一緒に渡すこと。',
      inputSchema: { url: z.string().describe('syllabus_searchの結果のurl'), ...searchFields },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, ...context }) => {
      const res = await client.request<{ detail: SyllabusDetail }>(
        `/api/syllabus/detail${qs({ url, ...context })}`,
      );
      return json(res.detail);
    },
  );
}
