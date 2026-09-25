<script lang="ts">
  import { api, ApiError, type CreditStatus } from '$lib/api';

  let credits = $state<CreditStatus | null>(null);
  let loading = $state(true);
  let error = $state('');
  // 再読込の連打で古い応答が新しい結果を上書きしないよう、最新の要求だけ採用する。
  let seq = 0;

  // message に相関 ID が含まれない経路(desktop 版など)でも見せる。browser 版は message に含まれる。
  function errorText(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError)) return fallback;
    const id = err.correlationId;
    return id && !err.message.includes(id) ? `${err.message}（エラーコード: ${id}）` : err.message;
  }

  // 学事システムは入るたびに数リクエスト要るので、開いたときの 1 回と再読込ボタンでだけ取得する。
  async function load() {
    const my = ++seq;
    loading = true;
    error = '';
    try {
      const res = await api.credits();
      if (my !== seq) return;
      credits = res.credits;
    } catch (err) {
      if (my !== seq) return;
      credits = null;
      error = errorText(err, '単位修得情報の取得に失敗しました');
    } finally {
      if (my === seq) loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  interface HeadCell {
    text: string;
    span: number;
    // 上の見出し行と同じ値（結合セルの展開）。薄く見せる。
    dup: boolean;
  }

  // 見出し: 見出しが 2 行以上あるとき、同じ値が横に連続するセルを colspan でまとめる。
  const headRows = $derived.by<HeadCell[][]>(() => {
    if (!credits) return [];
    const head = credits.rows.slice(0, credits.headerRows);
    return head.map((row, r) => {
      const cells: HeadCell[] = [];
      for (let c = 0; c < row.length; c++) {
        const last = cells[cells.length - 1];
        if (head.length >= 2 && last && last.text === row[c]) {
          last.span++;
          continue;
        }
        cells.push({ text: row[c], span: 1, dup: r > 0 && row[c] !== '' && head[r - 1][c] === row[c] });
      }
      return cells;
    });
  });

  const bodyRows = $derived(credits ? credits.rows.slice(credits.headerRows) : []);

  // 左側の「区分」の列の数。前の行と（左の列も含めて）同じ値が続く列を、左から数える。
  const labelCols = $derived.by(() => {
    const cols = bodyRows[0]?.length ?? 0;
    let n = 0;
    while (n < cols && bodyRows.some((_, r) => isRepeat(r, n))) n++;
    return n;
  });

  // r 行 c 列が、上の行と同じ値（かつ左の列もすべて同じ）＝結合セルの展開か。
  function isRepeat(r: number, c: number): boolean {
    if (r === 0 || bodyRows[r][c] === '') return false;
    for (let k = 0; k <= c; k++) if (bodyRows[r][k] !== bodyRows[r - 1][k]) return false;
    return true;
  }
</script>

<div class="bar">
  <button class="reload" onclick={load} disabled={loading}>再読込</button>
</div>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if error}
  <div class="error-box">
    <p class="error">{error}</p>
    <button class="retry" onclick={load}>再試行</button>
  </div>
{:else if !credits || bodyRows.length === 0}
  <p class="muted">単位修得の情報はありません。</p>
{:else}
  {#if credits.note}
    <p class="callout">{credits.note}</p>
  {/if}
  {#if credits.tabs.length > 0}
    <p class="note">
      表示しているのは既定のタブのみです（上流のタブ: {credits.tabs.join('、')}）。
    </p>
  {/if}
  <div class="scroll">
    <table>
      <thead>
        {#each headRows as row}
          <tr>
            {#each row as cell}
              <th colspan={cell.span} class:dup={cell.dup}>{cell.text}</th>
            {/each}
          </tr>
        {/each}
      </thead>
      <tbody>
        {#each bodyRows as row, r}
          <tr>
            {#each row as cell, c}
              <td class:label={c < labelCols} class:dup={c < labelCols && isRepeat(r, c)}>{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 10px;
  }
  .reload {
    padding: 6px 14px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-size: 0.85rem;
  }
  .reload:disabled {
    opacity: 0.5;
  }
  .callout {
    margin: 0 0 8px;
    padding: 10px 12px;
    background: var(--primary-bg);
    color: var(--navy);
    border-radius: var(--radius-sm, 8px);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 12px;
  }
  .scroll {
    overflow-x: auto;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    white-space: nowrap;
  }
  th {
    background: var(--primary-bg);
    color: var(--navy);
    font-weight: 600;
    text-align: center;
  }
  td.label {
    color: var(--navy);
    font-weight: 600;
  }
  /* 結合セルの展開で同じ値が繰り返される所は薄くして、区切りを読みやすくする。 */
  .dup {
    color: var(--primary-pale);
    font-weight: 400;
  }
  .muted {
    color: var(--muted);
    text-align: center;
    margin: 14px 0;
    font-size: 0.85rem;
  }
  .error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .error-box {
    text-align: center;
  }
  .retry {
    padding: 9px 22px;
    border: 1px solid var(--primary-light);
    background: var(--card);
    color: var(--primary);
    border-radius: 12px;
    font-weight: 500;
  }
</style>
