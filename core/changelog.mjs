/**
 * Material for the written story of the UI: per snapshot, what the capture and the lineage
 * say changed, and the commit messages in between. The agent turns this into
 * .ui-progress/changelog.json; the viewer shows it as the Story.
 */
import fs from "node:fs";
import path from "node:path";
import { git, readJson } from "./util.mjs";

export function changelogCandidates(p, config) {
  const data = path.join(p.viewer, "data", "history.js");
  if (!fs.existsSync(data)) throw new Error("Run `ui-progress build` first; the story is written from the built history.");
  const H = JSON.parse(fs.readFileSync(data, "utf8").replace(/^window\.UI_HISTORY = /, "").replace(/;\s*$/, ""));
  const snaps = H.snapshots;
  const major = config.thresholds.redesign;
  const shaOf = (id) => readJson(path.join(p.snapshots, id, "snapshot.json"))?.sha;
  const lines = [`# Story material: ${snaps.length} snapshots, ${H.pages.length} pages`, "", "For each snapshot: what changed since the one before, then the commits in between.", ""];
  snaps.forEach((s, i) => {
    const prev = snaps[i - 1];
    const here = H.pages.filter((pg) => pg.presence[s.id]);
    const added = prev ? here.filter((pg) => !pg.presence[prev.id]) : here;
    const removed = prev ? H.pages.filter((pg) => pg.presence[prev.id] && !pg.presence[s.id]) : [];
    // The page's first viewport decides; a change marked content-only kept its design.
    const changeOf = (pg) => { const sh = pg.views.find((x) => x.id === "page")?.shots[s.id]; const vp = sh?.change ? Object.keys(sh.change)[0] : null; return vp ? { diff: sh.change[vp], content: Boolean(sh.content?.[vp]) } : null; };
    const redesigned = here.filter((pg) => { const c = changeOf(pg); return c && !c.content && c.diff >= major; });
    const contentOnly = here.filter((pg) => changeOf(pg)?.content);
    const edges = H.edges.filter((e) => e.at === s.id && e.source === "agent");
    lines.push(`## ${s.date} ${s.id} — ${s.subject}`);
    if (added.length) lines.push(`  added: ${added.map((pg) => pg.id).join(", ")}`);
    if (removed.length) lines.push(`  removed: ${removed.map((pg) => pg.id).join(", ")}`);
    if (redesigned.length) lines.push(`  redesigned: ${redesigned.map((pg) => pg.id).join(", ")}`);
    if (contentOnly.length) lines.push(`  content only (same design, not a UI change): ${contentOnly.map((pg) => pg.id).join(", ")}`);
    for (const e of edges) lines.push(`  lineage: ${e.from} ${e.kind ?? e.type} ${e.to}${e.note ? ` (${e.note})` : ""}`);
    if (prev) {
      const a = shaOf(prev.id), b = shaOf(s.id);
      if (a && b) {
        const commits = git(p.repo, "log", "--first-parent", "--format=%h %s", `${a}..${b}`).split("\n").filter(Boolean);
        lines.push(`  commits in between: ${commits.length}`);
        for (const c of commits.filter((c) => !/^\w+ (chore|docs|test|ci|refactor)\b/.test(c)).slice(0, 12)) lines.push(`    ${c}`);
      }
    }
    lines.push("");
  });
  return lines.join("\n");
}

export function checkChangelog(p) {
  const data = readJson(p.changelog);
  if (!data) return { ok: false, problems: ["no changelog.json yet"] };
  const problems = [];
  (data.entries ?? []).forEach((e, i) => {
    if (!e.title) problems.push(`entry ${i}: needs a title`);
    if (!e.text) problems.push(`entry ${i}: needs text`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.from ?? e.date ?? "")) problems.push(`entry ${i}: needs a "from" date (YYYY-MM-DD)`);
  });
  return { ok: problems.length === 0, problems, entries: (data.entries ?? []).length };
}
