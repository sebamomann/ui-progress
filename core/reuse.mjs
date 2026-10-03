/**
 * Screenshots are stored once. A page whose source did not change since the previous
 * snapshot is not rendered again, and its files are not copied: its manifest entry is taken
 * over from the previous snapshot with
 *   copiedFrom  the snapshot it is unchanged since
 *   filesIn     the snapshot whose shots/ folder holds its screenshots
 * filesIn always names the snapshot that rendered the page, never another reference, so
 * finding a file takes one step. An entry without filesIn keeps its files in its own folder
 * (so do pages copied forward before 1.3.0, which copied the files).
 *
 * Capturing a snapshot again first hands the screenshots others use over to one of them
 * (`release`), so the references stay valid.
 */
import fs from "node:fs";
import path from "node:path";
import * as routes from "./routes.mjs";
import { git, readJson, writeJson } from "./util.mjs";

const dirOf = (p, short) => path.join(p.snapshots, short);
const manifestFile = (p, short) => path.join(dirOf(p, short), "shots", "manifest.json");

/** The folder that holds the screenshots of a manifest entry of snapshot `short`. */
export const filesDir = (p, short, entry) => path.join(dirOf(p, entry.filesIn ?? short), "shots");

/** Every screenshot file name of a manifest entry. */
export function entryFiles(entry) {
  const out = [];
  for (const variant of Object.values(entry.variants ?? {})) for (const item of [variant, ...(variant.states ?? [])]) out.push(...Object.values(item.files ?? {}));
  return out;
}

/** `entry` of snapshot `from`, as a reference to its screenshots where they are. */
export function referTo(entry, from) {
  const copy = structuredClone(entry);
  copy.copiedFrom = from;
  copy.filesIn = entry.filesIn ?? from;
  return copy;
}

/**
 * The routes whose source did not change between two commits, from the later commit's
 * dependency map ({ route: [file, ...] }). `read(file)` returns a file of the later commit.
 * Returns { routes, changed, namespaces }, or { reason, ... } when every page counts as changed.
 */
export function unchangedRoutes(p, config, { deps, from, to, read }) {
  if (!config.capture.incremental.enabled) return { reason: "capture.incremental is off" };
  const changed = git(p.repo, "diff", "--name-only", from, to).split("\n").filter(Boolean);
  const globals = config.capture.incremental.globalPaths.map(routes.globToRegex);
  const globalHit = changed.find((f) => globals.some((re) => re.test(f)));
  if (globalHit) return { reason: "global file changed", file: globalHit, changed: changed.length };
  // Translation files change in nearly every commit; only the pages that use a changed
  // namespace (a top-level key) are affected by them.
  const translations = (config.capture.incremental.translationPaths ?? []).map(routes.globToRegex);
  const changedNamespaces = new Set();
  const changedSet = new Set();
  for (const f of changed) {
    if (translations.some((re) => re.test(f)) && f.endsWith(".json")) {
      const parse = (ref) => { try { return JSON.parse(git(p.repo, "show", `${ref}:${f}`)); } catch { return null; } };
      const before = parse(from), after = parse(to);
      if (!before || !after) { changedSet.add(f); continue; }
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changedNamespaces.add(key);
    } else changedSet.add(f);
  }
  const sources = new Map();
  const usesNamespace = (file) => {
    if (!changedNamespaces.size) return false;
    if (!sources.has(file)) { try { sources.set(file, read(file)); } catch { sources.set(file, ""); } }
    const text = sources.get(file);
    return [...changedNamespaces].some((ns) => text.includes(`"${ns}"`) || text.includes(`'${ns}'`) || text.includes(`\`${ns}\``));
  };
  const unchanged = new Set();
  for (const [route, list] of Object.entries(deps)) {
    if (list.some(Boolean) && !list.some((f) => changedSet.has(f) || usesNamespace(f))) unchanged.add(route);
  }
  return { routes: unchanged, changed: changed.length, namespaces: [...changedNamespaces] };
}

/** Every snapshot folder with a manifest, by id. Changes are written by `save`. */
function load(p) {
  const all = new Map();
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const manifest = readJson(manifestFile(p, short));
    const info = readJson(path.join(dirOf(p, short), "snapshot.json"));
    if (manifest) all.set(short, { short, sha: info?.sha ?? null, info, manifest, done: fs.existsSync(path.join(dirOf(p, short), "OK")), dirty: false });
  }
  return all;
}

function save(p, all) {
  for (const s of all.values()) {
    if (!s.dirty) continue;
    s.manifest.reused = s.manifest.routes.filter((r) => r.copiedFrom).length;
    writeJson(manifestFile(p, s.short), s.manifest);
    if (s.info) writeJson(path.join(dirOf(p, s.short), "snapshot.json"), { ...s.info, reused: s.manifest.reused });
    s.dirty = false;
  }
}

/** Ancestors first: the number of commits reachable from each snapshot's commit. */
function depthOf(p) {
  const cache = new Map();
  return (sha) => {
    if (!sha) return Infinity;
    if (!cache.has(sha)) { try { cache.set(sha, Number(git(p.repo, "rev-list", "--count", sha).trim())); } catch { cache.set(sha, Infinity); } }
    return cache.get(sha);
  };
}

/**
 * Before snapshot `short` is captured again (its folder is wiped): move the screenshots
 * other snapshots refer to into the earliest of them, page by page, and point the rest
 * there. Returns the number of files moved.
 */
export function release(p, short) {
  const all = load(p);
  const users = new Map();
  for (const s of all.values()) {
    if (s.short === short) continue;
    for (const entry of s.manifest.routes ?? []) if (entry.filesIn === short) (users.get(entry.route) ?? users.set(entry.route, []).get(entry.route)).push({ s, entry });
  }
  if (!users.size) return 0;
  const depth = depthOf(p);
  const source = path.join(dirOf(p, short), "shots");
  let moved = 0;
  for (const list of users.values()) {
    list.sort((a, b) => depth(a.s.sha) - depth(b.s.sha));
    const [keeper, ...rest] = list;
    const target = path.join(dirOf(p, keeper.s.short), "shots");
    for (const file of entryFiles(keeper.entry)) {
      const from = path.join(source, file), to = path.join(target, file);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); moved++; }
    }
    delete keeper.entry.filesIn;
    keeper.s.dirty = true;
    for (const { s, entry } of rest) { entry.filesIn = keeper.s.short; s.dirty = true; }
  }
  save(p, all);
  return moved;
}
