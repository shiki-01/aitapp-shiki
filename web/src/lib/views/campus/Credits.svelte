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

  // 区分の列（左）と数値の列（右）の境目。見出しの最後の行で「必要単位」を含む最初の列より左が区分。
  // 見つからない（または区分の列が無い）ときは 0 とし、13 列をそのまま出す従来表示にフォールバックする。
  const split = $derived.by(() => {
    if (!credits || credits.headerRows < 1) return 0;
    const last = credits.rows[credits.headerRows - 1];
    const i = last ? last.findIndex((t) => t.includes('必要単位')) : -1;
    return i > 0 ? i : 0;
  });

  // 見出し: split 列目以降について、見出しが 2 行以上あるとき同じ値が横に連続するセルを colspan でまとめる。
  // 区分の列（split > 0 のとき）は「区分」1 セルにまとめて出すので、ここには含めない。
  const headRows = $derived.by<HeadCell[][]>(() => {
    if (!credits) return [];
    const head = credits.rows.slice(0, credits.headerRows);
    return head.map((row, r) => {
      const cells: HeadCell[] = [];
      for (let c = split; c < row.length; c++) {
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

  // 区分の列を 1 つのラベルにする。左から順に、直前の列と同じ値・空の値は飛ばし、残りを「 › 」でつなぐ。
  function labelOf(row: string[]): string {
    const parts: string[] = [];
    for (let c = 0; c < split; c++) {
      if (row[c] === '' || (c > 0 && row[c] === row[c - 1])) continue;
      parts.push(row[c]);
    }
    return parts.join(' › ');
  }

  const TOTAL_WORDS = ['合計', '最上位合計', '中要件合計', '大要件合計', '要件外'];
  function isTotal(row: string[]): boolean {
    const label = labelOf(row);
    return TOTAL_WORDS.some((w) => label.includes(w));
  }

  // 左側の「区分」の列の数。前の行と（左の列も含めて）同じ値が続く列を、左から数える。
  const labelCols = $derived.by(() => {
    if (split > 0) return 0;
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
    <table class:grouped={split > 0}>
      <thead>
        {#each headRows as row, r}
          <tr>
            {#if split > 0 && r === 0}
              <th class="label-head" rowspan={headRows.length}>区分</th>
            {/if}
            {#each row as cell}
              <th colspan={cell.span} class:dup={cell.dup}>{cell.text}</th>
            {/each}
          </tr>
        {/each}
      </thead>
      <tbody>
        {#each bodyRows as row, r}
          <tr class:total={split > 0 && isTotal(row)}>
            {#if split > 0}
              <td class="label group">{labelOf(row)}</td>
            {/if}
            {#each row.slice(split) as cell, i}
              <td
                class:label={split === 0 && i < labelCols}
                class:num={split > 0}
                class:dup={split === 0 && i < labelCols && isRepeat(r, i)}>{cell}</td
              >
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
  /* 区分の列を 1 つにまとめた表示（モバイルでも数値の列が見えるよう、余白とフォントを詰める）。 */
  table.grouped {
    font-size: 0.75rem;
  }
  table.grouped th,
  table.grouped td {
    padding: 6px 3px;
  }
  table.grouped th {
    white-space: normal;
    min-width: 2.4em;
    line-height: 1.3;
  }
  table.grouped td.num {
    text-align: right;
  }
  table.grouped th.label-head,
  table.grouped td.group {
    position: sticky;
    left: 0;
    z-index: 1;
    min-width: 5.5em;
    max-width: 7.5em;
    padding-left: 8px;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.35;
    background: var(--card);
    box-shadow: 1px 0 0 var(--border);
  }
  table.grouped th.label-head {
    background: var(--primary-bg);
  }
  table.grouped tr.total td {
    background: var(--primary-bg);
    font-weight: 700;
    color: var(--navy);
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
