<script lang="ts">
  import { memos, type Memo } from '$lib/stores/local.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import Syllabus from './Syllabus.svelte';

  let { userId = '', onLogout }: { userId?: string; onLogout?: () => void } = $props();

  // メモ編集シート
  let memoOpen = $state(false);
  let editing = $state<Memo | null>(null);
  let form = $state({ title: '', body: '' });

  function openNew() {
    editing = null;
    form = { title: '', body: '' };
    memoOpen = true;
  }
  function openEdit(m: Memo) {
    editing = m;
    form = { title: m.title, body: m.body };
    memoOpen = true;
  }
  function saveMemo() {
    if (!form.body.trim() && !form.title.trim()) return;
    if (editing) memos.update(editing.id, form.title.trim(), form.body.trim());
    else memos.add(form.title.trim(), form.body.trim());
    memoOpen = false;
  }

  // シラバス検索シート
  let syllabusOpen = $state(false);

  // 外部システム導線。実 URL が不明なものは導線のみ（要件: 推測補完しない）。
  const LINKS: { label: string; href: string }[] = [
    { label: '大学ポータル (AIT Portal)', href: 'https://portal.aitech.ac.jp/' },
    { label: 'Moodle', href: 'https://el.aitech.ac.jp/' },
  ];
</script>

<header class="head"><h1>その他</h1></header>

<section class="account">
  <div class="avatar"><Icon name="home" size={22} color="#fff" /></div>
  <div>
    <div class="uid">{userId || 'ゲスト'}</div>
    <div class="sub">愛工大ポータル</div>
  </div>
</section>

<!-- メモ管理 -->
<section class="block">
  <div class="block-h">
    <span><Icon name="note" size={18} color="var(--primary)" /> メモ</span>
    <button class="add" onclick={openNew}><Icon name="plus" size={15} color="#fff" /> 追加</button>
  </div>
  {#if memos.sorted.length === 0}
    <p class="empty">メモはまだありません。</p>
  {:else}
    <ul class="memos">
      {#each memos.sorted as m (m.id)}
        <li>
          <button class="memo-body" onclick={() => openEdit(m)}>
            {#if m.title}<span class="memo-title">{m.title}</span>{/if}
            <span class="memo-text">{m.body}</span>
          </button>
          <button class="del" aria-label="削除" onclick={() => memos.remove(m.id)}>
            <Icon name="close" size={16} color="var(--muted)" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- システム導線 -->
<section class="block">
  <div class="block-h"><span><Icon name="grid" size={18} color="var(--primary)" /> システム</span></div>
  <ul class="links">
    <li>
      <button class="link" onclick={() => (syllabusOpen = true)}>
        <Icon name="book" size={18} color="var(--primary)" /><span>シラバス検索</span>
        <Icon name="chevron-right" size={16} color="var(--muted)" />
      </button>
    </li>
    {#each LINKS as l}
      <li>
        <a class="link" href={l.href} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={18} color="var(--primary)" /><span>{l.label}</span>
          <Icon name="chevron-right" size={16} color="var(--muted)" />
        </a>
      </li>
    {/each}
  </ul>
</section>

<!-- 設定 -->
<section class="block">
  <div class="block-h"><span><Icon name="settings" size={18} color="var(--primary)" /> 設定</span></div>
  <ul class="links">
    <li>
      <button class="link danger" onclick={onLogout}>
        <Icon name="logout" size={18} color="var(--danger)" /><span>ログアウト</span>
      </button>
    </li>
  </ul>
</section>

<p class="version">aitapp-web · prototype</p>

<!-- メモ編集 -->
<Sheet bind:open={memoOpen} title={editing ? 'メモを編集' : 'メモを追加'}>
  <div class="form">
    <label>
      <span>タイトル（任意）</span>
      <input type="text" bind:value={form.title} />
    </label>
    <label>
      <span>本文</span>
      <textarea rows="6" bind:value={form.body}></textarea>
    </label>
    <button class="save" onclick={saveMemo} disabled={!form.body.trim() && !form.title.trim()}>
      保存する
    </button>
  </div>
</Sheet>

<!-- シラバス -->
<Sheet bind:open={syllabusOpen} title="シラバス検索">
  <Syllabus />
</Sheet>

<style>
  .head h1 {
    margin: 0 0 14px;
    font-size: 1.4rem;
    color: var(--navy);
  }
  .account {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    margin-bottom: 14px;
  }
  .avatar {
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: var(--primary-light);
    display: grid;
    place-items: center;
  }
  .uid {
    font-weight: 700;
    color: var(--navy);
  }
  .sub {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .block {
    margin-bottom: 16px;
  }
  .block-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .block-h span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: var(--navy);
    font-size: 0.9rem;
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: var(--primary);
    color: #fff;
    border-radius: 16px;
    padding: 5px 12px;
    font-size: 0.78rem;
  }
  .empty {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 6px 0;
  }
  .memos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .memos li {
    display: flex;
    align-items: stretch;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .memo-body {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    text-align: left;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .memo-title {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .memo-text {
    font-size: 0.82rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 0 12px;
    display: grid;
    place-items: center;
  }
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .link {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 13px 14px;
    text-decoration: none;
    color: var(--fg);
    font-size: 0.9rem;
  }
  .link span {
    flex: 1;
  }
  .link.danger {
    color: var(--danger);
  }
  .version {
    text-align: center;
    color: var(--muted);
    font-size: 0.75rem;
    margin: 20px 0 0;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .form input,
  .form textarea {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 1rem;
    font-family: inherit;
  }
  .save {
    border: none;
    border-radius: 10px;
    background: var(--primary);
    color: #fff;
    padding: 12px;
    font-size: 1rem;
  }
  .save:disabled {
    opacity: 0.5;
  }
</style>
