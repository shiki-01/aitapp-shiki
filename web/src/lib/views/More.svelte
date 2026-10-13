<script lang="ts">
  import { memos, type Memo } from '$lib/stores/local.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import Campus from '$lib/views/Campus.svelte';
  import SlideView from '$lib/components/SlideView.svelte';
  import { api, ApiError, type LcamSessionStatus } from '$lib/api';
  import { isDesktop, isTauri } from '$lib/platform';
  import { onActivate, sameData } from '$lib/activate.svelte';

  let { userId = '', onLogout, active = true }: { userId?: string; onLogout?: () => void; active?: boolean } = $props();

  // 「学内サービス」を開いている間は More の本体の代わりに Campus を出す（下タブは増やさない）。
  let campusOpen = $state(false);

  // ---- 確認ダイアログ ----
  // window.confirm() は Tauri の WebView（macOS の WKWebView）では常に false を返す
  // （wry が JS の確認パネルを実装していない）。デスクトップ版でも動くよう、アプリ内の Sheet で確認する。
  let confirmOpen = $state(false);
  let confirmMessage = $state('');
  let confirmOkLabel = $state('実行する');
  let confirmResolve: ((ok: boolean) => void) | null = null;

  function ask(message: string, okLabel = '実行する'): Promise<boolean> {
    confirmMessage = message;
    confirmOkLabel = okLabel;
    confirmOpen = true;
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }
  function answer(ok: boolean) {
    const r = confirmResolve;
    confirmResolve = null;
    confirmOpen = false;
    r?.(ok);
  }
  // 背景タップ・Esc・✕ で閉じた場合は「キャンセル」として扱う。
  $effect(() => {
    if (!confirmOpen && confirmResolve) {
      const r = confirmResolve;
      confirmResolve = null;
      r(false);
    }
  });

  // ---- LCAM 連携（アプリ方式 / Cookie 登録）----
  // LCAM は多要素認証のため、アプリ方式（URL キー）または Cookie で登録して使う。
  // セッション情報（時刻）のみサーバーから返される。
  let lcam = $state<LcamSessionStatus | undefined>(undefined);
  let lcamAppKey = $state('');
  let lcamBusy = $state(false);
  let lcamError = $state('');
  let lcamDone = $state(false);

  function loadLcam() {
    api
      .lcamSession()
      .then((r) => {
        if (!sameData(r, lcam)) lcam = r;
      })
      .catch(() => {});
  }
  onActivate(() => active, loadLcam);

  function fmtTime(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString('ja-JP') : '—';
  }

  // デスクトップ版のみ: WebView で SSO を通して Cookie を自動登録する。
  let lcamAuto = $state<boolean | undefined>(undefined);
  let lcamConnecting = $state(false);
  // 「LCAM に接続」の結果。ボタンの直下に表示する（貼り付け欄の下だと見落とすため）。
  let lcamConnectResult = $state<{ ok: boolean; text: string } | null>(null);

  onActivate(() => active, () => {
    api.lcamAutoGet?.().then((v) => (lcamAuto = v)).catch(() => {});
  });

  async function connectLcam() {
    lcamConnecting = true;
    lcamError = '';
    lcamDone = false;
    lcamConnectResult = null;
    try {
      await api.lcamConnect?.();
      lcamConnectResult = {
        ok: true,
        text: `接続しました（${new Date().toLocaleTimeString('ja-JP')}）。LCAM のデータが見られます。`,
      };
      loadLcam();
    } catch (e) {
      lcamConnectResult = {
        ok: false,
        text: e instanceof ApiError || e instanceof Error ? e.message : String(e),
      };
    } finally {
      lcamConnecting = false;
    }
  }

  // checkbox は押した瞬間に見た目が変わるため、キャンセル/失敗時は保存済みの状態へ戻す。
  async function toggleLcamAuto(el: HTMLInputElement) {
    const next = !(lcamAuto === true);
    if (
      next &&
      !(await ask(
        'LCAM が切れたとき、アプリが自動でログインし直します。LCAM は 1 つの端末でしか使えないため、ブラウザや公式アプリで開いている LCAM は切れます。オンにしますか？',
        'オンにする',
      ))
    ) {
      el.checked = lcamAuto === true;
      return;
    }
    try {
      await api.lcamAutoSet?.(next);
      lcamAuto = next;
    } catch (e) {
      lcamError = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      el.checked = lcamAuto === true;
    }
  }

  async function registerLcamAppKey() {
    lcamBusy = true;
    lcamError = '';
    lcamDone = false;
    try {
      await api.lcamAppKeySet(lcamAppKey.trim());
      lcamAppKey = '';
      lcamDone = true;
      loadLcam();
    } catch (e) {
      lcamError = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    } finally {
      lcamBusy = false;
    }
  }

  async function deleteLcam() {
    if (!(await ask('LCAM の登録を解除します。時間割・連絡などが見られなくなります。よろしいですか？', '解除する'))) {
      return;
    }
    lcamBusy = true;
    lcamError = '';
    try {
      await api.lcamSessionDelete();
      loadLcam();
    } catch (e) {
      lcamError = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    } finally {
      lcamBusy = false;
    }
  }

  // ---- Claude 連携（ユーザー別 MCP URL）----
  // 発行済みかどうかは /api/auth/me の mcp フラグ（desktop 版では取得できず undefined）。
  // 平文 URL は発行直後の応答でしか得られないため、この画面でだけ表示する。
  let mcpIssued = $state<boolean | undefined>(undefined);
  let mcpUrl = $state('');
  let mcpBusy = $state(false);
  let mcpError = $state('');
  let mcpCopied = $state(false);
  let mcpWrites = $state<boolean | undefined>(undefined);

  onActivate(() => active, () => {
    api
      .me()
      .then((r) => {
        mcpIssued = r.mcp;
        mcpWrites = r.mcpWrites;
      })
      .catch(() => {});
  });

  async function issueMcp() {
    if (
      mcpIssued &&
      !(await ask('再発行すると、いま設定済みの MCP URL は使えなくなります。続けますか？', '再発行する'))
    ) {
      return;
    }
    mcpBusy = true;
    mcpError = '';
    try {
      const r = await api.mcpTokenIssue();
      mcpUrl = r.url;
      mcpIssued = true;
      mcpCopied = false;
    } catch (e) {
      mcpError = e instanceof Error ? e.message : String(e);
    } finally {
      mcpBusy = false;
    }
  }

  async function revokeMcp() {
    if (!(await ask('MCP URL を失効させます。設定済みのコネクタは使えなくなります。よろしいですか？', '失効させる'))) {
      return;
    }
    mcpBusy = true;
    mcpError = '';
    try {
      await api.mcpTokenRevoke();
      mcpIssued = false;
      mcpUrl = '';
    } catch (e) {
      mcpError = e instanceof Error ? e.message : String(e);
    } finally {
      mcpBusy = false;
    }
  }

  async function copyMcpUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      mcpCopied = true;
    } catch {
      // clipboard 不可の環境ではテキストを手動選択してもらう。
    }
  }

  async function toggleMcpWrites(el: HTMLInputElement) {
    const next = !(mcpWrites === true);
    if (
      next &&
      !(await ask(
        'Claude がこの MCP 接続から、クイズの受験開始・課題やアンケートの提出など取り消せない操作を実行できるようになります。許可しますか？',
        '許可する',
      ))
    ) {
      el.checked = mcpWrites === true;
      return;
    }
    mcpBusy = true;
    mcpError = '';
    try {
      const r = await api.mcpWritesSet(next);
      mcpWrites = r.allow;
    } catch (e) {
      mcpError = e instanceof Error ? e.message : String(e);
    } finally {
      mcpBusy = false;
    }
  }

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

  // 外部システム導線。実 URL が不明なものは導線のみ（要件: 推測補完しない）。
  const LINKS: { label: string; href: string }[] = [
    { label: '大学ポータル (AIT Portal)', href: 'https://portal.aitech.ac.jp/' },
    { label: 'Moodle', href: 'https://cms.aitech.ac.jp/' },
  ];
</script>

<SlideView view={campusOpen ? 'campus' : 'more'} forward={campusOpen}>
{#snippet children(v)}
{#if v === 'campus'}
  <Campus onBack={() => (campusOpen = false)} />
{:else}
<header class="head"><h1>その他</h1></header>

<section class="account">
  <div class="avatar"><Icon name="home" size={22} color="#fff" /></div>
  <div>
    <div class="uid">{userId || 'ゲスト'}</div>
    <div class="sub">aitapp</div>
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
      <button class="link" onclick={() => (campusOpen = true)}>
        <Icon name="note" size={18} color="var(--primary)" /><span>学内サービス</span>
        <Icon name="chevron-right" size={16} color="var(--muted)" />
      </button>
    </li>
    <li>
      <!-- ブラウザ/PWA は新規タブ。Tauri にはタブが無いので同一ウィンドウで遷移する。 -->
      <a class="link" href="/syllabus" target={isTauri ? undefined : '_blank'} rel="noopener">
        <Icon name="book" size={18} color="var(--primary)" /><span>シラバス検索</span>
        <Icon name="chevron-right" size={16} color="var(--muted)" />
      </a>
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

<!-- LCAM 連携 -->
<section class="block">
  <div class="block-h">
    <span><Icon name="grid" size={18} color="var(--primary)" /> LCAM 連携</span>
  </div>
  <div class="mcp card">
    <p class="mcp-desc">
      LCAM（連絡・時間割・成績・アンケート）は多要素認証のため、アプリ登録方式または Cookie 登録で使います。
      アプリ登録方式は公式アプリと同じで、一度登録すると失効しても自動で再ログインします。
      LCAM は同時に 1 か所しかログインできないため、PC 版ブラウザや公式アプリで LCAM にログインするとこの連携は切れます。
      その場合は次の操作で自動的に再ログインしますが、そのとき他の場所のログインが切れます。
    </p>
    {#if lcam}
      <p class="mcp-note">
        {#if lcam.appRegistered}
          <b>アプリ方式で登録済み</b>（登録 {fmtTime(lcam.registeredAt)} ／ 最終成功 {fmtTime(lcam.lastOkAt)}）
          <br />失効しても自動で再ログインします。
        {:else if lcam.registered}
          Cookie で登録済み（登録 {fmtTime(lcam.registeredAt)} ／ 最終成功 {fmtTime(lcam.lastOkAt)}）
        {:else if lcam.expiredAt}
          失効を検知しました（{fmtTime(lcam.expiredAt)}）。再登録してください。
        {:else}
          未登録です。
        {/if}
      </p>
    {/if}
    {#if api.lcamConnect}
      <div class="mcp-actions">
        <button class="mcp-issue" onclick={connectLcam} disabled={lcamConnecting || lcamBusy}>
          {lcamConnecting ? '接続中…（開いた画面でログイン）' : 'LCAM に接続（ログイン画面を開く）'}
        </button>
      </div>
      {#if lcamConnectResult}
        <p class={lcamConnectResult.ok ? 'lcam-ok' : 'mcp-error'}>{lcamConnectResult.text}</p>
      {/if}
      <p class="mcp-note">
        デスクトップ版です。開いたウィンドウで Microsoft のログイン（番号入力など）を通すと、自動でアプリ方式で登録されます。
        下の URL 貼り付けは不要です。
      </p>
      <label class="mcp-writes">
        <input
          type="checkbox"
          checked={lcamAuto === true}
          disabled={lcamAuto === undefined}
          onchange={(e) => toggleLcamAuto(e.currentTarget)}
        />
        <span>
          切れたとき自動で再接続する
          <small>
            {#if isDesktop}
              アプリを開いている間だけ。番号入力などが要るときは自動では進めず、6 時間止まります。
            {:else}
              アプリを開いたときに LCAM が切れていれば、ログイン画面を自動で開いて接続します（30 分に 1 回まで）。
            {/if}
          </small>
        </span>
      </label>
      <p class="mcp-note">または、lamyapp:// URL を貼り付けて登録（手動方式）:</p>
    {/if}
    <textarea
      class="lcam-input"
      rows="3"
      placeholder="lamyapp://lcam?key=… または key=… の部分だけ"
      bind:value={lcamAppKey}
      autocomplete="off"
      spellcheck="false"
    ></textarea>
    <p class="mcp-note">
      <b>登録手順（手動方式）:</b> PC のブラウザで DevTools（F12）→ Network →「Preserve log」ON にして、
      https://lcam.aitech.ac.jp/portalv2/sp を開き、「ログイン」から MFA まで完了する。
      最後に <code>lamyapp://lcam?key=…</code> へ遷移する（Network の 302 Location、または Console のエラーメッセージに URL が出ます）。
      その URL をコピーして下に貼り付けます。key は使い捨てで短時間で無効になるため、コピーしたらすぐ登録してください。
    </p>
    <p class="mcp-note">
      手動の登録が要るのは初回だけです。デスクトップ版（上の「LCAM に接続」ボタン）なら、この手順なしで登録できます。
    </p>
    {#if lcamError}<p class="mcp-error">{lcamError}</p>{/if}
    {#if lcamDone}<p class="mcp-note">登録しました。</p>{/if}
    <div class="mcp-actions">
      <button class="mcp-issue" onclick={registerLcamAppKey} disabled={lcamBusy || !lcamAppKey.trim()}>
        {lcamBusy ? '確認中…' : 'URL を登録'}
      </button>
      {#if lcam?.registered}
        <button class="mcp-revoke" onclick={deleteLcam} disabled={lcamBusy}>
          登録を解除
        </button>
      {/if}
    </div>
  </div>
</section>

<!-- Claude 連携（ユーザー別 MCP URL） -->
<section class="block">
  <div class="block-h">
    <span><Icon name="grid" size={18} color="var(--primary)" /> Claude 連携 (MCP)</span>
  </div>
  <div class="mcp card">
    <p class="mcp-desc">
      自分専用の MCP URL を発行すると、Claude（カスタムコネクタ）から自分のアカウントで
      時間割・課題・お知らせ等を参照できます。URL はパスワードと同じ扱いで保管し、
      他人に共有しないでください。
    </p>
    {#if mcpUrl}
      <div class="mcp-url-box">
        <code class="mcp-url">{mcpUrl}</code>
        <button class="mcp-copy" onclick={copyMcpUrl}>
          {#if mcpCopied}<Icon name="check" size={15} color="var(--primary)" /> コピー済み{:else}コピー{/if}
        </button>
      </div>
      <p class="mcp-note">この URL は今しか表示されません。再表示はできず、必要なら再発行になります。</p>
      <p class="mcp-note">
        発行・再発行の反映には最大 1 分ほどかかることがあります。Claude のコネクタ登録で
        「サインインサービスに登録できませんでした」等のエラーが出た場合は、少し待ってから
        再試行してください。
      </p>
    {:else if mcpIssued}
      <p class="mcp-note">発行済みです（URL の再表示はできません。紛失した場合は再発行してください）。</p>
    {/if}
    {#if mcpError}<p class="mcp-error">{mcpError}</p>{/if}
    <div class="mcp-actions">
      <button class="mcp-issue" onclick={issueMcp} disabled={mcpBusy}>
        {mcpIssued ? 'MCP URL を再発行' : 'MCP URL を発行'}
      </button>
      {#if mcpIssued}
        <button class="mcp-revoke" onclick={revokeMcp} disabled={mcpBusy}>失効</button>
      {/if}
    </div>
    <label class="mcp-writes">
      <input
        type="checkbox"
        checked={mcpWrites === true}
        disabled={mcpBusy || mcpWrites === undefined}
        onchange={(e) => toggleMcpWrites(e.currentTarget)}
      />
      <span>
        不可逆操作を許可（クイズ受験開始・課題/アンケート提出）
        <small>オフの間、Claude からの提出系操作はすべて拒否されます。</small>
      </span>
    </label>
  </div>
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
{/if}
{/snippet}
</SlideView>

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

<!-- 確認ダイアログ（window.confirm の代わり。Tauri の WebView では confirm が常に false になるため） -->
<Sheet bind:open={confirmOpen} title="確認">
  <div class="form">
    <p class="confirm-msg">{confirmMessage}</p>
    <div class="confirm-actions">
      <button class="confirm-cancel" onclick={() => answer(false)}>キャンセル</button>
      <button class="save" onclick={() => answer(true)}>{confirmOkLabel}</button>
    </div>
  </div>
</Sheet>

<style>
  .confirm-msg {
    margin: 0 0 14px;
    font-size: 0.9rem;
    line-height: 1.6;
    color: var(--fg);
  }
  .confirm-actions {
    display: flex;
    gap: 10px;
  }
  .confirm-actions button {
    flex: 1;
  }
  .confirm-cancel {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
    color: var(--fg);
    padding: 11px;
    font-size: 0.95rem;
  }
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
  .mcp.card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 13px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .mcp-desc {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
    line-height: 1.5;
  }
  .mcp-url-box {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg, #f5f6f8);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
  }
  .mcp-url {
    flex: 1;
    min-width: 0;
    font-size: 0.72rem;
    word-break: break-all;
    user-select: all;
  }
  .mcp-copy {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 0.75rem;
  }
  .mcp-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .mcp-error {
    margin: 0;
    font-size: 0.78rem;
    color: var(--danger);
  }
  .mcp-actions {
    display: flex;
    gap: 8px;
  }
  .mcp-issue {
    border: none;
    border-radius: 10px;
    background: var(--primary);
    color: #fff;
    padding: 9px 14px;
    font-size: 0.85rem;
  }
  .mcp-revoke {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
    color: var(--danger);
    padding: 9px 14px;
    font-size: 0.85rem;
  }
  .mcp-issue:disabled,
  .mcp-revoke:disabled {
    opacity: 0.5;
  }
  .lcam-ok {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--primary);
  }
  .lcam-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    resize: vertical;
  }
  .mcp-writes {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.82rem;
    color: var(--fg);
  }
  .mcp-writes input {
    margin-top: 2px;
  }
  .mcp-writes small {
    display: block;
    color: var(--muted);
    font-size: 0.72rem;
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
