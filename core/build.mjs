/**
 * Turn the snapshots into the dataset the viewer reads, and install the viewer next to it:
 *   .ui-progress/viewer/index.html
 *   .ui-progress/viewer/data/history.js    window.UI_HISTORY = {...}
 *   .ui-progress/viewer/data/img/<sha>/    thumbnails and mid-size images (webp)
 * Full-size PNGs stay in .ui-progress/snapshots and are referenced relatively.
 *
 * A page has several "views": the page itself, its signed-out version where that differs,
 * and every section, dialog and menu found on it. Each view is tracked over time.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireDep } from "./deps.mjs";
import { routeRegex, sectionOf } from "./routes.mjs";
import { isCommitSnapshot } from "./snapshot.mjs";
import { git, readJson, VERSION } from "./util.mjs";

const VIEWER_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer", "index.html");
// Signed-in and signed-out versions that differ in less of the page than this are one page.
const SAME_PAGE = 0.02;
const LINEAGE_TYPES = { split: "split", extract: "split", merge: "merged", absorb: "merged", rename: "rename", replace: "replaced", clone: "clone" };

/** Every page add, delete and rename in the whole history, oldest first. */
export function pageEvents(repo, config, routeOfFile) {
  const log = git(repo, "log", "--reverse", "-M", "--diff-filter=ADR", "--name-status", "--format=@%h|%ad|%s", "--date=short", config.sampling.branch ?? "HEAD", "--", ...config.lineage.pagePaths);
  const events = [];
  let commit = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("@")) {
      const [sha, date, ...subject] = line.slice(1).split("|");
      commit = { sha, date, subject: subject.join("|") };
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 2 || !commit) continue;
    const kind = parts[0][0];
    if (kind === "R") {
      const from = routeOfFile(parts[1]);
      const to = routeOfFile(parts[2]);
      if (from && to && from !== to) events.push({ kind: "rename", from, to, ...commit });
      else if (!from && to) events.push({ kind: "add", route: to, ...commit });
      else if (from && !to) events.push({ kind: "delete", route: from, ...commit });
    } else {
      const route = routeOfFile(parts[1]);
      if (route) events.push({ kind: kind === "A" ? "add" : "delete", route, ...commit });
    }
  }
  return events;
}

const writeJsonFile = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };

/**
 * The mainline (first-parent) history as an index: indexOf(sha) is the position of the
 * commit, or of the mainline commit that brought it in (a merge), oldest first.
 */
export function commitLine(repo, branch) {
  const shas = git(repo, "log", "--first-parent", "--reverse", "--format=%H", branch).split("\n").filter(Boolean);
  const index = new Map(shas.map((s, i) => [s, i]));
  const cache = new Map();
  return {
    shas,
    indexOf(sha) {
      if (!sha) return null;
      if (cache.has(sha)) return cache.get(sha);
      let i = null;
      try {
        const full = git(repo, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim();
        i = index.get(full) ?? null;
        if (i == null) {
          const into = git(repo, "rev-list", "--first-parent", "--ancestry-path", "--reverse", `${full}..${branch}`).split("\n")[0];
          i = into ? index.get(into) ?? null : null;
        }
      } catch {
        i = null; // unknown commit
      }
      cache.set(sha, i);
      return i;
    },
  };
}

// Types after which the `to` pages exist, and types after which the `from` pages stop
// rendering. A replaced page may keep rendering for a while, so replace only counts as new.
const CREATES = new Set(["split", "extract", "clone", "replace"]);
const ENDS = new Set(["merge", "absorb", "rename"]);

/**
 * Check one lineage entry against the snapshots. Returns null when they agree, else where
 * the edge belongs ({ at, sha, date, reason }), with the commit from git where it can tell.
 *
 * Too late: every `to` page of a split/extract/clone/replace is already in the code of the
 * snapshots right before the placement (the unbroken run, so an older page of the same
 * name that was deleted in between does not count). Too early: a `from` page of a merge/rename/replace still
 * renders in a snapshot at or after the placement.
 */
export function auditEdge({ entry, placed, snapshots, pages, events, line }) {
  const at = snapshots.findIndex((s) => s.id === placed);
  const exists = (route, i) => { const here = pages.get(route)?.presence[snapshots[i].id]; return Boolean(here && !(here.missing === "not found")); };
  const renders = (route, i) => Boolean(pages.get(route)?.presence[snapshots[i].id]?.auth);
  const tos = [entry.to].flat();
  const froms = [entry.from].flat();
  const commitOf = (kinds, route, lo, hi) => {
    // The latest git event of this kind for the route between two mainline positions.
    const hits = events.filter((e) => kinds.includes(e.kind) && (e.route === route || e.to === route || e.from === route)).map((e) => ({ ...e, i: line.indexOf(e.sha) })).filter((e) => e.i != null && e.i > lo && e.i <= hi);
    return hits[hits.length - 1] ?? null;
  };
  if (CREATES.has(entry.type) && at !== 0) {
    const limit = at < 0 ? snapshots.length : at;
    let first = -1;
    for (let i = limit - 1; i >= 0 && tos.every((r) => exists(r, i)); i--) first = i;
    if (first >= 0) {
      const snap = snapshots[first];
      const prevIndex = first > 0 ? snapshots[first - 1].index ?? -1 : -1;
      // The commit that added the last of the new pages, between the two snapshots.
      const added = tos.map((r) => commitOf(["add", "rename"], r, prevIndex, snap.index ?? Infinity)).filter(Boolean).sort((a, b) => a.i - b.i).pop();
      // Without a git event, the snapshot's own commit: the split happened at or before it.
      return { at: snap.id, sha: added?.sha ?? snap.id, exact: Boolean(added), date: added?.date ?? snap.date, reason: `is placed too late: ${tos.join(", ")} already exist${tos.length > 1 ? "" : "s"} in snapshot ${snap.id} (${snap.date})` };
    }
  }
  if (ENDS.has(entry.type) && at >= 0) {
    let last = -1;
    for (let i = at; i < snapshots.length; i++) if (froms.some((r) => renders(r, i))) last = i;
    if (last >= 0) {
      const next = snapshots[last + 1];
      const gone = next ? froms.map((r) => commitOf(["delete", "rename"], r, snapshots[last].index ?? -1, next.index ?? Infinity)).filter(Boolean).sort((a, b) => a.i - b.i).pop() : null;
      return { at: next?.id ?? null, sha: gone?.sha ?? next?.id ?? null, exact: Boolean(gone), date: gone?.date ?? next?.date ?? entry.date, reason: `is placed too early: ${froms.join(", ")} still render${froms.length > 1 ? "" : "s"} in snapshot ${snapshots[last].id} (${snapshots[last].date})` };
    }
  }
  return null;
}

export async function build(p, config, adapter, { log = () => {} } = {}) {
  const sharp = requireDep("sharp");
  const dataDir = path.join(p.viewer, "data");
  const viewportNames = Object.keys(config.capture.viewports);
  const [mainViewport] = viewportNames;
  const cardSize = (name) => {
    const v = config.capture.viewports[name];
    return v.width >= v.height ? { width: 320, height: 200 } : { width: 150, height: 260 };
  };
  const midWidth = (name) => (config.capture.viewports[name].width >= 700 ? 720 : 300);

  async function derive(src, dest, resize) {
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return;
    let image = sharp(src);
    // WebP tops out at 16383px; an endless page is cut off at the bottom rather than dropped.
    const meta = await image.metadata();
    const scale = resize.height ? 1 : Math.min(1, resize.width / meta.width);
    if (meta.height * scale > 16000) image = image.extract({ left: 0, top: 0, width: meta.width, height: Math.floor(16000 / scale) });
    await image.resize(resize).webp({ quality: 78 }).toFile(dest);
  }
  /**
   * 0..1: the share of the page that looks different. Both screenshots are scaled to the
   * same width and cut into small blocks; a block counts when its pixels differ clearly.
   * A changed date or counter touches a block or two; a new layout touches most of them.
   * Byte-identical files are 0 without decoding.
   */
  const WIDTH = 96, BLOCK = 8, MAX_ROWS = 1600;
  const sampleCache = new Map();
  const digest = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  async function sample(file) {
    if (!sampleCache.has(file)) {
      const { data, info } = await sharp(file).resize({ width: WIDTH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      sampleCache.set(file, { data, height: Math.min(info.height, MAX_ROWS), hash: digest(file) });
    }
    return sampleCache.get(file);
  }
  /** Returns the share of changed blocks and the mask of which blocks changed (row-major, run-length encoded). */
  async function compare(fileA, fileB) {
    const [a, b] = await Promise.all([sample(fileA), sample(fileB)]);
    const cols = WIDTH / BLOCK;
    if (a.hash === b.hash) return { diff: 0, mask: null };
    const rows = Math.ceil(Math.max(a.height, b.height) / BLOCK);
    const shared = Math.min(a.height, b.height);
    let changed = 0;
    const bits = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Blocks below the shorter page exist in one screenshot only.
        let hit = false;
        if (row * BLOCK >= shared) hit = true;
        else {
          let sum = 0, count = 0;
          for (let y = row * BLOCK; y < Math.min((row + 1) * BLOCK, shared); y++) {
            for (let x = col * BLOCK; x < (col + 1) * BLOCK; x++) {
              const i = (y * WIDTH + x) * 3;
              sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
              count += 3;
            }
          }
          hit = sum / count > 10;
        }
        if (hit) changed++;
        bits.push(hit ? 1 : 0);
      }
    }
    // Run-length encode: alternating counts of unchanged and changed blocks.
    const runs = [];
    let current = 0, run = 0;
    for (const bit of bits) { if (bit === current) run++; else { runs.push(run); current = bit; run = 1; } }
    runs.push(run);
    return { diff: changed / (rows * cols), mask: { cols, rows, runs } };
  }
  const difference = async (fileA, fileB) => (await compare(fileA, fileB)).diff;

  const snapshots = [];
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const dir = path.join(p.snapshots, short);
    const info = readJson(path.join(dir, "snapshot.json"));
    const manifest = readJson(path.join(dir, "shots", "manifest.json"));
    if (!fs.existsSync(path.join(dir, "OK")) || !info || !manifest || !isCommitSnapshot(info)) continue;
    snapshots.push({ id: short, sha: info.sha, date: info.date, subject: info.subject, notes: info.notes ?? [], manifest });
  }
  if (!snapshots.length) throw new Error("No finished snapshots yet. Run: ui-progress snapshot --plan");
  // Snapshots are ordered by their place in the mainline history, not by date: commit dates
  // can go backwards (rebases, cherry-picks), and several snapshots can share a day.
  const line = commitLine(p.repo, config.sampling.branch ?? "HEAD");
  for (const snap of snapshots) snap.index = snap.sha ? line.indexOf(snap.sha) : null;
  snapshots.sort((a, b) => (a.index != null && b.index != null ? a.index - b.index : a.date.localeCompare(b.date)));

  const pages = new Map();
  const page = (route) => {
    if (!pages.has(route)) pages.set(route, { id: route, section: sectionOf(route), presence: {}, views: new Map(), history: [], life: [] });
    return pages.get(route);
  };
  const view = (record, id, kind, label) => {
    if (!record.views.has(id)) record.views.set(id, { id, kind, label, shots: {} });
    return record.views.get(id);
  };
  const edges = [];

  const broken = [];
  for (const snap of snapshots) {
   try {
    const shotsDir = path.join(p.snapshots, snap.id, "shots");
    const imgDir = path.join(dataDir, "img", snap.id);
    fs.mkdirSync(imgDir, { recursive: true });
    const fullBase = `../snapshots/${snap.id}/shots`;
    const imgBase = `data/img/${snap.id}`;

    const images = async (files, cardOnly) => {
      const out = {};
      for (const [viewport, file] of Object.entries(files)) {
        const src = path.join(shotsDir, file);
        const stem = file.replace(/\.png$/, "");
        await derive(src, path.join(imgDir, `${stem}.card.webp`), { ...cardSize(viewport), fit: "cover", position: "top" });
        out[viewport] = { full: `${fullBase}/${encodeURIComponent(file)}`, card: `${imgBase}/${encodeURIComponent(stem)}.card.webp` };
        if (!cardOnly) {
          await derive(src, path.join(imgDir, `${stem}.mid.webp`), { width: midWidth(viewport), withoutEnlargement: true });
          out[viewport].mid = `${imgBase}/${encodeURIComponent(stem)}.mid.webp`;
        } else out[viewport].mid = out[viewport].full;
      }
      return out;
    };
    const put = async (target, files, cardOnly) => {
      target.shots[snap.id] = { images: await images(files, cardOnly), src: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, path.join(shotsDir, f)])) };
    };

    const routesHere = snap.manifest.routes.map((r) => r.route);
    let views = 0;
    for (const entry of snap.manifest.routes) {
      const record = page(entry.route);
      const variants = { ...entry.variants };
      if (variants.user && variants.public) {
        const same = await difference(path.join(shotsDir, variants.user.files[mainViewport]), path.join(shotsDir, variants.public.files[mainViewport]));
        if (same < SAME_PAGE) delete variants.public;
      }
      const main = variants.user ?? variants.public;
      if (main) {
        record.presence[snap.id] = { auth: variants.user ? "user" : "public", url: entry.url };
        await put(view(record, "page", "page", "Page"), main.files, false);
        views++;
        if (variants.user && variants.public) {
          record.twoFaced = true;
          await put(view(record, "signed-out", "signed-out", "Signed out"), variants.public.files, false);
          views++;
        }
        for (const variant of Object.values(variants)) {
          const prefix = variant === main ? "" : "Signed out · ";
          for (const state of variant.states ?? []) {
            const label = prefix + state.label;
            // The same control across snapshots: matched by its stable key where captured
            // (test id, id, place in the document), else by its label.
            const byKey = state.key ? record.views.get(`${state.kind}|k:${prefix}${state.key}`) : null;
            const byLabel = record.views.get(`${state.kind}|${label.toLowerCase()}`);
            let v = byKey ?? byLabel;
            if (!v) {
              v = view(record, `${state.kind}|${label.toLowerCase()}`, state.kind, label);
              v.key = state.key ?? null;
            }
            if (state.key && !byKey) record.views.set(`${state.kind}|k:${prefix}${state.key}`, v);
            v.label = label; // the latest wording wins
            await put(v, state.files, state.kind !== "section");
            views++;
          }
        }
      } else if (entry.skipped === "redirected") {
        const target = routesHere.find((r) => r !== entry.route && routeRegex(r).test(entry.finalPath));
        record.presence[snap.id] = { redirect: target ?? entry.finalPath };
      } else {
        record.presence[snap.id] = { missing: entry.skipped ?? "not captured" };
      }
    }
    snap.pages = snap.manifest.routesTotal;
    snap.captured = snap.manifest.captured;
    snap.views = views;
    log(`${snap.date} ${snap.id}: ${snap.captured}/${snap.pages} pages, ${views} views`);
   } catch (err) {
    // A snapshot being recaptured right now, or one with a missing file: left out of this build.
    log(`${snap.date} ${snap.id}: skipped (${String(err.message).split("\n")[0]})`);
    broken.push(snap);
    for (const record of pages.values()) { delete record.presence[snap.id]; for (const v of record.views.values()) delete v.shots[snap.id]; }
   }
  }
  for (const snap of broken) snapshots.splice(snapshots.indexOf(snap), 1);
  if (!snapshots.length) throw new Error("No usable snapshots.");

  // How much each view changed since the previous snapshot it appears in, which blocks
  // changed, and (for the page itself) which source files changed in between.
  const depsOf = new Map(snapshots.map((s) => [s.id, readJson(path.join(p.snapshots, s.id, "deps.json"))]));
  const shaOf = new Map(snapshots.map((s) => [s.id, readJson(path.join(p.snapshots, s.id, "snapshot.json"))?.sha]));
  const diffCache = new Map();
  const changedBetween = (a, b) => {
    const key = `${a}..${b}`;
    if (!diffCache.has(key)) { try { diffCache.set(key, new Set(git(p.repo, "diff", "--name-only", a, b).split("\n").filter(Boolean))); } catch { diffCache.set(key, new Set()); } }
    return diffCache.get(key);
  };
  for (const record of pages.values()) {
    for (const v of new Set(record.views.values())) {
      let previous = null;
      for (const snap of snapshots) {
        const shot = v.shots[snap.id];
        if (!shot) continue;
        if (previous) {
          shot.change = {};
          shot.masks = {};
          for (const viewport of viewportNames) {
            if (previous.src[viewport] && shot.src[viewport]) {
              const { diff, mask } = await compare(previous.src[viewport], shot.src[viewport]);
              shot.change[viewport] = Number(diff.toFixed(4));
              if (mask) shot.masks[viewport] = mask;
            }
          }
          if (v.id === "page") {
            const deps = depsOf.get(snap.id)?.[record.id];
            const a = shaOf.get(previous.snap), b = shaOf.get(snap.id);
            if (deps && a && b) {
              const changed = changedBetween(a, b);
              const files = deps.filter((f) => changed.has(f));
              if (files.length) shot.sources = { changed: files.slice(0, 40), total: files.length, commits: Number(git(p.repo, "rev-list", "--count", `${a}..${b}`).trim()) };
            }
          }
        }
        previous = { ...shot, snap: snap.id };
      }
      for (const shot of Object.values(v.shots)) delete shot.src;
    }
    if (record.twoFaced) record.views.get("page").label = "Signed in";
  }

  // Lifecycle facts from the full git history, where the adapter can map files to routes.
  const snapshotAtOrAfter = (date) => snapshots.find((s) => s.date >= date)?.id ?? null;
  /** The first snapshot whose commit contains `sha` (by ancestry), else the first on or after `date`. */
  const placeAt = ({ sha, date }) => {
    const i = sha ? line.indexOf(sha) : null;
    if (i != null) return snapshots.find((s) => s.index != null && s.index >= i)?.id ?? null;
    return snapshotAtOrAfter(date);
  };
  if (adapter.routeOfFile) {
    for (const event of pageEvents(p.repo, config, adapter.routeOfFile)) {
      const commit = { sha: event.sha, date: event.date, subject: event.subject };
      if (event.kind === "rename") {
        page(event.from).history.push({ kind: "renamed-to", other: event.to, ...commit });
        page(event.to).history.push({ kind: "renamed-from", other: event.from, ...commit });
        edges.push({ type: "rename", from: event.from, to: event.to, at: placeAt(event), date: event.date, sha: event.sha, source: "git" });
      } else {
        page(event.route).history.push({ kind: event.kind === "add" ? "added" : "deleted", ...commit });
      }
    }
  }
  for (const record of pages.values()) {
    record.life = [];
    for (const h of record.history) {
      const open = record.life[record.life.length - 1];
      if (h.kind === "added" || h.kind === "renamed-from") {
        if (!open || open.to) record.life.push({ from: h.date, to: null });
      } else if (open && !open.to) open.to = h.date;
    }
  }

  // Lineage the agent worked out by reading the diffs. Each edge is placed at the first
  // snapshot that contains its commit, then checked against what the snapshots show: when
  // a snapshot added later (for example between two existing ones) proves the edge is
  // placed too late or too early, the placement is corrected here and the correction is
  // written to lineage-audit.json for `ui-progress lineage check --fix`.
  const lineage = readJson(p.lineage, { edges: [] });
  const events = adapter.routeOfFile ? pageEvents(p.repo, config, adapter.routeOfFile) : [];
  const corrections = [];
  const stated = new Set();
  (lineage.edges ?? []).forEach((entry, index) => {
    const type = LINEAGE_TYPES[entry.type];
    if (!type) return;
    const placed = placeAt({ sha: entry.sha, date: entry.date });
    const fix = auditEdge({ entry, placed, snapshots, pages, events, line });
    if (fix) {
      corrections.push({ index, type: entry.type, from: entry.from, to: entry.to, recorded: { sha: entry.sha ?? null, date: entry.date }, ...fix });
      log(`lineage: ${entry.type} ${[entry.from].flat().join(", ")} -> ${[entry.to].flat().join(", ")} (${entry.sha ?? entry.date}) ${fix.reason}; ${fix.at ? `placed at ${fix.at}${fix.sha ? `, commit ${fix.sha}` : ""}` : "no snapshot shows it done yet; left out of the snapshot views"}`);
    }
    for (const from of [entry.from].flat()) {
      for (const to of [entry.to].flat()) {
        page(from);
        page(to);
        stated.add(`${from}>${to}`);
        edges.push({
          type, from, to,
          at: fix ? fix.at : placed,
          date: fix?.date ?? entry.date,
          sha: fix?.sha ?? entry.sha ?? null,
          note: entry.evidence ?? null,
          confidence: entry.confidence ?? null,
          source: "agent",
          ...(fix ? { corrected: { sha: entry.sha ?? null, date: entry.date, reason: fix.reason } } : {}),
        });
      }
    }
  });
  writeJsonFile(path.join(dataDir, "lineage-audit.json"), { builtAt: new Date().toISOString(), snapshots: snapshots.map((s) => s.id), corrections });
  if (corrections.length) log(`${corrections.length} lineage edge(s) disagree with the snapshots and were re-placed; write the fixes with: ui-progress lineage check --fix`);

  // A page that used to render and now redirects was folded into its target.
  for (const record of pages.values()) {
    let hadShot = false;
    let reported = false;
    for (const snap of snapshots) {
      const here = record.presence[snap.id];
      if (here?.auth) hadShot = true;
      if (here?.redirect && !reported && pages.has(here.redirect)) {
        reported = true;
        if (!stated.has(`${record.id}>${here.redirect}`)) edges.push({ type: hadShot ? "merged" : "redirect", from: record.id, to: here.redirect, at: snap.id, date: snap.date, source: "redirect" });
      }
    }
  }
  // A new page under an existing one grew out of it: /account -> /account/settings.
  const born = (record) => record.life[0]?.from ?? snapshots.find((s) => record.presence[s.id])?.date ?? null;
  for (const record of pages.values()) {
    const date = born(record);
    if (!date || [...stated].some((k) => k.endsWith(`>${record.id}`))) continue;
    const segments = record.id.split("/").filter(Boolean);
    for (let depth = segments.length - 1; depth >= 1; depth--) {
      const parent = pages.get("/" + segments.slice(0, depth).join("/"));
      const parentBorn = parent && born(parent);
      if (parentBorn && parentBorn < date) {
        const added = record.history.find((h) => h.kind === "added" || h.kind === "renamed-from");
        edges.push({ type: "branch", from: parent.id, to: record.id, at: placeAt({ sha: added?.date === date ? added.sha : null, date }), date, source: "path" });
        break;
      }
    }
  }

  const list = [...pages.values()]
    .map(({ views, twoFaced, ...rest }) => ({ ...rest, views: [...new Set(views.values())], seen: Object.keys(rest.presence).length > 0 }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.id.localeCompare(b.id));
  const branch = config.sampling.branch ?? "HEAD";
  const changelog = readJson(p.changelog, { entries: [] }).entries ?? [];
  const history = {
    tool: { name: "ui-progress", version: VERSION },
    changelog,
    project: {
      name: config.project.name,
      commits: Number(git(p.repo, "rev-list", "--count", branch).trim()),
      from: git(p.repo, "log", "--reverse", "--format=%ad", "--date=short", branch).split("\n")[0],
      to: git(p.repo, "log", "-1", "--format=%ad", "--date=short", branch).trim(),
    },
    generatedAt: new Date().toISOString(),
    viewports: viewportNames,
    thresholds: config.thresholds,
    snapshots: snapshots.map(({ manifest, index, ...rest }) => rest),
    pages: list,
    edges,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "history.js"), `window.UI_HISTORY = ${JSON.stringify(history)};\n`);
  fs.copyFileSync(VIEWER_SOURCE, path.join(p.viewer, "index.html"));
  const types = edges.reduce((n, e) => ({ ...n, [e.type]: (n[e.type] ?? 0) + 1 }), {});
  return { corrections: corrections.length, snapshots: snapshots.length, pages: list.length, captured: list.filter((x) => x.seen).length, views: list.reduce((n, x) => n + x.views.length, 0), edges: types, index: path.join(p.viewer, "index.html") };
}
