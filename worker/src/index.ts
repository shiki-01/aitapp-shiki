// Cloudflare Workers エントリポイント。
import app from './router';
import type { Env } from './types';
import { runKeepAlive } from './keepalive';

export default {
  fetch: app.fetch,
  // Cron Trigger（wrangler.toml [triggers]）。LCAM セッションの keep-alive。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runKeepAlive(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
