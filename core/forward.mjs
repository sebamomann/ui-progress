/**
 * Keeping the history current: the hooks that tell an agent when a capture is due, and
 * the instructions block for projects whose agents do not load this plugin.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findRepo, loadConfig, paths } from "./config.mjs";
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
      `When this session changes how a page looks, or adds, removes, splits, merges or renames a page, capture it before finishing: use the ui-progress skill ("Capture the current state").` + stale,
  );
}

/**
 * Stop: if UI files changed during this session and no capture followed, send the agent
 * back once to decide. It asks at most once per state of the code, so it cannot loop.
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
  const committed = now.head !== session.start.head ? git(p.repo, "diff", "--name-only", session.start.head, now.head, "--", ...config.sampling.uiPaths).split("\n").filter(Boolean) : [];
  const uncommitted = now.dirty !== session.start.dirty && now.hasDirty;
  if (!committed.length && !uncommitted) return;

  const short = git(p.repo, "rev-parse", "--short=8", "HEAD").trim();
  if (!uncommitted && fs.existsSync(path.join(p.snapshots, short, "OK"))) return;
  saveSession(p, input.session_id, { ...session, asked: key });

  const files = committed.slice(0, 5).join(", ") + (committed.length > 5 ? `, and ${committed.length - 5} more` : "");
  const what = [committed.length ? `${committed.length} UI file(s) committed in this session (${files})` : null, uncommitted ? "uncommitted UI changes in the working tree" : null].filter(Boolean).join("; ");
  const reason =
    `ui-progress: ${what}, and the current state is not captured. ` +
    `If this changed how a page looks, or the set of pages: ` +
    (uncommitted
      ? `the changes are not committed, and snapshots are always of a commit: tell the user a capture is due once they commit (then \`ui-progress snapshot HEAD\`). Do not commit on your own. `
      : `run \`ui-progress snapshot HEAD\`. `) +
    `If a page was added, removed, split, merged or renamed, add the edge to .ui-progress/lineage.json, then run \`ui-progress build\`. ` +
    `If nothing visible changed (a refactor, logic, tests), say so in one line and stop. This reminder appears once.`;
  console.log(JSON.stringify({ decision: "block", reason }));
}

export function instructionsBlock() {
  return `${MARK_START}
## UI history (ui-progress)

This repository records how its UI evolves in \`.ui-progress/\` (screenshots of every page
per commit, page lineage, and a viewer at \`.ui-progress/viewer/index.html\`).

When your work changes how a page looks, or adds, removes, splits, merges or renames a
page, capture it before you finish:

1. After the change is committed: \`ui-progress snapshot HEAD\`. Snapshots are always of a
   commit and use a throwaway database; never point them at the project's own data.
2. If the set of pages changed, add the relationship to \`.ui-progress/lineage.json\`
   (\`type\`: split, extract, merge, replace, rename or clone; \`from\`, \`to\`, \`sha\`, \`date\`,
   \`confidence\`, and one or two sentences of \`evidence\`).
3. \`ui-progress build\`

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
