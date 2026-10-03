/**
 * Screenshots live in one shared store, snapshots/_store/<hash>.png, named by the hash of
 * their bytes. A manifest refers to them as "_store/<hash>.png"; no snapshot owns a file,
 * so capturing a snapshot again or deleting one never touches another.
 *
 * Whether a page needs rendering at all is decided from its source, not its pixels (two
 * renders of the same page are rarely byte-identical): a page whose source did not change
 * since the previous snapshot takes over that snapshot's manifest entry, marked
 * `copiedFrom`, with the same references.
 *
 * Manifests written before the store keep file names relative to their own shots/ folder;
 * `shotPath` resolves both. Files nothing refers to any more are removed by `gc`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as routes from "./routes.mjs";
import { git, readJson, writeJson } from "./util.mjs";

export const STORE = "_store";
const storeDir = (p) => path.join(p.snapshots, STORE);
const manifestFile = (p, short) => path.join(p.snapshots, short, "shots", "manifest.json");

export const isStored = (file) => file.startsWith(`${STORE}/`);
/** Where a screenshot of snapshot `short`'s manifest is on disk. */
export const shotPath = (p, short, file) => (isStored(file) ? path.join(p.snapshots, file) : path.join(p.snapshots, short, "shots", file));

/** Every screenshot reference of a manifest entry. */
export function entryFiles(entry) {
  const out = [];
  for (const variant of Object.values(entry.variants ?? {})) for (const item of [variant, ...(variant.states ?? [])]) out.push(...Object.values(item.files ?? {}));
  return out;
}

/** Rewrite every screenshot reference of an entry in place. */
function mapFiles(entry, fn) {
  for (const variant of Object.values(entry.variants ?? {})) {
    for (const item of [variant, ...(variant.states ?? [])]) for (const [k, f] of Object.entries(item.files ?? {})) item.files[k] = fn(f);
  }
}

/**
 * Put a file into the store and return its reference. `move` takes the file away (a fresh
 * render); otherwise it is copied (a file another snapshot's folder still lists).
 */
export function storeFile(p, src, { move = false } = {}) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex").slice(0, 32);
  const ref = `${STORE}/${hash}.png`;
  const dest = path.join(p.snapshots, ref);
  fs.mkdirSync(storeDir(p), { recursive: true });
  if (fs.existsSync(dest)) { if (move) fs.rmSync(src); }
  else if (move) fs.renameSync(src, dest);
  else {
    // Parallel captures may store the same file: only a complete file ever has the name.
    const temp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(src, temp);
    fs.renameSync(temp, dest);
  }
  return ref;
}

/** Move the screenshots a capture rendered into the store and point the entry at them. */
export function ingest(p, short, entry) {
  mapFiles(entry, (f) => (isStored(f) ? f : storeFile(p, shotPath(p, short, f), { move: true })));
}

/**
 * Entry `entry` of snapshot `from`, taken over by another snapshot (`field` names where it
 * came from). An entry from a manifest older than the store gets its files copied in.
 */
export function takeOver(p, from, entry, field = "copiedFrom") {
  const copy = structuredClone(entry);
  delete copy.copiedFrom;
  delete copy.sameAs;
  mapFiles(copy, (f) => (isStored(f) ? f : storeFile(p, shotPath(p, from, f))));
  copy[field] = from;
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

/**
 * Delete the stored screenshots no manifest refers to: those of snapshots captured again
 * or deleted. Every manifest counts, finished or not. Run under the repository lock only,
 * so no capture is between storing a file and writing the manifest that lists it.
 */
export function gc(p) {
  if (!fs.existsSync(storeDir(p))) return { files: 0, bytes: 0 };
  const used = new Set();
  for (const short of fs.readdirSync(p.snapshots)) {
    if (short === STORE) continue;
    const manifest = readJson(manifestFile(p, short));
    for (const entry of manifest?.routes ?? []) for (const f of entryFiles(entry)) if (isStored(f)) used.add(path.basename(f));
  }
  let files = 0, bytes = 0;
  for (const file of fs.readdirSync(storeDir(p))) {
    if (used.has(file)) continue;
    const full = path.join(storeDir(p), file);
    bytes += fs.statSync(full).size;
    fs.rmSync(full);
    files++;
  }
  return { files, bytes };
}

const isAncestor = (p, a, b) => { try { git(p.repo, "merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
const isCommitSnapshot = (info) => info?.sha && !info.live && !info.workingTree;

/**
 * The finished snapshots nearest before and after a commit in history, each with its
 * manifest and dependency map: where a page can be taken over from.
 */
export function neighbours(p, full) {
  let previous = null, next = null;
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    const dir = path.join(p.snapshots, short);
    const info = readJson(path.join(dir, "snapshot.json"));
    if (!fs.existsSync(path.join(dir, "OK")) || !isCommitSnapshot(info) || info.sha === full) continue;
    const before = isAncestor(p, info.sha, full);
    if (!before && !isAncestor(p, full, info.sha)) continue;
    const distance = Number(git(p.repo, "rev-list", "--count", before ? `${info.sha}..${full}` : `${full}..${info.sha}`).trim());
    const found = { short, sha: info.sha, distance };
    if (before && (!previous || distance < previous.distance)) previous = found;
    if (!before && (!next || distance < next.distance)) next = found;
  }
  for (const s of [previous, next]) {
    if (!s) continue;
    s.manifest = readJson(manifestFile(p, s.short));
    s.deps = readJson(path.join(p.snapshots, s.short, "deps.json"));
  }
  return { previous: previous?.manifest ? previous : null, next: next?.manifest ? next : null };
}

/** Every snapshot folder with a manifest, by id. Changes are written by `save`. */
function load(p) {
  const all = new Map();
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    if (short === STORE) continue;
    const manifest = readJson(manifestFile(p, short));
    const info = readJson(path.join(p.snapshots, short, "snapshot.json"));
    if (manifest) all.set(short, { short, sha: info?.sha ?? null, info, manifest, done: fs.existsSync(path.join(p.snapshots, short, "OK")), dirty: false });
  }
  return all;
}

function save(p, all) {
  for (const s of all.values()) {
    if (!s.dirty) continue;
    s.manifest.reused = s.manifest.routes.filter((r) => r.copiedFrom).length;
    writeJson(manifestFile(p, s.short), s.manifest);
    if (s.info) writeJson(path.join(p.snapshots, s.short, "snapshot.json"), { ...s.info, reused: s.manifest.reused });
    s.dirty = false;
  }
}

/** Finished snapshots, ancestors first, each with its nearest finished ancestor. */
function chain(p, all) {
  const depth = new Map();
  const depthOf = (sha) => {
    if (!depth.has(sha)) { try { depth.set(sha, Number(git(p.repo, "rev-list", "--count", sha).trim())); } catch { depth.set(sha, Infinity); } }
    return depth.get(sha);
  };
  const done = [...all.values()].filter((s) => s.done && isCommitSnapshot(s.info)).sort((a, b) => depthOf(a.sha) - depthOf(b.sha));
  return done.map((s, i) => {
    for (let k = i - 1; k >= 0; k--) if (depthOf(done[k].sha) < depthOf(s.sha) && isAncestor(p, done[k].sha, s.sha)) return { s, earlier: done[k] };
    return { s, earlier: null };
  });
}

const sameFiles = (a, b) => JSON.stringify(entryFiles(a)) === JSON.stringify(entryFiles(b));

/**
 * Give `later` the entries of `earlier` (its nearest finished ancestor) where they should
 * show the same thing:
 *   - an entry that is a reference (`copiedFrom`, `sameAs`) follows when the page's source
 *     did not change between the two: it has no screenshots of its own to go by
 *   - a page `later` rendered itself is evidence: it is shared only when it looks exactly
 *     the same (`identical`, see imagediff.mjs), whatever the source says, since a render
 *     that differs means something outside the page's files changed
 * Never at the cost of a view: a state or variant only `later` has keeps its entry. The
 * entry keeps its own URL. Only manifests change; files of manifests older than the store
 * that drop out go to `remove`. Returns the routes that changed.
 */
async function relink(p, config, earlier, later, remove, identical) {
  if (JSON.stringify(earlier.manifest.viewports) !== JSON.stringify(later.manifest.viewports)) return [];
  let unchanged;
  const sourceUnchanged = (route) => {
    if (unchanged === undefined) {
      const deps = readJson(path.join(p.snapshots, later.short, "deps.json"));
      unchanged = deps ? unchangedRoutes(p, config, { deps, from: earlier.sha, to: later.sha, read: (file) => git(p.repo, "show", `${later.sha}:${file}`) }).routes ?? null : null;
    }
    return Boolean(unchanged?.has(route));
  };
  const changed = [];
  for (const [i, entry] of later.manifest.routes.entries()) {
    if (!Object.keys(entry.variants ?? {}).length) continue;
    const before = earlier.manifest.routes.find((r) => r.route === entry.route);
    if (!before || before.skipped || !Object.keys(before.variants ?? {}).length || sameFiles(before, entry)) continue;
    const has = shape(before);
    if ([...shape(entry).keys()].some((key) => !has.has(key))) continue;
    const own = !entry.copiedFrom && !entry.sameAs;
    if (own ? !(identical && (await looksTheSame(p, later.short, entry, earlier.short, before, identical))) : !sourceUnchanged(entry.route)) continue;
    for (const f of entryFiles(entry)) if (!isStored(f)) remove.push(shotPath(p, later.short, f));
    later.manifest.routes[i] = { ...takeOver(p, earlier.short, before, own ? "sameAs" : "copiedFrom"), url: entry.url };
    later.dirty = true;
    changed.push(entry.route);
  }
  return changed;
}

/**
 * Relink the snapshots after the ones in `shorts` (every snapshot when null), oldest
 * first: a changed snapshot is passed on to the one after it, so a whole run of snapshots
 * that showed a page unchanged keeps showing one picture. Pages a snapshot rendered itself
 * are only compared with `identical`. Returns [{ short, from, routes }].
 */
export async function relinkAfter(p, config, shorts = null, { identical = null } = {}) {
  const all = load(p);
  const fresh = new Set(shorts ?? []);
  const touched = new Set(fresh);
  const out = [];
  const remove = [];
  for (const { s, earlier } of chain(p, all)) {
    if (!earlier || (shorts && !touched.has(earlier.short) && !fresh.has(s.short))) continue;
    const routes = await relink(p, config, earlier, s, remove, identical);
    if (routes.length) { out.push({ short: s.short, from: earlier.short, routes }); touched.add(s.short); }
  }
  save(p, all);
  for (const file of remove) fs.rmSync(file, { force: true });
  return out;
}

/** An entry's screenshots by what they show: variant, state and viewport. */
function shape(entry) {
  const out = new Map();
  for (const [name, variant] of Object.entries(entry.variants ?? {})) {
    for (const [viewport, f] of Object.entries(variant.files ?? {})) out.set(`${name}|page|${viewport}`, f);
    for (const state of variant.states ?? []) for (const [viewport, f] of Object.entries(state.files ?? {})) out.set(`${name}|${state.kind}|${state.key ?? state.label}|${viewport}`, f);
  }
  return out;
}

/**
 * Whether a page this snapshot rendered looks exactly like `before` (an entry of snapshot
 * `from`): the same views, and every screenshot `identical` (see imagediff.mjs).
 */
export async function looksTheSame(p, short, entry, from, before, identical) {
  const a = shape(entry), b = shape(before);
  if (a.size !== b.size || a.size !== entryFiles(entry).length || b.size !== entryFiles(before).length) return false;
  for (const [key, f] of a) {
    if (!b.has(key)) return false;
    const fa = shotPath(p, short, f), fb = shotPath(p, from, b.get(key));
    if (!fs.existsSync(fa) || !fs.existsSync(fb) || !(await identical(fa, fb))) return false;
  }
  return true;
}

/**
 * Bring snapshots made before the store into it, and share what can be shared across the
 * whole history (`ui-progress dedupe`):
 *   1. every file a finished snapshot's manifest lists in its own folder moves into the
 *      store; copies of pages copied forward collapse into one file there
 *   2. relinking over all snapshots, oldest first (see `relink`): with `identical`, pages
 *      a snapshot rendered that look exactly as in the snapshot before share its entry
 *   4. gc
 * Idempotent: a second run finds nothing to do.
 */
export async function dedupe(p, config, { identical = null, log = () => {} } = {}) {
  const all = load(p);
  let moved = 0;
  for (const s of all.values()) {
    if (!s.done) continue;
    for (const entry of s.manifest.routes ?? []) {
      const own = entryFiles(entry).filter((f) => !isStored(f));
      if (!own.length) continue;
      ingest(p, s.short, entry);
      moved += own.length;
      s.dirty = true;
    }
  }
  save(p, all);
  log(`moved ${moved} screenshot(s) into the store`);
  // One pass, oldest first: each snapshot is final before the one after it is compared.
  const fresh = load(p);
  const remove = [];
  let shared = 0;
  for (const { s, earlier } of chain(p, fresh)) if (earlier) shared += (await relink(p, config, earlier, s, remove, identical)).length;
  save(p, fresh);
  for (const file of remove) fs.rmSync(file, { force: true });
  log(`${shared} page(s) now share the earlier snapshot's screenshots`);
  const freed = gc(p);
  log(`removed ${freed.files} screenshot(s) nothing refers to any more`);
  return { moved, shared, freed };
}
