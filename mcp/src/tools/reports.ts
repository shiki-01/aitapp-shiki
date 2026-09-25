import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { ReportItem, ReportDetail } from '../types';
import { downloadedFileContent } from './download-content';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const idSchema = z.string().regex(/^\d{1,12}$/, 'idは数字のみ(最大12桁)');

// 一覧・詳細・ダウンロードで共通の絞り込み。省略時は上流の初期表示（今の年度・学期）。
const filterShape = {
  year: z.number().int().min(2000).max(2099).optional().describe('年度（例: 2026）。省略時は今の年度'),
  semester: z.union([z.literal(1), z.literal(2)]).optional().describe('学期（1=前期, 2=後期）。省略時は今の学期'),
  unsubmittedOnly: z.boolean().optional().describe('trueで未提出のレポートのみ'),
};

interface ReportFilter {
  year?: number;
  semester?: 1 | 2;
  unsubmittedOnly?: boolean;
}

function buildQuery(params: Record<string, string | number | undefined>, f: ReportFilter): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  if (f.year !== undefined) q.set('year', String(f.year));
  if (f.semester !== undefined) q.set('semester', String(f.semester));
  if (f.unsubmittedOnly) q.set('unsubmitted', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}

const FILTER_NOTE =
  '絞り込み（year・semester・unsubmittedOnly）を省略すると今の年度・学期のレポートだけが対象になる。' +
  '過去のレポートはyear・semesterを渡す（一覧・詳細・ダウンロードで同じ値を渡すこと）。';

export function registerReportTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_list_reports',
    {
      title: 'LCAMレポート一覧の取得',
      description:
        'LCAMの授業サポート > レポートの一覧を取得する。' +
        '各要素はid・科目・学期/曜日時限・タイトル・状態・提出期間・最終提出日時・実施形式・提出/提出取消の可否を持つ。' +
        '読み取り専用（提出・提出取消はできない）。' +
        FILTER_NOTE +
        '詳細はlcam_get_report_detailにid、提出したファイルの取得はlcam_download_report_fileに渡す' +
        '（一覧 → 詳細 → ダウンロードの順）。',
      inputSchema: filterShape,
    },
    async (f) => {
      const res = await client.request<{ reports: ReportItem[] }>(`/api/reports${buildQuery({}, f)}`);
      return json(res.reports);
    },
  );

  server.registerTool(
    'lcam_get_report_detail',
    {
      title: 'LCAMレポートの詳細取得',
      description:
        'LCAMのレポートの詳細（状態・タイトル・提出期間・評価方法・説明・伝達事項・評価結果・提出履歴）を取得する。' +
        'idはlcam_list_reportsが返した各要素のidを使う。' +
        '提出履歴submissionsの各filesのsubmitNo・fileNo（と名前）をlcam_download_report_fileへ渡してダウンロードできる。' +
        '読み取り専用。' +
        FILTER_NOTE,
      inputSchema: {
        id: idSchema.describe('lcam_list_reportsのid（数字文字列）'),
        ...filterShape,
      },
    },
    async ({ id, ...f }) => {
      const res = await client.request<{ detail: ReportDetail }>(`/api/reports/detail${buildQuery({ id }, f)}`);
      return json(res.detail);
    },
  );

  server.registerTool(
    'lcam_download_report_file',
    {
      title: 'LCAMレポートの提出ファイルをダウンロード',
      description:
        'LCAMのレポートに自分が提出した1ファイルを取得する。' +
        'idはlcam_list_reportsのid、submitNo・fileNoはlcam_get_report_detailのsubmissions[].files[]のsubmitNo・fileNo（いずれも1以上の整数）を使う。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す（Read等でそのまま開ける）。' +
        'リモート(HTTP)実行時はファイル内容を直接返す。' +
        '読み取り専用（提出はできない）。' +
        FILTER_NOTE +
        'LCAM連絡の添付はlcam_download_notice_attachment、Moodleのファイルはmoodle_download_fileを使う。',
      inputSchema: {
        id: idSchema.describe('lcam_list_reportsのid（数字文字列）'),
        submitNo: z.number().int().min(1).describe('lcam_get_report_detailのfilesのsubmitNo'),
        fileNo: z.number().int().min(1).describe('lcam_get_report_detailのfilesのfileNo'),
        ...filterShape,
        fileName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('保存名。lcam_get_report_detailのfilesのnameを渡すと拡張子が付く（省略時は拡張子なし）'),
      },
    },
    async ({ id, submitNo, fileNo, fileName, ...f }) => {
      const res = await client.downloadApi(
        `/api/reports/download${buildQuery({ id, submitNo, fileNo }, f)}`,
        fileName ?? `report-${id}-${submitNo}-${fileNo}`,
      );
      return downloadedFileContent(res);
    },
  );
}
