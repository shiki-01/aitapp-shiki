import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { CommonFileItem, CommonFileDetail } from '../types';
import { downloadedFileContent } from './download-content';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const idSchema = z.string().regex(/^\d{1,12}$/, 'idは数字のみ(最大12桁)');

export function registerCommonFileTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_list_common_files',
    {
      title: 'LCAM学内共有ファイル一覧の取得',
      description:
        'LCAMの学内共有ファイル（学内向けに公開されている配布資料・書式等）の一覧を取得する。' +
        '各要素はid・カテゴリ・タイトル・ダウンロード数・サイズ・更新日を持つ。' +
        '読み取り専用。' +
        '詳細はlcam_get_common_file_detailにid、実際のファイル取得はlcam_download_common_fileに渡す' +
        '（一覧 → 詳細 → ダウンロードの順）。',
    },
    async () => {
      const res = await client.request<{ files: CommonFileItem[] }>('/api/commonfiles');
      return json(res.files);
    },
  );

  server.registerTool(
    'lcam_get_common_file_detail',
    {
      title: 'LCAM学内共有ファイルの詳細取得',
      description:
        'LCAMの学内共有ファイルの詳細（タイトル・カテゴリ・説明・公開期間・ファイル一覧）を取得する。' +
        'idはlcam_list_common_filesが返した各要素のidを使う。' +
        'filesの各要素のno（と名前・サイズ）をlcam_download_common_fileへ渡してダウンロードできる。' +
        '読み取り専用。',
      inputSchema: {
        id: idSchema.describe('lcam_list_common_filesのid（数字文字列）'),
      },
    },
    async ({ id }) => {
      const res = await client.request<{ detail: CommonFileDetail }>(
        `/api/commonfiles/detail?id=${encodeURIComponent(id)}`,
      );
      return json(res.detail);
    },
  );

  server.registerTool(
    'lcam_download_common_file',
    {
      title: 'LCAM学内共有ファイルをダウンロード',
      description:
        'LCAMの学内共有ファイル内の1ファイルを取得する。' +
        'idはlcam_list_common_filesのid、noはlcam_get_common_file_detailのfilesの各要素のno（1以上の整数）を使う。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す（Read等でそのまま開ける）。' +
        'リモート(HTTP)実行時はファイル内容を直接返す。' +
        '読み取り専用。' +
        'LCAM連絡の添付はlcam_download_notice_attachment、Moodleのファイルはmoodle_download_fileを使う。',
      inputSchema: {
        id: idSchema.describe('lcam_list_common_filesのid（数字文字列）'),
        no: z.number().int().min(1).describe('lcam_get_common_file_detailのfilesのno'),
        fileName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('保存名。lcam_get_common_file_detailのfilesのnameを渡すと拡張子が付く（省略時は拡張子なし）'),
      },
    },
    async ({ id, no, fileName }) => {
      const res = await client.downloadApi(
        `/api/commonfiles/download?id=${encodeURIComponent(id)}&no=${no}`,
        fileName ?? `common-file-${id}-${no}`,
      );
      return downloadedFileContent(res);
    },
  );
}
