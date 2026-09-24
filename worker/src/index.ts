// Cloudflare Workers エントリポイント。
import app from './router';
import type { Env } from './types';

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
