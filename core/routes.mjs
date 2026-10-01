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
