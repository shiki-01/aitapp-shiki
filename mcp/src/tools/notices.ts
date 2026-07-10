import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerClient } from '../client';
import type { Notice, NoticeDetail } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerNoticeTools(server: McpServer, client: WorkerClient): void {
  server.registerTool(
    'list_notices',
    {
      title: '連絡一覧の取得',
      description:
        'LCAMの学内連絡(common)または授業連絡(class)を先頭からcount件取得する。' +
        '授業連絡(class)には「課題」として告知されるものが含まれることがあり、' +
        'これはMoodleの課題システム(list_assignments)とは別の、LCAM側の正式な情報源。' +
        'ユーザーが出典を指定せず単に「課題」と聞いた場合は、こちらとlist_assignmentsの' +
        '両方を確認し、どちらの結果かを明示して両方提示する。' +
        '「LCAMの」「授業連絡の」等と出典を指定された場合はこちらのみを使う。',
      inputSchema: {
        type: z.enum(['common', 'class']).default('common'),
        count: z.number().int().min(1).default(10),
      },
    },
    async ({ type, count }) => {
      const res = await client.request<{ notices: Notice[] }>(
        `/api/notices?type=${type}&count=${count}`,
      );
      return json(res.notices);
    },
  );

  server.registerTool(
    'get_notice_detail',
    {
      title: '連絡詳細の取得',
      description:
        '連絡の詳細本文を取得する。indexはlist_noticesが返した各要素のindexを使う。' +
        '添付ファイルがある場合はfilesにファイル名→パスが入り、download_notice_attachmentへ渡せる。',
      inputSchema: {
        type: z.enum(['common', 'class']).default('common'),
        index: z.number().int().min(0),
      },
    },
    async ({ type, index }) => {
      const res = await client.request<{ detail: NoticeDetail }>(
        `/api/notices/detail?type=${type}&index=${index}`,
      );
      return json(res.detail);
    },
  );

  server.registerTool(
    'download_notice_attachment',
    {
      title: '連絡の添付ファイルをダウンロード',
      description:
        'get_notice_detailのfilesに含まれる添付ファイルをローカルの一時ディレクトリへ保存し、' +
        'ファイルパスを返す。返ったパスはRead等でそのまま開ける。',
      inputSchema: {
        path: z.string().describe('get_notice_detailのfilesの値（相対パス）'),
        fileName: z.string().describe('get_notice_detailのfilesのキー（保存時のファイル名に使う）'),
      },
    },
    async ({ path, fileName }) => {
      const res = await client.downloadAttachment(path, fileName);
      return json(res);
    },
  );
}
