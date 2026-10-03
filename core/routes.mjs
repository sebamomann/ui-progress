/**
 * Route helpers for adapters. A route is written with bracketed parameters, whatever the
 * framework calls them: /plants/[id], /listings/[slug]/photos.
 */
import fs from "node:fs";
import path from "node:path";

export const isDynamic = (route) => route.includes("[");
export const slug = (route) => (route === "/" ? "index" : route.replace(/^\//, "").replaceAll("/", "__"));
export const sectionOf = (route) => (route === "/" ? "home" : route.split("/")[1].replace(/^\[|\]$/g, ""));

export function routeRegex(route) {
  const body = route
    .split("/")
    .map((seg) => {
      if (/^\[\[\.\.\..+\]\]$/.test(seg)) return "(?:.*)?";
      if (/^\[\.\.\..+\]$/.test(seg)) return ".+";
      if (/^\[.+\]$/.test(seg)) return "[^/]+";
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/** :id, {id}, <int:id>, <id> and $id all become [id]. */
export function normalizeRoute(route) {
  const cleaned = "/" + route.replace(/^\^|\$$/g, "").replace(/^\/+|\/+$/g, "");
  return cleaned
    .split("/")
    .map((seg) => seg.replace(/^:(\w+)\??$/, "[$1]").replace(/^\{(\w+)\}$/, "[$1]").replace(/^<(?:\w+:)?(\w+)>$/, "[$1]").replace(/^\$(\w+)$/, "[$1]"))
    .join("/") || "/";
}

/** Next.js App Router: app/(group)/plants/[id]/page.tsx -> /plants/[id]. */
export function nextAppRouteOfFile(file, appDir = "app") {
  const prefix = appDir.replace(/\/$/, "") + "/";
  if (!file.startsWith(prefix)) return null;
  const match = /^(?:(.*)\/)?page\.(tsx|jsx|ts|js|mdx)$/.exec(file.slice(prefix.length));
  if (!match) return null;
  const segments = (match[1] ?? "").split("/").filter(Boolean);
  if (segments[0] === "api") return null;
  if (segments.some((s) => s.startsWith("_") || s.startsWith("@") || s.startsWith("(."))) return null;
  return "/" + segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
}

/** Next.js Pages Router: pages/plants/[id].tsx -> /plants/[id]. */
export function nextPagesRouteOfFile(file, pagesDir = "pages") {
  const prefix = pagesDir.replace(/\/$/, "") + "/";
  if (!file.startsWith(prefix)) return null;
  const match = /^(.*)\.(tsx|jsx|ts|js|mdx)$/.exec(file.slice(prefix.length));
  if (!match) return null;
  const segments = match[1].split("/");
  if (segments[0] === "api" || segments.some((s) => s.startsWith("_"))) return null;
  if (segments[segments.length - 1] === "index") segments.pop();
  return "/" + segments.join("/");
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Every route a checkout defines, given a function that maps a file path to a route. */
export function routesFromFiles(checkout, routeOfFile, subdirs = ["."]) {
  const routes = new Set();
  for (const sub of subdirs) {
    for (const file of walk(path.join(checkout, sub), checkout)) {
      const route = routeOfFile(file);
      if (route) routes.add(route);
    }
  }
  return [...routes].sort();
}

/** Guess the route pattern behind a concrete URL: ids, uuids and tokens become [id]. */
export function patternOfPath(pathname) {
  return (
    "/" +
    pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(seg) || (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg)) ? "[id]" : seg))
      .join("/")
  );
}

// ---------- Source dependencies, for incremental capture and change evidence ----------

const SOURCE_EXT = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".json", ".mdx", ".md"];
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|@import\s+['"]([^'"]+)['"]/g;

/** Path aliases from tsconfig/jsconfig: { "@/": "src/" }. */
export function readAliases(checkout) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(checkout, name);
    if (!fs.existsSync(file)) continue;
    try {
      // JSON with comments. A comment opener only counts after whitespace or punctuation,
      // so a glob such as "@/*" in a string is left alone.
      const text = fs
        .readFileSync(file, "utf8")
        .replace(/(^|[\s,{[])\/\*[\s\S]*?\*\//gm, "$1")
        .replace(/(^|\s)\/\/[^\n]*$/gm, "$1")
        .replace(/,\s*([}\]])/g, "$1");
      const json = JSON.parse(text);
      const base = json.compilerOptions?.baseUrl ?? ".";
      const out = {};
      for (const [alias, targets] of Object.entries(json.compilerOptions?.paths ?? {})) {
        out[alias.replace(/\*$/, "")] = path.posix.join(base, String(targets[0] ?? "").replace(/\*$/, ""));
      }
      return out;
    } catch {
      return {};
    }
  }
  return {};
}

function resolveImport(checkout, fromFile, spec, aliases) {
  let target = null;
  if (spec.startsWith(".")) target = path.posix.join(path.posix.dirname(fromFile), spec);
  else {
    const alias = Object.keys(aliases).find((a) => spec.startsWith(a));
    if (alias) target = path.posix.join(aliases[alias], spec.slice(alias.length));
    else if (spec.startsWith("/")) target = spec.slice(1);
    else return null; // a package
  }
  target = path.posix.normalize(target);
  const candidates = [target, ...SOURCE_EXT.map((e) => target + e), ...SOURCE_EXT.map((e) => path.posix.join(target, "index" + e))];
  for (const cand of candidates) {
    const full = path.join(checkout, cand);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return cand;
  }
  return null;
}

/** Every repository file a source file pulls in, transitively (packages excluded). */
export function importClosure(checkout, entryFiles, { aliases = readAliases(checkout), limit = 600 } = {}) {
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length && seen.size < limit) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|sass|less)$/.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(checkout, file), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      if (!spec) continue;
      const resolved = resolveImport(checkout, file, spec, aliases);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/** Route -> page file, for a checkout and a routeOfFile mapping. */
export function pageFiles(checkout, routeOfFile, subdirs = ["."]) {
  const map = new Map();
  for (const sub of subdirs) for (const file of walk(path.join(checkout, sub), checkout)) {
    const route = routeOfFile(file);
    if (route && !map.has(route)) map.set(route, file);
  }
  return map;
}

/**
 * Files that shape a route: its page file and everything it imports, plus the layout,
 * template, loading and error files of every folder above it (the App Router convention,
 * harmless elsewhere).
 */
export function routeDependencies(checkout, pageFile, aliases) {
  const wrappers = [];
  for (let dir = path.posix.dirname(pageFile); dir && dir !== "."; dir = path.posix.dirname(dir)) {
    for (const name of ["layout", "template", "loading", "error", "not-found"]) {
      for (const ext of [".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte"]) {
        const f = path.posix.join(dir, name + ext);
        if (fs.existsSync(path.join(checkout, f))) wrappers.push(f);
      }
    }
  }
  return importClosure(checkout, [pageFile, ...wrappers], { aliases });
}

/** A tiny glob matcher: `**`, `*` and literal text, matched against a posix path. */
export function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${re}$`);
}
