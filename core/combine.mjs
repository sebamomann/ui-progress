/**
 * Combining snapshots after the fact: of the snapshots in one period (a day, two days, half
 * a day, a week), only the newest on the mainline is kept. It contains every earlier commit
 * of the period, so pages worked on separately during the day all show in it; what is lost
 * is the order in which they changed within the period.
 *
 * The choice is kept in .ui-progress/combined.json, small and meant to be committed, like
 * unbuildable.json: whoever plans or captures next skips the folded commits instead of
 * capturing them again. `snapshot --force <sha>` still captures a folded commit, and takes it
 * out of its group. A snapshot that is the only one showing a page is never folded.
 */
import fs from "node:fs";
import path from "node:path";
import { git, readJson, writeJson } from "./util.mjs";

const file = (p) => path.join(p.root, "combined.json");
const STORE = "_store";

export function readCombined(p) {
  return readJson(file(p), { groups: [] }).groups ?? [];
}

const fullSha = (p, sha) => {
  try {
    return git(p.repo, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim();
  } catch {
    return null;
  }
};

/** The group a commit was folded into, as { group, folded }, or null. */
export function combinedEntry(p, sha) {
  const groups = readCombined(p);
  if (!groups.length) return null;
  const full = fullSha(p, sha);
  for (const group of groups) {
    const folded = group.folded.find((f) => f.sha === full);
    if (folded) return { group, folded };
  }
  return null;
}

/**
 * The group that covers a commit: one it folded, or any commit of a combined period that the
 * survivor contains (a plan may pick another commit of that period than the ones that were
 * captured). Returns { group, folded } (folded may be null), or null.
 */
export function coveringGroup(p, config, sha) {
  const exact = combinedEntry(p, sha);
  if (exact) return exact;
  const groups = readCombined(p);
  if (!groups.length) return null;
  const full = fullSha(p, sha);
  if (!full) return null;
  const seconds = Number(git(p.repo, "log", "-1", "--format=%ct", full).trim());
  for (const group of groups) {
    if (group.into === full || !group.period) continue;
    if (bucketOf(seconds, parsePeriod(group.period), config.combine.dayStartsAt).label !== group.bucket) continue;
    try {
      git(p.repo, "merge-base", "--is-ancestor", full, group.into);
      return { group, folded: null };
    } catch {
      // not in the survivor's history
    }
  }
  return null;
}

/** "day", "week", "12h", "2d", "1w" as { n, unit }; "0" or "none" as null. */
export function parsePeriod(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (["", "0", "none", "off"].includes(value)) return null;
  const named = { day: "1d", week: "1w", "half-day": "12h" }[value] ?? value;
  const m = /^(\d+)\s*(h|d|w)$/.exec(named);
  if (!m || Number(m[1]) === 0) throw new Error(`Unknown period "${text}". Use day, week, or a number with h, d or w (12h, 2d, 1w).`);
  return { n: Number(m[1]), unit: m[2] };
}
const periodMs = ({ n, unit }) => n * { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[unit];

/**
 * The period a commit time (unix seconds) falls into, in the machine's time zone. A day
 * starts at `dayStartsAt` ("04:00"), so work past midnight belongs to the day before.
 * Weeks start on Monday. Returns { key, label }.
 */
export function bucketOf(seconds, period, dayStartsAt = "00:00") {
  const [hh, mm] = String(dayStartsAt).split(":").map(Number);
  const local = new Date(seconds * 1000 - ((hh || 0) * 60 + (mm || 0)) * 60_000);
  const day = Math.floor(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000);
  const dateOf = (d) => new Date(d * 86_400_000).toISOString().slice(0, 10);
  if (period.unit === "h") {
    const slot = Math.floor((day * 24 + local.getHours()) / period.n);
    const start = slot * period.n;
    return { key: `h${period.n}:${slot}`, label: `${dateOf(Math.floor(start / 24))} ${String(start % 24).padStart(2, "0")}:00+${period.n}h` };
  }
  const days = period.unit === "w" ? period.n * 7 : period.n;
  const offset = period.unit === "w" ? 3 : 0; // 1970-01-01 was a Thursday
  const slot = Math.floor((day + offset) / days);
  const first = slot * days - offset;
  return { key: `d${days}:${slot}`, label: days === 1 ? dateOf(first) : `${dateOf(first)}..${dateOf(first + days - 1)}` };
}

/** Finished commit snapshots, with their commit time and the pages they captured. */
function loadSnapshots(p) {
  const out = [];
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    if (short === STORE) continue;
    const dir = path.join(p.snapshots, short);
    const info = readJson(path.join(dir, "snapshot.json"));
    if (!info?.sha || info.live || info.workingTree || !fs.existsSync(path.join(dir, "OK"))) continue;
    const manifest = readJson(path.join(dir, "shots", "manifest.json"));
    const pages = new Set((manifest?.routes ?? []).filter((r) => Object.keys(r.variants ?? {}).length).map((r) => r.route));
    const time = Number(git(p.repo, "log", "-1", "--format=%ct", info.sha).trim());
    out.push({ short, sha: info.sha, date: info.date, subject: info.subject, time, pages, covers: info.covers ?? [] });
  }
  return out;
}

/**
 * Which snapshots to fold, per period: every finished snapshot on the mainline older than
 * `keepRecent`, grouped by period; the newest of each group survives. A snapshot that is the
 * only one left showing a page is kept, with the reason. Snapshots off the mainline (a side
 * branch) are left as they are.
 */
export function planCombine(p, config, { period, keepRecent, now = Date.now() } = {}) {
  const c = config.combine;
  const per = parsePeriod(period ?? c.period);
  if (!per) throw new Error("No period to combine by. Set combine.period or pass --period.");
  const recent = parsePeriod(keepRecent ?? c.keepRecent);
  const cutoff = now - (recent ? periodMs(recent) : 0);
  const line = git(p.repo, "log", "--first-parent", "--format=%H", config.sampling.branch ?? "HEAD").split("\n").filter(Boolean);
  const position = new Map(line.map((sha, i) => [sha, line.length - i]));
  const all = loadSnapshots(p);
  const onLine = all.filter((s) => position.has(s.sha)).sort((a, b) => position.get(a.sha) - position.get(b.sha));

  const buckets = new Map();
  for (const s of onLine) {
    const { key, label } = bucketOf(s.time, per, c.dayStartsAt);
    if (!buckets.has(key)) buckets.set(key, { key, label, snaps: [] });
    buckets.get(key).snaps.push(s);
  }
  const groups = [];
  for (const b of buckets.values()) {
    const newest = b.snaps[b.snaps.length - 1];
    // A period that may still get snapshots stays as it is.
    if (b.snaps.length < 2 || newest.time * 1000 > cutoff) continue;
    groups.push({ bucket: b.label, into: newest, folded: b.snaps.slice(0, -1), kept: [] });
  }

  // Never lose a page: a snapshot that is the only one left showing a page stays.
  const folding = new Set(groups.flatMap((g) => g.folded.map((s) => s.short)));
  const shown = new Map();
  for (const s of all) if (!folding.has(s.short)) for (const route of s.pages) shown.set(route, (shown.get(route) ?? 0) + 1);
  for (const g of groups) {
    for (const s of [...g.folded]) {
      const only = [...s.pages].filter((route) => !shown.get(route));
      if (!only.length) continue;
      g.folded = g.folded.filter((f) => f !== s);
      g.kept.push({ snap: s, why: `only snapshot showing ${only.slice(0, 3).join(", ")}${only.length > 3 ? ` and ${only.length - 3} more` : ""}` });
      for (const route of s.pages) shown.set(route, (shown.get(route) ?? 0) + 1);
    }
  }
  return { period: period ?? c.period, groups: groups.filter((g) => g.folded.length || g.kept.length) };
}

const commitOf = (s) => ({ sha: s.sha, short: s.short, date: s.date, subject: s.subject });

/**
 * Fold the planned groups: record them in combined.json, note on each survivor which
 * commits it covers, and delete the folded snapshot folders (their stored screenshots go with
 * the next gc). A survivor that was itself a survivor before takes over its earlier group.
 */
export function applyCombine(p, plan) {
  const groups = readCombined(p);
  let folded = 0;
  for (const g of plan.groups) {
    if (!g.folded.length) continue;
    const foldedShas = new Set(g.folded.map((s) => s.sha));
    // Groups whose survivor is folded now (a coarser period) move into this one.
    const absorbed = groups.filter((old) => foldedShas.has(old.into) || old.into === g.into.sha);
    const carried = absorbed.flatMap((old) => old.folded);
    for (const old of absorbed) groups.splice(groups.indexOf(old), 1);
    const entry = {
      into: g.into.sha, short: g.into.short, period: plan.period, bucket: g.bucket,
      folded: [...carried, ...g.folded.map(commitOf)].sort((a, b) => a.date.localeCompare(b.date) || a.short.localeCompare(b.short)),
      combinedAt: new Date().toISOString(),
    };
    groups.push(entry);
    const infoFile = path.join(p.snapshots, g.into.short, "snapshot.json");
    const info = readJson(infoFile);
    if (info) writeJson(infoFile, { ...info, covers: entry.folded });
    for (const s of g.folded) {
      fs.rmSync(path.join(p.snapshots, s.short), { recursive: true, force: true });
      folded++;
    }
  }
  groups.sort((a, b) => (a.bucket ?? "").localeCompare(b.bucket ?? ""));
  writeJson(file(p), { groups });
  return { folded };
}

/**
 * Take commits out of combined.json so they can be planned and captured again: a folded
 * commit, every commit of the group a survivor (or bucket label) names. Their pictures are
 * gone; a later capture makes new ones. Returns the commits released.
 */
export function uncombine(p, target) {
  const groups = readCombined(p);
  const full = fullSha(p, target);
  const released = [];
  for (const group of [...groups]) {
    if (group.into === full || group.bucket === target) {
      released.push(...group.folded);
      groups.splice(groups.indexOf(group), 1);
    } else {
      const hit = group.folded.find((f) => f.sha === full);
      if (!hit) continue;
      group.folded = group.folded.filter((f) => f !== hit);
      released.push(hit);
      if (!group.folded.length) groups.splice(groups.indexOf(group), 1);
    }
  }
  if (!released.length) return [];
  writeJson(file(p), { groups });
  // The survivors' notes follow the record.
  for (const short of fs.readdirSync(p.snapshots)) {
    const infoFile = path.join(p.snapshots, short, "snapshot.json");
    const info = readJson(infoFile);
    if (!info?.covers) continue;
    const group = groups.find((g) => g.into === info.sha);
    if (group) writeJson(infoFile, { ...info, covers: group.folded });
    else { const { covers, ...rest } = info; writeJson(infoFile, rest); }
  }
  return released;
}
