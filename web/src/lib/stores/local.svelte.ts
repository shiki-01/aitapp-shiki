// メモとカスタム予定のローカル永続化ストア（Svelte 5 runes）。
// バックエンドを持たない UI レイヤ。localStorage に JSON で保存する。
// 要件のスコープ外機能なので、サーバ同期は行わない。

const MEMO_KEY = 'aitapp.memos.v1';
const EVENT_KEY = 'aitapp.events.v1';

export interface Memo {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

export interface CustomEvent {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  start?: string; // HH:MM
  end?: string;
  note?: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function load<T>(key: string): T[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function persist<T>(key: string, value: T[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過などは黙殺
  }
}

// ---- メモ ----

class MemoStore {
  items = $state<Memo[]>(load<Memo>(MEMO_KEY));

  get sorted(): Memo[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  add(title: string, body: string): void {
    this.items.push({ id: uid(), title, body, updatedAt: Date.now() });
    persist(MEMO_KEY, this.items);
  }

  update(id: string, title: string, body: string): void {
    const m = this.items.find((x) => x.id === id);
    if (!m) return;
    m.title = title;
    m.body = body;
    m.updatedAt = Date.now();
    persist(MEMO_KEY, this.items);
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    persist(MEMO_KEY, this.items);
  }
}

export const memos = new MemoStore();

// ---- カスタム予定 ----

class EventStore {
  items = $state<CustomEvent[]>(load<CustomEvent>(EVENT_KEY));

  forDate(dateKey: string): CustomEvent[] {
    return this.items
      .filter((e) => e.date === dateKey)
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  }

  // 予定のある日付キーの集合（カレンダーのオレンジドット用）。
  get markedDates(): Set<string> {
    return new Set(this.items.map((e) => e.date));
  }

  add(ev: Omit<CustomEvent, 'id'>): void {
    this.items.push({ ...ev, id: uid() });
    persist(EVENT_KEY, this.items);
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    persist(EVENT_KEY, this.items);
  }
}

export const events = new EventStore();
