/**
 * One snapshot: check a commit out into a throwaway worktree, let the adapter install,
 * seed and start it, capture it, and clean up. Results land in
 * .ui-progress/snapshots/<short sha>/.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { capture } from "./capture.mjs";
import { entryFiles, ingest, keepDesign, looksTheSame, neighbours, shotPath, takeOver, unchangedRoutes } from "./reuse.mjs";
import { imageComparer } from "./imagediff.mjs";
import { addFinding } from "./findings.mjs";
import { unbuildableEntry } from "./unbuildable.mjs";
import { assertIsolated, neutraliseCheckout, protectedDatabases, rewriteDatabaseUrls } from "./isolation.mjs";
import { hasDep, requireDep } from "./deps.mjs";
import { appendRun, machine, setupFingerprint, shotCount } from "./stats.mjs";
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

/**
 * The manifest entries to take over, by route: from the previous snapshot for pages whose
 * source dependencies are untouched since it, else from the next one for pages untouched
 * until it (a snapshot captured between two others). Also writes deps.json for the build's
 * evidence and for `relinkAfter`. `why` gets the reason when everything is recaptured, for
 * runs.jsonl.
 */
export function planReuse(p, config, adapter, ctx, full, near, why = {}) {
  const none = (fields) => (Object.assign(why, fields), null);
  if (!adapter.routeOfFile) return none({ reason: "no routeOfFile in the adapter" });
  const files = routes.pageFiles(ctx.dir, adapter.routeOfFile, config.lineage.pagePaths);
  const aliases = routes.readAliases(ctx.dir);
  const deps = {};
  for (const [route, file] of files) deps[route] = routes.routeDependencies(ctx.dir, file, aliases);
  writeJson(path.join(ctx.out, "deps.json"), deps);
  if (!config.capture.incremental.enabled) return none({ reason: "capture.incremental is off" });
  if (!near.previous && !near.next) return none({ reason: "no earlier snapshot" });
  const sides = [];
  if (near.previous) sides.push({ other: near.previous, word: "since", check: () => unchangedRoutes(p, config, { deps, from: near.previous.sha, to: full, read: (file) => fs.readFileSync(path.join(ctx.dir, file), "utf8") }) });
  if (near.next) sides.push({ other: near.next, word: "until", check: () => (near.next.deps ? unchangedRoutes(p, config, { deps: near.next.deps, from: full, to: near.next.sha, read: (file) => git(p.repo, "show", `${near.next.sha}:${file}`) }) : { reason: "no deps.json" }) });
  const entries = new Map();
  const from = [];
  let first = null, usable = false;
  for (const { other, word, check } of sides) {
    const result = JSON.stringify(other.manifest.viewports) !== JSON.stringify(config.capture.viewports) ? { reason: "viewports changed" } : check();
    first ??= { ...result, from: other.short };
    if (!result.routes) {
      if (result.file) ctx.log(`incremental: ${result.file} changed ${word} ${other.short}, no page is taken over from it`);
      continue;
    }
    usable = true;
    if (result.namespaces.length) ctx.log(`incremental: translation namespaces changed ${word} ${other.short}: ${result.namespaces.join(", ")}`);
    let taken = 0;
    for (const route of result.routes) {
      if (entries.has(route) || !deps[route]) continue;
      const entry = other.manifest.routes.find((r) => r.route === route);
      if (entry && !entry.skipped && Object.keys(entry.variants ?? {}).length) { entries.set(route, takeOver(p, other.short, entry)); taken++; }
    }
    ctx.log(`incremental: ${result.changed} files changed ${word} ${other.short}; ${taken} of ${files.size} pages taken over from it`);
    if (taken) from.push(`${taken} from ${other.short}`);
  }
  if (!usable) {
    if (!near.previous) return none({ reason: "no earlier snapshot" });
    ctx.log(`incremental: everything is recaptured`);
    const { routes: _, namespaces: __, ...fields } = first;
    return none(fields);
  }
  Object.assign(why, { reason: "incremental", from: near.previous?.short ?? null, ...(near.next ? { next: near.next.short } : {}), changed: first.changed ?? null });
  return { entries, from: from.join(", ") || "neighbours" };
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
  const recapture = {};
  const startedAt = new Date().toISOString();
  const setup = setupFingerprint(p);
  /** One line in runs.jsonl per attempt, failed or not. */
  const record = (fields) => {
    try {
      appendRun(p, {
        kind: "snapshot", started: startedAt, sha: short, date, subject,
        seconds: Object.values(timings).reduce((a, b) => a + b, 0), timings,
        concurrency: Number(process.env.UI_PROGRESS_CONCURRENCY) || 1, tabs: config.capture.parallel,
        setup, machine: machine(), ...fields,
      });
    } catch (err) {
      log(`could not write runs.jsonl: ${err.message}`);
    }
  };
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
    const near = neighbours(p, full);
    const reuse = planReuse(p, config, adapter, ctx, full, near, recapture);
    const screens = readJson(path.join(p.root, "screens.json"), []);
    const manifest = await timed("capture", () => capture({ baseUrl, outDir: path.join(out, "shots"), config, adapter, ctx, screens, reuse, log }));
    // A snapshot of error pages is not a snapshot.
    if (manifest.captured === 0) throw new Error(`no page could be captured (${manifest.routesTotal} routes, ${manifest.serverErrors.length} server errors${manifest.loginError ? ", sign-in failed: " + manifest.loginError : ""})`);
    if (manifest.serverErrors.length > manifest.routesTotal / 2) throw new Error(`${manifest.serverErrors.length} of ${manifest.routesTotal} pages answered with a server error; see server.log`);
    // Pages copied forward keep their old suspects; only what this commit rendered counts.
    const copied = new Set(manifest.routes.filter((r) => r.copiedFrom).map((r) => r.route));
    const errorPages = new Set(manifest.suspects.filter((s) => s.issues.includes("error page or overlay") && !copied.has(s.route)).map((s) => s.route));
    if (errorPages.size > (manifest.captured - manifest.reused) * config.run.fallback.errorPageShare) throw new Error(`${errorPages.size} of ${manifest.captured - manifest.reused} rendered pages show an error page or overlay; see server.log`);
    // A page rendered because its source changed may still look exactly like it does in a
    // neighbour (a comment, a refactor, a server-side change): it keeps the neighbour's
    // screenshots, marked `sameAs`, and the new files are dropped.
    if (config.capture.incremental.visualMatch) {
      const { identical } = imageComparer(requireDep("sharp"));
      let matched = 0;
      for (const [i, entry] of manifest.routes.entries()) {
        if (entry.copiedFrom || !Object.keys(entry.variants ?? {}).length) continue;
        for (const other of [near.previous, near.next]) {
          if (!other || JSON.stringify(other.manifest.viewports) !== JSON.stringify(manifest.viewports)) continue;
          const before = other.manifest.routes.find((r) => r.route === entry.route);
          if (!before || before.skipped || !(await looksTheSame(p, short, entry, other.short, before, identical))) continue;
          for (const f of entryFiles(entry)) fs.rmSync(shotPath(p, short, f), { force: true });
          manifest.routes[i] = { ...keepDesign(takeOver(p, other.short, before, "sameAs"), entry), url: entry.url };
          matched++;
          break;
        }
      }
      if (matched) log(`${matched} rendered page(s) look exactly as in a neighbouring snapshot; they share its screenshots`);
    }
    // What this commit rendered goes into the shared store (see reuse.mjs).
    for (const entry of manifest.routes) if (!entry.copiedFrom && !entry.sameAs) ingest(p, short, entry);
    writeJson(path.join(out, "shots", "manifest.json"), manifest);
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
    record({
      ok: true, pages: manifest.routesTotal, captured: manifest.captured, reused: manifest.reused, states: manifest.states, shots: shotCount(manifest),
      skipped: manifest.skipped.length, skippedWhy: manifest.skipped.reduce((n, s) => ({ ...n, [s.why]: (n[s.why] ?? 0) + 1 }), {}),
      suspects: manifest.suspects.length, crawled: manifest.crawled, recapture,
    });
    return { short, date, timings, manifest };
  } catch (err) {
    // The cause of a build or start failure is usually only in the app's own log.
    const cause = ["start", "capture"].includes(phase) ? firstError(path.join(out, "server.log")) : null;
    if (cause && !err.message.includes(cause)) err.message += `\nFirst error in server.log: ${cause}`;
    const fixUp = FALLBACK_PHASES.includes(phase) ? fixUpCandidates(p.repo, full, { ...config.run.fallback, branch: config.sampling.branch ?? "HEAD" }).find((c) => !unbuildableEntry(p, c.sha)) : null;
    if (fixUp) err.message += `\nThe next commit ${fixUp.short} came ${fixUp.minutes} min later ("${fixUp.subject}") and may fix this one.`;
    log(`FAILED in ${phase}: ${err.stack ?? err}`);
    fs.writeFileSync(path.join(out, "FAILED"), `${phase}\n${err.message}\n`);
    record({ ok: false, phase, error: err.message.split("\n")[0].slice(0, 300), ...(recapture.reason ? { recapture } : {}) });
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
