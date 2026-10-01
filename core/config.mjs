/** Where things live in the tracked project, and its configuration merged over defaults. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, readJson } from "./util.mjs";

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
    viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } },
    signedOut: true,
    states: { enabled: true, maxClicks: 14, maxPerPage: 10, sectionChange: 0.2 },
    // labels never clicked while looking for dialogs and sections (regex, case-insensitive)
    // Destructive controls, and controls that do something rather than show something.
    unsafe:
      "delete|löschen|entfernen|remove|log ?out|abmelden|sign ?out|verwerfen|discard|impersonat|block|sperren|revoke|widerrufen|trash|pay|bezahlen|purchase|kaufen" +
      "|mark as|markieren|accept|annehmen|decline|ablehnen|reject|absagen|confirm|bestätigen|send|senden|save|speichern|submit|apply|anwenden|snooze|follow|folgen|publish|veröffentlichen",
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
  run: { concurrency: 3, basePort: 4100, keepWorktrees: false, readyPath: "/", readyTimeoutMs: 180000, workDir: null },
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

/** The project adapter: plain functions that know how to run this particular app. */
export async function loadAdapter(p) {
  if (!fs.existsSync(p.adapter)) return {};
  const mod = await import(pathToFileURL(p.adapter).href + `?t=${fs.statSync(p.adapter).mtimeMs}`);
  return mod.default ?? mod;
}
