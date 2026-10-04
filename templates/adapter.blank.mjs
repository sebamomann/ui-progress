/**
 * ui-progress adapter: everything that is specific to THIS project.
 *
 * Each function receives `ctx`, describing one commit checked out into a throwaway folder:
 *   ctx.dir      absolute path of the checkout          ctx.sha / ctx.short / ctx.date
 *   ctx.port     the port the app must listen on        ctx.baseUrl  http://localhost:<port>
 *   ctx.repo     the real repository (read-only use)    ctx.out      this snapshot's result folder
 *   ctx.exec(cmd, { env })   run a shell command in the checkout; throws if it fails
 *   ctx.has(file) / ctx.read(file)   look at files of that commit (the app changes over time!)
 *   ctx.require(name)        a module from the checkout's node_modules, else the repo's
 *   ctx.sharp                image library, for writing placeholder pictures
 *   ctx.routes               helpers: nextAppRouteOfFile, nextPagesRouteOfFile, routesFromFiles, normalizeRoute
 *   ctx.state                scratch space shared between the functions for this commit
 *   ctx.log(message)         write to the snapshot's run.log
 *
 * Only start() is required. See docs/ADAPTERS.md in the plugin for a complete example.
 */
export default {
  /** Install dependencies for this commit. */
  async install(ctx) {
    // await ctx.exec("npm ci --no-audit --no-fund --prefer-offline");
  },

  /**
   * Create a throwaway database and fill it so that EVERY feature has something to show:
   * no page should be captured in its empty state. Include placeholder images where the
   * app shows photos. Use the project's own seed where one exists at this commit, and add
   * whatever it leaves empty.
   *
   * The data must be the same on every run and only ever added to: no random values, no
   * inserts racing for ids, and when the seed grows, existing records stay as they were
   * (new records after them, a record of its own for each new case). A change in the data
   * shows as a change in the UI. See "The same data in every snapshot" in docs/ADAPTERS.md.
   */
  async seed(ctx) {},

  /** Start the app on ctx.port. Return the command; ui-progress runs and stops it. */
  async start(ctx) {
    return { command: `npm run dev -- --port ${ctx.port}`, env: {}, readyPath: "/" };
  },

  /** Sign in with the seeded user. `page` is a Playwright page. Remove if there is no sign-in. */
  // async login(page, ctx) {
  //   await page.goto(ctx.baseUrl + "/login");
  //   await page.fill('input[name="email"]', "test@example.com");
  //   await page.fill('input[name="password"]', "secret");
  //   await Promise.all([page.waitForURL((u) => u.pathname !== "/login"), page.click('button[type="submit"]')]);
  // },

  /** Every route of this commit, parameters in brackets: ["/", "/listings/[id]"]. Remove to crawl from "/". */
  // async routes(ctx) { return []; },

  /** Concrete URLs for dynamic routes that nothing links to: { "/listings/[id]": "/listings/1" }. */
  // async resolve(ctx) { return {}; },

  /** Map a source file to the route it defines (or null). Enables exact add/remove dates and lineage. */
  // routeOfFile(file) { return null; },

  /** Drop the throwaway database, stop containers, and so on. */
  async teardown(ctx) {},
};
