/** Where things live in the tracked project, and its configuration merged over defaults. */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION, git, readJson } from "./util.mjs";

export const DEFAULTS = {
  version: 1,
  project: { name: null },
  sampling: {
    // pilot | monthly | weekly | daily | every-n | auto | all | manual
    mode: "pilot",
    everyN: 25,
    max: null,
    from: null,
    to: null,
    branch: null,
    // git pathspecs that count as "UI" when measuring how much a commit changed
    uiPaths: ["."],
    auto: { churn: 600, minGapDays: 1 },
  },
  capture: {
    // A viewport may carry its own colorScheme ("light" | "dark"); the first one is primary.
    viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } },
    // Tabs capturing at the same time against one app instance.
    parallel: 3,
    signedOut: true,
    // depth 2 also tries tabs and buttons inside an opened dialog or menu.
    // budgetMs per page; totalBudgetMs for the click-through of the whole snapshot, after
    // which the remaining pages are shot without looking for their states.
    states: { enabled: true, maxClicks: 20, maxPerPage: 12, depth: 2, depthClicks: 3, sectionChange: 0.2, budgetMs: 45000, totalBudgetMs: 900000 },
    // Copy a page forward from the previous snapshot when none of its source files changed.
    // globalPaths: a change there recaptures everything. translationPaths: JSON message
    // files whose changed top-level keys (namespaces) decide which pages are affected.
    // visualMatch: a page rendered again that looks exactly as in a neighbouring snapshot
    // (at full resolution, at most a few anti-aliased pixels differ) keeps its screenshots.
    incremental: { enabled: true, visualMatch: true, globalPaths: ["package.json", "*.config.*", "**/globals.css", "**/global.css", "public/**", "tailwind.config.*"], translationPaths: ["messages/**", "locales/**", "i18n/**", "**/translations/**"] },
    // labels never clicked while looking for dialogs and sections (regex, case-insensitive)
    // Destructive controls, and controls that do something rather than show something.
    unsafe:
      "delete|löschen|entfernen|remove|log ?out|abmelden|sign ?out|verwerfen|discard|impersonat|block|sperren|revoke|widerrufen|trash|pay|bezahlen|purchase|kaufen" +
      "|mark as|markieren|accept|annehmen|decline|ablehnen|reject|absagen|confirm|bestätigen|send|senden|save|speichern|submit|apply|anwenden|snooze|follow|folgen|publish|veröffentlichen",
    // Cheap checks after every page load. notFound: title or main heading of a page that
    // says it does not exist (also when it answered 200). errorSelectors: dev-server error
    // overlays and framework error pages. hydration: page errors and console errors that
    // report a server/client render mismatch. Pages that match are skipped or marked as suspect.
    checks: {
      notFound: "\\b404\\b|not found|page not found|does not exist|nicht gefunden|introuvable|no encontrad|non trovat|não encontrad|niet gevonden|nie znaleziono|見つかりません|找不到|не найден",
      errorSelectors: ["vite-error-overlay", "#webpack-dev-server-client-overlay", "[data-nextjs-dialog-overlay]", "#__next_error__", "#traceback", ".exception_value"],
      errorTitle: "traceback|exception|internal server error|application error|unhandled runtime error|server error|fatal error|\\b500\\b",
      signInPaths: "login|log-in|signin|sign-in|signup|sign-up|register|auth|password|account/new",
      hydration: "hydrat|did not match\\. Server|server (rendered )?HTML|Minified React error #(418|419|421|422|423|425)",
    },
    hide: ["nextjs-portal", "#__next-build-watcher", "vite-error-overlay", "#djDebug"],
    locale: "en-US",
    colorScheme: "light",
    maxPageHeight: 9000,
    settleRounds: 20,
    navTimeoutMs: 45000,
    crawlLimit: 80,
    include: [],
    exclude: [],
  },
  // fallback: when a commit fails to install, build, start or render, capture the next
  // commit on the line within maxCommits / maxHours instead, and record the broken one in
  // unbuildable.json. errorPageShare: more rendered pages than this share showing an error
  // page or overlay makes the snapshot a failure.
  run: { concurrency: 3, basePort: 4100, keepWorktrees: false, readyPath: "/", readyTimeoutMs: 180000, workDir: null, fallback: { enabled: true, maxCommits: 5, maxHours: 24, errorPageShare: 0.5 } },
  // isolation "throwaway": snapshots build their own data and are refused if they would
  // touch a database from the project's env files. "shared" only on the user's explicit wish.
  data: { isolation: "throwaway", protect: [] },
  login: null,
  lineage: { pagePaths: ["."] },
  // auto: a hook sends the agent back to capture when a session changed UI files.
  // remind: only the note at session start. off: nothing.
  // instructionsFile: whether the user wanted the capture rule in AGENTS.md / CLAUDE.md
  // (null = not asked yet).
  forward: { mode: "auto", instructionsFile: null },
  // Share of the page (in blocks) that must differ. Below "tweak" a view counts as unchanged.
  thresholds: { redesign: 0.3, tweak: 0.02 },
};

function merge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object" || base === null || typeof over !== "object" || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
  return out;
}

export function findRepo(start = process.cwd()) {
  try {
    return git(start, "rev-parse", "--show-toplevel").trim();
  } catch {
    throw new Error("Not inside a git repository. ui-progress tracks a project through its git history.");
  }
}

export function paths(repo) {
  const root = path.join(repo, ".ui-progress");
  return {
    repo,
    root,
    config: path.join(root, "config.json"),
    adapter: path.join(root, "adapter.mjs"),
    plan: path.join(root, "plan.json"),
    lineage: path.join(root, "lineage.json"),
    changelog: path.join(root, "changelog.json"),
    screens: path.join(root, "screens.json"),
    snapshots: path.join(root, "snapshots"),
    findings: path.join(root, "findings"),
    // Checkouts of old commits live OUTSIDE the repository. Inside it, build tools walk up
    // the folder tree and pick up the live project's lockfile, config and env files.
    work: path.join(os.homedir(), ".ui-progress", "work", `${path.basename(repo)}-${crypto.createHash("sha1").update(repo).digest("hex").slice(0, 8)}`),
    viewer: path.join(root, "viewer"),
  };
}

export function loadConfig(p, { required = true } = {}) {
  if (!fs.existsSync(p.config)) {
    if (required) throw new Error(`No ${path.relative(p.repo, p.config)} here. Run: ui-progress init`);
    return merge(DEFAULTS, {});
  }
  const config = merge(DEFAULTS, readJson(p.config));
  config.project.name ??= path.basename(p.repo);
  if (config.run.workDir) p.work = path.resolve(p.repo, config.run.workDir);
  return config;
}

/** Methods ctx offers, with the version that added each one (for the skew check). */
export const CTX_METHODS = { exec: "0.1.0", has: "0.1.0", read: "0.1.0", require: "0.1.0", log: "0.1.0", assertThrowaway: "0.5.0", rewriteDatabaseUrls: "0.6.0", sharp: "0.1.0" };

const semver = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
export function versionAtLeast(have, want) {
  const [a, b] = [semver(have), semver(want)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * Fail before any checkout when the adapter needs a newer ui-progress than this one: by its
 * `export const requires = "x.y.z"`, or by calling a ctx method this version lacks.
 */
function checkAdapterVersion(p, mod) {
  const where = `ui-progress ${VERSION} at ${path.join(path.dirname(fileURLToPath(import.meta.url)), "..")}`;
  const update = "Update the plugin (claude plugin update ui-progress), then restart Claude Code so the new version is on PATH.";
  if (mod.requires && !versionAtLeast(VERSION, mod.requires)) throw new Error(`.ui-progress/adapter.mjs requires ui-progress ${mod.requires} or newer; this is ${where}. ${update}`);
  const sources = [p.adapter];
  const helpers = path.join(p.root, "adapter");
  if (fs.existsSync(helpers)) for (const f of fs.readdirSync(helpers)) if (/\.(m|c)?js$/.test(f)) sources.push(path.join(helpers, f));
  const missing = new Set();
  for (const file of sources) for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/\bctx\.([A-Za-z_]\w*)\s*\(/g)) if (!(name in CTX_METHODS)) missing.add(name);
  if (missing.size) throw new Error(`The adapter calls ctx.${[...missing].join(", ctx.")}, which ${where} does not have. Either the adapter was written for a newer ui-progress, or the name is wrong (docs/ADAPTERS.md lists the ctx methods). ${update}`);
}

/** The project adapter: plain functions that know how to run this particular app. */
export async function loadAdapter(p) {
  if (!fs.existsSync(p.adapter)) return {};
  let mod;
  try {
    mod = await import(pathToFileURL(p.adapter).href + `?t=${fs.statSync(p.adapter).mtimeMs}`);
  } catch (err) {
    // An ES module that does not parse says only "Unexpected token": ask node for the place.
    let where = "";
    if (err instanceof SyntaxError) {
      try {
        execFileSync(process.execPath, ["--check", p.adapter], { stdio: "pipe" });
      } catch (check) {
        where = String(check.stderr).trim().split("\n").slice(0, 3).join("\n");
      }
    }
    throw new Error(`${path.relative(p.repo, p.adapter)} does not load: ${err.message}${where ? `\n${where}` : ""}`);
  }
  checkAdapterVersion(p, mod);
  return mod.default ?? mod;
}
