<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    open = $bindable(),
    title = '',
    tall = false,
    children,
  }: {
    open: boolean;
    title?: string;
    /** 上に余白を残して画面下まで伸ばした固定高にする。ヘッダーを上へ引くと余白なしに広がり、下へ引くと戻る/閉じる */
    tall?: boolean;
    children: import('svelte').Snippet;
  } = $props();

  // 通常時に上へ残す余白(px)。CSS の高さ計算と揃える
  const TOP_GAP = 200;
  // 余白ぶんを超えて下へ引いて離すと閉じる(px)
  const CLOSE_DRAG = 110;
  // 上へこれだけ引いて離すと余白なし、余白なし状態から下へこれだけ引くと通常に戻る(px)
  const SNAP_DRAG = 60;
  const RADIUS = 20;
  // 閉じるアニメーションの長さ(ms)。CSS の transition と揃える
  const CLOSE_MS = 220;

  let expanded = $state(false);
  let dy = $state(0);
  let dragging = $state(false);
  let closing = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let startY = 0;
  let pointerId = -1;

  // 現在の上余白(0 = 余白なし)と、余白を使い切ったあとの下方向の引き量
  let raw = $derived((expanded ? 0 : TOP_GAP) + dy);
  let gap = $derived(Math.min(Math.max(raw, 0), TOP_GAP));
  let overshoot = $derived(Math.max(raw - TOP_GAP, 0));

  $effect(() => {
    if (!open) {
      expanded = false;
      dy = 0;
      dragging = false;
      closing = false;
      clearTimeout(closeTimer);
    }
  });

  // 画面下までスライドしきってから閉じる
  function close() {
    if (closing) return;
    closing = true;
    dragging = false;
    closeTimer = setTimeout(() => {
      open = false;
    }, CLOSE_MS);
  }

  function dragStart(e: PointerEvent) {
    if (!tall || closing || (e.target as HTMLElement).closest('button')) return;
    dragging = true;
    startY = e.clientY;
    pointerId = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function dragMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== pointerId) return;
    dy = e.clientY - startY;
  }

  function dragEnd(e: PointerEvent) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (overshoot > CLOSE_DRAG) {
      close();
      return;
    }
    expanded = expanded ? gap < SNAP_DRAG : TOP_GAP - gap > SNAP_DRAG;
    dy = 0;
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} />

{#if open}
  <div
    class="overlay"
    class:closing
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && close()}
  >
    <div
      class="sheet"
      class:tall
      class:dragging
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      style:transform={closing
        ? 'translateY(100%)'
        : overshoot > 0
          ? `translateY(${overshoot}px)`
          : undefined}
      style:height={tall ? `calc(100dvh - ${gap}px)` : undefined}
      style:border-radius={tall ? `${RADIUS * (gap / TOP_GAP)}px ${RADIUS * (gap / TOP_GAP)}px 0 0` : undefined}
      style:--k={tall ? 1 - gap / TOP_GAP : undefined}
    >
      <!-- ドラッグは補助操作。キーボードでは × ボタン / Esc で閉じられる -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header
        class:draggable={tall}
        onpointerdown={dragStart}
        onpointermove={dragMove}
        onpointerup={dragEnd}
        onpointercancel={dragEnd}
      >
        {#if tall}<span class="grip" aria-hidden="true"></span>{/if}
        <h2>{title}</h2>
        <button class="x" aria-label="閉じる" onclick={close}>
          <Icon name="close" size={22} color="var(--muted)" />
        </button>
      </header>
      <div class="body">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(16, 32, 64, 0.4);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    transition: background 0.22s ease;
  }
  .overlay.closing {
    background: rgba(16, 32, 64, 0);
    pointer-events: none;
  }
  .sheet {
    width: 100%;
    max-width: var(--app-max);
    background: var(--card);
    border-radius: 20px 20px 0 0;
    padding: 16px 18px calc(20px + env(safe-area-inset-bottom));
    max-height: 86dvh;
    overflow-y: auto;
    animation: rise 0.22s ease;
    transition: transform 0.22s ease;
  }
  .sheet.tall {
    /* 高さ・角丸・上余白はドラッグ状態に応じて inline で指定する。中身が少なくても高さは変えない */
    padding-top: calc(16px + env(safe-area-inset-top) * var(--k, 0));
    max-height: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition:
      transform 0.22s ease,
      height 0.22s ease,
      border-radius 0.22s ease,
      padding-top 0.22s ease;
  }
  .sheet.dragging {
    transition: none;
  }
  .sheet.tall .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  @keyframes rise {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  header.draggable {
    cursor: grab;
    touch-action: none;
    user-select: none;
    /* 掴める範囲を広げる */
    margin: -16px -18px 12px;
    padding: 22px 18px 6px;
  }
  .grip {
    position: absolute;
    top: 8px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border);
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .x {
    border: none;
    background: none;
    padding: 4px;
    display: grid;
    place-items: center;
  }
</style>
