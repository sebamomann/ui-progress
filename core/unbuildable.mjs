/**
 * Commits that do not build or run, kept in .ui-progress/unbuildable.json. The file is
 * small and meant to be committed: whoever plans or captures next (a person, another agent,
 * another machine) skips these commits instead of spending a full install and start on
 * them again, and takes the commit that stands in for them.
 *
 * A commit is recorded automatically only once a nearby later commit built and was captured
 * with the same adapter, which shows the adapter works and the commit itself is broken.
 * Failures with no such proof stay ordinary failures, to be fixed in the adapter.
 */
import path from "node:path";
import { git, readJson, writeJson } from "./util.mjs";

const file = (p) => path.join(p.root, "unbuildable.json");

export function readUnbuildable(p) {
  return readJson(file(p), { commits: [] }).commits ?? [];
}

/** The record for this commit (any form of sha), or null. */
export function unbuildableEntry(p, sha) {
  const list = readUnbuildable(p);
  if (!list.length) return null;
  let full;
  try {
    full = git(p.repo, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim();
  } catch {
    return null;
  }
  return list.find((e) => e.sha === full) ?? null;
}

/**
 * Record a commit as unbuildable. `replacedBy` is the commit captured in its place, if any;
 * `source` is "auto" (the fallback proved it) or "agent" (someone looked and decided).
 */
export function markUnbuildable(p, sha, { phase = null, cause = null, replacedBy = null, source = "agent", note = null } = {}) {
  const full = git(p.repo, "rev-parse", `${sha}^{commit}`).trim();
  const short = git(p.repo, "rev-parse", "--short=8", full).trim();
  const [date, subject] = git(p.repo, "log", "-1", "--format=%ad|%s", "--date=short", full).trim().split(/\|(.*)/s);
  const replacement = replacedBy ? git(p.repo, "rev-parse", `${replacedBy}^{commit}`).trim() : null;
  const commits = readUnbuildable(p).filter((e) => e.sha !== full);
  const entry = { sha: full, short, date, subject, phase, cause: cause ? String(cause).split("\n")[0].slice(0, 300) : null, replacedBy: replacement?.slice(0, 8) ?? null, replacedBySha: replacement, source, note, recordedAt: new Date().toISOString() };
  commits.push(entry);
  commits.sort((a, b) => a.date.localeCompare(b.date) || a.short.localeCompare(b.short));
  writeJson(file(p), { commits });
  return entry;
}

export function clearUnbuildable(p, sha) {
  const entry = unbuildableEntry(p, sha);
  if (!entry) return null;
  writeJson(file(p), { commits: readUnbuildable(p).filter((e) => e.sha !== entry.sha) });
  return entry;
}
