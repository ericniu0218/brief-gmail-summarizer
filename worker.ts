import handler from 'vinext/server/fetch-handler';
import { runAgent } from './server/sync';
import type { Runtime } from './server/runtime';
export default {
  fetch: handler.fetch,
  async scheduled(_event: ScheduledController, env: Runtime, ctx: ExecutionContext) {
    ctx.waitUntil(runAgent(env));
  },
};
