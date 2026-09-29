import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { Notice, NoticeDetail } from '../types';
import { downloadedFileContent } from './download-content';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerNoticeTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_list_notices',
    {
      title: 'LCAM連絡一覧の取得',
      description:
        'LCAMの連絡一覧をtypeで指定して先頭からcount件取得する。' +
        'type=common: 学内連絡（全学向けの掲示・事務連絡）。' +
        'type=class: 授業連絡（担当科目の教員からの連絡。「課題」の告知がここに' +
        '書かれることもあるが、Moodleのmoodle_list_assignmentsとは別物）。' +
        '出典を指定せず単に「課題」と聞かれた場合は、type=classとmoodle_list_assignmentsの' +
        '両方を確認し、どちらの結果かを明示して両方提示する。' +
        '「LCAMの」「授業連絡の」等と出典を指定された場合はこちらのみを使う。',
      inputSchema: {
        type: z.enum(['common', 'class']).default('common'),
        count: z.number().int().min(1).default(10),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ type, count }) => {
      const res = await client.request<{ notices: Notice[] }>(
        `/api/notices?type=${type}&count=${count}`,
      );
      return json(res.notices);
    },
  );

  server.registerTool(
    'lcam_get_notice_detail',
    {
      title: 'LCAM連絡詳細の取得',
      description:
        'LCAMの連絡の詳細本文を取得する。indexはlcam_list_noticesが返した各要素のindexを使う。' +
        '添付ファイルがある場合はfilesにファイル名→パスが入り、lcam_download_notice_attachmentへ渡せる。',
      inputSchema: {
        type: z.enum(['common', 'class']).default('common'),
        index: z.number().int().min(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ type, index }) => {
      const res = await client.request<{ detail: NoticeDetail }>(
        `/api/notices/detail?type=${type}&index=${index}`,
      );
      return json(res.detail);
    },
  );

  server.registerTool(
    'lcam_download_notice_attachment',
    {
      title: 'LCAM連絡の添付ファイルをダウンロード',
      description:
        'lcam_get_notice_detailのfilesに含まれる添付ファイルを取得する。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す（Read等でそのまま開ける）。' +
        'リモート(HTTP)実行時はファイル内容を直接返す。' +
        'Moodle側のファイルはmoodle_download_fileを使う（このツールはLCAM連絡の添付専用）。',
      inputSchema: {
        path: z.string().describe('lcam_get_notice_detailのfilesの値（相対パス）'),
        fileName: z.string().describe('lcam_get_notice_detailのfilesのキー（保存時のファイル名に使う）'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, fileName }) => {
      const res = await client.downloadAttachment(path, fileName);
      return downloadedFileContent(res);
    },
  );
}
