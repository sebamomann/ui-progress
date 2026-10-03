# Adapters

`.ui-progress/adapter.mjs` is the only project-specific code. It answers one question for
any commit in the history: how do I get this app running, full of data, and signed in?

Claude writes it during setup. This page is the contract.

## Shape

```js
export default {
  async install(ctx) {},            // optional
  async seed(ctx) {},               // optional, but nearly always needed
  async start(ctx) { return { command: "...", env: {}, readyPath: "/" }; },   // required
  async login(page, ctx) {},        // optional: omit for sites without sign-in
  async routes(ctx) { return ["/", "/listings/[id]"]; },                      // optional: omit to crawl
  async resolve(ctx) { return { "/listings/[id]": "/listings/1" }; },         // optional
  routeOfFile(file) { return null; },                                         // optional, synchronous
  async teardown(ctx) {},           // optional
};
```

Order per snapshot: `install` → `seed` → `start` → (`login`, `routes`, `resolve` during
capture) → `teardown`. `teardown` always runs, also after a failure.

## `ctx`

| Field | Meaning |
| --- | --- |
| `ctx.dir` | The commit, checked out in a throwaway folder outside the repository |
| `ctx.sha`, `ctx.short`, `ctx.date`, `ctx.subject` | The commit |
| `ctx.port`, `ctx.baseUrl` | Where the app must listen. Several snapshots run in parallel, each with its own port |
| `ctx.repo` | The live repository. Read from it (for a tool the old commit lacks); never write |
| `ctx.out` | This snapshot's result folder, for files you want to keep (`route-hints.json`, …) |
| `ctx.exec(cmd, { env, cwd })` | Run a shell command in the checkout. Output goes to `run.log`. Throws on failure |
| `ctx.has(file)`, `ctx.read(file)` | Inspect the checkout. This is how one adapter handles every era |
| `ctx.require(name)` | A module from the checkout's `node_modules`, else from the live repository's |
| `ctx.sharp` | The sharp image library, for placeholder pictures |
| `ctx.assertThrowaway(url)` | Throws if `url` is one of the project's own databases. Call it before connecting with a database client directly; `ctx.exec` and `start` are checked automatically |
| `ctx.rewriteDatabaseUrls(url)` | Points every literal connection string in the checkout that ui-progress neutralised (or that still names one of the project's databases) at `url`, the throwaway database. Returns the files it changed |
| `ctx.routes` | Helpers: `routesFromFiles`, `nextAppRouteOfFile`, `nextPagesRouteOfFile`, `normalizeRoute`, `patternOfPath` |
| `ctx.state` | Scratch object shared by the functions of one snapshot. `ctx.state.notes = [...]` ends up in `snapshot.json` |
| `ctx.log(msg)` | Write to `run.log` |

## The functions

### `install(ctx)`

Install dependencies. Old commits may lack a lockfile or use another package manager:

```js
await ctx.exec(ctx.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : ctx.has("package-lock.json") ? "npm ci" : "npm install");
```

### `seed(ctx)`

Create a **throwaway** database named after the commit, bring it to this commit's schema,
and fill it.

- Never connect to a real database. ui-progress enforces this for `ctx.exec` and `start`
  (see `data.isolation` in CONFIGURATION.md); direct clients call `ctx.assertThrowaway`.
  Right after checkout, ui-progress replaces every copy of the project's own connection
  strings in the checkout's tracked files with an address that points nowhere. When old
  commits hardcode the connection in a file the app reads, call
  `ctx.rewriteDatabaseUrls(throwawayUrl)` in `seed`, before the first command. Verify
  afterwards that the throwaway database has tables; if not, the migration went somewhere
  else: throw.
- Use the project's own seed if the commit has one, then fill every table it leaves empty.
  Write inserts that only use the columns the schema has at this commit, so one seed serves
  every era. See `examples/nextjs-prisma-postgres/adapter/enrich.mjs`.
- Generate placeholder images for every record the app shows a picture of, themed to the
  subject, different per record. See `placeholders.mjs` in the same example.
- Create a second (and third) user where the app has anything social or shared.
- Write the concrete URLs of dynamic routes to `ctx.out` for `resolve`.

### `start(ctx)`

Return the command that starts the app on `ctx.port`. ui-progress runs it, waits until
`readyPath` answers, and stops it afterwards.

```js
return { command: `npx next dev -p ${ctx.port}`, env: { DATABASE_URL: url(ctx) }, readyPath: "/login" };
```

A development server is fine and usually better than a production build: it starts faster
and does not fail on type errors in old commits. Apps with two processes (API and
frontend) start both in one command: `"(cd api && ./run.sh &) ; cd web && npm run dev"`,
or start the first in `seed` and stop it in `teardown`. To manage the process yourself,
return `{ stop() {...} }` instead of a command.

### `login(page, ctx)`

`page` is a Playwright page in the context used for all signed-in screenshots. Sign in
with the seeded user. Return without doing anything for commits that predate sign-in.
Token-based apps can set the token directly:

```js
await page.goto(ctx.baseUrl);
await page.evaluate((t) => localStorage.setItem("token", t), ctx.state.token);
```

### `routes(ctx)`

Every route of this commit, parameters in brackets. `ctx.routes.normalizeRoute` converts
`:id`, `{id}`, `<int:id>` and `$id` to `[id]`. Omit the function to crawl from `/`
instead: any framework works, but pages nothing links to are missed.

### `resolve(ctx)`

A concrete URL for each dynamic route. Routes that are linked from a captured page resolve
on their own; this is for the rest (share links with tokens, previews, detail pages only
reachable through a form).

### `routeOfFile(file)`

Given a repository-relative path, return the route that file defines, or `null`. Must be
synchronous and must not need a checkout. With it, ui-progress reads the whole git history
for the exact day each page was added, removed or renamed, can plan in `auto` mode by page
changes, and can gather lineage evidence. Without it, lifetimes are only as precise as the
snapshots.

### `teardown(ctx)`

Drop the throwaway database, stop helper processes.

## Examples by stack

**Next.js, Prisma, Postgres**: complete, in `examples/nextjs-prisma-postgres/`.

**Django backend, React (Vite) frontend, React Router**:

```js
import fs from "node:fs";
import path from "node:path";

const db = (ctx) => `uiprog_${ctx.short}`;
const env = (ctx) => ({ DATABASE_URL: `postgres://dev:dev@localhost:5432/${db(ctx)}`, DJANGO_SETTINGS_MODULE: "config.settings.local", VITE_API_URL: `http://localhost:${ctx.port + 1000}` });

export default {
  async install(ctx) {
    await ctx.exec("python -m venv .venv && .venv/bin/pip install -q -r requirements.txt", { cwd: path.join(ctx.dir, "backend") });
    await ctx.exec("npm ci", { cwd: path.join(ctx.dir, "frontend") });
  },
  async seed(ctx) {
    await ctx.exec(`createdb ${db(ctx)}`);
    await ctx.exec(".venv/bin/python manage.py migrate --noinput", { cwd: path.join(ctx.dir, "backend"), env: env(ctx) });
    // The project's fixtures where they exist, then everything they leave empty.
    if (ctx.has("backend/fixtures/demo.json")) await ctx.exec(".venv/bin/python manage.py loaddata demo", { cwd: path.join(ctx.dir, "backend"), env: env(ctx) });
    await ctx.exec(`.venv/bin/python ${path.join(ctx.repo, ".ui-progress/adapter/seed.py")} ${ctx.out}`, { cwd: path.join(ctx.dir, "backend"), env: env(ctx) });
  },
  async start(ctx) {
    return {
      command: `(cd backend && .venv/bin/python manage.py runserver ${ctx.port + 1000} &) ; cd frontend && npx vite --port ${ctx.port} --strictPort`,
      env: env(ctx),
      readyPath: "/",
    };
  },
  async login(page, ctx) {
    await page.goto(ctx.baseUrl + "/login");
    await page.fill("#email", "agent@example.com");
    await page.fill("#password", "secret");
    await Promise.all([page.waitForURL((u) => u.pathname !== "/login"), page.click("button[type=submit]")]);
  },
  // React Router: read the <Route path="..."> declarations of this commit.
  async routes(ctx) {
    const source = ctx.read("frontend/src/routes.tsx");
    return [...source.matchAll(/path:\s*["']([^"']+)["']|<Route[^>]*\spath=["']([^"']+)["']/g)].map((m) => ctx.routes.normalizeRoute(m[1] ?? m[2]));
  },
  async resolve(ctx) {
    return JSON.parse(fs.readFileSync(path.join(ctx.out, "route-hints.json"), "utf8"));
  },
  async teardown(ctx) {
    await ctx.exec(`dropdb --if-exists ${db(ctx)}`).catch(() => {});
  },
};
```

Routes declared in one file have no "page file" per route, so `routeOfFile` is left out
here and lifetimes come from the snapshots. If pages live in `frontend/src/pages/<Name>.tsx`
and map predictably to routes, implement it.

**No database, static or content site**: `install`, `start`, nothing else; use the `crawl` preset.

## Checklist before a long run

- [ ] Newest, middle and oldest commits each produce real pages (open the PNGs)
- [ ] The real database was never contacted (`grep -i "database\|datasource" run.log`)
- [ ] `snapshot.json` has an empty `skipped`, or every entry is explained
- [ ] No table that a page displays is empty after `seed`
- [ ] Pictures are placeholders that fit the subject, different per record
- [ ] Signed-out and signed-in versions of the home page differ, if the app has a landing page
