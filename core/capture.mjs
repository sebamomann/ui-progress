/**
 * Capture a running app: every page signed out and signed in (where both exist), plus
 * every dialog, menu and in-page section one click away, at each configured viewport.
 *
 * Nothing here knows the framework. The adapter supplies the routes, the sign-in and the
 * concrete URLs for dynamic routes; without routes the app is crawled from "/".
 */
import fs from "node:fs";
import path from "node:path";
import { requireDep } from "./deps.mjs";
import { isDynamic, patternOfPath, routeRegex, slug } from "./routes.mjs";

const CLICKABLE = 'button, [role="button"], [role="tab"], [role="radio"], summary';

export async function capture({ baseUrl, outDir, config, adapter, ctx, log = () => {} }) {
  const { chromium } = requireDep("playwright");
  const c = config.capture;
  const viewports = c.viewports;
  const [firstViewport] = Object.values(viewports);
  const unsafe = new RegExp(c.unsafe, "i");
  const hideCss = c.hide.length ? `${c.hide.join(",")}{display:none!important}` : "";
  fs.mkdirSync(outDir, { recursive: true });

  /**
   * Wait until the page stops moving: finite animations are run to their end, then the
   * viewport must render identically twice in a row. Entrance animations and staged
   * reveals finish; a spinner that never stops just runs into the cap.
   */
  async function settle(page, rounds = c.settleRounds) {
    await page
      .evaluate(() => {
        for (const animation of document.getAnimations()) {
          try {
            if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
          } catch {
            // an animation that cannot be finished is left to run
          }
        }
      })
      .catch(() => {});
    let previous = null;
    for (let i = 0; i < rounds; i++) {
      const frame = await page.screenshot({ type: "jpeg", quality: 30 }).catch(() => null);
      if (frame && previous && frame.equals(previous)) return;
      previous = frame;
      await page.waitForTimeout(300);
    }
  }

  async function visit(page, url) {
    const errors = [];
    const onError = (err) => errors.push(String(err.message ?? err).slice(0, 200));
    page.on("pageerror", onError);
    let status = null;
    let failure = null;
    try {
      // Some pages keep a request open forever, so "load" is awaited but not required.
      const response = await page.goto(baseUrl + url, { waitUntil: "domcontentloaded", timeout: c.navTimeoutMs });
      status = response?.status() ?? null;
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      if (hideCss) await page.addStyleTag({ content: hideCss }).catch(() => {});
      await settle(page);
    } catch (err) {
      failure = String(err.message ?? err).split("\n")[0];
    }
    page.off("pageerror", onError);
    const finalPath = failure ? null : new URL(page.url()).pathname;
    return { status, failure, finalPath, errors };
  }

  /**
   * Whole-page shot at every viewport. The viewport is grown to the document height first,
   * so fixed bars and floating buttons sit at the real bottom instead of mid-page.
   */
  async function shootPage(page, name) {
    const files = {};
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      await page.setViewportSize(viewport);
      await settle(page, 6);
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => viewport.height);
      if (height > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height: Math.min(height, c.maxPageHeight) });
        await settle(page, 6);
      }
      const file = `${name}.${viewportName}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: true });
      files[viewportName] = file;
    }
    await page.setViewportSize(firstViewport);
    return files;
  }

  /** Viewport-sized shot: for overlays, which are positioned to the screen. */
  async function shootOverlay(page, name) {
    const files = {};
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      await page.setViewportSize(viewport);
      await settle(page, 6);
      const file = `${name}.${viewportName}.png`;
      await page.screenshot({ path: path.join(outDir, file) });
      files[viewportName] = file;
    }
    await page.setViewportSize(firstViewport);
    await page.waitForTimeout(150);
    return files;
  }

  async function collectLinks(page) {
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
    return hrefs.filter((h) => h && h.startsWith("/") && !h.startsWith("//")).map((h) => h.split("#")[0].split("?")[0]);
  }

  /** The page's visible text as a set of lines: what makes two sections "different". */
  const textOf = async (page) => {
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    return new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
  };
  function textChange(a, b) {
    let shared = 0;
    for (const line of a) if (b.has(line)) shared++;
    const union = a.size + b.size - shared;
    return union === 0 ? 0 : 1 - shared / union;
  }

  /** Signatures of everything currently laid over the page. */
  const overlaysOf = (page) =>
    page
      .evaluate(() => {
        const area = innerWidth * innerHeight;
        const found = [];
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
        };
        for (const el of document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], dialog[open], [aria-modal="true"]')) {
          if (visible(el)) found.push(`${el.getAttribute("role") ?? el.tagName.toLowerCase()}|${el.className}`);
        }
        for (const el of document.querySelectorAll("body *")) {
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "absolute") continue;
          if (style.pointerEvents === "none" || !visible(el)) continue;
          const rect = el.getBoundingClientRect();
          const share = (rect.width * rect.height) / area;
          // Thin full-width strips are sticky headers and toolbars, not overlays.
          const bar = rect.width > innerWidth * 0.8 && rect.height < innerHeight * 0.15;
          if (bar) continue;
          if ((style.position === "fixed" && share >= 0.12) || (Number(style.zIndex) >= 20 && share >= 0.03)) {
            found.push(`layer|${el.tagName}|${el.className}`);
          }
        }
        return found;
      })
      .catch(() => []);

  const candidatesOf = (page) =>
    page
      .evaluate((selector) => {
        return [...document.querySelectorAll(selector)].map((el, index) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          // Icon-only buttons are named after their icon class (lucide-x, fa-x, icon-x).
          const svg = el.querySelector("svg, i");
          const icon = [...(svg?.classList ?? [])].map((cls) => /^(?:lucide|fa|icon|bi|ti)-(.+)$/.exec(cls)?.[1]).find(Boolean);
          const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || (icon ? `(${icon.replaceAll("-", " ")})` : ""))
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
          const role = el.getAttribute("role");
          return {
            index,
            label,
            usable: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.type !== "submit",
            // A control that switches what the page shows, rather than doing something.
            switcher: role === "tab" || role === "radio" || el.hasAttribute("aria-pressed") || el.hasAttribute("aria-selected"),
            selected: ["aria-selected", "aria-pressed", "aria-checked"].some((a) => el.getAttribute(a) === "true"),
            chrome: Boolean(el.closest("header, nav, footer")),
            popup: el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls"),
          };
        });
      }, CLICKABLE)
      .catch(() => []);

  /**
   * Click through a page's controls and record each one that opens an overlay or switches
   * the page to a different section. Controls in the site chrome are captured once for the
   * whole site, not on every page.
   */
  async function captureStates(page, route, url, auth, chromeSeen) {
    const limits = c.states;
    const states = [];
    const reload = () => visit(page, url);
    await reload();
    const baseText = await textOf(page);
    const baseSearch = new URL(page.url()).search;

    const seen = new Set();
    const queue = (await candidatesOf(page))
      .filter((k) => k.usable && k.label && !unsafe.test(k.label) && !(k.switcher && k.selected))
      .filter((k) => {
        const key = k.label.toLowerCase();
        if (seen.has(key) || (k.chrome && chromeSeen.has(key))) return false;
        seen.add(key);
        return true;
      })
      // Section switchers and overlay openers first, so the click budget is spent well.
      .sort((a, b) => Number(b.switcher) * 2 + Number(b.popup) - (Number(a.switcher) * 2 + Number(a.popup)))
      .slice(0, limits.maxClicks);

    for (const candidate of queue) {
      if (states.length >= limits.maxPerPage) break;
      const before = new Set(await overlaysOf(page));
      try {
        await page.locator(CLICKABLE).nth(candidate.index).click({ timeout: 2_500 });
      } catch {
        continue;
      }
      await page.waitForTimeout(350);
      await settle(page, 8);

      const here = new URL(page.url());
      if (here.pathname !== url) {
        await reload();
        continue;
      }
      const name = `${slug(route)}.${auth}.s${states.length + 1}`;
      const opened = (await overlaysOf(page)).filter((sig) => !before.has(sig));
      if (opened.length > 0) {
        const kind = opened.some((s) => s.startsWith("menu") || s.startsWith("listbox")) ? "menu" : "dialog";
        states.push({ label: candidate.label, kind, chrome: candidate.chrome, files: await shootOverlay(page, name) });
        if (candidate.chrome) chromeSeen.add(candidate.label.toLowerCase());
        await reload();
        continue;
      }
      const change = textChange(baseText, await textOf(page));
      if (change >= limits.sectionChange || here.search !== baseSearch || (candidate.switcher && change > 0)) {
        states.push({ label: candidate.label, kind: "section", chrome: candidate.chrome, change: Number(change.toFixed(3)), files: await shootPage(page, name) });
        await reload();
      } else if (change > 0) {
        await reload();
      }
    }
    return states;
  }

  // ---------- Routes ----------
  const hints = (await adapter.resolve?.(ctx)) ?? {};
  const allowed = (route) => (!c.include.length || c.include.some((r) => new RegExp(r).test(route))) && !c.exclude.some((r) => new RegExp(r).test(route));
  let routes = adapter.routes ? [...new Set(await adapter.routes(ctx))].sort() : null;
  const crawling = !routes;

  const browser = await chromium.launch();
  const contextOptions = { viewport: firstViewport, locale: c.locale, colorScheme: c.colorScheme, reducedMotion: "reduce" };
  const results = {};
  const texts = {};
  const links = new Set();
  const entryFor = (route, url) => (results[route] ??= { route, url, variants: {} });

  const anon = await browser.newContext(contextOptions);
  const anonPage = await anon.newPage();
  const authed = await browser.newContext(contextOptions);
  const page = await authed.newPage();

  // Sign in, if the project has a sign-in at all.
  let loggedIn = false;
  let loginError = null;
  if (adapter.login || config.login) {
    try {
      if (adapter.login) await adapter.login(page, { ...ctx, baseUrl });
      else {
        const l = config.login;
        await page.goto(baseUrl + l.url, { waitUntil: "load", timeout: c.navTimeoutMs });
        for (const [selector, value] of Object.entries(l.fill)) {
          await page.waitForSelector(selector, { state: "visible", timeout: 20_000 });
          await page.fill(selector, value);
        }
        await Promise.all([page.waitForURL((u) => u.pathname !== l.url, { timeout: 30_000 }), page.click(l.submit ?? 'button[type="submit"]')]);
      }
      loggedIn = true;
    } catch (err) {
      loginError = String(err.message ?? err).split("\n")[0];
      log(`sign-in failed: ${loginError}`);
    }
  }

  // Without a route list, walk the links from "/" and generalise ids into [id].
  if (crawling) {
    const found = new Map();
    const queue = ["/"];
    const walker = loggedIn ? page : anonPage;
    while (queue.length && found.size < c.crawlLimit) {
      const url = queue.shift();
      const pattern = patternOfPath(url);
      if (found.has(pattern)) continue;
      const res = await visit(walker, url);
      if (res.failure || (res.status ?? 200) >= 400) continue;
      found.set(pattern, url);
      for (const link of await collectLinks(walker)) if (!found.has(patternOfPath(link))) queue.push(link);
    }
    routes = [...found.keys()].sort();
    for (const [pattern, url] of found) if (isDynamic(pattern)) hints[pattern] ??= url;
    log(`crawled ${routes.length} routes from /`);
  }
  routes = routes.filter(allowed);
  const staticRoutes = routes.filter((r) => !isDynamic(r));
  const dynamicRoutes = routes.filter(isDynamic);

  // Pass 1: signed out. Whatever does not bounce away is a public page.
  if (c.signedOut || !loggedIn) {
    const targets = [...staticRoutes.map((r) => [r, r]), ...dynamicRoutes.filter((r) => hints[r]).map((r) => [r, hints[r]])];
    for (const [route, url] of targets) {
      const res = await visit(anonPage, url);
      if (res.failure || res.finalPath !== url || (res.status ?? 200) >= 400) continue;
      const entry = entryFor(route, url);
      Object.assign(entry, res);
      texts[route] = await textOf(anonPage);
      entry.variants.public = { files: await shootPage(anonPage, `${slug(route)}.public`) };
      (await collectLinks(anonPage)).forEach((l) => links.add(l));
    }
  }

  // Pass 2: signed in. A page that reads the same as its public version is one page.
  const shoot = async (route, url) => {
    const res = await visit(page, url);
    const redirected = !res.failure && res.finalPath !== url && !routeRegex(route).test(res.finalPath);
    const existing = results[route];
    const broken = (res.status ?? 200) >= 500;
    if (res.failure || redirected || broken) {
      if (!existing) results[route] = { route, url, ...res, variants: {}, skipped: res.failure ? "failed" : broken ? "server error" : "redirected" };
      return;
    }
    const text = await textOf(page);
    if (existing && texts[route] && textChange(texts[route], text) === 0) return;
    const entry = entryFor(route, url);
    if (!existing) Object.assign(entry, res);
    entry.variants.user = { files: await shootPage(page, `${slug(route)}.user`) };
    (await collectLinks(page)).forEach((l) => links.add(l));
  };
  if (loggedIn) {
    for (const route of staticRoutes) await shoot(route, route);
    // Dynamic routes: from the adapter's hints, else from links seen so far.
    const pending = new Set(dynamicRoutes.filter((r) => !results[r]?.variants.user));
    for (let round = 0; round < 3 && pending.size > 0; round++) {
      let progressed = false;
      for (const route of [...pending]) {
        const regex = routeRegex(route);
        const match = hints[route] ?? [...links].find((l) => regex.test(l) && !staticRoutes.includes(l));
        if (!match) continue;
        pending.delete(route);
        progressed = true;
        await shoot(route, match);
      }
      if (!progressed) break;
    }
    for (const route of pending) results[route] ??= { route, url: null, variants: {}, skipped: "unresolved" };
  }
  for (const route of routes) results[route] ??= { route, url: null, variants: {}, skipped: isDynamic(route) ? "unresolved" : "needs sign-in" };
  log(`pages: ${Object.values(results).filter((r) => Object.keys(r.variants).length).length} of ${routes.length}`);

  // Pass 3: overlays and sections. Last, because clicking around changes data.
  if (c.states.enabled) {
    const chromeSeen = new Set();
    for (const entry of Object.values(results)) {
      for (const [auth, variant] of Object.entries(entry.variants)) {
        variant.states = await captureStates(auth === "user" ? page : anonPage, entry.route, entry.url, auth, chromeSeen).catch(() => []);
      }
    }
  }
  await browser.close();

  const list = Object.values(results).sort((a, b) => a.route.localeCompare(b.route));
  const states = list.reduce((n, r) => n + Object.values(r.variants).reduce((m, v) => m + (v.states?.length ?? 0), 0), 0);
  const manifest = {
    baseUrl,
    capturedAt: new Date().toISOString(),
    crawled: crawling,
    loggedIn,
    loginError,
    viewports,
    routesTotal: routes.length,
    captured: list.filter((r) => Object.keys(r.variants).length > 0).length,
    twoVariants: list.filter((r) => Object.keys(r.variants).length > 1).map((r) => r.route),
    states,
    serverErrors: list.filter((r) => r.skipped === "server error").map((r) => r.route),
    pageErrors: list.filter((r) => r.errors?.length).map((r) => r.route),
    skipped: list.filter((r) => r.skipped).map((r) => ({ route: r.route, why: r.skipped, finalPath: r.finalPath, failure: r.failure })),
    routes: list,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
