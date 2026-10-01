/**
 * ui-progress adapter for this app: Next.js App Router, Prisma, Postgres.
 *
 * Each snapshot gets its own database (uiprog_<sha>) in the local Postgres container, so
 * plantdb and plantdb_test are never touched. The database is dropped again afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PG = process.env.UI_PROGRESS_PG ?? "postgresql://plantuser:plantpass@localhost:5433";
const EMAIL = "test@plants.local";
const PASSWORD = "TestPassword123!";

const env = (ctx) => ({
  DATABASE_URL: `${PG}/uiprog_${ctx.short}`,
  SESSION_SECRET: "ui-progress-session-secret-0123456789abcdef",
  TEST_USER_EMAIL: EMAIL,
  TEST_USER_PASSWORD: PASSWORD,
  APP_URL: ctx.baseUrl,
  ADMIN_EMAIL: EMAIL,
  CRON_SECRET: "ui-progress",
  NEXT_E2E_DEV_SERVER: "1", // hides the dev indicator
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
    // One early commit has no lockfile.
    await ctx.exec(`npm ${ctx.has("package-lock.json") ? "ci" : "install"} --no-audit --no-fund --prefer-offline`);
    if (ctx.has("prisma/schema.prisma")) await ctx.exec("npx prisma generate", { env: env(ctx) });
  },

  async seed(ctx) {
    const vars = env(ctx);
    fs.writeFileSync(path.join(ctx.dir, ".env"), Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + '\nSMTP_HOST=""\n');
    if (!ctx.has("prisma/schema.prisma")) return; // the very first commits had no database
    // The first commits hardcoded the real database in prisma.config.ts. Point it at the
    // throwaway one, and refuse to continue if any literal connection string is left.
    if (ctx.has("prisma.config.ts")) {
      const file = path.join(ctx.dir, "prisma.config.ts");
      fs.writeFileSync(file, ctx.read("prisma.config.ts").replace(/"postgres(?:ql)?:\/\/[^"]+"/g, "process.env.DATABASE_URL"));
      if (/postgres(?:ql)?:\/\//.test(fs.readFileSync(file, "utf8"))) throw new Error("prisma.config.ts still contains a literal database URL");
    }
    const db = `uiprog_${ctx.short}`;
    const tsx = path.join(ctx.repo, "node_modules", ".bin", "tsx");
    await sql(ctx, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    if (ctx.has("scripts/seed-test-db.ts")) {
      // Creates the database, migrates it and seeds the project's own dataset.
      await ctx.exec(`"${tsx}" scripts/seed-test-db.ts`, { env: vars });
    } else {
      // Before the project had a seed script: schema plus one user; enrich.mjs adds the data.
      await sql(ctx, "postgres", `CREATE DATABASE "${db}"`);
      try {
        await ctx.exec("npx prisma migrate deploy", { env: vars });
      } catch {
        // A few early migrations only applied on top of the data the real database had.
        // The schema file is the truth for the commit, so build the tables straight from it.
        ctx.log("migrations do not apply to an empty database; creating the schema with db push");
        await sql(ctx, "postgres", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
        await sql(ctx, "postgres", `CREATE DATABASE "${db}"`);
        await ctx.exec("npx prisma db push --accept-data-loss", { env: vars });
      }
      if (ctx.has("scripts/setup-user.ts")) await ctx.exec(`"${tsx}" scripts/setup-user.ts ${EMAIL} '${PASSWORD}' --admin`, { env: vars });
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
    await sql(ctx, db, `UPDATE "User" SET "isAdmin" = true WHERE email = '${EMAIL}'`).catch(() => ctx.log("could not set isAdmin"));
    fs.rmSync(path.join(ctx.dir, "data", "uploads"), { recursive: true, force: true });
    // Fills every feature table the seed leaves empty, adds placeholder photos, and writes
    // route-hints.json with concrete URLs for the dynamic routes.
    // The first photo feature stored full public URLs; later ones store bare file names.
    const publicPhotos = ctx.has("lib/photos.ts") && ctx.read("lib/photos.ts").includes("`/uploads/plants/");
    await ctx.exec(`node "${path.join(HERE, "adapter", "enrich.mjs")}" "${ctx.dir}" "${ctx.out}" "${ctx.repo}"`, { env: { ...vars, PHOTO_MODE: publicPhotos ? "public" : "data" } });
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

  // Before /login existed the app answered on "/" only.
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
