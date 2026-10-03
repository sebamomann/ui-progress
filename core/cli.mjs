/** The ui-progress command line. Run `ui-progress help` for the list of commands. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { DEFAULTS, findRepo, loadAdapter, loadConfig, paths } from "./config.mjs";
import { DEPS_DIR, PACKAGES, hasDep } from "./deps.mjs";
import { addFinding, exportFindings, listFindings, resolveFinding } from "./findings.mjs";
import { changelogCandidates, checkChangelog } from "./changelog.mjs";
import { instructions, sessionStart, stop } from "./forward.mjs";
import { candidates, checkLineage, renderCandidates } from "./lineage.mjs";
import { MODES, buildPlan } from "./plan.mjs";
import { depsReady, ensureClone, isDone, runSnapshot, snapshotDir } from "./snapshot.mjs";
import { VERSION, git, parseArgs, readJson, sh, table, writeJson } from "./util.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.join(ROOT, "bin", "ui-progress");

const HELP = `ui-progress ${VERSION} — track how a website's UI evolves

Setup
  doctor [--install]            check (or install) Playwright, Chromium and sharp
  init [--preset <name>]        create .ui-progress/ in this repository
                                presets: blank, next-app, next-pages, crawl

Choosing commits
  plan [--mode <mode>] [--max N] [--from DATE] [--to DATE] [--print]
                                modes: ${MODES.join(", ")}
  plan --candidates             every commit with its UI change stats, as JSON (for "auto")

Capturing
  snapshot <sha...>             capture specific commits
  snapshot --plan               capture every planned commit that is not done yet
      [--concurrency N] [--force] [--limit N] [--ignore-memory]
  status                        what is planned, done and failed

Keeping it current
  instructions [--write [file]] print the section that tells any agent to capture after UI
                                changes, or write it into AGENTS.md / CLAUDE.md
  (with the plugin enabled, hooks do this on their own; see config "forward.mode")

Lineage and story
  lineage candidates            evidence for splits, merges and renames, for the agent
  lineage check                 validate .ui-progress/lineage.json
  changelog candidates          per snapshot: what changed, and the commits in between
  changelog check               validate .ui-progress/changelog.json

Viewing
  build                         rebuild the viewer's dataset
  view                          build, then open the viewer

Findings (problems with ui-progress itself)
  finding add --kind <bug|limitation|workaround|idea> --title "..." [--detail "..."]
              [--command "..."] [--sha <sha>] [--log-file <path>]
  finding list | export | resolve <id>
`;

function context(required = true) {
  const p = paths(findRepo());
  return { p, config: loadConfig(p, { required }) };
}

async function doctor(flags) {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(["node >= 18", major >= 18, process.version]);
  let gitVersion = null;
  try {
    gitVersion = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // reported below
  }
  checks.push(["git", Boolean(gitVersion), gitVersion ?? "not found"]);
  if (flags.install) {
    fs.mkdirSync(DEPS_DIR, { recursive: true });
    if (!fs.existsSync(path.join(DEPS_DIR, "package.json"))) writeJson(path.join(DEPS_DIR, "package.json"), { name: "ui-progress-deps", private: true });
    console.log(`Installing ${PACKAGES.join(", ")} into ${DEPS_DIR} ...`);
    await sh(`npm install --no-audit --no-fund ${PACKAGES.join(" ")}`, { cwd: DEPS_DIR });
    console.log("Installing the Chromium build Playwright drives ...");
    await sh("npx playwright install chromium", { cwd: DEPS_DIR });
  }
  checks.push(["playwright", hasDep("playwright"), DEPS_DIR]);
  checks.push(["sharp", hasDep("sharp"), DEPS_DIR]);
  let browser = false;
  if (hasDep("playwright")) {
    try {
      const { chromium } = (await import("./deps.mjs")).requireDep("playwright");
      browser = fs.existsSync(chromium.executablePath());
    } catch {
      browser = false;
    }
  }
  checks.push(["chromium", browser, browser ? "installed" : "missing"]);
  console.log(table(checks.map(([name, ok, note]) => [ok ? "ok " : "MISSING", name, note])));
  if (checks.some(([, ok]) => !ok)) {
    console.log("\nRun: ui-progress doctor --install");
    process.exitCode = 1;
  }
}

function init(flags) {
  const p = paths(findRepo());
  const preset = flags.preset ?? "blank";
  const template = path.join(ROOT, "templates", `adapter.${preset}.mjs`);
  if (!fs.existsSync(template)) throw new Error(`Unknown preset "${preset}". Available: ${fs.readdirSync(path.join(ROOT, "templates")).filter((f) => f.startsWith("adapter.")).map((f) => f.slice(8, -4)).join(", ")}`);
  fs.mkdirSync(p.root, { recursive: true });
  const created = [];
  const place = (file, content) => {
    if (fs.existsSync(file) && !flags.force) return;
    fs.writeFileSync(file, content);
    created.push(path.relative(p.repo, file));
  };
  place(p.config, fs.readFileSync(path.join(ROOT, "templates", "config.json"), "utf8").replace("__NAME__", path.basename(p.repo)));
  place(p.adapter, fs.readFileSync(template, "utf8"));
  place(path.join(p.root, ".gitignore"), fs.readFileSync(path.join(ROOT, "templates", "gitignore"), "utf8"));
  place(path.join(p.root, "README.md"), fs.readFileSync(path.join(ROOT, "templates", "project-readme.md"), "utf8"));
  place(p.lineage, JSON.stringify({ edges: [], reviewed: {} }, null, 2) + "\n");
  console.log(created.length ? `Created:\n${created.map((f) => "  " + f).join("\n")}` : "Everything already exists (use --force to overwrite).");
  console.log(`\nNext: fill in .ui-progress/adapter.mjs, then run  ui-progress plan --mode pilot`);
}

async function plan(flags) {
  const { p, config } = context();
  const adapter = await loadAdapter(p);
  if (flags.max) config.sampling.max = Number(flags.max);
  if (flags.from) config.sampling.from = flags.from;
  if (flags.to) config.sampling.to = flags.to;
  if (flags.candidates) {
    const { commits } = await import("./plan.mjs");
    console.log(JSON.stringify(commits(p.repo, config, adapter).filter((c) => c.churn || c.pagesAdded.length || c.pagesRemoved.length), null, 1));
    return;
  }
  const mode = flags.mode ?? config.sampling.mode;
  const result = mode === "manual" ? readJson(p.plan) : buildPlan(p.repo, config, adapter, mode);
  if (!result) throw new Error("Mode is manual and there is no plan.json. Write one, or pick another --mode.");
  if (!flags.print && mode !== "manual") writeJson(p.plan, result);
  console.log(`${result.entries.length} snapshots planned (${result.mode}) out of ${result.commitsInRange ?? "?"} commits${flags.print ? " — not saved" : ""}\n`);
  console.log(table(result.entries.map((e) => [isDone(p, e.short) ? "done" : "todo", e.date, e.short, e.reason.slice(0, 70)])));
}

async function snapshot(flags, positional) {
  const { p, config } = context();
  if (!depsReady()) throw new Error("Dependencies are missing. Run: ui-progress doctor --install");
  const adapter = await loadAdapter(p);
  if (flags.live || flags["working-tree"]) {
    throw new Error("Snapshots are always of a commit. Commit the change, then run: ui-progress snapshot HEAD");
  }
  let shas = positional;
  if (flags.plan) {
    const planned = readJson(p.plan);
    if (!planned) throw new Error("No plan.json. Run: ui-progress plan --mode pilot");
    shas = planned.entries.filter((e) => flags.force || !isDone(p, e.short)).map((e) => e.sha);
    if (flags.limit) shas = shas.slice(0, Number(flags.limit));
  }
  if (!shas.length) {
    console.log("Nothing to capture.");
    return;
  }
  // A single commit runs in this process; several run as parallel child processes.
  if (shas.length === 1 && flags.port) {
    const result = await runSnapshot(p, config, adapter, shas[0], { port: Number(flags.port), force: true, refreshClone: false });
    console.log(JSON.stringify({ short: result.short, date: result.date, failed: result.failed ?? null, error: result.error ?? null, timings: result.timings ?? null, pages: result.manifest ? `${result.manifest.captured}/${result.manifest.routesTotal}` : null, reused: result.manifest?.reused ?? 0, states: result.manifest?.states ?? null }));
    if (result.failed) process.exitCode = 1;
    return;
  }
  ensureClone(p); // once, here: the parallel workers must not race to create or fetch it
  // Each snapshot runs the app's dev server and a browser: budget about 3.5 GB apiece and
  // leave 6 GB for everything else on the machine. Asking for more than fits is how a long
  // run gets killed for memory halfway through.
  const wanted = Math.max(1, Number(flags.concurrency ?? config.run.concurrency));
  const fits = Math.max(1, Math.floor((os.totalmem() / 2 ** 30 - 6) / 3.5));
  const concurrency = flags["ignore-memory"] ? wanted : Math.min(wanted, fits);
  if (concurrency < wanted) console.log(`This machine has ${Math.round(os.totalmem() / 2 ** 30)} GB of memory: running ${concurrency} at a time instead of ${wanted} (override with --ignore-memory).`);
  const queue = [...shas];
  const started = Date.now();
  let done = 0;
  let failed = 0;
  console.log(`Capturing ${shas.length} snapshot(s), ${concurrency} at a time ...`);
  const worker = async (slot) => {
    while (queue.length) {
      const sha = queue.shift();
      const line = await new Promise((resolve) => {
        let output = "";
        const child = spawn(process.execPath, [SELF, "snapshot", sha, "--port", String(config.run.basePort + slot)], { cwd: p.repo, stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.on("data", (d) => (output += d));
        child.on("exit", () => resolve(output.trim().split("\n").pop()));
      });
      let result = {};
      try {
        result = JSON.parse(line);
      } catch {
        result = { short: sha.slice(0, 8), failed: "crash", error: line };
      }
      done++;
      if (result.failed) failed++;
      const seconds = result.timings ? Object.values(result.timings).reduce((a, b) => a + b, 0) : 0;
      console.log(`[${done}/${shas.length}] ${result.date ?? ""} ${result.short}  ${result.failed ? `FAILED in ${result.failed}: ${result.error}` : `${result.pages} pages${result.reused ? ` (${result.reused} copied forward)` : ""}, ${result.states} states, ${seconds}s`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, shas.length) }, (_, i) => worker(i)));
  console.log(`\nDone in ${Math.round((Date.now() - started) / 60000)} min: ${done - failed} captured, ${failed} failed.`);
  if (failed) console.log("Failures are recorded as findings: ui-progress finding list");
}

function status(flags) {
  const { p, config } = context();
  const planned = readJson(p.plan, { entries: [] });
  const rows = planned.entries.map((e) => {
    const dir = snapshotDir(p, e.short);
    const state = fs.existsSync(path.join(dir, "OK")) ? "done" : fs.existsSync(path.join(dir, "FAILED")) ? `FAILED (${fs.readFileSync(path.join(dir, "FAILED"), "utf8").split("\n")[0]})` : "todo";
    return [state, e.date, e.short, e.reason.slice(0, 60)];
  });
  console.log(`Project: ${config.project.name}   sampling: ${planned.mode ?? config.sampling.mode}   planned: ${rows.length}   done: ${rows.filter((r) => r[0] === "done").length}   failed: ${rows.filter((r) => r[0].startsWith("FAILED")).length}\n`);
  console.log(table(rows));
  const open = listFindings(p).filter((f) => f.status === "open").length;
  if (open) console.log(`\n${open} open finding(s): ui-progress finding list`);
}

async function lineage(flags, [sub]) {
  const { p, config } = context();
  if (sub === "check") {
    const result = checkLineage(p);
    console.log(result.ok ? `lineage.json is valid: ${result.edges} edges, ${result.reviewed} commits reviewed without lineage` : `Problems:\n${result.problems.map((x) => "  " + x).join("\n")}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const adapter = await loadAdapter(p);
  const list = candidates(p.repo, config, adapter);
  console.log(flags.json ? JSON.stringify(list, null, 1) : renderCandidates(list, readJson(p.lineage)));
}

async function doBuild() {
  const { p, config } = context();
  const adapter = await loadAdapter(p);
  const result = await build(p, config, adapter, { log: (m) => console.log("  " + m) });
  console.log(`\n${result.snapshots} snapshots, ${result.captured} pages captured (${result.pages} known), ${result.views} views, lineage ${JSON.stringify(result.edges)}`);
  console.log(`Viewer: ${result.index}`);
  return result;
}

function finding(flags, [sub, id]) {
  const { p, config } = context();
  if (sub === "add") {
    const log = flags["log-file"] ? fs.readFileSync(flags["log-file"], "utf8").split("\n").slice(-60).join("\n") : null;
    const f = addFinding(p, { kind: flags.kind ?? "bug", title: flags.title, detail: flags.detail ?? "", command: flags.command ?? null, sha: flags.sha ?? null, log });
    console.log(`Recorded ${f.id}`);
  } else if (sub === "export") {
    const result = exportFindings(p, config.project.name);
    console.log(`${result.count} open finding(s) written to ${path.relative(p.repo, result.file)}`);
  } else if (sub === "resolve") {
    resolveFinding(p, id);
    console.log(`Resolved ${id}`);
  } else {
    const all = listFindings(p);
    console.log(all.length ? table(all.map((f) => [f.status, f.kind, f.id, f.title])) : "No findings.");
  }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  try {
    if (!command || command === "help" || flags.help) console.log(HELP);
    else if (command === "version" || command === "--version") console.log(VERSION);
    else if (command === "doctor") await doctor(flags);
    else if (command === "init") init(flags);
    else if (command === "plan") await plan(flags);
    else if (command === "snapshot") await snapshot(flags, positional);
    else if (command === "status") status(flags);
    else if (command === "hook") (positional[0] === "stop" ? stop : sessionStart)();
    else if (command === "instructions") instructions(flags);
    else if (command === "lineage") await lineage(flags, positional);
    else if (command === "changelog") {
      const { p, config } = context();
      if (positional[0] === "check") { const r = checkChangelog(p); console.log(r.ok ? `changelog.json is valid: ${r.entries} chapters` : `Problems:\n${r.problems.map((x) => "  " + x).join("\n")}`); if (!r.ok) process.exitCode = 1; }
      else console.log(changelogCandidates(p, config));
    }
    else if (command === "build") await doBuild();
    else if (command === "view") {
      const result = await doBuild();
      const opener = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
      spawn(opener, [result.index], { stdio: "ignore", detached: true, shell: os.platform() === "win32" }).unref();
    } else if (command === "finding" || command === "findings") finding(flags, positional);
    else {
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`ui-progress: ${err.message}`);
    if (process.env.UI_PROGRESS_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}

export { DEFAULTS };
