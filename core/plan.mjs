/**
 * Decide which commits get a snapshot.
 *
 * Interval modes take the last commit of each period. "auto" takes the commits where the
 * UI actually moved: a page was added or removed, or enough UI code changed since the
 * previous pick. The result is plan.json, which can be edited by hand or by the agent.
 */
import { git } from "./util.mjs";

export const MODES = ["pilot", "monthly", "weekly", "daily", "every-n", "auto", "all", "manual"];
const PILOT_MAX = 8;

/** Mainline commits, oldest first, with how much UI each one touched. */
export function commits(repo, config, adapter) {
  const s = config.sampling;
  const range = [s.branch ?? "HEAD"];
  const limits = [];
  if (s.from) limits.push(`--since=${s.from}`);
  if (s.to) limits.push(`--until=${s.to}`);
  const list = git(repo, "log", "--first-parent", "--reverse", "--format=%H|%h|%ad|%s", "--date=short", ...limits, ...range)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, short, date, ...subject] = line.split("|");
      return { sha, short, date, subject: subject.join("|"), churn: 0, pagesAdded: [], pagesRemoved: [] };
    });
  const bySha = new Map(list.map((c) => [c.sha, c]));

  let current = null;
  for (const line of git(repo, "log", "--first-parent", "--numstat", "--format=@%H", ...limits, ...range, "--", ...s.uiPaths).split("\n")) {
    if (line.startsWith("@")) current = bySha.get(line.slice(1));
    else if (current && line.trim()) {
      const [added, deleted] = line.split("\t");
      current.churn += (Number(added) || 0) + (Number(deleted) || 0);
    }
  }
  if (adapter.routeOfFile) {
    current = null;
    for (const line of git(repo, "log", "--first-parent", "-M", "--diff-filter=ADR", "--name-status", "--format=@%H", ...limits, ...range, "--", ...config.lineage.pagePaths).split("\n")) {
      if (line.startsWith("@")) current = bySha.get(line.slice(1));
      else if (current && line.trim()) {
        const [status, a, b] = line.split("\t");
        const from = adapter.routeOfFile(a);
        const to = b ? adapter.routeOfFile(b) : null;
        if (status[0] === "A" && from) current.pagesAdded.push(from);
        if (status[0] === "D" && from) current.pagesRemoved.push(from);
        if (status[0] === "R" && from !== to) {
          if (from) current.pagesRemoved.push(from);
          if (to) current.pagesAdded.push(to);
        }
      }
    }
  }
  return list;
}

function isoWeek(date) {
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function lastPerBucket(list, key, label) {
  const picks = new Map();
  for (const c of list) picks.set(key(c), c);
  return [...picks.entries()].map(([bucket, c]) => ({ ...c, reason: `${label} ${bucket}` }));
}

/** Keep the first and last pick and thin the rest evenly (or by lowest score). */
function thin(picks, max, score) {
  if (!max || picks.length <= max) return picks;
  if (score) {
    const keep = new Set([picks[0], picks[picks.length - 1]]);
    for (const c of [...picks.slice(1, -1)].sort((a, b) => score(b) - score(a))) {
      if (keep.size >= max) break;
      keep.add(c);
    }
    return picks.filter((c) => keep.has(c));
  }
  const out = [];
  for (let i = 0; i < max; i++) out.push(picks[Math.round((i * (picks.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

function auto(list, config) {
  const { churn: threshold, minGapDays } = config.sampling.auto;
  const picks = [];
  let pending = 0;
  let lastDate = null;
  const gapOk = (date) => !lastDate || (Date.parse(date) - Date.parse(lastDate)) / 86400000 >= minGapDays;
  list.forEach((c, i) => {
    pending += c.churn;
    const pagesMoved = c.pagesAdded.length + c.pagesRemoved.length;
    const next = list[i + 1];
    // Take the last commit of a burst: wait while the next commit keeps changing pages the same day.
    const burstContinues = next && next.date === c.date && next.pagesAdded.length + next.pagesRemoved.length > 0;
    let reason = null;
    if (i === 0) reason = "first commit";
    else if (pagesMoved && !burstContinues) reason = [c.pagesAdded.length ? `+${c.pagesAdded.length} page(s): ${c.pagesAdded.slice(0, 3).join(", ")}` : null, c.pagesRemoved.length ? `-${c.pagesRemoved.length} page(s): ${c.pagesRemoved.slice(0, 3).join(", ")}` : null].filter(Boolean).join("; ");
    else if (pending >= threshold && gapOk(c.date) && !burstContinues) reason = `${pending} lines of UI changed since the last pick`;
    if (i === list.length - 1 && !reason) reason = "latest commit";
    if (!reason) return;
    picks.push({ ...c, reason, score: pending + pagesMoved * threshold });
    pending = 0;
    lastDate = c.date;
  });
  return picks;
}

/**
 * Commits recorded as unbuildable give way to the commit that stands in for them, or drop
 * out when none is known. A stand-in already picked is not picked twice.
 */
export function avoidUnbuildable(picks, list, unbuildable) {
  if (!unbuildable.length) return picks;
  const broken = new Map(unbuildable.map((e) => [e.sha, e]));
  const out = [];
  const seen = new Set();
  for (const pick of picks) {
    const entry = broken.get(pick.sha);
    const stand = entry?.replacedBySha ? list.find((c) => c.sha === entry.replacedBySha) : null;
    const next = entry ? (stand && !broken.has(stand.sha) ? { ...stand, reason: `${pick.reason} (stands in for ${entry.short}, which does not build)`, score: pick.score } : null) : pick;
    if (!next || seen.has(next.sha)) continue;
    seen.add(next.sha);
    out.push(next);
  }
  return out;
}

export function buildPlan(repo, config, adapter, mode = config.sampling.mode, { unbuildable = [] } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown sampling mode "${mode}". Use one of: ${MODES.join(", ")}`);
  const list = commits(repo, config, adapter);
  if (!list.length) throw new Error("No commits in range.");
  const head = { ...list[list.length - 1], reason: "latest commit" };
  let picks;
  let max = config.sampling.max;
  let score = null;
  if (mode === "pilot") {
    picks = lastPerBucket(list, (c) => c.date.slice(0, 7), "end of");
    max = Math.min(max ?? PILOT_MAX, PILOT_MAX);
  } else if (mode === "monthly") picks = lastPerBucket(list, (c) => c.date.slice(0, 7), "end of");
  else if (mode === "weekly") picks = lastPerBucket(list, (c) => isoWeek(c.date), "end of");
  else if (mode === "daily") picks = lastPerBucket(list, (c) => c.date, "end of");
  else if (mode === "every-n") picks = list.filter((_, i) => i % config.sampling.everyN === 0).map((c, i) => ({ ...c, reason: `every ${config.sampling.everyN} commits (#${i + 1})` }));
  else if (mode === "all") picks = list.map((c) => ({ ...c, reason: "every commit" }));
  else if (mode === "auto") {
    picks = auto(list, config);
    score = (c) => c.score;
  } else return null;
  if (picks[picks.length - 1].sha !== head.sha) picks.push(head);
  picks = thin(avoidUnbuildable(picks, list, unbuildable), max, score);
  return {
    mode,
    generatedAt: new Date().toISOString(),
    commitsInRange: list.length,
    entries: picks.map(({ sha, short, date, subject, reason }) => ({ sha, short, date, subject, reason })),
  };
}
