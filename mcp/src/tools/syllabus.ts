import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
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

export function registerSyllabusTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'get_syllabus_filters',
    {
      title: 'シラバス検索用フィルタの取得',
      description:
        'シラバス検索で使えるフィルタ選択肢（年度/キャンパス/学期/曜日/時限/フォルダ）を取得する。' +
        'yearを指定すると、その年度に応じたフィルタ選択肢に絞り込む。',
      inputSchema: { year: z.string().optional() },
    },
    async ({ year }) => {
      const res = await client.request<{ filters: SyllabusFilters }>(
        `/api/syllabus/filters${qs({ year })}`,
      );
      return json(res.filters);
    },
  );

  server.registerTool(
    'search_syllabus',
    {
      title: 'シラバス検索',
      description: '条件に合致する科目のシラバス一覧を検索する。detailを見るにはget_syllabus_detailを使う。',
      inputSchema: searchFields,
    },
    async (params) => {
      const res = await client.request<{ results: SyllabusListItem[] }>(
        `/api/syllabus/search${qs(params)}`,
      );
      return json(res.results);
    },
  );

  server.registerTool(
    'get_syllabus_detail',
    {
      title: 'シラバス詳細の取得',
      description:
        'search_syllabusの結果に含まれるurlを指定してシラバス詳細を取得する。' +
        '検索状態の再現のためsearch_syllabusと同じ検索条件を一緒に渡すこと。',
      inputSchema: { url: z.string().describe('search_syllabusの結果のurl'), ...searchFields },
    },
    async ({ url, ...context }) => {
      const res = await client.request<{ detail: SyllabusDetail }>(
        `/api/syllabus/detail${qs({ url, ...context })}`,
      );
      return json(res.detail);
    },
  );
}
