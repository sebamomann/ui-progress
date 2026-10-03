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
import { git, readJson } from "./util.mjs";

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
