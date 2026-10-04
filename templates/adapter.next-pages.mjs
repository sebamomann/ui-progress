/**
 * ui-progress adapter, Next.js Pages Router preset. Routes come from pages/**.
 * Fill in seed() and login(); see templates/adapter.blank.mjs for every available function.
 */
const PAGES_DIR = "pages"; // or "src/pages"

export default {
  async install(ctx) {
    await ctx.exec("npm ci --no-audit --no-fund --prefer-offline");
  },
  // Throwaway database, every feature seeded; same data on every run, only ever added to
  // (docs/ADAPTERS.md, "The same data in every snapshot").
  async seed(ctx) {},
  async start(ctx) {
    return { command: `npx next dev -p ${ctx.port}`, env: { NEXT_TELEMETRY_DISABLED: "1" }, readyPath: "/" };
  },
  // async login(page, ctx) {},
  async routes(ctx) {
    return ctx.routes.routesFromFiles(ctx.dir, (file) => ctx.routes.nextPagesRouteOfFile(file, PAGES_DIR), [PAGES_DIR]);
  },
  routeOfFile(file) {
    const prefix = PAGES_DIR + "/";
    if (!file.startsWith(prefix)) return null;
    const match = /^(.*)\.(tsx|jsx|ts|js|mdx)$/.exec(file.slice(prefix.length));
    if (!match) return null;
    const segments = match[1].split("/");
    if (segments[0] === "api" || segments.some((s) => s.startsWith("_"))) return null;
    if (segments[segments.length - 1] === "index") segments.pop();
    return "/" + segments.join("/");
  },
  async teardown(ctx) {},
};
