/**
 * How the history was made: every snapshot attempt, every snapshot batch, and every agent
 * task the agent reports, one JSON line each in .ui-progress/runs.jsonl. Unlike the
 * screenshots, this file is committed: it is the only record of what a rebuild costs and
 * where it went wrong.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUnbuildable } from "./unbuildable.mjs";
import { VERSION, table } from "./util.mjs";

export const runsFile = (p) => path.join(p.root, "runs.jsonl");

/** Append one record. Parallel snapshot workers append to the same file; each line is one write. */
export function appendRun(p, record) {
  fs.mkdirSync(p.root, { recursive: true });
  fs.appendFileSync(runsFile(p), JSON.stringify({ at: new Date().toISOString(), version: VERSION, ...record }) + "\n");
}

/** Every record, oldest first. A line that does not parse (a merge conflict, a cut-off write) is skipped. */
export function readRuns(p) {
  if (!fs.existsSync(runsFile(p))) return [];
  const out = [];
  for (const line of fs.readFileSync(runsFile(p), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const hashOf = (file) => (fs.existsSync(file) ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 10) : null);

/** The files that decide how a snapshot is made. A change between two attempts on one commit is a fix. */
export function setupFingerprint(p) {
  const adapterDir = path.join(p.root, "adapter");
  const parts = [p.adapter, ...(fs.existsSync(adapterDir) ? fs.readdirSync(adapterDir, { recursive: true }).map((f) => path.join(adapterDir, String(f))).filter((f) => fs.statSync(f).isFile()).sort() : [])];
  const adapter = crypto.createHash("sha1");
  for (const file of parts) if (fs.existsSync(file)) adapter.update(path.relative(p.root, file)).update(fs.readFileSync(file));
  return { adapter: adapter.digest("hex").slice(0, 10), config: hashOf(p.config), screens: hashOf(p.screens) };
}

export function machine() {
  const cpus = os.cpus();
  return { platform: os.platform(), arch: os.arch(), cpus: cpus.length, cpu: cpus[0]?.model?.trim() ?? null, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version };
}

/** Screenshot files in a capture manifest, copied-forward pages included. */
export function shotCount(manifest) {
  let n = 0;
  for (const route of manifest.routes ?? []) {
    for (const variant of Object.values(route.variants ?? {})) {
      n += Object.keys(variant.files ?? {}).length;
      for (const state of variant.states ?? []) n += Object.keys(state.files ?? {}).length;
    }
  }
  return n;
}

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const SETUP_PARTS = ["adapter", "config", "screens"];
const FINAL_FIELDS = ["seconds", "timings", "pages", "captured", "reused", "states", "shots", "skipped", "skippedWhy", "suspects", "recapture", "concurrency"];

/** 45s, 6m 11s, 1h 03m. */
export function duration(seconds) {
  if (seconds == null) return "?";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
const count = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;

/**
 * Everything runs.jsonl says, per commit and in total, with plain-language conclusions.
 * The result is plain data: the CLI prints it, the viewer's Runs page draws it.
 */
export function summarize(p, runs = readRuns(p)) {
  const attempts = runs.filter((r) => r.kind === "snapshot");
  const batches = runs.filter((r) => r.kind === "batch");
  const unbuildable = readUnbuildable(p);
  const byCommit = new Map();
  for (const r of attempts) {
    if (!byCommit.has(r.sha)) byCommit.set(r.sha, []);
    byCommit.get(r.sha).push(r);
  }
  const commits = [...byCommit].map(([sha, list]) => {
    const final = list[list.length - 1];
    // What changed in the setup since the attempt before: a fix made between the two.
    const changed = list.map((r, i) => (i && r.setup && list[i - 1].setup ? SETUP_PARTS.filter((k) => r.setup[k] !== list[i - 1].setup[k]) : []));
    return {
      sha,
      date: final.date,
      subject: final.subject,
      firstAt: list[0].started ?? list[0].at,
      lastAt: final.at,
      attempts: list.map((r, i) => ({ at: r.started ?? r.at, ok: Boolean(r.ok), phase: r.phase ?? null, error: r.error ?? null, seconds: r.seconds ?? null, changed: changed[i] })),
      fixes: changed.filter((c) => c.length).length,
      ok: Boolean(final.ok),
      firstTry: list.length === 1 && Boolean(final.ok),
      final: final.ok ? Object.fromEntries(FINAL_FIELDS.filter((k) => k in final).map((k) => [k, final[k]])) : null,
      standsInFor: unbuildable.filter((u) => u.replacedBy && u.replacedBy === sha.slice(0, u.replacedBy.length)).map((u) => u.short),
    };
  });
  commits.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.firstAt).localeCompare(String(b.firstAt)));
  const done = commits.filter((c) => c.ok);
  const finals = done.map((c) => c.final);

  const phaseSeconds = {};
  for (const f of finals) for (const [phase, sec] of Object.entries(f.timings ?? {})) phaseSeconds[phase] = (phaseSeconds[phase] ?? 0) + sec;
  const phaseTotal = sum(Object.values(phaseSeconds));
  const phases = Object.entries(phaseSeconds).map(([phase, seconds]) => ({ phase, seconds, share: phaseTotal ? seconds / phaseTotal : 0 })).sort((a, b) => b.seconds - a.seconds);
  const rendered = (f) => (f.captured ?? 0) - (f.reused ?? 0);
  const perPage = median(finals.filter((f) => rendered(f) > 0 && f.timings?.capture != null).map((f) => f.timings.capture / rendered(f)));
  const overhead = median(finals.filter((f) => f.timings).map((f) => (f.seconds ?? 0) - (f.timings.capture ?? 0)));
  const failedByPhase = {};
  for (const r of attempts.filter((a) => !a.ok)) failedByPhase[r.phase ?? "?"] = (failedByPhase[r.phase ?? "?"] ?? 0) + 1;
  const fullRecaptures = done.filter((c) => c.final.recapture?.reason && c.final.recapture.reason !== "incremental").map((c) => ({ sha: c.sha, date: c.date, reason: c.final.recapture.reason, file: c.final.recapture.file ?? null }));

  const totals = {
    commits: commits.length,
    captured: done.length,
    failed: commits.length - done.length,
    attempts: attempts.length,
    failedAttempts: attempts.filter((a) => !a.ok).length,
    attemptSeconds: sum(attempts.map((a) => a.seconds)),
    finalSeconds: sum(finals.map((f) => f.seconds)),
    batches: batches.length,
    batchSeconds: sum(batches.map((b) => b.seconds)),
    pages: sum(finals.map((f) => f.pages)),
    pagesCaptured: sum(finals.map((f) => f.captured)),
    reused: sum(finals.map((f) => f.reused)),
    shots: sum(finals.map((f) => f.shots)),
    states: sum(finals.map((f) => f.states)),
    skipped: sum(finals.map((f) => f.skipped)),
    suspects: sum(finals.map((f) => f.suspects)),
    fixes: sum(commits.map((c) => c.fixes)),
    firstTry: commits.filter((c) => c.firstTry).length,
    standIns: commits.filter((c) => c.standsInFor.length).length,
    setups: new Set(attempts.map((a) => a.setup?.adapter).filter(Boolean)).size,
  };
  const rates = { secondsPerPage: perPage, overheadSeconds: overhead, savedSeconds: perPage != null ? Math.round(totals.reused * perPage) : null };
  const summary = { totals, phases, rates, failedByPhase, fullRecaptures, commits, batches, machines: [...new Set(attempts.map((a) => a.machine && `${a.machine.cpu ?? a.machine.arch}, ${a.machine.cpus} cores, ${a.machine.memoryGb} GB`).filter(Boolean))] };
  summary.conclusions = conclusions(summary);
  return summary;
}

/** What the numbers say, in sentences. Only what the data supports. */
function conclusions({ totals: t, phases, rates, failedByPhase, fullRecaptures, commits, batches }) {
  const out = [];
  if (!commits.length) return out;
  const reruns = t.attempts - t.commits;
  out.push(`${count(t.captured, "snapshot")} took ${duration(t.finalSeconds)} in their final runs${reruns ? `; counting ${count(reruns, "earlier attempt")}, ${duration(t.attemptSeconds)} in all` : ""}.`);
  const parallel = batches.filter((b) => b.concurrency > 1 && b.started);
  if (parallel.length) {
    const inside = (a) => parallel.some((b) => a.at >= b.started && a.at <= b.at);
    const work = sum(commits.flatMap((c) => c.attempts.filter(inside).map((a) => a.seconds)));
    const wall = sum(parallel.map((b) => b.seconds));
    if (work > wall * 1.1) out.push(`Running several at a time, ${duration(work)} of snapshot work took ${duration(wall)} of wall time.`);
  }
  if (phases.length && phases[0].share > 0) out.push(`${cap(phases[0].phase)} is ${Math.round(phases[0].share * 100)}% of a snapshot's time${phases.slice(1, 3).filter((x) => x.share >= 0.05).map((x, i, a) => `${i === 0 ? "; " : ", "}${x.phase} ${Math.round(x.share * 100)}%`).join("")}.`);
  if (rates.secondsPerPage != null) out.push(`Rendering one page with its states takes about ${rates.secondsPerPage.toFixed(1)}s; getting a commit running (checkout, install, seed, start) about ${duration(rates.overheadSeconds)}.`);
  if (t.reused) out.push(`Copying unchanged pages forward saved ${count(t.reused, "page")} from being rendered again${rates.savedSeconds ? `, about ${duration(rates.savedSeconds)} of capture` : ""}.`);
  const global = fullRecaptures.filter((r) => r.reason === "global file changed");
  if (global.length) {
    const files = Object.entries(global.reduce((n, r) => ({ ...n, [r.file]: (n[r.file] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    out.push(`${global.length} of ${t.captured} snapshots recaptured every page because a global file changed (${files.slice(0, 3).map(([f, n]) => `${f} ×${n}`).join(", ")}). A change there makes every page count as changed.`);
  }
  const otherFull = fullRecaptures.filter((r) => r.reason !== "global file changed" && r.reason !== "no earlier snapshot");
  if (otherFull.length) out.push(`${count(otherFull.length, "snapshot")} could not copy pages forward: ${[...new Set(otherFull.map((r) => r.reason))].join("; ")}.`);
  if (t.fixes) {
    const order = [...commits].sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
    const lastFix = order.map((c) => c.fixes > 0).lastIndexOf(true);
    const cleanAfter = order.slice(lastFix + 1).filter((c) => c.firstTry).length;
    out.push(`${count(t.fixes, "setup fix", "setup fixes")} (adapter, config or screens changed between two attempts on one commit), all within the first ${count(lastFix + 1, "commit")} tried${cleanAfter ? `; the ${count(cleanAfter, "commit")} after that ran clean first time` : ""}.`);
  } else if (t.firstTry === t.commits) out.push(`Every commit was captured on the first try.`);
  const fails = Object.entries(failedByPhase).sort((a, b) => b[1] - a[1]);
  if (fails.length) out.push(`${count(t.failedAttempts, "failed attempt")}: ${fails.map(([ph, n]) => `${n} in ${ph}`).join(", ")}.${t.failed ? ` ${count(t.failed, "commit")} still ${t.failed === 1 ? "has" : "have"} no snapshot.` : ""}`);
  if (t.standIns) out.push(`${count(t.standIns, "snapshot")} stand${t.standIns === 1 ? "s" : ""} in for commits that do not build.`);
  const withPages = commits.filter((c) => c.final?.pages);
  if (withPages.length > 1) {
    const [a, b] = [withPages[0], withPages[withPages.length - 1]];
    if (a.final.pages !== b.final.pages) out.push(`The site went from ${a.final.pages} pages (${a.date}) to ${b.final.pages} (${b.date}); capture time per snapshot went from ${duration(a.final.seconds)} to ${duration(b.final.seconds)}.`);
  }
  if (t.suspects) {
    const worst = [...commits].filter((c) => c.final?.suspects).sort((x, y) => y.final.suspects - x.final.suspects)[0];
    out.push(`${count(t.suspects, "suspect page")} to review across the final runs, most in ${worst.sha} (${worst.final.suspects}).`);
  }
  return out;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * How long `count` more snapshots will take, from the median of the most recent finished
 * snapshots. Null without measurements.
 */
export function estimate(summary, n, concurrency = 1) {
  const recent = summary.commits.filter((c) => c.ok && c.final.seconds != null).sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt))).slice(-5).map((c) => c.final.seconds);
  if (!recent.length || !n) return null;
  const perSnapshot = median(recent);
  return { perSnapshot, seconds: Math.ceil(n / Math.max(1, concurrency)) * perSnapshot, basedOn: recent.length };
}

export function renderStats(summary) {
  const { totals: t, commits } = summary;
  if (!commits.length) return "No runs recorded yet. Every `ui-progress snapshot` adds to .ui-progress/runs.jsonl.";
  const rows = [["date", "commit", "attempts (s)", "pages", "shots", "states", "skipped", "suspects", "fixes", "result"]];
  for (const c of commits) {
    const f = c.final;
    rows.push([
      c.date, c.sha,
      c.attempts.map((a) => (a.ok ? a.seconds : `${a.seconds}✗`)).join(" → "),
      f ? `${f.captured}/${f.pages}${f.reused ? ` (${f.reused} copied)` : ""}` : "",
      f?.shots ?? "", f?.states ?? "", f?.skipped ?? "", f?.suspects ?? "", c.fixes || "",
      c.ok ? (c.firstTry ? "ok, first try" : "ok") + (c.standsInFor.length ? `, for ${c.standsInFor.join(", ")}` : "") : `FAILED in ${c.attempts[c.attempts.length - 1].phase}`,
    ]);
  }
  const lines = [table(rows), ""];
  lines.push(`Totals: ${count(t.captured, "snapshot")} of ${count(t.commits, "commit")} · ${count(t.attempts, "attempt")} · ${duration(t.finalSeconds)} final runs, ${duration(t.attemptSeconds)} all attempts · ${t.pagesCaptured} pages · ${t.shots} screenshots · ${t.states} states · ${count(t.fixes, "setup fix", "setup fixes")}`);
  if (summary.conclusions.length) lines.push("", ...summary.conclusions.map((c) => `- ${c}`));
  return lines.join("\n");
}
