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
import { unbuildableEntry } from "./unbuildable.mjs";
import { assertIsolated, neutraliseCheckout, protectedDatabases, rewriteDatabaseUrls } from "./isolation.mjs";
import { hasDep, requireDep } from "./deps.mjs";
import * as routes from "./routes.mjs";
import { background, freePort, git, readJson, sh, tail, waitForHttp, writeJson } from "./util.mjs";

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
/** Older versions could also capture a running app or uncommitted changes; those are not commits. */
export const isCommitSnapshot = (info) => !info.live && !info.workingTree;
export const isDone = (p, short) => fs.existsSync(path.join(snapshotDir(p, short), "OK"));
/**
 * The folder name of a commit's snapshot. Plans keep git's own abbreviation, which can be
 * shorter than the folder's, so anything that starts from a plan entry goes through this.
 */
export const snapshotId = (p, sha) => git(p.repo, "rev-parse", "--short=8", sha).trim();

/** The finished snapshot nearest below this commit in history, if any. */
function previousSnapshot(p, full) {
  let best = null;
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const info = readJson(path.join(snapshotDir(p, short), "snapshot.json"));
    if (!info || !isDone(p, short) || !isCommitSnapshot(info) || info.sha === full) continue;
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

export async function runSnapshot(p, config, adapter, sha, { port, force = false, refreshClone = true } = {}) {
  const full = git(p.repo, "rev-parse", sha).trim();
  const short = git(p.repo, "rev-parse", "--short=8", full).trim();
  const [date, subject] = git(p.repo, "log", "-1", "--format=%ad|%s", "--date=short", full).trim().split(/\|(.*)/s);
  const out = snapshotDir(p, short);
  if (isDone(p, short) && !force) return { short, skipped: true };

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const logFile = path.join(out, "run.log");
  const log = (message) => fs.appendFileSync(logFile, `[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
  const clone = ensureClone(p, { refresh: refreshClone });
  const dir = path.join(p.work, short);
  // Something else on the port would answer the readiness check in place of this app.
  const wantedPort = port;
  port = await freePort(port);
  if (port !== wantedPort) log(`port ${wantedPort} is in use; using ${port}`);
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
    /** Point literal connection strings in the checkout at the throwaway database `url`. */
    rewriteDatabaseUrls: (url) => {
      const files = rewriteDatabaseUrls({ config, protectedDbs, checkout: dir, url });
      if (files.length) log(`pointed connection strings at the throwaway database in: ${files.join(", ")}`);
      return files;
    },
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
      const neutralised = neutraliseCheckout({ config, protectedDbs, checkout: dir });
      if (neutralised.length) log(`neutralised the project's own connection strings in: ${neutralised.join(", ")}`);
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
      // An app that failed to bind exits at once, while whatever holds the port answers.
      await new Promise((r) => setTimeout(r, 1000));
      if (server?.exited()) throw new Error(`the app exited right after start, and something else answered on port ${port}; see server.log`);
    });
    const reuse = planReuse(p, config, adapter, ctx, full);
    const screens = readJson(path.join(p.root, "screens.json"), []);
    const manifest = await timed("capture", () => capture({ baseUrl, outDir: path.join(out, "shots"), config, adapter, ctx, screens, reuse, log }));
    // A snapshot of error pages is not a snapshot.
    if (manifest.captured === 0) throw new Error(`no page could be captured (${manifest.routesTotal} routes, ${manifest.serverErrors.length} server errors${manifest.loginError ? ", sign-in failed: " + manifest.loginError : ""})`);
    if (manifest.serverErrors.length > manifest.routesTotal / 2) throw new Error(`${manifest.serverErrors.length} of ${manifest.routesTotal} pages answered with a server error; see server.log`);
    // Pages copied forward keep their old suspects; only what this commit rendered counts.
    const copied = new Set(manifest.routes.filter((r) => r.copiedFrom).map((r) => r.route));
    const errorPages = new Set(manifest.suspects.filter((s) => s.issues.includes("error page or overlay") && !copied.has(s.route)).map((s) => s.route));
    if (errorPages.size > (manifest.captured - manifest.reused) * config.run.fallback.errorPageShare) throw new Error(`${errorPages.size} of ${manifest.captured - manifest.reused} rendered pages show an error page or overlay; see server.log`);
    writeJson(path.join(out, "snapshot.json"), {
      sha: full,
      short,
      date,
      subject,
      timings,
      pages: manifest.routesTotal,
      captured: manifest.captured,
      reused: manifest.reused,
      states: manifest.states,
      skipped: manifest.skipped,
      suspects: manifest.suspects,
      notes: ctx.state.notes ?? [],
    });
    fs.writeFileSync(path.join(out, "OK"), "");
    return { short, date, timings, manifest };
  } catch (err) {
    // The cause of a build or start failure is usually only in the app's own log.
    const cause = ["start", "capture"].includes(phase) ? firstError(path.join(out, "server.log")) : null;
    if (cause && !err.message.includes(cause)) err.message += `\nFirst error in server.log: ${cause}`;
    const fixUp = FALLBACK_PHASES.includes(phase) ? fixUpCandidates(p.repo, full, { ...config.run.fallback, branch: config.sampling.branch ?? "HEAD" }).find((c) => !unbuildableEntry(p, c.sha)) : null;
    if (fixUp) err.message += `\nThe next commit ${fixUp.short} came ${fixUp.minutes} min later ("${fixUp.subject}") and may fix this one.`;
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
      error: err.message,
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

/** The first line in an app log that looks like the cause of a failure, with its context. */
export function firstError(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  const i = lines.findIndex((l) => /Module not found|Cannot find module|Failed to compile|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError|ImportError|NameError|error TS\d+|Traceback|Exception|EADDRINUSE|\bERROR\b|Error:/.test(l));
  return i < 0 ? null : lines.slice(i, i + 3).map((l) => l.trim()).filter(Boolean).join(" | ").slice(0, 400);
}

/** Phases whose failure can be the commit's own fault (it does not install, build or run). */
export const FALLBACK_PHASES = ["install", "seed", "start", "capture"];

/**
 * The commits right after this one on the mainline, within `maxHours` and `maxCommits`:
 * where a fix for a broken commit usually lands. The search stops before a commit for which
 * `stop(sha)` is true (one that is planned or captured anyway), so a stand-in never jumps
 * over the next snapshot.
 */
export function fixUpCandidates(repo, full, { maxCommits = 5, maxHours = 24, branch = "HEAD", stop = () => false } = {}) {
  try {
    const time = (sha) => Number(git(repo, "log", "-1", "--format=%ct", sha).trim());
    const t0 = time(full);
    const out = [];
    for (const line of git(repo, "log", "--first-parent", "--reverse", "--ancestry-path", "--format=%H|%ct|%ad|%s", "--date=short", `${full}..${branch}`).split("\n").filter(Boolean)) {
      const [sha, t, date, ...subject] = line.split("|");
      const minutes = Math.round((Number(t) - t0) / 60);
      if (out.length >= maxCommits || minutes > maxHours * 60 || stop(sha)) break;
      out.push({ sha, short: sha.slice(0, 8), date, minutes, subject: subject.join("|") });
    }
    return out;
  } catch {
    return [];
  }
}

export const depsReady = () => hasDep("playwright") && hasDep("sharp");
