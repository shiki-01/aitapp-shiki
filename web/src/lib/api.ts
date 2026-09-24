// browser版(fetch)/desktop版(tauri invoke)を切り替える薄い入口。
// ビュー側は `import { api } from '$lib/api'` のみで済み、プラットフォーム分岐を意識しない。

import { isTauri } from './platform';
import { browserApi } from './api.browser';
import { desktopApi } from './api.desktop';
import type { ApiClient } from './types';

export * from './types';

export const api: ApiClient = isTauri ? desktopApi : browserApi;
