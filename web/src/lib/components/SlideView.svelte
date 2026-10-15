<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { scrollRoot } from '$lib/scroll';

  // 画面の切替を「右から入り、戻ると右へ出ていく」スライドで見せる。
  // 切替の間は新旧 2 枚が同じ枠に重なり、終わると旧い方が消える。
  // view が変わるたびに children(view) を描き直す。退場中の旧画面は view の値を保ったまま固まる。
  let {
    view,
    forward = true,
    children,
  }: {
    view: string;
    /** true: 右から入る（奥へ進む）/ false: 右へ出る（戻る） */
    forward?: boolean;
    children: Snippet<[string]>;
  } = $props();

  const DURATION = 300;
  // 下に隠れる側が動く量(%)。手前の画面より少しだけ動かして奥行きを出す。
  const PARALLAX = -30;
  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function slide(_node: Element, offset: number, top: boolean): TransitionConfig {
    return {
      duration: reduceMotion ? 0 : DURATION,
      easing: cubicOut,
      css: (_t, u) => `transform: translateX(${offset * u}%); z-index: ${top ? 2 : 1};`,
    };
  }
  const enter = (node: Element) => slide(node, forward ? 100 : PARALLAX, forward);
  const leave = (node: Element) => slide(node, forward ? PARALLAX : 100, !forward);

  // 進むときは新しい画面を頭から見せる。
  let first = true;
  $effect.pre(() => {
    void view;
    if (first) {
      first = false;
      return;
    }
    if (forward) scrollRoot().scrollTo({ top: 0, behavior: 'instant' });
  });
</script>

<div class="stage">
  {#each [view] as v (v)}
    <div class="layer" in:enter out:leave>
      {@render children(v)}
    </div>
  {/each}
</div>

<style>
  .stage {
    display: grid;
    overflow-x: clip;
  }
  .layer {
    grid-area: 1 / 1;
    min-width: 0;
    background: var(--card);
    position: relative;
  }
</style>
