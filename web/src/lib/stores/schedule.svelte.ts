// LCAM の個人スケジュール（休講・補講・学校行事など）のキャッシュストア（Svelte 5 runes）。
// 取得は Worker が LCAM の PC 画面を週ごとにたどるため重い（1 回で十数リクエスト。LCAM の単一セッションにも
// 影響し得る）。そのため localStorage に保存し、古くなったときだけ取り直す。表示は常にキャッシュから行う。

import { api, ApiError, type ScheduleDay, type ScheduleEvent } from '$lib/api';

const KEY = 'aitapp.schedule.v3';
/** キャッシュを新しいとみなす期間。 */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** 取得に失敗したあと、自動では取り直さない期間（手動の「更新」は常に可能）。 */
const RETRY_MS = 10 * 60 * 1000;
/**
 * 取得のチャンク。カレンダーの表示範囲（今月の前後 6 か月）を、Worker の 1 リクエストで動かせる回数の上限
 * （subrequest 50）に収まるよう分けて取る。month は今月からのずらし、weeks はその月の 1 日を含む週からの週数。
 * 画面に見えている今月と近い月を先に取る。
 */
const CHUNKS: { month: number; weeks: number }[] = [
  { month: 0, weeks: 14 },
  { month: 3, weeks: 14 },
  { month: -3, weeks: 14 },
  { month: 6, weeks: 6 },
  { month: -6, weeks: 14 },
];
/** キャッシュに残す範囲（今日から前後）。表示範囲（±6 か月）より少し広い。 */
const KEEP_BEFORE_DAYS = 215;
const KEEP_AFTER_DAYS = 250;

interface Cache {
  /** 全チャンクを取り終えた時刻。途中までのときは 0（次の機会に取り直す）。 */
  fetchedAt: number;
  days: ScheduleDay[];
}

function load(): Cache | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    return Array.isArray(c.days) && typeof c.fetchedAt === 'number' ? c : null;
  } catch {
    return null;
  }
}

function persist(c: Cache): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // 容量超過などは黙殺
  }
}

class ScheduleStore {
  private cache = $state<Cache | null>(load());
  loading = $state(false);
  /** 取得中の進み（完了したチャンク数 / 全チャンク数）。 */
  progress = $state(0);
  readonly total = CHUNKS.length;
  error = $state('');
  private failedAt = 0;

  get fetchedAt(): number | null {
    return this.cache?.fetchedAt || null;
  }

  /** 取得済みの期間に含まれる日か（含まれない日は、曜日ごとの時間割で代用する）。 */
  covers(date: string): boolean {
    return this.cache?.days.some((d) => d.date === date) ?? false;
  }

  /** その日の予定（時刻順）。 */
  forDate(date: string): ScheduleEvent[] {
    const day = this.cache?.days.find((d) => d.date === date);
    return day ? [...day.events].sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
  }

  /** 授業以外の予定、または休講・補講の注記がある日付の集合（カレンダーのドット用）。 */
  get markedDates(): Set<string> {
    const out = new Set<string>();
    for (const d of this.cache?.days ?? []) {
      if (d.events.some((e) => e.period === undefined || e.note)) out.add(d.date);
    }
    return out;
  }

  get stale(): boolean {
    return !this.cache || !this.cache.fetchedAt || Date.now() - this.cache.fetchedAt > FRESH_MS;
  }

  /** 古い（または無い）ときだけ取り直す。 */
  async ensureFresh(): Promise<void> {
    // 失敗直後の画面遷移のたびに LCAM へ取りに行かない（重い取得のため）。
    if (this.stale && Date.now() - this.failedAt > RETRY_MS) await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.progress = 0;
    this.error = '';
    const merged = new Map<string, ScheduleDay>((this.cache?.days ?? []).map((d) => [d.date, d]));
    let failed: string | null = null;
    for (const chunk of CHUNKS) {
      try {
        const res = await this.fetchChunk(chunk.weeks, chunk.month);
        for (const d of res) merged.set(d.date, d);
        this.save(merged, 0);
      } catch (err) {
        // 失敗した以降は続けない（同じ理由で失敗する）。ここまでに取れた分は残す。
        failed = err instanceof ApiError ? err.message : 'スケジュールの取得に失敗しました';
        break;
      }
      this.progress++;
    }
    if (failed === null) {
      this.save(merged, Date.now());
      this.failedAt = 0;
    } else {
      this.error = failed;
      this.failedAt = Date.now();
    }
    this.loading = false;
  }

  /** 1 チャンク。LCAM は他の呼び出しと重なると一時的に失敗することがあるため、1 回だけ再試行する。 */
  private async fetchChunk(weeks: number, month: number): Promise<ScheduleDay[]> {
    try {
      return (await api.schedule(weeks, month)).schedule;
    } catch (err) {
      // 認証切れ（401）や未連携（424）は再試行しても同じ。
      if (err instanceof ApiError && (err.status === 401 || err.status === 424)) throw err;
      return (await api.schedule(weeks, month)).schedule;
    }
  }

  private save(merged: Map<string, ScheduleDay>, fetchedAt: number): void {
    const now = Date.now();
    const lo = new Date(now - KEEP_BEFORE_DAYS * 86400000).toISOString().slice(0, 10);
    const hi = new Date(now + KEEP_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
    const days = [...merged.values()]
      .filter((d) => d.date >= lo && d.date <= hi)
      .sort((a, b) => a.date.localeCompare(b.date));
    // 途中経過でも、これまでの取得完了時刻は失わない。
    this.cache = { fetchedAt: fetchedAt || (this.cache?.fetchedAt ?? 0), days };
    persist(this.cache);
  }
}

export const schedule = new ScheduleStore();
