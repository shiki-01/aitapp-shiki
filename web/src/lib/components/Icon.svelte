<script module lang="ts">
  // 利用可能なアイコン名。他コンポーネントからも型参照できるよう module で公開する。
  export type IconName =
    | 'notification'
    | 'calendar'
    | 'home'
    | 'task'
    | 'grid'
    | 'settings'
    | 'edit'
    | 'search'
    | 'plus'
    | 'chevron-right'
    | 'chevron-left'
    | 'external'
    | 'logout'
    | 'book'
    | 'note'
    | 'check'
    | 'close'
    | 'clock'
    | 'more';
</script>

<script lang="ts">
  // 軽量な inline SVG アイコン集。Figma の iconify アイコン
  // (ant-design:notification-filled / uis:schedule / material-symbols:home-rounded /
  //  jam:task-list-f / その他) を自前パスで再現する。リモート資産に依存しない。
  type Name = IconName;

  let {
    name,
    size = 24,
    color = 'currentColor',
  }: { name: Name; size?: number | string; color?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke={color}
  stroke-width="1.9"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'notification'}
    <path d="M3 11l16-7v16L3 13z" fill={color} stroke="none" />
    <path d="M7 12v4a2 2 0 0 0 2 2h1v-5" fill={color} stroke="none" />
  {:else if name === 'calendar'}
    <rect x="3" y="4.5" width="18" height="16" rx="2.5" fill={color} stroke="none" />
    <rect x="3" y="4.5" width="18" height="4.5" rx="2.5" fill="rgba(0,0,0,0.18)" stroke="none" />
    <rect x="6.5" y="2.5" width="2" height="4" rx="1" fill={color} stroke="none" />
    <rect x="15.5" y="2.5" width="2" height="4" rx="1" fill={color} stroke="none" />
  {:else if name === 'home'}
    <path d="M4 11l8-6 8 6v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" fill={color} stroke="none" />
  {:else if name === 'task'}
    <rect x="4" y="3" width="16" height="18" rx="2.5" fill={color} stroke="none" />
    <path d="M8 9l1.5 1.5L12.5 7.5" stroke="#fff" stroke-width="1.8" />
    <path d="M8 15l1.5 1.5 3-3" stroke="#fff" stroke-width="1.8" />
  {:else if name === 'grid'}
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" fill={color} stroke="none" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" fill={color} stroke="none" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" fill={color} stroke="none" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" fill={color} stroke="none" />
  {:else if name === 'settings'}
    <path
      d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm9 3.5l-2-1 .3-2.2-2-1.1-1.6 1.5-2-.9L12.7 3h-1.4l-1 2.3-2 .9L6.7 4.7l-2 1.1L5 8l-2 1 .8 2.2L2 12l2 1-.8 2.2L5 16l-.3 2.2 2 1.1 1.6-1.5 2 .9L11.3 21h1.4l1-2.3 2-.9 1.6 1.5 2-1.1L19 16l2-1z"
      fill={color}
      stroke="none"
    />
  {:else if name === 'edit'}
    <path d="M4 16.5V20h3.5L18 9.5 14.5 6z" />
    <path d="M16 4.5L19.5 8" />
  {:else if name === 'search'}
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'chevron-right'}
    <path d="M9 5l7 7-7 7" />
  {:else if name === 'chevron-left'}
    <path d="M15 5l-7 7 7 7" />
  {:else if name === 'external'}
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H11" />
  {:else if name === 'logout'}
    <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
    <path d="M17 8l4 4-4 4" />
    <path d="M21 12H9" />
  {:else if name === 'book'}
    <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
    <path d="M18 16H7a2 2 0 0 0-2 2" />
  {:else if name === 'note'}
    <path d="M5 4h10l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path d="M14 4v5h5" />
    <path d="M8 13h7M8 16.5h5" />
  {:else if name === 'check'}
    <path d="M5 12.5l4.5 4.5L19 7" />
  {:else if name === 'close'}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  {:else if name === 'more'}
    <circle cx="12" cy="5.5" r="1.6" fill={color} stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill={color} stroke="none" />
    <circle cx="12" cy="18.5" r="1.6" fill={color} stroke="none" />
  {/if}
</svg>
