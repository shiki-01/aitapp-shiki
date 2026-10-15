// お知らせ（学内連絡・授業連絡）と授業アンケートのキャッシュストア（Svelte 5 runes）。
// 一覧の取得は Worker が LCAM の Struts TOKEN を直列にたどるため遅い（1 回で 3 リクエスト、詳細は 4）。
// そのため localStorage に保存して表示は常にキャッシュから行い、裏で取り直して変化があったときだけ差し替える
// （stale-while-revalidate）。Home とお知らせタブで同じキャッシュを共有する。

import { api, ApiError, type Notice, type NoticeDetail } from '$lib/api';
import { toEnqueteView, type EnqueteView } from '$lib/enquete';
import { session } from '$lib/stores/session.svelte';

const KEY = 'aitapp.notices.v1';
/** 一覧の 1 ページ（上流 listPageNo の刻み）。 */
export const STEP = 10;
/** 直前に取ったばかりなら取り直さない期間（Home → お知らせの連続表示で LCAM を叩き直さない）。 */
const MIN_INTERVAL_MS = 30 * 1000;
/**
 * 詳細は一覧上の位置（index）で取るため、新着で位置がずれた古い一覧からは別の連絡を開いてしまう。
 * 一覧がこれより古ければ、詳細を取る前に一覧を取り直して位置を引き直す。
 */
const DETAIL_INDEX_FRESH_MS = 5 * 60 * 1000;
/** 詳細キャッシュの保持件数（古い順に捨てる）。 */
const MAX_DETAILS = 50;

export type NoticeType = 'common' | 'class';

interface ListCache {
  items: Notice[];
  /** 累積表示件数（上流 listPageNo）。 */
  count: number;
  noMore: boolean;
  fetchedAt: number;
}

interface Cache {
  /** 別アカウントのキャッシュを表示しないための持ち主。 */
  userId: string;
  common: ListCache | null;
  class: ListCache | null;
  enquetes: { items: EnqueteView[]; fetchedAt: number } | null;
  details: Record<string, { detail: NoticeDetail; at: number }>;
}

function load(): Cache | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    return typeof c.userId === 'string' && c.details ? c : null;
  } catch {
    return null;
  }
}

function persist(c: Cache | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    // 容量超過などは黙殺
  }
}

/** 詳細のキー。index は新着でずれるため、一覧の内容から作る。 */
function detailKey(n: Notice): string {
  return [n.type, n.sender, n.title, n.type === 'common' ? n.sendAt : n.makeupClassAt].join('|');
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

class NoticesStore {
  private raw = $state<Cache | null>(load());
  /** キャッシュが無い状態での初回取得中（キャッシュがあるときの裏の取り直しでは立てない）。 */
  loading = $state<Record<NoticeType | 'enquete', boolean>>({ common: false, class: false, enquete: false });
  error = $state<Record<NoticeType | 'enquete', string>>({ common: '', class: '', enquete: '' });
  loadingMore = $state(false);
  private inflight: Partial<Record<NoticeType | 'enquete', Promise<void>>> = {};

  /** ログイン中のユーザーのキャッシュ（持ち主が違えば無いものとして扱う）。 */
  private get cache(): Cache | null {
    const c = this.raw;
    return c && session.userId && c.userId === session.userId ? c : null;
  }

  private update(fn: (c: Cache) => void): void {
    const c: Cache = this.cache
      ? { ...this.cache }
      : { userId: session.userId, common: null, class: null, enquetes: null, details: {} };
    fn(c);
    this.raw = c;
    persist(c);
  }

  list(type: NoticeType): Notice[] {
    return this.cache?.[type]?.items ?? [];
  }

  /** 一覧をまだ一度も取れていないか。 */
  empty(type: NoticeType | 'enquete'): boolean {
    return !(type === 'enquete' ? this.cache?.enquetes : this.cache?.[type]);
  }

  noMore(type: NoticeType): boolean {
    return this.cache?.[type]?.noMore ?? false;
  }

  get enquetes(): EnqueteView[] {
    return this.cache?.enquetes?.items ?? [];
  }

  private recent(fetchedAt: number | undefined): boolean {
    return !!fetchedAt && Date.now() - fetchedAt < MIN_INTERVAL_MS;
  }

  /** 一覧を裏で取り直す。保存済みの件数（「もっと見る」で増やした分）を保つ。 */
  revalidate(type: NoticeType, force = false): Promise<void> {
    if (!force && this.recent(this.cache?.[type]?.fetchedAt)) return Promise.resolve();
    return (this.inflight[type] ??= this.fetchList(type).finally(() => delete this.inflight[type]));
  }

  private async fetchList(type: NoticeType): Promise<void> {
    const count = Math.max(STEP, this.cache?.[type]?.count ?? STEP);
    if (this.empty(type)) this.loading[type] = true;
    try {
      const res = await api.notices(type, count);
      // 取得中に「もっと見る」で件数が変わったら、古い件数の結果は捨てる。
      if ((this.cache?.[type]?.count ?? count) !== count) return;
      const next: ListCache = {
        items: res.notices,
        count,
        // 要求件数に満たなければ末尾に到達している。
        noMore: res.notices.length < count,
        fetchedAt: Date.now(),
      };
      this.update((c) => (c[type] = next));
      this.error[type] = '';
    } catch (err) {
      // キャッシュがあれば既存の表示を保つ。
      if (this.empty(type)) this.error[type] = errorMessage(err, '取得に失敗しました');
    } finally {
      this.loading[type] = false;
    }
  }

  /** 累積件数を増やして全件を取り直す（上流は先頭から count 件を返すため）。 */
  async more(type: NoticeType): Promise<void> {
    const cur = this.cache?.[type];
    if (this.loadingMore || !cur || cur.noMore) return;
    this.loadingMore = true;
    const next = cur.count + STEP;
    try {
      const res = await api.notices(type, next);
      const noMore = res.notices.length <= cur.items.length || res.notices.length < next;
      this.update((c) => (c[type] = { items: res.notices, count: next, noMore, fetchedAt: Date.now() }));
    } catch {
      this.update((c) => (c[type] = { ...cur, noMore: true }));
    } finally {
      this.loadingMore = false;
    }
  }

  revalidateEnquetes(force = false): Promise<void> {
    if (!force && this.recent(this.cache?.enquetes?.fetchedAt)) return Promise.resolve();
    return (this.inflight.enquete ??= this.fetchEnquetes().finally(() => delete this.inflight.enquete));
  }

  private async fetchEnquetes(): Promise<void> {
    if (this.empty('enquete')) this.loading.enquete = true;
    try {
      const items = (await api.enquetes()).items.map(toEnqueteView);
      this.update((c) => (c.enquetes = { items, fetchedAt: Date.now() }));
      this.error.enquete = '';
    } catch (err) {
      if (this.empty('enquete')) this.error.enquete = errorMessage(err, 'アンケートの取得に失敗しました');
    } finally {
      this.loading.enquete = false;
    }
  }

  /** 詳細。一度開いたものはキャッシュから返す。 */
  cachedDetail(n: Notice): NoticeDetail | null {
    return this.cache?.details[detailKey(n)]?.detail ?? null;
  }

  async detail(n: Notice): Promise<NoticeDetail> {
    const hit = this.cachedDetail(n);
    if (hit) return hit;
    let index = n.index;
    const fetchedAt = this.cache?.[n.type]?.fetchedAt ?? 0;
    if (Date.now() - fetchedAt > DETAIL_INDEX_FRESH_MS) {
      await this.revalidate(n.type, true);
      const key = detailKey(n);
      const fresh = this.list(n.type).find((x) => detailKey(x) === key);
      if (!fresh) throw new ApiError(404, 'このお知らせは見つかりませんでした');
      index = fresh.index;
    }
    const { detail } = await api.noticeDetail(n.type, index);
    this.update((c) => {
      const entries = Object.entries({ ...c.details, [detailKey(n)]: { detail, at: Date.now() } })
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_DETAILS);
      c.details = Object.fromEntries(entries);
    });
    return detail;
  }

  /** ログアウト時に消す。 */
  clear(): void {
    this.raw = null;
    persist(null);
  }
}

export const notices = new NoticesStore();
