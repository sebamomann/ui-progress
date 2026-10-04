/**
 * Screenshots live in one shared store, snapshots/_store/<ab>/<hash>.png, named by the hash
 * of their bytes (in subfolders by the first two digits, as git does). A manifest refers to
 * them as "_store/<ab>/<hash>.png"; no snapshot owns a file,
 * so capturing a snapshot again or deleting one never touches another.
 *
 * Whether a page needs rendering at all is decided from its source, not its pixels (two
 * renders of the same page are rarely byte-identical): a page whose source did not change
 * since the previous snapshot takes over that snapshot's manifest entry, marked
 * `copiedFrom`, with the same references.
 *
 * Manifests written before the store keep file names relative to their own shots/ folder;
 * `shotPath` resolves both, and `migrateStore` brings them in. Files nothing refers to any
 * more are removed by `gc`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as routes from "./routes.mjs";
import { setupDifference, setupOf } from "./stats.mjs";
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

/** The reference of a stored file: in a subfolder named by the first two hex digits, as git does. */
const refOf = (hash) => `${STORE}/${hash.slice(0, 2)}/${hash}.png`;
/** Stored references of 1.3.0, before the subfolders: "_store/<hash>.png". */
const isFlat = (file) => isStored(file) && !file.slice(STORE.length + 1).includes("/");

/**
 * Put a file into the store and return its reference. `move` takes the file away (a fresh
 * render); otherwise the source stays where it is (a file a manifest still lists there),
 * and is hard-linked in where the file system allows it, else copied.
 */
export function storeFile(p, src, { move = false } = {}) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex").slice(0, 32);
  const ref = refOf(hash);
  const dest = path.join(p.snapshots, ref);
  if (fs.existsSync(dest)) { if (move) fs.rmSync(src); }
  else if (move) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(src, dest); }
  else place(src, dest);
  return ref;
}

/**
 * Give `src` a second name `dest`: a hard link where the file system allows it, else a
 * copy. Only a complete file ever has the name, even if parallel captures store the same
 * file or the run is interrupted.
 */
function place(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  try { fs.linkSync(src, temp); } catch { fs.copyFileSync(src, temp); }
  fs.renameSync(temp, dest);
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
 * Give a taken-over entry the style fingerprints (`design`, see capture.mjs) of the entry it
 * replaces where it has none: the pages look the same, so both fingerprints hold, and one
 * captured before fingerprints existed must not drop the newer one.
 */
export function keepDesign(copy, rendered) {
  for (const [name, variant] of Object.entries(copy.variants ?? {})) {
    const other = rendered.variants?.[name];
    if (!other) continue;
    if (!variant.design && other.design) variant.design = other.design;
    for (const state of variant.states ?? []) {
      const match = other.states?.find((s) => s.kind === state.kind && (s.key ?? s.label) === (state.key ?? state.label));
      if (!state.design && match?.design) state.design = match.design;
    }
  }
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
  // namespace (a top-level key) are affected by them. When every changed key is named
  // literally somewhere in the pages' source, a page must also name one of them: a nav that
  // shows `t("items")` from another namespace is not affected by a new key under "items".
  // A key no source names may be built at runtime (from a template string): then the
  // namespace alone counts.
  const translations = (config.capture.incremental.translationPaths ?? []).map(routes.globToRegex);
  const changedKeys = new Map(); // namespace -> last segments of its changed keys
  const changedSet = new Set();
  const leavesOf = (a, b, out, name) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    const objects = [a, b].filter((v) => v && typeof v === "object" && !Array.isArray(v));
    if (objects.length === 0) return out.add(name);
    for (const key of new Set(objects.flatMap(Object.keys))) leavesOf(a?.[key], b?.[key], out, key);
    return out;
  };
  for (const f of changed) {
    if (translations.some((re) => re.test(f)) && f.endsWith(".json")) {
      const parse = (ref) => { try { return JSON.parse(git(p.repo, "show", `${ref}:${f}`)); } catch { return null; } };
      const before = parse(from), after = parse(to);
      if (!before || !after) { changedSet.add(f); continue; }
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        const keys = changedKeys.get(key) ?? new Set();
        for (const leaf of leavesOf(before[key], after[key], new Set(), key)) keys.add(leaf);
        changedKeys.set(key, keys);
      }
    } else changedSet.add(f);
  }
  const changedNamespaces = new Set(changedKeys.keys());
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) { try { sources.set(file, read(file)); } catch { sources.set(file, ""); } }
    return sources.get(file);
  };
  const named = (text, word) => text.includes(`"${word}"`) || text.includes(`'${word}'`) || text.includes(`\`${word}\``) || new RegExp(`["'\`.]${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(text);
  const allFiles = [...new Set(Object.values(deps).flat().filter(Boolean))];
  const literal = changedNamespaces.size > 0 && [...changedKeys.values()].every((keys) => [...keys].every((key) => allFiles.some((f) => named(source(f), key))));
  const affected = (list) => {
    const files = list.filter(Boolean);
    return [...changedKeys].some(([ns, keys]) => files.some((f) => named(source(f), ns)) && (!literal || files.some((f) => [...keys].some((key) => named(source(f), key)))));
  };
  const unchanged = new Set();
  for (const [route, list] of Object.entries(deps)) {
    if (list.some(Boolean) && !list.some((f) => changedSet.has(f)) && !affected(list)) unchanged.add(route);
  }
  return { routes: unchanged, changed: changed.length, namespaces: [...changedNamespaces] };
}

/** Every file in the store, as references, subfolders and 1.3.0's flat files alike. */
function storedFiles(p) {
  const out = [];
  if (!fs.existsSync(storeDir(p))) return out;
  for (const entry of fs.readdirSync(storeDir(p), { withFileTypes: true })) {
    if (entry.isDirectory()) for (const file of fs.readdirSync(path.join(storeDir(p), entry.name))) out.push(`${STORE}/${entry.name}/${file}`);
    else out.push(`${STORE}/${entry.name}`);
  }
  return out;
}

/**
 * Delete the stored screenshots no manifest refers to: those of snapshots captured again
 * or deleted. Every manifest counts, finished or not. Run under the repository lock only,
 * so no capture is between storing a file and writing the manifest that lists it.
 */
export function gc(p) {
  const used = new Set();
  for (const short of fs.existsSync(p.snapshots) ? fs.readdirSync(p.snapshots) : []) {
    if (short === STORE) continue;
    const manifest = readJson(manifestFile(p, short));
    for (const entry of manifest?.routes ?? []) for (const f of entryFiles(entry)) if (isStored(f)) used.add(f);
  }
  let files = 0, bytes = 0;
  for (const ref of storedFiles(p)) {
    if (used.has(ref)) continue;
    const full = path.join(p.snapshots, ref);
    bytes += fs.statSync(full).size;
    fs.rmSync(full);
    files++;
  }
  for (const dir of fs.existsSync(storeDir(p)) ? fs.readdirSync(storeDir(p), { withFileTypes: true }) : []) {
    if (dir.isDirectory() && !fs.readdirSync(path.join(storeDir(p), dir.name)).length) fs.rmdirSync(path.join(storeDir(p), dir.name));
  }
  return { files, bytes };
}

/**
 * Bring what older versions left into today's layout; runs on its own at the start of
 * every command that reads or writes snapshots, so updating needs no step of its own:
 *   - 1.3.0's flat "_store/<hash>.png" references move into the subfolders
 *   - screenshots a finished snapshot keeps in its own folder (before 1.3.0) move into the
 *     store; copies of pages copied forward collapse into one file there
 * Lossless and safe to interrupt: files are linked into their new place first, then every
 * manifest is rewritten, and only then are the old files removed. Returns what it moved.
 */
export function migrateStore(p) {
  const all = load(p);
  const old = new Set();
  let moved = 0;
  for (const s of all.values()) {
    for (const entry of s.manifest.routes ?? []) {
      mapFiles(entry, (f) => {
        if (isFlat(f)) {
          // The name is the hash already: link it into its subfolder.
          const src = path.join(p.snapshots, f), ref = refOf(path.basename(f, ".png"));
          if (!fs.existsSync(path.join(p.snapshots, ref))) {
            if (!fs.existsSync(src)) return f; // gone: left for the build to report
            place(src, path.join(p.snapshots, ref));
          }
          old.add(src);
          s.dirty = true;
          moved++;
          return ref;
        }
        if (!isStored(f) && s.done) {
          const src = shotPath(p, s.short, f);
          if (!fs.existsSync(src)) return f;
          old.add(src);
          s.dirty = true;
          moved++;
          return storeFile(p, src);
        }
        return f;
      });
    }
  }
  save(p, all);
  for (const file of old) fs.rmSync(file, { force: true });
  // Flat files no manifest listed, and temporary files of an interrupted run.
  for (const ref of storedFiles(p)) if (isFlat(ref) || ref.endsWith(".tmp")) fs.rmSync(path.join(p.snapshots, ref), { force: true });
  return { moved, files: old.size };
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
  // A reference follows only between snapshots made the same way (see setupDifference).
  const sameSetup = !setupDifference(setupOf(p, earlier.short), setupOf(p, later.short));
  const sourceUnchanged = (route) => {
    if (!sameSetup) return false;
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
    later.manifest.routes[i] = { ...keepDesign(takeOver(p, earlier.short, before, own ? "sameAs" : "copiedFrom"), entry), url: entry.url };
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
 *   1. `migrateStore` (which every command runs anyway)
 *   2. relinking over all snapshots, oldest first (see `relink`): with `identical`, pages
 *      a snapshot rendered that look exactly as in the snapshot before share its entry
 *   3. gc
 * Idempotent: a second run finds nothing to do.
 */
export async function dedupe(p, config, { identical = null, log = () => {} } = {}) {
  const { moved } = migrateStore(p);
  log(`moved ${moved} screenshot reference(s) into the store`);
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
