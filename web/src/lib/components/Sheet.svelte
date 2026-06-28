<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    open = $bindable(),
    title = '',
    children,
  }: { open: boolean; title?: string; children: import('svelte').Snippet } = $props();

  function close() {
    open = false;
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} />

{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && close()}
  >
    <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabindex="-1">
      <header>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
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
