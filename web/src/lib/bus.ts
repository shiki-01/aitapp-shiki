// 愛工大シャトルバス（八草駅 ⇄ 大学）の時刻。kajiLabTeam/ait-bus-v2 の公開 API（/api/v2/afterbus）を
// ブラウザから直接取得する（大学の認証情報は不要で、API 側が CORS を許可しているため Worker を経由しない）。
// 運行日カレンダーは API 側が年度ごとに更新するため、こちらで時刻表データは持たない。

export const BUS_SITE_URL = 'https://bus.kajilab.net/';

// API のオリジン。参考リポジトリでは front から NEXT_PUBLIC_API_URL で別指定されており、実ホストは未確認
// （MIGRATION_NOTES.md「要確認」）。違っていれば VITE_BUS_API_BASE で差し替える。
const BUS_API_BASE = import.meta.env.VITE_BUS_API_BASE ?? 'https://bus.kajilab.net';

/** [時, 分] の組。その日の全便が入る（運行のない日は空配列）。 */
export type BusTime = [number, number];
export type BusTimes = { toAIT: BusTime[]; toYakusa: BusTime[] };

export async function fetchBusTimes(): Promise<BusTimes> {
  const res = await fetch(new URL('/api/v2/afterbus', BUS_API_BASE));
  if (!res.ok) throw new Error(`bus api ${res.status}`);
  const body = (await res.json()) as { busTimes?: Partial<BusTimes> };
  return { toAIT: body.busTimes?.toAIT ?? [], toYakusa: body.busTimes?.toYakusa ?? [] };
}

/** now 以降の便を早い順に最大 count 件、"HH:MM" で返す。 */
export function nextBuses(times: BusTime[], now: Date, count = 2): string[] {
  const cur = now.getHours() * 60 + now.getMinutes();
  return times
    .map(([h, m]) => h * 60 + m)
    .filter((t) => t >= cur)
    .sort((a, b) => a - b)
    .slice(0, count)
    .map((t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
}
