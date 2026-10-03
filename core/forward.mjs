/**
 * Keeping the history current: the hooks that tell an agent when a capture is due, and
 * the instructions block for projects whose agents do not load this plugin.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findRepo, loadConfig, paths } from "./config.mjs";
import { unbuildableEntry } from "./unbuildable.mjs";
import { VERSION, git, readJson, writeJson } from "./util.mjs";

const MARK_START = "<!-- ui-progress:start -->";
const MARK_END = "<!-- ui-progress:end -->";

function tracked() {
  try {
    const p = paths(findRepo());
    if (!fs.existsSync(p.config)) return null;
    return { p, config: loadConfig(p) };
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

/** HEAD plus a fingerprint of the uncommitted UI changes. */
function uiState(p, config) {
  const specs = config.sampling.uiPaths;
  const head = git(p.repo, "rev-parse", "HEAD").trim();
  const dirty = git(p.repo, "status", "--porcelain", "--", ...specs).trim();
  const diff = dirty ? git(p.repo, "diff", "HEAD", "--", ...specs) : "";
  return { head, dirty: crypto.createHash("sha1").update(dirty + diff).digest("hex"), hasDirty: Boolean(dirty) };
}

const stateFile = (p) => path.join(p.root, ".hook-state.json");
function saveSession(p, id, value) {
  const state = readJson(stateFile(p), { sessions: {} });
  state.sessions[id] = { ...value, at: Date.now() };
  const keep = Object.entries(state.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
  writeJson(stateFile(p), { sessions: Object.fromEntries(keep) });
}

/** SessionStart: say that the repository is tracked, and remember where the session began. */
export function sessionStart() {
  const t = tracked();
  if (!t) return;
  const { p, config } = t;
  const input = readStdin();
  const mode = config.forward.mode;
  if (mode === "off") return;
  if (input.session_id) saveSession(p, input.session_id, { start: uiState(p, config) });
  const done = fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots).filter((s) => fs.existsSync(path.join(p.snapshots, s, "OK"))).length : 0;
  // The viewer in the project is a copy made at build time; say so when the plugin moved on.
  const dataFile = path.join(p.viewer, "data", "history.js");
  const builtWith = fs.existsSync(dataFile) ? /"tool":\{"name":"ui-progress","version":"([^"]+)"/.exec(fs.readFileSync(dataFile, "utf8").slice(0, 400))?.[1] : null;
  const stale = builtWith && builtWith !== VERSION ? ` The viewer in .ui-progress/viewer was built with ui-progress ${builtWith}; this is ${VERSION}, so run \`ui-progress build\` once to update it.` : "";
  console.log(
    `This repository records its UI history with ui-progress (${done} snapshots in .ui-progress/). ` +
      `Snapshots are of commits only. When this session changes how a page looks, or adds, removes, splits, merges or renames a page: commit in small, focused steps, and when the work is done capture HEAD once for the whole batch (\`ui-progress pending\` shows what is due; see the ui-progress:history skill, "Capture the current state"). Do not capture after every intermediate commit.` + stale,
  );
}

/** Commit snapshots that finished, by full sha. */
function capturedShas(p) {
  const out = new Set();
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const dir = path.join(p.snapshots, short);
    const info = readJson(path.join(dir, "snapshot.json"));
    if (info?.sha && fs.existsSync(path.join(dir, "OK")) && !info.live && !info.workingTree) out.add(info.sha);
  }
  return out;
}

/**
 * What a capture would cover now: HEAD, the newest captured commit on its first-parent
 * line, the commits in between (and which of them touch UI paths), and whether the working
 * tree holds UI changes that no snapshot can include until they are committed.
 */
export function pendingState(p, config) {
  const head = git(p.repo, "rev-parse", "HEAD").trim();
  const short = git(p.repo, "rev-parse", "--short=8", head).trim();
  const captured = capturedShas(p);
  const line = git(p.repo, "log", "--first-parent", "--format=%H", "-n", "5000", head).split("\n").filter(Boolean);
  const lastIndex = line.findIndex((sha) => captured.has(sha));
  const last = lastIndex >= 0 ? { sha: line[lastIndex], short: line[lastIndex].slice(0, 8) } : null;
  const range = last ? [`${last.sha}..${head}`] : [head];
  const log = (...extra) => git(p.repo, "log", "--first-parent", "--format=%h|%ad|%s", "--date=short", ...range, ...extra).split("\n").filter(Boolean).map((l) => { const [sha, date, subject] = l.split(/\|/); return { sha, date, subject }; });
  const since = last ? log() : [];
  const uiSince = last ? log("--", ...config.sampling.uiPaths) : [];
  const dirty = git(p.repo, "status", "--porcelain", "--", ...config.sampling.uiPaths).split("\n").filter((l) => l.trim() && !l.slice(3).startsWith(".ui-progress/"));
  const broken = unbuildableEntry(p, head);
  return { head, short, headCaptured: captured.has(head), headUnbuildable: broken ? { phase: broken.phase, cause: broken.note ?? broken.cause } : null, last, since, uiSince, dirty: dirty.length };
}

/** Human-readable advice for `ui-progress pending`. */
export function renderPending(s) {
  const out = [];
  if (s.headCaptured) out.push(`HEAD ${s.short} is captured. Nothing to do.`);
  else if (s.headUnbuildable) out.push(`HEAD ${s.short} is recorded as unbuildable (${s.headUnbuildable.cause ?? s.headUnbuildable.phase ?? "no reason given"}). Capture the commit that fixes it once it exists, or: ui-progress unbuildable remove ${s.short}`);
  else if (!s.last) out.push(`HEAD ${s.short} is not captured, and no earlier commit on this line is either.`, `Capture the current state with: ui-progress snapshot HEAD   (backfill older history with ui-progress plan)`);
  else if (!s.uiSince.length) out.push(`HEAD ${s.short} is not captured, but none of the ${s.since.length} commit(s) since the last snapshot (${s.last.short}) touch UI paths. Nothing to capture.`);
  else {
    out.push(`HEAD ${s.short} is not captured. ${s.since.length} commit(s) since the last snapshot (${s.last.short}), ${s.uiSince.length} of them touch UI paths:`);
    for (const c of s.uiSince.slice(0, 15)) out.push(`  ${c.date} ${c.sha} ${c.subject}`);
    if (s.uiSince.length > 15) out.push(`  ... and ${s.uiSince.length - 15} more`);
    out.push("", "One snapshot of HEAD covers the whole batch. Capture once, after the last commit of the work:", "  ui-progress snapshot HEAD", `  ui-progress lineage candidates --since ${s.last.short}   (record splits, merges, renames in lineage.json)`, "  ui-progress build");
  }
  if (s.dirty) out.push("", `${s.dirty} uncommitted UI change(s) in the working tree. Snapshots are of commits only, so these are not captured until they are committed.`);
  return out.join("\n");
}

/**
 * Stop: if this session committed UI changes and HEAD is not captured, send the agent back
 * once to capture HEAD — one snapshot for the whole batch of commits, not one per commit.
 * Uncommitted UI changes only get a note: snapshots are of commits. It asks at most once
 * per state of the code, so it cannot loop.
 */
export function stop() {
  const t = tracked();
  if (!t) return;
  const { p, config } = t;
  if (config.forward.mode !== "auto") return;
  const input = readStdin();
  if (input.stop_hook_active || !input.session_id) return;
  const session = readJson(stateFile(p), { sessions: {} }).sessions[input.session_id];
  if (!session?.start) return;

  const now = uiState(p, config);
  const key = `${now.head}:${now.dirty}`;
  if (session.asked === key) return;
  const sessionCommits = now.head !== session.start.head ? git(p.repo, "log", "--first-parent", "--format=%h", `${session.start.head}..${now.head}`, "--", ...config.sampling.uiPaths).split("\n").filter(Boolean) : [];
  const uncommitted = now.dirty !== session.start.dirty && now.hasDirty;
  if (!sessionCommits.length && !uncommitted) return;
  const pending = pendingState(p, config);
  if (!uncommitted && (pending.headCaptured || pending.headUnbuildable)) return;
  saveSession(p, input.session_id, { ...session, asked: key });

  const parts = [];
  if (sessionCommits.length && !pending.headCaptured && !pending.headUnbuildable) {
    const batch = pending.last ? ` (${pending.uiSince.length} UI commit(s) since the last snapshot ${pending.last.short})` : "";
    parts.push(
      `ui-progress: this session made ${sessionCommits.length} commit(s) that touch UI files, and HEAD ${pending.short} is not captured${batch}.`,
      uncommitted
        ? `There are also uncommitted UI changes. If you are going to commit them as part of this task, do that first (in small, focused commits) and capture once after the last commit. Otherwise capture HEAD now; uncommitted work is not captured.`
        : `If the work is finished, capture once now: one snapshot of HEAD covers every commit of the batch; do not capture intermediate commits.`,
      `Run \`ui-progress snapshot HEAD\`; if a page was added, removed, split, merged or renamed, run \`ui-progress lineage candidates${pending.last ? ` --since ${pending.last.short}` : ""}\` and add the edges to .ui-progress/lineage.json; then \`ui-progress build\`.`,
    );
  } else {
    parts.push(
      `ui-progress: there are uncommitted UI changes. Snapshots are of commits only, so nothing can be captured yet.`,
      `If committing is part of this task, commit in small, focused steps and capture HEAD once after the last commit (\`ui-progress snapshot HEAD\`). Otherwise do not commit on your own: tell the user in one line that a capture is due after they commit.`,
    );
  }
  parts.push(`If nothing visible changed (a refactor, logic, tests), say so in one line and stop. This reminder appears once.`);
  console.log(JSON.stringify({ decision: "block", reason: parts.join(" ") }));
}

export function instructionsBlock() {
  return `${MARK_START}
## UI history (ui-progress)

This repository records how its UI evolves in \`.ui-progress/\` (screenshots of every page
per commit, page lineage, and a viewer at \`.ui-progress/viewer/index.html\`).

Snapshots are always of a **commit**: the commit is checked out into a throwaway folder
and run with a throwaway database. Uncommitted work and running apps are never captured.

When your work changes how a page looks, or adds, removes, splits, merges or renames a
page:

1. Commit in small, focused steps, one change per commit, so the history shows what
   changed when.
2. Capture **once, after the last commit of the task**, not after every commit. One
   snapshot of HEAD covers the whole batch. \`ui-progress pending\` says whether a capture
   is due and which commits it covers. Then: \`ui-progress snapshot HEAD\`.
3. If the set of pages changed, run \`ui-progress lineage candidates --since <last
   snapshot>\` (the sha \`pending\` prints) and add each relationship to
   \`.ui-progress/lineage.json\` (\`type\`: split, extract, merge, replace, rename or clone;
   \`from\`, \`to\`, \`sha\` of the commit that did it, \`date\`, \`confidence\`, and one or
   two sentences of \`evidence\`).
4. \`ui-progress build\`

If the feature you added needs data to show anything, extend the seed in
\`.ui-progress/adapter/\` so the page is not captured empty. Skip all of this for changes
with no visible effect. If \`ui-progress\` is not on PATH, the ui-progress plugin for
Claude Code is not enabled in this session: tell the user a capture is due.
${MARK_END}`;
}

/** Print the block, or write it into AGENTS.md / CLAUDE.md (replacing an earlier copy). */
export function instructions(flags) {
  const block = instructionsBlock();
  if (!flags.write) {
    console.log(block);
    return;
  }
  const repo = findRepo();
  const target = typeof flags.write === "string" ? path.resolve(repo, flags.write) : ["AGENTS.md", "CLAUDE.md"].map((f) => path.join(repo, f)).find((f) => fs.existsSync(f)) ?? path.join(repo, "AGENTS.md");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const pattern = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  const next = pattern.test(existing) ? existing.replace(pattern, block) : `${existing.replace(/\s*$/, "")}${existing ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(target, next);
  console.log(`${pattern.test(existing) ? "Updated" : "Added"} the ui-progress section in ${path.relative(repo, target)}`);
}
