import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { PcNoticeList, PcNoticeDetail, PcNoticeQuery } from '../types';
import { downloadedFileContent } from './download-content';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const idSchema = z.string().regex(/^\d{1,12}$/, 'idは数字のみ(最大12桁)');
const dateSchema = z.string().regex(/^\d{4}[-/]\d{2}[-/]\d{2}$/, 'YYYY-MM-DD または YYYY/MM/DD');

// 検索・詳細・ダウンロードで共通の絞り込み。詳細・添付は一覧と同じ値を渡す必要がある。
const filterShape = {
  kind: z.enum(['campus', 'class']).describe('campus=学内連絡（キャンパスライフ）, class=授業連絡（授業サポート）'),
  keyword: z.string().min(1).max(100).optional().describe('タイトル・本文の検索語（授業連絡は教員名・科目名も対象）'),
  category: z
    .string()
    .min(1)
    .max(50)
    .optional()
    .describe('カテゴリ（学内連絡）/連絡種別（授業連絡）の名前。検索結果のcategoriesにある名前から選ぶ'),
  subject: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('授業科目の名前（授業連絡のみ）。検索結果のsubjectsにある名前から選ぶ'),
  from: dateSchema.optional().describe('連絡日の範囲の開始（YYYY-MM-DD または YYYY/MM/DD）'),
  to: dateSchema.optional().describe('連絡日の範囲の終了（YYYY-MM-DD または YYYY/MM/DD）'),
  unreadOnly: z.boolean().optional().describe('trueで未読のみ'),
  todoOnly: z.boolean().optional().describe('trueでToDo登録されたもののみ'),
  attachmentOnly: z.boolean().optional().describe('trueで添付ファイルありのみ'),
  year: z.number().int().min(2000).max(2099).optional().describe('年度（授業連絡のみ。例: 2026）。省略時は今の年度'),
  semester: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe('学期（授業連絡のみ。1=前期, 2=後期）。省略時は今の学期'),
};

type NoticeFilter = { kind: 'campus' | 'class' } & PcNoticeQuery;

function buildQuery(params: Record<string, string | number | undefined>, f: NoticeFilter): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  q.set('kind', f.kind);
  if (f.keyword !== undefined) q.set('keyword', f.keyword);
  if (f.category !== undefined) q.set('category', f.category);
  if (f.subject !== undefined) q.set('subject', f.subject);
  if (f.from !== undefined) q.set('from', f.from);
  if (f.to !== undefined) q.set('to', f.to);
  if (f.unreadOnly) q.set('unread', '1');
  if (f.todoOnly) q.set('todo', '1');
  if (f.attachmentOnly) q.set('attachment', '1');
  if (f.year !== undefined) q.set('year', String(f.year));
  if (f.semester !== undefined) q.set('semester', String(f.semester));
  return `?${q.toString()}`;
}

const FILTER_NOTE =
  '詳細・添付の取得には、一覧を出したときと同じ絞り込み（kind・keyword・category・subject・from・to・' +
  'unreadOnly・todoOnly・attachmentOnly・year・semester）を同じ値で渡すこと' +
  '（上流の一覧の行でidを引くため、違う条件だと別の連絡や見つからないエラーになる）。';

export function registerPcNoticeTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_search_notices',
    {
      title: 'LCAM連絡の検索',
      description:
        'LCAM（PC版）の連絡を、キーワード・カテゴリ・科目・日付範囲・未読/ToDo/添付などで検索・絞り込む。' +
        'kind=campus: 学内連絡（キャンパスライフ > 学内連絡。全学向けの掲示・事務連絡）。' +
        'kind=class: 授業連絡（授業サポート > 授業連絡。担当教員から科目ごとに届く連絡）。' +
        '条件なしの既定は、学内連絡=有効な連絡すべて、授業連絡=今の年度・学期。授業連絡の過去分はyear・semesterを渡す。' +
        '新しい順に先頭から見るだけならlcam_list_notices、検索・絞り込みが要るときはこちらを使う。' +
        '結果は { items, categories, subjects }。itemsの各要素はid・kind・title・category・sender・' +
        'subject/term（授業連絡のみ）・important・startAt・endAtを持つ。' +
        'category・subjectは自由入力ではなく、categories・subjectsの候補名から選ぶ' +
        '（最初は条件なしで呼ぶと候補が返る）。' +
        '本文・添付はlcam_get_notice_search_detailにid、添付はlcam_download_notice_search_fileにid・no。' +
        FILTER_NOTE +
        '読み取り専用（既読化・ToDo登録・返信はしない）。',
      inputSchema: filterShape,
    },
    async (f) => {
      const res = await client.request<{ list: PcNoticeList }>(`/api/pcnotices${buildQuery({}, f)}`);
      return json(res.list);
    },
  );

  server.registerTool(
    'lcam_get_notice_search_detail',
    {
      title: 'LCAM連絡（検索結果）の詳細取得',
      description:
        'lcam_search_noticesで見つけた連絡の詳細（本文・連絡元・連絡日時・参照URL・添付・授業連絡は返信可否）を取得する。' +
        'idはlcam_search_noticesのitemsのidを使う。bodyはテキスト（書式は落ちる）。' +
        '添付filesの各noがlcam_download_notice_search_fileのnoに使える。' +
        FILTER_NOTE +
        '読み取り専用（既読化・ToDo・返信はしない）。',
      inputSchema: {
        id: idSchema.describe('lcam_search_noticesのid（数字文字列）'),
        ...filterShape,
      },
    },
    async ({ id, ...f }) => {
      const res = await client.request<{ detail: PcNoticeDetail }>(
        `/api/pcnotices/detail${buildQuery({ id }, f)}`,
      );
      return json(res.detail);
    },
  );

  server.registerTool(
    'lcam_download_notice_search_file',
    {
      title: 'LCAM連絡（検索結果）の添付ファイルをダウンロード',
      description:
        'lcam_search_noticesで見つけた連絡の添付を1ファイル取得する。' +
        'idはlcam_search_noticesのid、noはlcam_get_notice_search_detailのfiles[].no（1以上の整数）を使う。' +
        'ローカル(stdio)実行時は一時ディレクトリへ保存しパスを返す（Read等でそのまま開ける）。' +
        'リモート(HTTP)実行時はファイル内容を直接返す。' +
        FILTER_NOTE +
        '読み取り専用。SP版のlcam_list_noticesで見つけた連絡の添付はlcam_download_notice_attachmentを使う。',
      inputSchema: {
        id: idSchema.describe('lcam_search_noticesのid（数字文字列）'),
        no: z.number().int().min(1).describe('lcam_get_notice_search_detailのfilesのno'),
        ...filterShape,
        fileName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('保存名。lcam_get_notice_search_detailのfilesのnameを渡すと拡張子が付く（省略時は拡張子なし）'),
      },
    },
    async ({ id, no, fileName, ...f }) => {
      const res = await client.downloadApi(
        `/api/pcnotices/file${buildQuery({ id, no }, f)}`,
        fileName ?? `notice-${id}-${no}`,
      );
      return downloadedFileContent(res);
    },
  );
}
