<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api';

  let id = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state('');

  async function submit(e: Event) {
    e.preventDefault();
    error = '';
    if (id.trim().length < 2 || password.trim().length < 2) {
      error = 'ID とパスワードを入力してください';
      return;
    }
    loading = true;
    try {
      await api.login(id.trim(), password.trim());
      await goto('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        error = 'ID またはパスワードが異なります';
      } else if (err instanceof ApiError) {
        // サーバー側エラー（上流障害等）。correlationId を含む message をそのまま見せて
        // 問い合わせ・ログ照合（wrangler tail）に使えるようにする。
        error = `ログインに失敗しました（HTTP ${err.status}）: ${err.message}`;
      } else {
        error = '通信エラーが発生しました（サーバーに接続できません）';
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <h1>愛工大ポータル</h1>
    <p class="sub">ログイン</p>
    <p class="hint">
      Moodle と同じ ID・パスワードです。LCAM（連絡・時間割・成績）は多要素認証のため、
      ログイン後に「その他 → LCAM 連携」から別途つなぎます。
    </p>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    <label>
      <span>愛工大 ID</span>
      <input
        type="text"
        bind:value={id}
        autocomplete="username"
        inputmode="email"
      />
    </label>
    <label>
      <span>パスワード</span>
      <input type="password" bind:value={password} autocomplete="current-password" />
    </label>
    <button type="submit" disabled={loading}>
      {loading ? 'ログイン中…' : 'ログイン'}
    </button>
  </form>
</div>

<style>
  .wrap {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .card {
    background: var(--card);
    border-radius: 16px;
    padding: 32px 28px;
    width: 100%;
    max-width: 360px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h1 {
    margin: 0;
    font-size: 1.3rem;
    text-align: center;
  }
  .sub {
    margin: 0;
    text-align: center;
    color: var(--muted);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--muted);
  }
  input {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 1rem;
  }
  button {
    margin-top: 8px;
    padding: 12px;
    border: none;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
    font-size: 1rem;
  }
  button:disabled {
    opacity: 0.6;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.9rem;
    text-align: center;
  }
</style>
