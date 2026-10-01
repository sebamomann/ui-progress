/**
 * ui-progress adapter, crawl preset: no route list. Pages are discovered by following
 * links from "/", and ids in URLs are generalised to [id]. Works with any framework, but
 * pages nothing links to are missed and exact add/remove dates are unknown.
 * See templates/adapter.blank.mjs for every available function.
 */
export default {
  async install(ctx) {
    // await ctx.exec("npm ci --no-audit --no-fund --prefer-offline");
  },
  async seed(ctx) {},
  async start(ctx) {
    return { command: `npm run dev -- --port ${ctx.port}`, readyPath: "/" };
  },
  async teardown(ctx) {},
};
