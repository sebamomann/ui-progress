/**
 * Evidence for page lineage. Git cannot say "this page was split in two", but it can show,
 * for every commit that added or removed a page, which files moved or were copied between
 * page folders and which existing pages shrank in the same commit. The agent reads this,
 * looks at the diffs that matter, and writes its conclusions to .ui-progress/lineage.json.
 */
import fs from "node:fs";
import path from "node:path";
import { git, readJson, writeJson } from "./util.mjs";

export const EDGE_TYPES = ["split", "extract", "merge", "absorb", "rename", "replace", "clone"];

function pageDirs(repo, sha, config, routeOfFile) {
  const dirs = new Map();
  let files;
  try {
    files = git(repo, "ls-tree", "-r", "--name-only", sha, "--", ...config.lineage.pagePaths).split("\n");
  } catch {
    return dirs;
  }
  for (const file of files) {
    const route = routeOfFile(file);
    if (route) dirs.set(path.posix.dirname(file), route);
  }
  return dirs;
}

/** The page a file belongs to: the nearest folder above it that holds a page. */
function owner(dirs, file) {
  for (let dir = path.posix.dirname(file); dir && dir !== "."; dir = path.posix.dirname(dir)) {
    if (dirs.has(dir)) return dirs.get(dir);
  }
  return null;
}

/** `since`: only commits after this one (for the batch since the last snapshot). */
export function candidates(repo, config, adapter, { since = null } = {}) {
  if (!adapter.routeOfFile) throw new Error("Lineage evidence needs adapter.routeOfFile(file) so files can be mapped to pages.");
  const branch = config.sampling.branch ?? "HEAD";
  const range = since ? `${since}..${branch}` : branch;
  const shas = git(repo, "log", "--first-parent", "--reverse", "--diff-filter=ADR", "-M", "--format=%H", range, "--", ...config.lineage.pagePaths).split("\n").filter(Boolean);
  const out = [];
  for (const sha of shas) {
    // Against the first parent, so a merge commit shows what it brought in.
    const hasParent = (() => {
      try {
        git(repo, "rev-parse", "--verify", "--quiet", `${sha}^`);
        return true;
      } catch {
        return false;
      }
    })();
    const diff = (...format) => (hasParent ? git(repo, "diff", ...format, `${sha}^`, sha, "--", ...config.lineage.pagePaths) : git(repo, "show", "--format=", ...format, sha, "--", ...config.lineage.pagePaths));
    const status = diff("--name-status", "-M40%", "-C40%", "--find-copies-harder").split("\n").filter(Boolean);
    const added = [];
    const removed = [];
    const rows = status.map((line) => line.split("\t"));
    for (const [kind, a, b] of rows) {
      const from = adapter.routeOfFile(a);
      const to = b ? adapter.routeOfFile(b) : null;
      if (kind[0] === "A" && from) added.push(from);
      if (kind[0] === "D" && from) removed.push(from);
      if (kind[0] === "R" && from !== to) {
        if (from) removed.push(from);
        if (to) added.push(to);
      }
      if (kind[0] === "C" && to && from !== to) added.push(to);
    }
    if (!added.length && !removed.length) continue;

    const after = pageDirs(repo, sha, config, adapter.routeOfFile);
    const before = hasParent ? pageDirs(repo, `${sha}^`, config, adapter.routeOfFile) : new Map();
    // Files that moved or were copied from one page's folder into another's.
    const transfers = new Map();
    for (const [kind, a, b] of rows) {
      if ((kind[0] !== "R" && kind[0] !== "C") || !b) continue;
      const from = owner(before, a);
      const to = owner(after, b);
      if (!from || !to || from === to) continue;
      const key = `${from} -> ${to}`;
      if (!transfers.has(key)) transfers.set(key, { from, to, files: [] });
      transfers.get(key).files.push({ how: kind[0] === "R" ? "moved" : "copied", similarity: Number(kind.slice(1)), from: a, to: b });
    }
    // Existing pages that lost or gained a lot of code in the same commit.
    const churn = new Map();
    for (const line of diff("--numstat").split("\n")) {
      const [plus, minus, file] = line.split("\t");
      if (!file) continue;
      const route = owner(before, file.replace(/\{.* => (.*)\}/, "$1")) ?? owner(after, file);
      if (!route || added.includes(route)) continue;
      const entry = churn.get(route) ?? { route, added: 0, deleted: 0 };
      entry.added += Number(plus) || 0;
      entry.deleted += Number(minus) || 0;
      churn.set(route, entry);
    }
    const [short, date, subject] = git(repo, "log", "-1", "--format=%h|%ad|%s", "--date=short", sha).trim().split(/\|/);
    out.push({
      sha: short,
      date,
      subject,
      added: [...new Set(added)],
      removed: [...new Set(removed)],
      transfers: [...transfers.values()],
      touched: [...churn.values()].filter((e) => e.added + e.deleted >= 20).sort((a, b) => b.deleted - a.deleted).slice(0, 8),
    });
  }
  return out;
}

export function renderCandidates(list, lineage) {
  const reviewed = new Set([...Object.keys(lineage?.reviewed ?? {}), ...(lineage?.edges ?? []).map((e) => e.sha)]);
  const lines = [`# Lineage evidence: ${list.length} commits changed the set of pages`, ""];
  for (const c of list) {
    lines.push(`## ${c.date} ${c.sha} ${reviewed.has(c.sha) ? "(reviewed)" : ""}`, c.subject);
    if (c.added.length) lines.push(`  added:   ${c.added.join(", ")}`);
    if (c.removed.length) lines.push(`  removed: ${c.removed.join(", ")}`);
    for (const t of c.transfers) {
      lines.push(`  files ${t.files[0].how} ${t.from} -> ${t.to}: ${t.files.length}`);
      for (const f of t.files.slice(0, 4)) lines.push(`    ${f.how} ${f.similarity}%  ${f.from} -> ${f.to}`);
    }
    if (c.touched.length) lines.push(`  other pages touched: ${c.touched.map((e) => `${e.route} (+${e.added}/-${e.deleted})`).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Placement corrections from the last build (edges the snapshots contradict), unless
 * lineage.json changed since: then a build has to look again.
 */
function auditOf(p) {
  const file = path.join(p.viewer, "data", "lineage-audit.json");
  const audit = readJson(file);
  if (!audit) return { corrections: [], stale: false, missing: true };
  const stale = fs.existsSync(p.lineage) && fs.statSync(p.lineage).mtimeMs > Date.parse(audit.builtAt);
  return { corrections: stale ? [] : audit.corrections ?? [], stale, missing: false };
}

/** Write the corrections of the last build into lineage.json, keeping what was recorded before. */
export function fixLineage(p) {
  const lineage = readJson(p.lineage);
  const audit = auditOf(p);
  if (!lineage) throw new Error("no lineage.json yet");
  if (audit.missing || audit.stale) throw new Error("Run ui-progress build first: it checks lineage.json against the snapshots.");
  let fixed = 0;
  for (const c of audit.corrections) {
    const entry = lineage.edges[c.index];
    if (!entry || entry.type !== c.type || (entry.sha ?? null) !== c.recorded.sha || entry.date !== c.recorded.date || !c.sha) continue;
    entry.corrected = { sha: c.recorded.sha, date: c.recorded.date, reason: c.reason, exact: c.exact, at: new Date().toISOString().slice(0, 10) };
    entry.sha = c.sha;
    entry.date = c.date;
    fixed++;
  }
  if (fixed) writeJson(p.lineage, lineage);
  return { fixed, corrections: audit.corrections };
}

export function checkLineage(p) {
  const lineage = readJson(p.lineage);
  if (!lineage) return { ok: false, problems: ["no lineage.json yet"] };
  const problems = [];
  (lineage.edges ?? []).forEach((e, i) => {
    if (!EDGE_TYPES.includes(e.type)) problems.push(`edge ${i}: type "${e.type}" is not one of ${EDGE_TYPES.join(", ")}`);
    if (![e.from].flat().length || ![e.to].flat().length) problems.push(`edge ${i}: needs from and to`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "")) problems.push(`edge ${i}: date must be YYYY-MM-DD`);
    if (!e.evidence) problems.push(`edge ${i}: say what the evidence is`);
  });
  const audit = auditOf(p);
  const where = (c) =>
    !c.sha ? "no snapshot shows it done yet: check the edge, or capture a later commit"
    : c.exact ? `it belongs at ${c.sha}`
    : `it belongs at or before ${c.sha} (the snapshot that first shows it; git could not name the exact commit)`;
  const warnings = audit.corrections.map((c) => `edge ${c.index} (${c.type} ${[c.from].flat().join(", ")} -> ${[c.to].flat().join(", ")}, ${c.recorded.sha ?? c.recorded.date}) ${c.reason}; ${where(c)}`);
  if (audit.stale) warnings.push("lineage.json changed since the last build: run ui-progress build to check it against the snapshots again");
  return { ok: problems.length === 0, problems, warnings, edges: (lineage.edges ?? []).length, reviewed: Object.keys(lineage.reviewed ?? {}).length };
}
