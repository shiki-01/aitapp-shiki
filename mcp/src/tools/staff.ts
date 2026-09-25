import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { StaffMember, ScheduleDay } from '../types';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** 上流が受け付ける週数の範囲（今週の月曜からの週数）。 */
const MIN_WEEK = -4;
const MAX_WEEK = 8;

export function registerStaffTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_search_staff',
    {
      title: 'LCAM教職員の氏名検索',
      description:
        'LCAMのキャンパスライフ > スケジュール > 教職員スケジュールで、教職員を氏名で検索する。' +
        'nameは氏名の一部（1〜30文字）で、姓だけでも検索できる。' +
        '各要素はcode（教職員コード）・name（姓名の間は全角スペース）・kana・department（所属）を持つ。' +
        '同姓の人が複数出ることがあるので、所属（department）で区別すること。' +
        '読み取り専用。' +
        '授業やオフィスアワーなどの予定を調べるには、lcam_get_staff_scheduleにこの結果のcodeと、検索に使ったnameを渡す。',
      inputSchema: {
        name: z.string().min(1).max(30).describe('氏名の一部（1〜30文字。姓だけでも可）'),
      },
    },
    async ({ name }) => {
      const q = new URLSearchParams({ name });
      const res = await client.request<{ staff: StaffMember[] }>(`/api/staff?${q}`);
      return json(res.staff);
    },
  );

  server.registerTool(
    'lcam_get_staff_schedule',
    {
      title: 'LCAM教職員のスケジュールの取得',
      description:
        'LCAMの教職員の授業・予定（スケジュール）を取得する。教員が授業やオフィスアワー等で在室かを調べる用途。' +
        'codeはlcam_search_staffの結果のcode（数字）、nameはその検索に使ったのと同じ検索語（上流が検索結果にcodeが含まれることを要求するため）。' +
        'weekは-4〜8の整数。省略または0は「今日から7日間」、0以外は「今週の月曜を起点にN週後（負は前。来週=1、先週=-1）」の週（月曜始まり）。' +
        '結果は、staff（該当の教職員）と、days（日ごとのdate・events[]。eventsにtitle・startTime・endTime・period・teacher・location）。' +
        '分かるのはLCAMに登録されている授業・予定だけで、私的な予定や実際の在室状況ではない。読み取り専用。',
      inputSchema: {
        name: z.string().min(1).max(30).describe('lcam_search_staffで使った検索語と同じもの'),
        code: z.string().regex(/^\d{1,10}$/, '教職員コードは数字のみ(最大10桁)').describe('lcam_search_staffの結果のcode'),
        week: z
          .number()
          .int()
          .min(MIN_WEEK)
          .max(MAX_WEEK)
          .optional()
          .describe('週（-4〜8。省略・0は今日から7日、N≠0は今週の月曜を起点にN週後）'),
      },
    },
    async ({ name, code, week }) => {
      const q = new URLSearchParams({ name, code });
      if (week !== undefined) q.set('week', String(week));
      const res = await client.request<{ schedule: { staff: StaffMember; days: ScheduleDay[] } }>(
        `/api/staff/schedule?${q}`,
      );
      return json(res.schedule);
    },
  );
}
