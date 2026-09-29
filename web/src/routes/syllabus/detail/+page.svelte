<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api, ApiError, type SyllabusDetail, type SyllabusListItem } from '$lib/api';
  import { session } from '$lib/stores/session.svelte';
  import Icon from '$lib/components/Icon.svelte';

  // 開き方は 2 通り。どちらも URL だけで再現できる（再読み込みしても開ける）。
  //  - url + 検索条件: シラバス検索の結果から。
  //  - title (+ teacher, date): カレンダーの授業から。科目名で検索して該当のシラバスを探す。
  // from は戻る先の既定（履歴が無いとき用）。
  const q = page.url.searchParams;
  const from = q.get('from') === 'calendar' ? 'calendar' : 'search';

  let checking = $state(!session.userId);
  let loading = $state(true);
  let error = $state('');
  let detail = $state<SyllabusDetail | null>(null);

  function back() {
    if (history.length > 1) history.back();
    else void goto(from === 'calendar' ? '/calendar' : '/syllabus', { replaceState: true });
  }

  // 科目名の表記ゆれ（全角半角・空白）を吸収して比べる。
  const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

  // 日付の属する年度（4 月始まり）。
  function academicYear(date: string | null): number {
    const d = date ? new Date(date) : new Date();
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  }

  function pick(list: SyllabusListItem[], title: string, teacher: string): SyllabusListItem | undefined {
    const t = norm(title);
    let c = list.filter((r) => norm(r.subject) === t);
    if (c.length === 0) c = list.filter((r) => norm(r.subject).includes(t) || t.includes(norm(r.subject)));
    if (c.length > 1 && teacher) {
      const names = teacher.split(/[\s,、，・/／]+/).filter(Boolean).map(norm);
      const byTeacher = c.filter((r) => names.some((n) => norm(r.teacher).includes(n)));
      if (byTeacher.length > 0) c = byTeacher;
    }
    return c[0];
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const url = q.get('url');
      if (url) {
        const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        const res = await api.syllabusDetail(url, {
          year: q.get('year') ?? undefined,
          word: q.get('word') ?? undefined,
          campus: num('campus'),
          semester: num('semester'),
          week: num('week'),
          hour: num('hour'),
          folder: q.get('folder') ?? undefined,
        });
        detail = res.detail;
        return;
      }
      const title = q.get('title')?.trim();
      if (!title) {
        error = '科目が指定されていません';
        return;
      }
      const ay = String(academicYear(q.get('date')));
      const { filters } = await api.syllabusFilters();
      const years = Object.values(filters.year);
      const year = years.find((v) => v === ay) ?? years[0];
      if (!year) {
        error = '年度を取得できませんでした';
        return;
      }
      const { results } = await api.syllabusSearch({ year, word: title });
      const hit = pick(results, title, q.get('teacher') ?? '');
      if (!hit) {
        error = `「${title}」のシラバスが見つかりませんでした。シラバス検索から探してください。`;
        return;
      }
      const res = await api.syllabusDetail(hit.url, { year, word: title });
      detail = res.detail;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'シラバスの取得に失敗しました';
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    try {
      const me = await api.me();
      session.userId = me.userId;
      checking = false;
    } catch {
      await goto('/login');
      return;
    }
    await load();
  });
</script>

<svelte:head><title>{detail?.subject ?? 'シラバス'}</title></svelte:head>

<main>
  <header class="head">
    <button class="back" aria-label={from === 'calendar' ? 'カレンダーへ戻る' : 'シラバス検索へ戻る'} onclick={back}>
      <Icon name="chevron-left" size={22} color="var(--primary)" />
    </button>
    <h1>{detail?.subject ?? 'シラバス'}</h1>
  </header>

  {#if checking || loading}
    <p class="muted">読み込み中…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if detail}
    <div class="meta">
      {detail.teachers.map((t) => t.name).join(', ')} · {detail.semester} ·
      {detail.classPeriod} · {detail.classRoom}
    </div>
    <div class="meta">{detail.classification} · {detail.unitsNumber}単位</div>
    {@render Section('概要', detail.content)}
    {@render Section('学習到達目標', [detail.learningGoal])}
    {@render Section('方法と特徴', [detail.features])}
    {@render Section('成績評価の方法', [detail.records])}
    {@render Section('計画', detail.plan)}
    {@render Section('教科書', [detail.textBook])}
    {@render Section('参考書', [detail.referenceBook])}
    {@render Section('教員からのメッセージ', [detail.teachersMessage])}
  {/if}
</main>

{#snippet Section(title: string, lines: string[])}
  {#if lines.some((l) => l && l !== '不明')}
    <h2>{title}</h2>
    {#each lines as l}
      {#if l && l !== '不明'}<p>{l}</p>{/if}
    {/each}
  {/if}
{/snippet}

<style>
  main {
    padding: 18px 16px 32px;
    min-height: 100dvh;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
    color: var(--navy);
  }
  .back {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 4px;
    margin-left: -6px;
    display: grid;
    place-items: center;
  }
  h2 {
    margin: 18px 0 4px;
    font-size: 0.95rem;
    color: var(--navy);
  }
  p {
    margin: 0 0 6px;
    white-space: pre-wrap;
  }
  .meta {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
