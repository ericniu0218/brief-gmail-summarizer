import handler from 'vinext/server/fetch-handler';
import { runAgent } from './server/sync';
import type { Runtime } from './server/runtime';

/** Cloudflare Worker entry points for web requests and scheduled inbox refreshes. */
export default {
  fetch: handler.fetch,
  async scheduled(_event: ScheduledController, env: Runtime, ctx: ExecutionContext) {
    // Keep the cron event alive until the agent finishes.
    ctx.waitUntil(runAgent(env));
  },
};
