<script lang="ts">
  import {
    api,
    type Assignment,
    type LcamSessionStatus,
    type Notice,
    type TimetableEntry,
  } from '$lib/api';
  import {
    PERIODS,
    TIMETABLE_DAY_KEYS,
    WEEKDAY_LABELS,
  } from '$lib/date';
  import { memos } from '$lib/stores/local.svelte';
  import { toEnqueteView, isPending, type EnqueteView } from '$lib/enquete';
  import { submissions } from '$lib/stores/submission.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { Tab } from '$lib/components/BottomNav.svelte';

  let { userId = '', onNavigate }: { userId?: string; onNavigate?: (t: Tab) => void } = $props();

  let assignments = $state<Assignment[]>([]);
  let notices = $state<Notice[]>([]);
  let timetable = $state<TimetableEntry[]>([]);
  let enquetes = $state<EnqueteView[]>([]);
  // LCAM は MFA のため、初回に lamyapp:// の key（または Cookie）を登録する。登録済みなら Worker が自動で
  // 再ログインするので、未登録（資格情報が拒否されて破棄された場合を含む）のときだけ登録を促す
  // （登録状況の取得は KV 読み取りのみで LCAM へはアクセスしない）。取得に失敗したら何も出さない。
  let lcam = $state<LcamSessionStatus | undefined>(undefined);

  const now = new Date();
  const greeting =
    now.getHours() < 11 ? 'おはようございます' : now.getHours() < 18 ? 'こんにちは' : 'こんばんは';
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 (${WEEKDAY_LABELS[now.getDay()]})`;

  // 各 API は失敗しても握りつぶし、表示できる範囲で出す。
  $effect(() => {
    api
      .lcamSession()
      .then((r) => (lcam = r))
      .catch(() => {});
    (async () => {
      try {
        assignments = (await api.assignments()).assignments;
      } catch {
        assignments = [];
      }
    })();
    (async () => {
      try {
        notices = (await api.notices('common')).notices;
      } catch {
        notices = [];
      }
    })();
    (async () => {
      try {
        enquetes = (await api.enquetes()).items.map(toEnqueteView);
      } catch {
        enquetes = [];
      }
    })();
    (async () => {
      try {
        timetable = (await api.timetable()).timetable;
      } catch {
        timetable = [];
      }
    })();
  });

  const todayKey = TIMETABLE_DAY_KEYS[now.getDay()];
  const todayClasses = $derived(
    todayKey
      ? PERIODS.map((p) => timetable.find((e) => e.day === todayKey && e.period === p.period))
          .map((e, i) => (e ? { period: PERIODS[i], entry: e } : null))
          .filter((x): x is { period: (typeof PERIODS)[number]; entry: TimetableEntry } => !!x)
      : [],
  );

  const nextClass = $derived.by(() => {
    const hm = now.getHours() * 60 + now.getMinutes();
    return todayClasses.find((c) => {
      const [h, m] = c.period.end.split(':').map(Number);
      return h * 60 + m >= hm;
    });
  });

  // 締切なし（dueEpochMs=0）の課題も「これからの課題」に含める（期限切れではないため）。
  const upcoming = $derived(
    [...assignments]
      .filter((a) => a.dueEpochMs === 0 || a.dueEpochMs >= Date.now())
      // Moodle で提出済みの課題は「これから」に含めない（未取得のうちは残す）。
      .filter((a) => submissions.submitted(a.id) !== true)
      .sort((a, b) => (a.dueEpochMs || Number.MAX_SAFE_INTEGER) - (b.dueEpochMs || Number.MAX_SAFE_INTEGER)),
  );

  const pendingEnquetes = $derived(enquetes.filter(isPending));
  // これからの課題のうち、先頭 15 件の提出状況を取る（提出済みを一覧から外すため）。
  $effect(() => {
    const ids = upcoming.slice(0, 15).map((a) => a.id);
    if (ids.length > 0) void submissions.ensure(ids);
  });

  const latestNotices = $derived(notices.slice(0, 3));
  const recentMemos = $derived(memos.sorted.slice(0, 2));

  function fmtDue(epoch: number): string {
    if (!epoch) return '締切なし';
    const d = new Date(epoch);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const TOOLS: { label: string; tab?: Tab; href?: string }[] = [
    { label: '時間割', tab: 'calendar' },
    { label: '課題', tab: 'assignments' },
    { label: 'お知らせ', tab: 'notices' },
    { label: 'その他', tab: 'more' },
  ];
</script>

<header class="head">
  <div>
    <p class="greeting">{greeting}</p>
    <p class="date">{dateLabel}{#if userId} · {userId}{/if}</p>
  </div>
</header>

{#if lcam && !lcam.registered}
  <button class="lcam-banner" onclick={() => onNavigate?.('more')}>
    <span class="lcam-banner-title">
      {lcam.expiredAt ? 'LCAM のログインが切れています' : 'LCAM が未連携です'}
    </span>
    <span class="lcam-banner-sub">
      時間割・連絡・成績を見るには、「その他 → LCAM 連携」でログイン情報を登録してください。
    </span>
  </button>
{/if}

<!-- 次の予定 -->
<section class="card hero">
  <div class="card-h"><Icon name="clock" size={18} color="var(--primary)" /><span>次の授業</span></div>
  {#if nextClass}
    <div class="next">
      <span class="next-time">{nextClass.period.start}〜{nextClass.period.end}</span>
      <span class="next-title">{nextClass.entry.title}</span>
      <span class="next-room">{nextClass.entry.classRoom}{#if nextClass.entry.teacher} · {nextClass.entry.teacher}{/if}</span>
    </div>
  {:else}
    <p class="empty">本日の残りの授業はありません。</p>
  {/if}
</section>

<!-- クイックツール -->
<section class="tools">
  {#each TOOLS as t}
    <button class="tool" onclick={() => t.tab && onNavigate?.(t.tab)}>
      <span class="tool-label">{t.label}</span>
      <Icon name="chevron-right" size={16} color="var(--primary)" />
    </button>
  {/each}
</section>

<!-- 課題サマリ -->
<section class="card">
  <button class="card-h link" onclick={() => onNavigate?.('assignments')}>
    <Icon name="task" size={18} color="var(--primary)" /><span>これからの課題</span>
    <span class="count">{upcoming.length}</span>
    <Icon name="chevron-right" size={16} color="var(--muted)" />
  </button>
  {#if upcoming.length === 0}
    <p class="empty">提出予定の課題はありません。</p>
  {:else}
    <ul class="mini">
      {#each upcoming.slice(0, 3) as a (a.id)}
        <li>
          <span class="mini-title">{a.name}</span>
          <span class="mini-sub">{a.courseName} · {fmtDue(a.dueEpochMs)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- お知らせサマリ -->
<section class="card">
  <button class="card-h link" onclick={() => onNavigate?.('notices')}>
    <Icon name="notification" size={18} color="var(--primary)" /><span>最近のお知らせ</span>
    <Icon name="chevron-right" size={16} color="var(--muted)" />
  </button>
  {#if latestNotices.length === 0 && pendingEnquetes.length === 0}
    <p class="empty">お知らせはありません。</p>
  {:else}
    <ul class="mini">
      {#each pendingEnquetes as e (e.index)}
        <li>
          <span class="mini-title"><span class="badge">アンケート</span>{e.title}</span>
          <span class="mini-sub">
            未回答 · {e.subject}{#if e.period} · {e.period}{/if}
          </span>
        </li>
      {/each}
      {#each latestNotices as n (n.index)}
        <li>
          <span class="mini-title">{#if n.isImportant}<span class="badge">重要</span>{/if}{n.title}</span>
          <span class="mini-sub">{n.sender}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- メモ -->
<section class="card">
  <button class="card-h link" onclick={() => onNavigate?.('more')}>
    <Icon name="note" size={18} color="var(--primary)" /><span>メモ</span>
    <Icon name="chevron-right" size={16} color="var(--muted)" />
  </button>
  {#if recentMemos.length === 0}
    <p class="empty">メモはまだありません。</p>
  {:else}
    <ul class="mini">
      {#each recentMemos as m (m.id)}
        <li>
          {#if m.title}<span class="mini-title">{m.title}</span>{/if}
          <span class="mini-sub">{m.body}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 14px;
  }
  .greeting {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    color: var(--navy);
  }
  .date {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .lcam-banner {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    background: #fff7e6;
    border: 1px solid #ffd591;
    border-radius: var(--radius);
    padding: 10px 14px;
    margin-bottom: 12px;
    color: #8a5300;
  }
  .lcam-banner-title {
    font-weight: 700;
    font-size: 0.9rem;
  }
  .lcam-banner-sub {
    font-size: 0.78rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    margin-bottom: 12px;
  }
  .hero {
    background: linear-gradient(135deg, var(--primary-bg), #fff);
    border-color: var(--primary-light);
  }
  .card-h {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
    color: var(--navy);
    font-size: 0.92rem;
  }
  .card-h.link {
    width: 100%;
    border: none;
    background: none;
    padding: 0;
    text-align: left;
  }
  .card-h .count {
    margin-left: auto;
    background: var(--primary);
    color: #fff;
    border-radius: 12px;
    font-size: 0.74rem;
    padding: 1px 9px;
  }
  .card-h.link :global(svg:last-child) {
    margin-left: auto;
  }
  .card-h.link .count + :global(svg) {
    margin-left: 6px;
  }
  .next {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 10px;
  }
  .next-time {
    color: var(--primary);
    font-weight: 700;
    font-size: 0.85rem;
  }
  .next-title {
    font-size: 1.05rem;
    font-weight: 600;
  }
  .next-room {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .empty {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  }
  .tool {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
  }
  .tool-label {
    font-weight: 600;
    color: var(--navy);
  }
  .mini {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .mini li {
    display: flex;
    flex-direction: column;
  }
  .mini-title {
    font-size: 0.88rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-sub {
    font-size: 0.76rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    background: var(--important);
    color: #fff;
    border-radius: 4px;
    padding: 0 5px;
    font-size: 0.68rem;
    margin-right: 5px;
  }
</style>
