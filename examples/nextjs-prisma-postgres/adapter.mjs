/**
 * Example ui-progress adapter: Next.js App Router, Prisma, Postgres.
 *
 * Each snapshot gets its own database (uiprog_<sha>) on the local Postgres server, so the
 * project's own databases are never touched. The database is dropped again afterwards.
 *
 * Names to adapt for a real project: the Postgres URL, the seed script, the login form
 * selectors, and the tables in adapter/enrich.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const requires = "0.6.0"; // ctx.rewriteDatabaseUrls

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PG = process.env.UI_PROGRESS_PG ?? "postgresql://postgres:postgres@localhost:5432";
const EMAIL = "test@example.com";
const PASSWORD = "TestPassword123!";

const env = (ctx) => ({
  DATABASE_URL: `${PG}/uiprog_${ctx.short}`,
  SESSION_SECRET: "ui-progress-session-secret-0123456789abcdef",
  TEST_USER_EMAIL: EMAIL,
  TEST_USER_PASSWORD: PASSWORD,
  APP_URL: ctx.baseUrl,
  NEXT_TELEMETRY_DISABLED: "1",
});

async function sql(ctx, database, text) {
  const pg = ctx.require("pg");
  const client = new pg.Client({ connectionString: `${PG}/${database}` });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

export default {
  async install(ctx) {
    // Early commits may have no lockfile, or one that is out of sync with package.json,
    // which `npm ci` refuses.
    const flags = "--no-audit --no-fund --prefer-offline";
    if (!ctx.has("package-lock.json")) await ctx.exec(`npm install ${flags}`);
    else await ctx.exec(`npm ci ${flags}`).catch(() => ctx.exec(`npm install ${flags}`));
    if (ctx.has("prisma/schema.prisma")) await ctx.exec("npx prisma generate", { env: env(ctx) });
  },

  async seed(ctx) {
    const vars = env(ctx);
    ctx.assertThrowaway(vars.DATABASE_URL); // never the project's own database
    fs.writeFileSync(path.join(ctx.dir, ".env"), Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
    if (!ctx.has("prisma/schema.prisma")) return; // commits before the app had a database
    // Old commits sometimes hardcode a connection string in a config file. ui-progress has
    // already pointed those at nowhere; point them at this snapshot's database instead.
    ctx.rewriteDatabaseUrls(vars.DATABASE_URL);
    const db = `uiprog_${ctx.short}`;
    await sql(ctx, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await sql(ctx, "postgres", `CREATE DATABASE "${db}"`);
    try {
      await ctx.exec("npx prisma migrate deploy", { env: vars });
    } catch {
      // Some migrations only apply on top of data a real database had. The schema file is
      // the truth for the commit, so build the tables straight from it.
      ctx.log("migrations do not apply to an empty database; creating the schema with db push");
      await sql(ctx, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await sql(ctx, "postgres", `CREATE DATABASE "${db}"`);
      await ctx.exec("npx prisma db push --accept-data-loss", { env: vars });
    }
    // Use the project's own seed where this commit has one.
    if (ctx.has("prisma/seed.ts")) {
      await ctx.exec("npx tsx prisma/seed.ts", { env: vars }).catch(() => {
        ctx.log("the project's seed failed at this commit; enrich.mjs writes the dataset instead");
        ctx.state.notes = [...(ctx.state.notes ?? []), "project seed unusable at this commit; hand-written dataset used"];
      });
    }
    const { rows } = await (async () => {
      const pg = ctx.require("pg");
      const client = new pg.Client({ connectionString: `${PG}/${db}` });
      await client.connect();
      try {
        return await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      } finally {
        await client.end();
      }
    })();
    if (rows[0].n === 0) throw new Error(`migrations did not reach ${db}: it has no tables`);
    // Creates the test user if needed, fills every table the seed left empty, adds
    // placeholder images, and writes route-hints.json with concrete URLs for dynamic routes.
    await ctx.exec(`node "${path.join(HERE, "adapter", "enrich.mjs")}" "${ctx.dir}" "${ctx.out}" "${ctx.repo}"`, { env: vars });
  },

  async start(ctx) {
    return { command: `npx next dev -p ${ctx.port}`, env: env(ctx), readyPath: ctx.has("app/login/page.tsx") ? "/login" : "/" };
  },

  async login(page, ctx) {
    if (!ctx.has("app/login/page.tsx")) return; // before accounts existed, everything was public
    await page.goto(ctx.baseUrl + "/login", { waitUntil: "load" });
    await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 20_000 });
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }), page.click('button[type="submit"]')]);
  },

  async routes(ctx) {
    return ctx.routes.routesFromFiles(ctx.dir, (file) => ctx.routes.nextAppRouteOfFile(file, "app"), ["app"]);
  },

  async resolve(ctx) {
    const file = path.join(ctx.out, "route-hints.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  },

  routeOfFile(file) {
    if (!file.startsWith("app/")) return null;
    const match = /^(?:(.*)\/)?page\.(tsx|jsx|ts|js|mdx)$/.exec(file.slice(4));
    if (!match) return null;
    const segments = (match[1] ?? "").split("/").filter(Boolean);
    if (segments[0] === "api" || segments.some((s) => s.startsWith("_") || s.startsWith("@") || s.startsWith("(."))) return null;
    return "/" + segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
  },

  async teardown(ctx) {
    await sql(ctx, "postgres", `DROP DATABASE IF EXISTS "uiprog_${ctx.short}" WITH (FORCE)`).catch(() => {});
  },
};
