/**
 * Capture a running app: every page signed out and signed in (where both exist), plus the
 * dialogs, menus and in-page sections one or two clicks away, at each configured viewport.
 *
 * Nothing here knows the framework. The adapter supplies the routes, the sign-in and the
 * concrete URLs for dynamic routes; without routes the app is crawled from "/".
 *
 * Speed: several pages are captured at once in separate tabs; protected routes are detected
 * with a request instead of a render; overlays are closed with Escape instead of reloading;
 * a dialog seen on one page of a section is not opened again on its siblings; pages whose
 * source did not change since the previous snapshot can be copied forward (see `reuse`).
 */
import fs from "node:fs";
import path from "node:path";
import { requireDep } from "./deps.mjs";
import { isDynamic, patternOfPath, routeRegex, sectionOf, slug } from "./routes.mjs";

const CLICKABLE = 'button, [role="button"], [role="tab"], [role="radio"], summary, [role="menuitem"]';
const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"], dialog[open], [aria-modal="true"]';

export async function capture({ baseUrl, outDir, config, adapter, ctx, screens = [], reuse = null, log = () => {} }) {
  const { chromium } = requireDep("playwright");
  const c = config.capture;
  const viewports = c.viewports;
  const viewportNames = Object.keys(viewports);
  const primaryName = viewportNames[0];
  const schemeOf = (name) => viewports[name].colorScheme ?? c.colorScheme;
  const primaryScheme = schemeOf(primaryName);
  const schemes = [...new Set(viewportNames.map(schemeOf))];
  const unsafe = new RegExp(c.unsafe, "i");
  const hideCss = c.hide.length ? `${c.hide.join(",")}{display:none!important}` : "";
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();

  // ---------- Page helpers ----------

  /** Wait until the viewport renders identically twice in a row; finite animations are finished first. */
  async function settle(page, rounds = c.settleRounds) {
    await page
      .evaluate(() => {
        for (const animation of document.getAnimations()) {
          try {
            if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
          } catch {
            // left to run
          }
        }
      })
      .catch(() => {});
    let previous = null;
    for (let i = 0; i < rounds; i++) {
      const frame = await page.screenshot({ type: "jpeg", quality: 25, scale: "css" }).catch(() => null);
      if (frame && previous && frame.equals(previous)) return;
      previous = frame;
      await page.waitForTimeout(220);
    }
  }

  async function visit(page, url) {
    const errors = [];
    const onError = (err) => errors.push(String(err.message ?? err).slice(0, 200));
    page.on("pageerror", onError);
    let status = null;
    let failure = null;
    try {
      const response = await page.goto(baseUrl + url, { waitUntil: "domcontentloaded", timeout: c.navTimeoutMs });
      status = response?.status() ?? null;
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      if (hideCss) await page.addStyleTag({ content: hideCss }).catch(() => {});
      await settle(page);
    } catch (err) {
      failure = String(err.message ?? err).split("\n")[0];
    }
    page.off("pageerror", onError);
    const finalPath = failure ? null : new URL(page.url()).pathname;
    return { status, failure, finalPath, errors };
  }

  /** Does this URL answer for a signed-out visitor, without rendering it? */
  async function publicProbe(context, url) {
    try {
      const res = await context.request.get(baseUrl + url, { maxRedirects: 0, timeout: c.navTimeoutMs });
      const status = res.status();
      if (status >= 300 && status < 400) {
        const to = res.headers().location ?? "";
        return { ok: false, redirect: new URL(to, baseUrl).pathname };
      }
      return { ok: status < 400, status };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Whole-page shot at every viewport. `pages` maps colour scheme to a page already showing
   * the right content. The viewport is grown to the document height first, so fixed bars
   * and floating buttons sit at the real bottom instead of mid-page.
   */
  async function shootPage(pages, name) {
    const files = {};
    for (const viewportName of viewportNames) {
      const viewport = viewports[viewportName];
      const page = pages[schemeOf(viewportName)];
      if (!page) continue; // states are shot in the primary scheme only
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await settle(page, 4);
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => viewport.height);
      if (height > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height: Math.min(height, c.maxPageHeight) });
        await settle(page, 4);
      }
      const file = `${name}.${viewportName}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: true, scale: "css" });
      files[viewportName] = file;
    }
    for (const page of Object.values(pages)) await page.setViewportSize({ width: viewports[primaryName].width, height: viewports[primaryName].height });
    return files;
  }

  /** Viewport-sized shot at every viewport of the primary scheme: for overlays, which are positioned to the screen. */
  async function shootOverlay(page, name) {
    const files = {};
    for (const viewportName of viewportNames) {
      if (schemeOf(viewportName) !== primaryScheme) continue;
      const viewport = viewports[viewportName];
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await settle(page, 4);
      const file = `${name}.${viewportName}.png`;
      await page.screenshot({ path: path.join(outDir, file), scale: "css" });
      files[viewportName] = file;
    }
    await page.setViewportSize({ width: viewports[primaryName].width, height: viewports[primaryName].height });
    return files;
  }

  async function collectLinks(page) {
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
    return hrefs.filter((h) => h && h.startsWith("/") && !h.startsWith("//")).map((h) => h.split("#")[0].split("?")[0]);
  }

  const textOf = async (page, scope = "body") => {
    const text = await page.evaluate((s) => document.querySelector(s)?.innerText ?? "", scope).catch(() => "");
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
      .evaluate((overlaySelector) => {
        const area = innerWidth * innerHeight;
        const found = [];
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
        };
        for (const el of document.querySelectorAll(overlaySelector)) if (visible(el)) found.push(`${el.getAttribute("role") ?? el.tagName.toLowerCase()}|${el.className}`);
        // Positioned layers: only elements that could be large enough to matter are measured.
        for (const el of document.querySelectorAll("body *")) {
          if (el.children.length === 0 && el.tagName !== "IMG") continue;
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "absolute") continue;
          if (style.pointerEvents === "none" || !visible(el)) continue;
          const rect = el.getBoundingClientRect();
          const share = (rect.width * rect.height) / area;
          const bar = rect.width > innerWidth * 0.8 && rect.height < innerHeight * 0.15;
          if (bar) continue;
          if ((style.position === "fixed" && share >= 0.12) || (Number(style.zIndex) >= 20 && share >= 0.03)) found.push(`layer|${el.tagName}|${el.className}`);
        }
        return found;
      }, OVERLAY)
      .catch(() => []);

  /**
   * Clickable controls, each with a label for people and a key for matching the same
   * control across snapshots: a test id, id or aria link where present, else its place in
   * the document.
   */
  const candidatesOf = (page, scope = null) =>
    page
      .evaluate(
        ([selector, scopeSel]) => {
          const root = scopeSel ? [...document.querySelectorAll(scopeSel)].pop() : document;
          if (!root) return [];
          const all = [...document.querySelectorAll(selector)];
          return [...root.querySelectorAll(selector)].map((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const svg = el.querySelector("svg, i");
            const icon = [...(svg?.classList ?? [])].map((cls) => /^(?:lucide|fa|icon|bi|ti)-(.+)$/.exec(cls)?.[1]).find(Boolean);
            const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || (icon ? `(${icon.replaceAll("-", " ")})` : "")).trim().replace(/\s+/g, " ").slice(0, 40);
            const role = el.getAttribute("role");
            let key = el.dataset.testid || el.id || el.getAttribute("aria-controls") || el.getAttribute("name") || "";
            if (!key) {
              const parts = [];
              for (let node = el; node && node !== document.body; node = node.parentElement) {
                if (node.matches('[role="dialog"], main, header, nav, footer, aside')) { parts.unshift(node.tagName.toLowerCase() + (node.getAttribute("role") ? "[" + node.getAttribute("role") + "]" : "")); break; }
                const siblings = [...node.parentElement?.children ?? []].filter((s) => s.tagName === node.tagName);
                parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? `:${siblings.indexOf(node) + 1}` : ""));
              }
              key = parts.join(">") + (icon ? `#${icon}` : "");
            }
            return {
              index: all.indexOf(el),
              label,
              key,
              usable: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.type !== "submit",
              switcher: role === "tab" || role === "radio" || el.hasAttribute("aria-pressed") || el.hasAttribute("aria-selected"),
              selected: ["aria-selected", "aria-pressed", "aria-checked"].some((a) => el.getAttribute(a) === "true"),
              chrome: Boolean(el.closest("header, nav, footer")),
              popup: el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls"),
            };
          });
        },
        [CLICKABLE, scope],
      )
      .catch(() => []);

  /** Press Escape until no overlay is left; say whether the page is back to its base state. */
  async function closeOverlays(page, baseText) {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(180);
      if ((await overlaysOf(page)).length === 0) break;
    }
    if ((await overlaysOf(page)).length > 0) return false;
    return textChange(baseText, await textOf(page)) < 0.02;
  }

  /**
   * Click through a page's controls and record each one that opens an overlay or switches
   * the page to a different section; inside an overlay, one more level is tried. Controls
   * in the site chrome are captured once for the whole site; a control already captured on
   * a sibling page of the same section is skipped.
   */
  async function captureStates(page, route, url, auth, seenGlobal) {
    const limits = c.states;
    const states = [];
    const deadline = Date.now() + limits.budgetMs;
    const section = sectionOf(route);
    const reload = () => visit(page, url);
    let baseText = await textOf(page);
    const baseSearch = new URL(page.url()).search;
    const baseOverlays = new Set(await overlaysOf(page));

    const seen = new Set();
    const queue = (await candidatesOf(page))
      .filter((k) => k.usable && k.label && !/^\d+$/.test(k.label) && !unsafe.test(k.label) && !(k.switcher && k.selected))
      .filter((k) => {
        const id = k.label.toLowerCase();
        const scopeKey = k.chrome ? `chrome:${id}` : `${section}:${id}`;
        if (seen.has(id) || seenGlobal.has(scopeKey)) return false;
        seen.add(id);
        k.scopeKey = scopeKey;
        return true;
      })
      .sort((a, b) => Number(b.switcher) * 2 + Number(b.popup) - (Number(a.switcher) * 2 + Number(a.popup)))
      .slice(0, limits.maxClicks);

    const record = async (candidate, kind, name, extra = {}) => {
      const files = kind === "section" ? await shootPage({ [primaryScheme]: page }, name) : await shootOverlay(page, name);
      states.push({ label: candidate.label, key: candidate.key, kind, chrome: candidate.chrome, files, ...extra });
      seenGlobal.add(candidate.scopeKey);
    };

    for (const candidate of queue) {
      if (states.length >= limits.maxPerPage || Date.now() > deadline) break;
      try {
        await page.locator(CLICKABLE).nth(candidate.index).click({ timeout: 2_000, noWaitAfter: true });
      } catch {
        continue;
      }
      await page.waitForTimeout(250);
      await settle(page, 5);

      const here = new URL(page.url());
      if (here.pathname !== url) { await reload(); continue; }
      const name = `${slug(route)}.${auth}.s${states.length + 1}`;
      const opened = (await overlaysOf(page)).filter((sig) => !baseOverlays.has(sig));
      if (opened.length > 0) {
        const kind = opened.some((s) => s.startsWith("menu") || s.startsWith("listbox")) ? "menu" : "dialog";
        await record(candidate, kind, name);
        // One level deeper: tabs and openers inside the overlay.
        if (limits.depth > 1) {
          const overlayText = await textOf(page, OVERLAY);
          const inner = (await candidatesOf(page, OVERLAY)).filter((k) => k.usable && k.label && !unsafe.test(k.label) && !(k.switcher && k.selected) && !/close|schließen|cancel|abbrechen|back|zurück/i.test(k.label)).sort((a, b) => Number(b.switcher) - Number(a.switcher)).slice(0, limits.depthClicks);
          for (const sub of inner) {
            if (states.length >= limits.maxPerPage || Date.now() > deadline) break;
            try {
              await page.locator(CLICKABLE).nth(sub.index).click({ timeout: 1_500, noWaitAfter: true });
            } catch {
              continue;
            }
            await page.waitForTimeout(200);
            await settle(page, 4);
            if (new URL(page.url()).pathname !== url) { await reload(); break; }
            const stillOpen = (await overlaysOf(page)).length > 0;
            const changed = stillOpen && textChange(overlayText, await textOf(page, OVERLAY)) >= 0.15;
            if (changed) await record({ ...candidate, label: `${candidate.label} › ${sub.label}`, key: `${candidate.key}>${sub.key}`, scopeKey: `${candidate.scopeKey}>${sub.label.toLowerCase()}` }, kind, `${slug(route)}.${auth}.s${states.length + 1}`, { depth: 2 });
            if (!stillOpen) break;
          }
        }
        if (!(await closeOverlays(page, baseText))) await reload();
        continue;
      }
      const change = textChange(baseText, await textOf(page));
      if (change >= limits.sectionChange || here.search !== baseSearch || (candidate.switcher && change > 0)) {
        await record(candidate, "section", name, { change: Number(change.toFixed(3)) });
        await reload();
        baseText = await textOf(page);
      } else if (change > 0.02) {
        await reload();
      }
    }
    return states;
  }

  /** Screens the adapter or the agent asked for explicitly: a URL plus optional steps. */
  async function captureScreens(page, route, url, auth) {
    const states = [];
    for (const screen of screens.filter((s) => s.route === route && (s.auth ?? "user") === auth)) {
      try {
        await visit(page, screen.url ?? url);
        for (const step of screen.steps ?? []) {
          if (step.click) await page.locator(step.click).first().click({ timeout: 4_000 });
          if (step.hover) await page.locator(step.hover).first().hover({ timeout: 4_000 });
          if (step.fill) await page.locator(step.fill.selector).first().fill(String(step.fill.value), { timeout: 4_000 });
          if (step.press) await page.keyboard.press(step.press);
          if (step.scroll) await page.evaluate((y) => window.scrollTo(0, y), step.scroll);
          if (step.wait) await page.waitForTimeout(step.wait);
          await settle(page, 4);
        }
        const kind = screen.kind ?? "section";
        const name = `${slug(route)}.${auth}.x${states.length + 1}`;
        const files = kind === "section" ? await shootPage({ [primaryScheme]: page }, name) : await shootOverlay(page, name);
        states.push({ label: screen.label, key: `screen:${screen.id ?? screen.label}`, kind, chrome: false, files, screen: true });
      } catch (err) {
        log(`screen "${screen.label}" on ${route} failed: ${String(err.message).split("\n")[0]}`);
      }
    }
    return states;
  }

  /**
   * Mechanical checks on the page as rendered: a not-found page (even with status 200), an
   * error overlay or framework error page, a sign-in form, a blank page, broken images.
   */
  const inspect = (page) =>
    page
      .evaluate((k) => {
        const issues = [];
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const text = (document.body?.innerText ?? "").trim();
        const heading = [...document.querySelectorAll("h1, h2")].filter(visible).slice(0, 3).map((h) => h.innerText).join(" ");
        const label = `${document.title} ${heading}`;
        const notFound = document.querySelector('meta[name="next-error"][content="not-found"]') || (new RegExp(k.notFound, "i").test(label) && text.length < 2000);
        if (notFound) issues.push("not-found");
        const overlay = k.errorSelectors.some((s) => { try { return document.querySelector(s); } catch { return false; } }) ||
          [...document.querySelectorAll("nextjs-portal")].some((el) => el.shadowRoot?.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay]"));
        if (overlay || new RegExp(k.errorTitle, "i").test(label)) issues.push("error page or overlay");
        if ([...document.querySelectorAll('input[type="password"]')].some(visible)) issues.push("sign-in form");
        const media = [...document.querySelectorAll("img, svg, canvas, video, picture")].filter(visible).length;
        if (text.length < 15 && media < 2) issues.push("blank");
        const broken = [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && visible(img)).length;
        if (broken) issues.push(`${broken} broken image(s)`);
        return issues;
      }, c.checks)
      .catch(() => []);
  const signInPath = new RegExp(c.checks.signInPaths, "i");
  /** Issues worth a look, without the ones expected on this route. */
  const suspectsOf = (issues, route) => issues.filter((i) => i !== "not-found" && !(i === "sign-in form" && signInPath.test(route)));

  // ---------- Routes ----------
  const hints = (await adapter.resolve?.(ctx)) ?? {};
  const allowed = (route) => (!c.include.length || c.include.some((r) => new RegExp(r).test(route))) && !c.exclude.some((r) => new RegExp(r).test(route));
  let routes = adapter.routes ? [...new Set(await adapter.routes(ctx))].sort() : null;
  const crawling = !routes;

  const browser = await chromium.launch();
  const contextFor = (scheme) => browser.newContext({ viewport: { width: viewports[primaryName].width, height: viewports[primaryName].height }, locale: c.locale, colorScheme: scheme, reducedMotion: "reduce" });
  const anonCtx = {}, userCtx = {};
  for (const scheme of schemes) { anonCtx[scheme] = await contextFor(scheme); userCtx[scheme] = await contextFor(scheme); }

  // Sign in once per colour scheme (contexts do not share cookies).
  let loggedIn = false;
  let loginError = null;
  if (adapter.login || config.login) {
    for (const scheme of schemes) {
      const page = await userCtx[scheme].newPage();
      try {
        if (adapter.login) await adapter.login(page, { ...ctx, baseUrl });
        else {
          const l = config.login;
          await page.goto(baseUrl + l.url, { waitUntil: "load", timeout: c.navTimeoutMs });
          for (const [selector, value] of Object.entries(l.fill)) { await page.waitForSelector(selector, { state: "visible", timeout: 20_000 }); await page.fill(selector, value); }
          await Promise.all([page.waitForURL((u) => u.pathname !== l.url, { timeout: 30_000 }), page.click(l.submit ?? 'button[type="submit"]')]);
        }
        loggedIn = true;
      } catch (err) {
        loginError = String(err.message ?? err).split("\n")[0];
        log(`sign-in failed (${scheme}): ${loginError}`);
      }
      await page.close();
    }
  }

  // Without a route list, walk the links from "/" and generalise ids into [id].
  if (crawling) {
    const walker = await (loggedIn ? userCtx : anonCtx)[primaryScheme].newPage();
    const found = new Map();
    const queue = ["/"];
    while (queue.length && found.size < c.crawlLimit) {
      const url = queue.shift();
      const pattern = patternOfPath(url);
      if (found.has(pattern)) continue;
      const res = await visit(walker, url);
      if (res.failure || (res.status ?? 200) >= 400) continue;
      found.set(pattern, url);
      for (const link of await collectLinks(walker)) if (!found.has(patternOfPath(link))) queue.push(link);
    }
    await walker.close();
    routes = [...found.keys()].sort();
    for (const [pattern, url] of found) if (isDynamic(pattern)) hints[pattern] ??= url;
    log(`crawled ${routes.length} routes from /`);
  }
  routes = routes.filter(allowed);

  // Pages whose source did not change since the previous snapshot are copied forward.
  const results = {};
  const reused = [];
  if (reuse) {
    for (const entry of reuse.manifest.routes) {
      if (!reuse.routes.has(entry.route) || !routes.includes(entry.route) || !Object.keys(entry.variants).length) continue;
      const copy = JSON.parse(JSON.stringify(entry));
      for (const variant of Object.values(copy.variants)) {
        const items = [variant, ...(variant.states ?? [])];
        for (const item of items) for (const file of Object.values(item.files ?? {})) fs.copyFileSync(path.join(reuse.dir, file), path.join(outDir, file));
      }
      copy.copiedFrom = reuse.from;
      results[entry.route] = copy;
      reused.push(entry.route);
    }
    if (reused.length) log(`copied forward ${reused.length} unchanged page(s) from ${reuse.from}`);
  }

  // ---------- Per-route work, spread over several tabs ----------
  const links = new Set();
  const seenGlobal = new Set();
  const staticRoutes = routes.filter((r) => !isDynamic(r) && !results[r]);
  const dynamicRoutes = routes.filter((r) => isDynamic(r) && !results[r]);

  async function captureRoute(worker, route, url) {
    const entry = { route, url, variants: {} };
    let publicText = null;
    let notFound = false;
    // Signed out: a request tells whether the page answers at all, before a tab renders it.
    const probe = await publicProbe(anonCtx[primaryScheme], url);
    if (probe.ok) {
      const res = await visit(worker.anon[primaryScheme], url);
      const issues = res.failure ? [] : await inspect(worker.anon[primaryScheme]);
      if (issues.includes("not-found")) notFound = true;
      else if (!res.failure && res.finalPath === url && (res.status ?? 200) < 400) {
        Object.assign(entry, res);
        publicText = await textOf(worker.anon[primaryScheme]);
        for (const scheme of schemes) if (scheme !== primaryScheme) await visit(worker.anon[scheme], url);
        entry.variants.public = { files: await shootPage(worker.anon, `${slug(route)}.public`) };
        const suspects = suspectsOf(issues, route);
        if (suspects.length) entry.variants.public.suspects = suspects;
        (await collectLinks(worker.anon[primaryScheme])).forEach((l) => links.add(l));
      }
    }
    if (loggedIn) {
      const page = worker.user[primaryScheme];
      const res = await visit(page, url);
      const redirected = !res.failure && res.finalPath !== url && !routeRegex(route).test(res.finalPath);
      const broken = (res.status ?? 200) >= 500;
      const issues = res.failure || redirected ? [] : await inspect(page);
      const missing = res.status === 404 || issues.includes("not-found");
      if (res.failure || redirected || broken || missing) {
        if (!entry.variants.public) { Object.assign(entry, res); entry.skipped = res.failure ? "failed" : broken ? "server error" : missing ? "not found" : "redirected"; }
      } else {
        const text = await textOf(page);
        if (!(publicText && textChange(publicText, text) === 0)) {
          if (!entry.variants.public) Object.assign(entry, res);
          for (const scheme of schemes) if (scheme !== primaryScheme) await visit(worker.user[scheme], url);
          entry.variants.user = { files: await shootPage(worker.user, `${slug(route)}.user`) };
          const suspects = suspectsOf(issues, route);
          if (suspects.length) entry.variants.user.suspects = suspects;
          (await collectLinks(page)).forEach((l) => links.add(l));
        }
      }
    } else if (!entry.variants.public && !entry.skipped) {
      entry.skipped = notFound ? "not found" : probe.redirect ? "redirected" : "needs sign-in";
      entry.finalPath = probe.redirect ?? null;
    }
    if (c.states.enabled) {
      for (const [auth, variant] of Object.entries(entry.variants)) {
        const page = (auth === "user" ? worker.user : worker.anon)[primaryScheme];
        await visit(page, url);
        variant.states = await captureStates(page, route, url, auth, seenGlobal).catch(() => []);
        variant.states.push(...(await captureScreens(page, route, url, auth)));
      }
    }
    results[route] = entry;
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, c.parallel); i++) {
    const w = { anon: {}, user: {} };
    for (const scheme of schemes) { w.anon[scheme] = await anonCtx[scheme].newPage(); w.user[scheme] = await userCtx[scheme].newPage(); }
    workers.push(w);
  }
  const run = async (jobs) => {
    const queue = [...jobs];
    await Promise.all(workers.map(async (worker) => {
      while (queue.length) {
        const [route, url] = queue.shift();
        try {
          await captureRoute(worker, route, url);
        } catch (err) {
          results[route] = { route, url, variants: {}, skipped: "failed", failure: String(err.message).split("\n")[0] };
        }
      }
    }));
  };
  await run(staticRoutes.map((r) => [r, r]));
  // Dynamic routes: from the adapter's hints, else from links seen so far. Repeat while new ones resolve.
  const pending = new Set(dynamicRoutes);
  for (let round = 0; round < 3 && pending.size > 0; round++) {
    const batch = [];
    for (const route of pending) {
      const regex = routeRegex(route);
      const match = hints[route] ?? [...links].find((l) => regex.test(l) && !staticRoutes.includes(l));
      if (match) { pending.delete(route); batch.push([route, match]); }
    }
    if (!batch.length) break;
    await run(batch);
  }
  for (const route of pending) results[route] ??= { route, url: null, variants: {}, skipped: "unresolved" };
  for (const route of routes) results[route] ??= { route, url: null, variants: {}, skipped: isDynamic(route) ? "unresolved" : "needs sign-in" };
  await browser.close();

  const list = Object.values(results).sort((a, b) => a.route.localeCompare(b.route));
  const states = list.reduce((n, r) => n + Object.values(r.variants).reduce((m, v) => m + (v.states?.length ?? 0), 0), 0);
  const manifest = {
    baseUrl,
    capturedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    crawled: crawling,
    loggedIn,
    loginError,
    viewports,
    routesTotal: routes.length,
    captured: list.filter((r) => Object.keys(r.variants).length > 0).length,
    reused: reused.length,
    twoVariants: list.filter((r) => Object.keys(r.variants).length > 1).map((r) => r.route),
    states,
    serverErrors: list.filter((r) => r.skipped === "server error").map((r) => r.route),
    pageErrors: list.filter((r) => r.errors?.length).map((r) => r.route),
    // Pages that were shot but look wrong (an error overlay, a sign-in form, blank, broken
    // images): where a review of the screenshots starts.
    suspects: list.flatMap((r) => Object.entries(r.variants).filter(([, v]) => v.suspects?.length).map(([variant, v]) => ({ route: r.route, variant, issues: v.suspects }))),
    skipped: list.filter((r) => r.skipped).map((r) => ({ route: r.route, why: r.skipped, finalPath: r.finalPath, failure: r.failure })),
    routes: list,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`captured ${manifest.captured}/${manifest.routesTotal} pages (${reused.length} copied forward), ${states} states in ${manifest.seconds}s`);
  return manifest;
}
