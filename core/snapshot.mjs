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
import { hasDep, requireDep } from "./deps.mjs";
import * as routes from "./routes.mjs";
import { background, git, sh, tail, waitForHttp, writeJson } from "./util.mjs";

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
  const baseUrl = `http://localhost:${port}`;

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
    exec: (command, options = {}) => sh(command, { cwd: dir, log: logFile, ...options }),
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
  let phase = "checkout";
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
    });
    if (adapter.install) await timed("install", () => adapter.install(ctx));
    if (adapter.seed) await timed("seed", () => adapter.seed(ctx));
    await timed("start", async () => {
      if (!adapter.start) throw new Error("adapter.mjs has no start(ctx): ui-progress does not know how to run this app");
      const started = await adapter.start(ctx);
      const spec = typeof started === "string" ? { command: started } : started ?? {};
      if (spec.command) {
        server = background(spec.command, { cwd: spec.cwd ?? dir, env: { PORT: String(port), ...spec.env }, log: path.join(out, "server.log") });
      } else if (spec.stop) server = { stop: spec.stop, exited: () => false };
      await waitForHttp(baseUrl + (spec.readyPath ?? config.run.readyPath), { timeoutMs: config.run.readyTimeoutMs, alive: () => !server?.exited() });
    });
    const manifest = await timed("capture", () => capture({ baseUrl, outDir: path.join(out, "shots"), config, adapter, ctx, log }));
    // A snapshot of error pages is not a snapshot.
    if (manifest.captured === 0) throw new Error(`no page could be captured (${manifest.routesTotal} routes, ${manifest.serverErrors.length} server errors${manifest.loginError ? ", sign-in failed: " + manifest.loginError : ""})`);
    if (manifest.serverErrors.length > manifest.routesTotal / 2) throw new Error(`${manifest.serverErrors.length} of ${manifest.routesTotal} pages answered with a server error; see server.log`);
    writeJson(path.join(out, "snapshot.json"), {
      sha: full,
      short,
      date,
      subject,
      timings,
      pages: manifest.routesTotal,
      captured: manifest.captured,
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
export async function captureLive(p, config, adapter, baseUrl, { states = false } = {}) {
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
  const manifest = await capture({ baseUrl: baseUrl.replace(/\/$/, ""), outDir: path.join(out, "shots"), config, adapter, ctx, log });
  writeJson(path.join(out, "snapshot.json"), { sha: full, short, date, subject, live: true, dirty, pages: manifest.routesTotal, captured: manifest.captured, states: manifest.states, skipped: manifest.skipped });
  fs.writeFileSync(path.join(out, "OK"), "");
  return { short, date, manifest, dirty };
}

export const depsReady = () => hasDep("playwright") && hasDep("sharp");
