import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { CreditStatus, CurriculumItem, SchoolEvents, LotteryResult } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAcademicTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_get_credit_status',
    {
      title: 'LCAM学事システムの単位修得情報の取得',
      description:
        'LCAMの学事システムの単位修得情報（卒業・進級に必要な単位の充足状況）を取得する。' +
        '結果は { tabs, header, rows, note }。tabsは表の上のタブ名、headerは見出し行（複数行）、' +
        'rowsはデータ行、noteは表の下の注記（例: 総修得単位数の要件）。' +
        '列の意味（必要単位(A)・修得単位(C)・履修単位(E) など）は上流の見出しのまま返すので、headerを見て読み取ること。' +
        '結合セルは展開済みで、同じ値が繰り返し入る。' +
        '取得できるのは表示中のタブ（既定は卒業進級用１年）のみで、他のタブは選べない。' +
        '学事システムはLCAMと別のアプリで、呼ぶたびに数リクエスト要る。読み取り専用。' +
        '個々の科目と評価はlcam_get_curriculum、成績の一覧はlcam_get_gradesを使う。',
      inputSchema: {},
    },
    async () => {
      const res = await client.request<{ credits: CreditStatus }>('/api/credits');
      const { tabs, headerRows, rows, note } = res.credits;
      return json({ tabs, header: rows.slice(0, headerRows), rows: rows.slice(headerRows), note });
    },
  );

  server.registerTool(
    'lcam_get_curriculum',
    {
      title: 'LCAM学事システムのカリキュラム（履修対象科目と評価）の取得',
      description:
        'LCAMの学事システムのカリキュラム（履修対象の全科目と評価）を取得する。' +
        '各要素はcode（科目コード）・name（科目名）・category（科目区分）・creditType（単位区分。必修・選択など）・' +
        'credits（単位数）・grade（評価。未修得・履修中は空）を持つ。' +
        '全科目は180件程度あり、引数なしだと長い。keyword（科目名またはコードの部分一致）・' +
        'category（科目区分の部分一致）・onlyUngraded（trueで評価が空のものだけ）で絞るとよい。' +
        '学事システムはLCAMと別のアプリで、呼ぶたびに数リクエスト要る。読み取り専用。',
      inputSchema: {
        keyword: z.string().min(1).max(50).optional().describe('科目名またはコードの部分一致'),
        category: z.string().min(1).max(50).optional().describe('科目区分の部分一致（例: 「専門」）'),
        onlyUngraded: z.boolean().optional().describe('trueで評価が空（未修得・履修中）の科目のみ'),
      },
    },
    async ({ keyword, category, onlyUngraded }) => {
      const res = await client.request<{ curriculum: CurriculumItem[] }>('/api/curriculum');
      const items = res.curriculum
        .filter(
          (x) =>
            (keyword === undefined || x.name.includes(keyword) || x.code.includes(keyword)) &&
            (category === undefined || x.category.includes(category)) &&
            (!onlyUngraded || x.grade === ''),
        )
        .map((x) => ({
          code: x.code,
          name: x.name,
          category: x.category,
          creditType: x.creditType,
          credits: x.credits,
          grade: x.grade,
        }));
      return json(items);
    },
  );

  server.registerTool(
    'lcam_get_school_events',
    {
      title: 'LCAM学事システムの学内スケジュール（年間行事）の取得',
      description:
        'LCAMの学事システムの学内スケジュール（年間行事・祝祭日）を取得する。' +
        '結果は { nendo, months: [{ month, days: [{ date, weekday, holiday, event }] }] }で、' +
        '行事や祝祭日のある日（eventかholidayが空でない日）だけを返す。' +
        'monthは1〜12の整数か"all"。省略は今の月。日付（YYYY-MM-DD）は年度に基づくので、1〜3月は翌年の日付になる。' +
        '"all"は12か月分で、上流へ12回アクセスするので遅い。全期間から探したいときなど必要なときだけ使う。' +
        'keywordを渡すと、event・holidayに部分一致する日だけを返す（行事名の検索には month="all" と組み合わせる）。' +
        '学事システムはLCAMと別のアプリで、呼ぶたびに数リクエスト要る。読み取り専用。',
      inputSchema: {
        month: z
          .union([z.number().int().min(1).max(12), z.literal('all')])
          .optional()
          .describe('月（1〜12）または "all"（12か月分。上流アクセスが多い）。省略は今の月'),
        keyword: z.string().min(1).max(50).optional().describe('行事名・祝祭日名の部分一致'),
      },
    },
    async ({ month, keyword }) => {
      const q = month === undefined ? '' : `?month=${month}`;
      const res = await client.request<{ events: SchoolEvents }>(`/api/schoolevents${q}`);
      const months = res.events.months
        .map((m) => ({
          month: m.month,
          days: m.days
            .filter((d) => d.event !== '' || d.holiday !== '')
            .filter((d) => keyword === undefined || d.event.includes(keyword) || d.holiday.includes(keyword))
            .map((d) => ({ date: d.date, weekday: d.weekday, holiday: d.holiday, event: d.event })),
        }))
        // all のときに空の月が並ぶのを避ける。単月指定では該当なしを空配列で示す。
        .filter((m) => month !== 'all' || m.days.length > 0);
      return json({ nendo: res.events.nendo, months });
    },
  );
  server.registerTool(
    'lcam_get_lottery_results',
    {
      title: 'LCAM学事システムの抽選履修登録の結果の取得',
      description:
        'LCAMの学事システムの抽選履修登録の結果（申し込んだ科目ごとの当落）を取得する。' +
        '各要素はslot（曜日時限）・subject（科目名）・classCode・biweekly（隔週授業の表記）・category（科目区分）・' +
        'creditType（単位区分）・credits（単位数）・campus（校舎区分）・capacity（定員）・preference（希望順位）・' +
        'result（当選/落選）・processedAt（抽選処理日）を持つ。' +
        '抽選処理前の科目はresultとprocessedAtが空。当選・落選は上流の表記のまま返す。' +
        '学事システムはLCAMと別のアプリで、呼ぶたびに数リクエスト要る。読み取り専用（申し込み・変更はできない）。',
      inputSchema: {},
    },
    async () => {
      const res = await client.request<{ lottery: LotteryResult[] }>('/api/lottery');
      return json(res.lottery);
    },
  );
}
