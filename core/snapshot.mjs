/**
 * One snapshot: check a commit out into a throwaway worktree, let the adapter install,
 * seed and start it, capture it, and clean up. Results land in
 * .ui-progress/snapshots/<short sha>/.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { capture } from "./capture.mjs";
import { addFinding } from "./findings.mjs";
import { assertIsolated, protectedDatabases } from "./isolation.mjs";
import { hasDep, requireDep } from "./deps.mjs";
import * as routes from "./routes.mjs";
import { background, git, readJson, sh, tail, waitForHttp, writeJson } from "./util.mjs";

/** A private clone owns the worktrees, so the project's own git metadata is never touched. */
export function ensureClone(p, { refresh = true } = {}) {
  const clone = path.join(p.work, "repo");
  if (!refresh && fs.existsSync(clone)) return clone;
  if (!fs.existsSync(clone)) {
    fs.mkdirSync(p.work, { recursive: true });
    git(p.repo, "clone", "--local", "--no-checkout", "--quiet", p.repo, clone);
  } else {
    git(clone, "fetch", "--quiet", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*");
  }
  return clone;
}

export function snapshotDir(p, short) {
  return path.join(p.snapshots, short);
}
export const isDone = (p, short) => fs.existsSync(path.join(snapshotDir(p, short), "OK"));

/** The finished snapshot nearest below this commit in history, if any. */
function previousSnapshot(p, full) {
  let best = null;
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const info = readJson(path.join(snapshotDir(p, short), "snapshot.json"));
    if (!info || !isDone(p, short) || info.live || info.sha === full) continue;
    try {
      git(p.repo, "merge-base", "--is-ancestor", info.sha, full);
    } catch {
      continue;
    }
    const distance = Number(git(p.repo, "rev-list", "--count", `${info.sha}..${full}`).trim());
    if (!best || distance < best.distance) best = { ...info, distance };
  }
  return best;
}

/**
 * Which routes can be copied from the previous snapshot: those whose source dependencies
 * are untouched by the commits in between. Also writes deps.json for the build's evidence.
 */
function planReuse(p, config, adapter, ctx, full) {
  if (!adapter.routeOfFile) return null;
  const files = routes.pageFiles(ctx.dir, adapter.routeOfFile, config.lineage.pagePaths);
  const aliases = routes.readAliases(ctx.dir);
  const deps = {};
  for (const [route, file] of files) deps[route] = routes.routeDependencies(ctx.dir, file, aliases);
  writeJson(path.join(ctx.out, "deps.json"), deps);
  if (!config.capture.incremental.enabled) return null;
  const previous = previousSnapshot(p, full);
  if (!previous) return null;
  const prevDir = snapshotDir(p, previous.short);
  const prevManifest = readJson(path.join(prevDir, "shots", "manifest.json"));
  if (!prevManifest || JSON.stringify(prevManifest.viewports) !== JSON.stringify(config.capture.viewports)) return null;
  const changed = git(p.repo, "diff", "--name-only", previous.sha, full).split("\n").filter(Boolean);
  const globals = config.capture.incremental.globalPaths.map(routes.globToRegex);
  const globalHit = changed.find((f) => globals.some((re) => re.test(f)));
  if (globalHit) {
    ctx.log(`incremental: ${globalHit} changed since ${previous.short}, everything is recaptured`);
    return null;
  }
  // Translation files change in nearly every commit; only the pages that use a changed
  // namespace (a top-level key) are affected by them.
  const translations = (config.capture.incremental.translationPaths ?? []).map(routes.globToRegex);
  const changedNamespaces = new Set();
  const changedSet = new Set();
  for (const f of changed) {
    if (translations.some((re) => re.test(f)) && f.endsWith(".json")) {
      const read = (ref) => { try { return JSON.parse(git(p.repo, "show", `${ref}:${f}`)); } catch { return null; } };
      const before = read(previous.sha), after = read(full);
      if (!before || !after) { changedSet.add(f); continue; }
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changedNamespaces.add(key);
    } else changedSet.add(f);
  }
  const sources = new Map();
  const usesNamespace = (file) => {
    if (!changedNamespaces.size) return false;
    if (!sources.has(file)) { try { sources.set(file, fs.readFileSync(path.join(ctx.dir, file), "utf8")); } catch { sources.set(file, ""); } }
    const text = sources.get(file);
    return [...changedNamespaces].some((ns) => text.includes(`"${ns}"`) || text.includes(`'${ns}'`) || text.includes(`\`${ns}\``));
  };
  const reusable = new Set();
  for (const [route, list] of Object.entries(deps)) {
    const entry = prevManifest.routes.find((r) => r.route === route);
    if (!entry || entry.skipped || !list.some(Boolean)) continue;
    if (!list.some((f) => changedSet.has(f) || usesNamespace(f))) reusable.add(route);
  }
  if (changedNamespaces.size) ctx.log(`incremental: translation namespaces changed: ${[...changedNamespaces].join(", ")}`);
  ctx.log(`incremental: ${changed.length} files changed since ${previous.short}; ${reusable.size} of ${files.size} pages unchanged`);
  return { routes: reusable, from: previous.short, dir: path.join(prevDir, "shots"), manifest: prevManifest };
}

/** Tracked and untracked changes in the working tree, relative to HEAD (ignored files excluded). */
function workingChanges(repo) {
  const out = git(repo, "status", "--porcelain", "-z", "--untracked-files=all");
  const changes = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), file = parts[i].slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the next entry is the original path
    if (file.startsWith(".ui-progress/")) continue;
    changes.push({ file, deleted: code.includes("D") });
  }
  return changes;
}

export async function runSnapshot(p, config, adapter, sha, { port, force = false, refreshClone = true, workingTree = false } = {}) {
  const full = git(p.repo, "rev-parse", sha).trim();
  const headShort = git(p.repo, "rev-parse", "--short=8", full).trim();
  // A working-tree snapshot: HEAD plus the uncommitted changes, built like any other commit.
  const short = workingTree ? `${headShort}-wip` : headShort;
  let [date, subject] = git(p.repo, "log", "-1", "--format=%ad|%s", "--date=short", full).trim().split(/\|(.*)/s);
  if (workingTree) { date = new Date().toISOString().slice(0, 10); subject = `uncommitted changes on top of ${headShort}`; }
  const out = snapshotDir(p, short);
  if (isDone(p, short) && !force) return { short, skipped: true };

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const logFile = path.join(out, "run.log");
  const log = (message) => fs.appendFileSync(logFile, `[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
  const clone = ensureClone(p, { refresh: refreshClone });
  const dir = path.join(p.work, short);
  const baseUrl = `http://localhost:${port}`;

  const protectedDbs = protectedDatabases(p.repo, config);
  let phase = "checkout";
  const ctx = {
    sha: full,
    short,
    date,
    subject,
    dir,
    out,
    repo: p.repo,
    port,
    baseUrl,
    config,
    routes,
    state: {},
    log,
    has: (file) => fs.existsSync(path.join(dir, file)),
    read: (file) => fs.readFileSync(path.join(dir, file), "utf8"),
    exec: (command, options = {}) => {
      // Seeding and running must never reach the project's own databases.
      if (phase === "seed" || phase === "start") assertIsolated({ config, protectedDbs, env: { ...process.env, ...options.env }, checkout: dir, where: `run \`${command.slice(0, 80)}\`` });
      return sh(command, { cwd: dir, log: logFile, ...options });
    },
    /** For adapters that connect directly (a database client): throws for a protected database. */
    assertThrowaway: (url) => assertIsolated({ config, protectedDbs, env: { url }, where: "connect" }),
    /** A module from the checked-out commit's own node_modules, else from the live repo's. */
    require: (name) => {
      for (const base of [dir, p.repo]) {
        try {
          return createRequire(path.join(base, "package.json"))(name);
        } catch {
          // try the next location
        }
      }
      throw new Error(`cannot resolve "${name}" from the checkout or the repository`);
    },
    get sharp() {
      return requireDep("sharp");
    },
  };

  const timings = {};
  let server = null;
  const timed = async (name, run) => {
    phase = name;
    const start = Date.now();
    log(`=== ${name}`);
    try {
      return await run();
    } finally {
      timings[name] = Math.round((Date.now() - start) / 1000);
    }
  };

  try {
    await timed("checkout", async () => {
      try {
        git(clone, "worktree", "remove", "--force", dir);
      } catch {
        // no stale worktree
      }
      fs.rmSync(dir, { recursive: true, force: true });
      git(clone, "worktree", "add", "--detach", "--quiet", dir, full);
      if (workingTree) {
        const changes = workingChanges(p.repo);
        for (const { file, deleted } of changes) {
          const target = path.join(dir, file);
          if (deleted) fs.rmSync(target, { force: true });
          else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(p.repo, file), target); }
        }
        log(`applied ${changes.length} uncommitted change(s) from the working tree`);
      }
    });
    if (adapter.install) await timed("install", () => adapter.install(ctx));
    if (adapter.seed) await timed("seed", () => adapter.seed(ctx));
    await timed("start", async () => {
      if (!adapter.start) throw new Error("adapter.mjs has no start(ctx): ui-progress does not know how to run this app");
      const started = await adapter.start(ctx);
      const spec = typeof started === "string" ? { command: started } : started ?? {};
      assertIsolated({ config, protectedDbs, env: { ...process.env, ...spec.env }, checkout: dir, where: "start the app" });
      if (spec.command) {
        server = background(spec.command, { cwd: spec.cwd ?? dir, env: { PORT: String(port), ...spec.env }, log: path.join(out, "server.log") });
      } else if (spec.stop) server = { stop: spec.stop, exited: () => false };
      await waitForHttp(baseUrl + (spec.readyPath ?? config.run.readyPath), { timeoutMs: config.run.readyTimeoutMs, alive: () => !server?.exited() });
    });
    const reuse = planReuse(p, config, adapter, ctx, full);
    const screens = readJson(path.join(p.root, "screens.json"), []);
    const manifest = await timed("capture", () => capture({ baseUrl, outDir: path.join(out, "shots"), config, adapter, ctx, screens, reuse, log }));
    // A snapshot of error pages is not a snapshot.
    if (manifest.captured === 0) throw new Error(`no page could be captured (${manifest.routesTotal} routes, ${manifest.serverErrors.length} server errors${manifest.loginError ? ", sign-in failed: " + manifest.loginError : ""})`);
    if (manifest.serverErrors.length > manifest.routesTotal / 2) throw new Error(`${manifest.serverErrors.length} of ${manifest.routesTotal} pages answered with a server error; see server.log`);
    writeJson(path.join(out, "snapshot.json"), {
      sha: full,
      short,
      date,
      subject,
      workingTree,
      timings,
      pages: manifest.routesTotal,
      captured: manifest.captured,
      reused: manifest.reused,
      states: manifest.states,
      skipped: manifest.skipped,
      notes: ctx.state.notes ?? [],
    });
    fs.writeFileSync(path.join(out, "OK"), "");
    return { short, date, timings, manifest };
  } catch (err) {
    log(`FAILED in ${phase}: ${err.stack ?? err}`);
    fs.writeFileSync(path.join(out, "FAILED"), `${phase}\n${err.message}\n`);
    addFinding(p, {
      kind: "failure",
      source: "snapshot",
      title: `Snapshot ${short} failed in ${phase}`,
      detail: `${err.message}\n\nCommit ${short} (${date}): ${subject}\nThis is recorded automatically. It may be a problem in the project's adapter rather than in ui-progress; resolve the finding once the cause is known.`,
      command: `ui-progress snapshot ${short}`,
      sha: short,
      phase,
      log: tail(logFile, 30) + (fs.existsSync(path.join(out, "server.log")) ? "\n--- server.log ---\n" + tail(path.join(out, "server.log"), 20) : ""),
    });
    return { short, date, failed: phase, error: err.message };
  } finally {
    server?.stop();
    try {
      await adapter.teardown?.(ctx);
    } catch (err) {
      log(`teardown failed: ${err.message}`);
    }
    if (!config.run.keepWorktrees) {
      try {
        git(clone, "worktree", "remove", "--force", dir);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

/** Capture an app that is already running (the working tree as it is now). */
export async function captureLive(p, config, adapter, baseUrl, { states = false, useLiveData = false } = {}) {
  if ((config.data?.isolation ?? "throwaway") !== "shared" && !useLiveData) {
    throw new Error(
      "A live capture photographs your running app with its own (development) data. ui-progress builds its own dataset in a throwaway database instead.\n" +
        "For uncommitted work use:  ui-progress snapshot --working-tree\n" +
        "Only if you want your dev data in the history, add --use-live-data (or set data.isolation to \"shared\").",
    );
  }
  // The running app holds the developer's own data: look, but do not click around in it
  // unless asked to.
  config = { ...config, capture: { ...config.capture, states: { ...config.capture.states, enabled: states && config.capture.states.enabled } } };
  const full = git(p.repo, "rev-parse", "HEAD").trim();
  const short = git(p.repo, "rev-parse", "--short=8", full).trim();
  const [date, subject] = git(p.repo, "log", "-1", "--format=%ad|%s", "--date=short", full).trim().split(/\|(.*)/s);
  const dirty = git(p.repo, "status", "--porcelain").trim().length > 0;
  const out = snapshotDir(p, short);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const logFile = path.join(out, "run.log");
  const log = (message) => fs.appendFileSync(logFile, `${message}\n`);
  const ctx = { sha: full, short, date, subject, dir: p.repo, out, repo: p.repo, baseUrl, config, routes, state: {}, live: true, log, has: (f) => fs.existsSync(path.join(p.repo, f)), read: (f) => fs.readFileSync(path.join(p.repo, f), "utf8"), require: (name) => createRequire(path.join(p.repo, "package.json"))(name) };
  const screens = readJson(path.join(p.root, "screens.json"), []);
  const manifest = await capture({ baseUrl: baseUrl.replace(/\/$/, ""), outDir: path.join(out, "shots"), config, adapter, ctx, screens, log });
  writeJson(path.join(out, "snapshot.json"), { sha: full, short, date, subject, live: true, dirty, pages: manifest.routesTotal, captured: manifest.captured, states: manifest.states, skipped: manifest.skipped });
  fs.writeFileSync(path.join(out, "OK"), "");
  return { short, date, manifest, dirty };
}

export const depsReady = () => hasDep("playwright") && hasDep("sharp");
