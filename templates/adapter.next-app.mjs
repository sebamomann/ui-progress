/**
 * ui-progress adapter, Next.js App Router preset. Routes come from the page.* files under app/.
 * Fill in seed() and login(); see templates/adapter.blank.mjs for every available function.
 */
const APP_DIR = "app"; // or "src/app"

export default {
  async install(ctx) {
    await ctx.exec("npm ci --no-audit --no-fund --prefer-offline");
  },

  async seed(ctx) {
    // Create a throwaway database for ctx.short, migrate it, and seed every feature.
  },

  async start(ctx) {
    return { command: `npx next dev -p ${ctx.port}`, env: { NEXT_TELEMETRY_DISABLED: "1" }, readyPath: "/" };
  },

  // async login(page, ctx) {},

  async routes(ctx) {
    return ctx.routes.routesFromFiles(ctx.dir, (file) => ctx.routes.nextAppRouteOfFile(file, APP_DIR), [APP_DIR]);
  },

  // async resolve(ctx) { return {}; },

  routeOfFile(file) {
    const prefix = APP_DIR + "/";
    if (!file.startsWith(prefix)) return null;
    const match = /^(?:(.*)\/)?page\.(tsx|jsx|ts|js|mdx)$/.exec(file.slice(prefix.length));
    if (!match) return null;
    const segments = (match[1] ?? "").split("/").filter(Boolean);
    if (segments[0] === "api" || segments.some((s) => s.startsWith("_") || s.startsWith("@") || s.startsWith("(."))) return null;
    return "/" + segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
  },

  async teardown(ctx) {},
};
