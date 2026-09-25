import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from '../tool-client';
import type { FacilityItem, FacilityWeek } from '../types';
import { PERIODS, busyEvents, freeRooms, weekOffsetFromToday } from '../../../shared/facility';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** 上流が受け付ける週数の範囲（今週からの週数）と、1 回に問い合わせられる施設数。 */
const MIN_WEEK = -4;
const MAX_WEEK = 8;
const MAX_IDS = 60;

const idSchema = z.string().regex(/^\d{1,8}$/, '施設コードは数字のみ(最大8桁)');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM形式（例: 13:00）');

const filterShape = {
  building: z.string().min(1).max(50).optional().describe('建物名の部分一致（例: 「1号館」）'),
  minCapacity: z.number().int().min(1).max(2000).optional().describe('定員の下限（この人数以上の施設のみ）'),
  name: z.string().min(1).max(50).optional().describe('施設名の部分一致（例: 「101」）'),
};

interface FacilityFilter {
  building?: string;
  minCapacity?: number;
  name?: string;
}

function filterFacilities(list: FacilityItem[], f: FacilityFilter): FacilityItem[] {
  return list.filter(
    (x) =>
      (f.building === undefined || x.building.includes(f.building)) &&
      (f.minCapacity === undefined || x.capacity >= f.minCapacity) &&
      (f.name === undefined || x.name.includes(f.name)),
  );
}

function summary(x: FacilityItem) {
  return { id: x.id, building: x.building, name: x.name, capacity: x.capacity, equipment: x.equipment };
}

export function registerFacilityTools(server: McpServer, client: ToolClient): void {
  server.registerTool(
    'lcam_list_facilities',
    {
      title: 'LCAM施設一覧の取得',
      description:
        'LCAMのキャンパスライフ > 施設の一覧（教室など）を取得する。' +
        '各要素はid（施設コード）・建物・施設名・定員・設備(equipment)を持つ。' +
        '全施設は200件超で長いので、building（建物名）・minCapacity（定員の下限）・name（施設名）で絞るとよい' +
        '（引数なしでも全件返す）。定員0は未登録の意味であることが多い。読み取り専用。' +
        '施設の使用状況はlcam_get_facility_scheduleにid、空き教室探しはlcam_find_free_facilitiesを使う。',
      inputSchema: filterShape,
    },
    async (f) => {
      const res = await client.request<{ facilities: FacilityItem[] }>('/api/facilities');
      return json(filterFacilities(res.facilities, f).map(summary));
    },
  );

  server.registerTool(
    'lcam_get_facility_schedule',
    {
      title: 'LCAM施設の週間使用状況の取得',
      description:
        'LCAMの施設の1週間ぶんの使用状況（授業・予約）を取得する。' +
        'idsはlcam_list_facilitiesのid（施設コード）の配列で1〜60件。' +
        'weekは今週からの週数（-4〜8の整数。省略は今週）。' +
        '結果は、dates（月〜日のYYYY-MM-DD）と、rooms（ids順。各施設のdays[].events[]にstart・end・title・teacher・note）。' +
        '読み取り専用。',
      inputSchema: {
        ids: z.array(idSchema).min(1).max(MAX_IDS).describe('lcam_list_facilitiesのid（1〜60件）'),
        week: z
          .number()
          .int()
          .min(MIN_WEEK)
          .max(MAX_WEEK)
          .optional()
          .describe('今週からの週数（-4〜8。省略は今週。来週=1、先週=-1）'),
      },
    },
    async ({ ids, week }) => {
      const q = new URLSearchParams({ ids: ids.join(',') });
      if (week !== undefined) q.set('week', String(week));
      const res = await client.request<{ schedule: FacilityWeek }>(`/api/facilities/schedule?${q}`);
      return json(res.schedule);
    },
  );

  server.registerTool(
    'lcam_find_free_facilities',
    {
      title: 'LCAMの空き施設（空き教室）を探す',
      description:
        '指定した日時に空いている施設（空き教室）を探す。' +
        'dateはYYYY-MM-DD。時間帯は、periodで時限（1〜7。Ⅰ限09:00-10:30, Ⅱ限10:40-12:10, Ⅲ限13:00-14:30, ' +
        'Ⅳ限14:40-16:10, Ⅴ限16:20-17:50, Ⅵ限18:00-19:30, Ⅶ限19:40-21:10）か、start・end（HH:MM）のどちらか一方を必ず指定する' +
        '（両方あればstart・endを優先）。building・minCapacity・nameで対象を絞れる。' +
        '返すのは、空き施設（id・建物・施設名・定員・設備。limit件まで）、空き施設の総数、対象日時に使用中の施設の件数。' +
        '制約: 一度に調べられるのは最大60施設なので、全施設（200件超）を対象にせず建物名などで絞ること' +
        '（絞り込み後が60件を超えるとエラー）。dateは今週から見て-4〜+8週の範囲のみ。' +
        '授業・予約として登録されている情報から算出するので、登録の無い私的な利用は反映されない。読み取り専用。',
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD形式（例: 2026-09-25）')
          .describe('調べる日（YYYY-MM-DD）'),
        period: z.number().int().min(1).max(7).optional().describe('時限（1〜7）。start・endを指定するなら不要'),
        start: timeSchema.optional().describe('開始時刻（HH:MM）。endと組で指定'),
        end: timeSchema.optional().describe('終了時刻（HH:MM）。startと組で指定'),
        ...filterShape,
        limit: z.number().int().min(1).max(200).optional().describe('返す空き施設の最大件数（既定30）'),
      },
    },
    async ({ date, period, start, end, limit, ...f }) => {
      let from: string;
      let to: string;
      if (start !== undefined || end !== undefined) {
        if (start === undefined || end === undefined) throw new Error('start と end は両方指定してください。');
        if (start >= end) throw new Error('start は end より前にしてください。');
        from = start;
        to = end;
      } else if (period !== undefined) {
        const p = PERIODS.find((x) => x.period === period)!;
        from = p.start;
        to = p.end;
      } else {
        throw new Error('period（1〜7）か start・end（HH:MM）のどちらかを指定してください。');
      }

      const week = weekOffsetFromToday(date, new Date());
      if (week < MIN_WEEK || week > MAX_WEEK) {
        throw new Error(`date は今週から見て${MIN_WEEK}〜+${MAX_WEEK}週の範囲で指定してください（指定は${week}週）。`);
      }

      const listRes = await client.request<{ facilities: FacilityItem[] }>('/api/facilities');
      const targets = filterFacilities(listRes.facilities, f);
      if (targets.length === 0) throw new Error('条件に合う施設がありません。絞り込みを緩めてください。');
      if (targets.length > MAX_IDS) {
        throw new Error(
          `対象が${targets.length}施設で、一度に調べられる${MAX_IDS}施設を超えています。` +
            'building（建物名）・name・minCapacityで絞り込んでください。',
        );
      }

      const q = new URLSearchParams({ ids: targets.map((x) => x.id).join(','), week: String(week) });
      const { schedule } = await client.request<{ schedule: FacilityWeek }>(`/api/facilities/schedule?${q}`);

      const free = freeRooms(schedule.rooms, date, from, to);
      const busyCount = schedule.rooms.filter(
        (r) => r.days.some((d) => d.date === date) && busyEvents(r, date, from, to).length > 0,
      ).length;
      const byId = new Map(targets.map((x) => [x.id, x]));
      const freeItems = free.flatMap((r) => {
        const x = byId.get(r.id);
        return x ? [summary(x)] : [];
      });
      const max = limit ?? 30;
      return json({
        date,
        start: from,
        end: to,
        checkedCount: targets.length,
        freeCount: freeItems.length,
        busyCount,
        free: freeItems.slice(0, max),
        ...(freeItems.length > max ? { note: `空き施設は${freeItems.length}件。先頭${max}件のみ表示（limitで変更可）。` } : {}),
      });
    },
  );
}
