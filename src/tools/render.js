import { lookup as dnsLookup } from "node:dns/promises";
import { assertPublicUrl, hostIsPublic } from "./fetch-guard.js";
import { htmlToArticle } from "./extract.js";
import { partialFields } from "../partial-answer.js";
import { buildOpportunities } from "./page-speed-opportunities.js";

const NAV_TIMEOUT_MS = 25000;
const MAX_CONCURRENT = 3;
// Admission control for the shared Chromium pool (security audit A402-08). The
// wait queue was unbounded: a burst of paid render/screenshot calls could grow
// it without limit (memory) and make callers wait indefinitely. Now at most
// MAX_QUEUE waiters, each with a QUEUE_DEADLINE_MS cap and abort-on-disconnect,
// plus an EXEC_DEADLINE_MS ceiling over the whole in-slot run.
const MAX_QUEUE = 24;
// A saturated pool answers 503 with this Retry-After (seconds): about one
// typical in-slot run, so a retry lands when a slot has likely freed.
const POOL_RETRY_AFTER_S = 10;
let QUEUE_DEADLINE_MS = 20_000; // let: a test hook shortens it to exercise the deadline
let EXEC_DEADLINE_MS = 60_000; // > NAV_TIMEOUT_MS; a backstop over fn(page) too (let: test hook)
// After the exec deadline fires we force the context closed and wait for the
// timed-out run to unwind before releasing its slot (audit R-09). Bound that
// wait so a pathologically wedged run can't hold a slot forever.
let CLEANUP_DEADLINE_MS = 10_000;
// Cap total bytes the page is allowed to download (sum of all subresources).
// A page that tries to balloon Chromium with a multi-GB asset is treated like
// a malicious upstream and aborted. 50 MB covers heavy real sites; anything
// bigger is treated as a render failure.
const PAGE_BYTE_BUDGET = 50 * 1024 * 1024;
// Per-resource cap: any single subresource larger than this is aborted up
// front (Content-Length header sniff) so we never even start streaming a
// 10-GB zip into the renderer.
const PER_RESOURCE_MAX = 25 * 1024 * 1024;

// F03: ACTUAL-byte budget. Content-Length lies (chunked / streamed / headerless
// responses report zero), so we feed this the real transferred size per request
// from CDP Network.dataReceived (+ WebSocket frames) instead. Pure and testable:
// account(id, bytes) sums per-resource and per-page and calls onTrip() exactly
// once, the first time either cap is crossed.
export function makeByteBudget(perResourceMax, pageBudget, onTrip) {
  let total = 0, tripped = false;
  const perReq = new Map();
  return {
    account(id, n) {
      if (!n || n <= 0 || tripped) return;
      total += n;
      const r = (perReq.get(id) || 0) + n;
      perReq.set(id, r);
      if (r > perResourceMax || total > pageBudget) { tripped = true; try { onTrip(); } catch { /* */ } }
    },
    get tripped() { return tripped; },
    get total() { return total; },
  };
}

// The network guard every pool navigation uses. Held in one object so the
// browser test suites can point a run at a loopback fixture server
// (__test.setNetworkGuard); production never reassigns it.
const PUBLIC_GUARD = Object.freeze({ assertPublicUrl, hostIsPublic });
let guard = PUBLIC_GUARD;

let browserPromise = null;
let active = 0;
// Each queued entry is a waiter { resolve, reject, timer, signal, onAbort }.
const queue = [];

function detach(waiter) {
  if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
  if (waiter.signal && waiter.onAbort) { waiter.signal.removeEventListener("abort", waiter.onAbort); waiter.onAbort = null; }
}
function dropFromQueue(waiter) {
  const i = queue.indexOf(waiter);
  if (i >= 0) queue.splice(i, 1);
  detach(waiter);
}
// Take a concurrency slot. Resolves once a slot is held (active incremented);
// rejects with a 503 if the queue is full or the wait times out, or a 499 if
// the caller's AbortSignal fires (client disconnected). Never resolves without
// incrementing `active`, so releaseSlot() stays balanced.
function acquireSlot(signal) {
  if (signal?.aborted) {
    const e = new Error("render aborted before start"); e.statusCode = 499; return Promise.reject(e);
  }
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  if (queue.length >= MAX_QUEUE) {
    const e = new Error("browser pool is saturated - too many concurrent render requests, retry shortly");
    e.statusCode = 503; e.retryAfter = POOL_RETRY_AFTER_S;
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null, signal, onAbort: null };
    waiter.timer = setTimeout(() => {
      dropFromQueue(waiter);
      const e = new Error("timed out waiting for a browser slot, retry shortly"); e.statusCode = 503; e.retryAfter = POOL_RETRY_AFTER_S;
      reject(e);
    }, QUEUE_DEADLINE_MS);
    if (signal) {
      waiter.onAbort = () => {
        dropFromQueue(waiter);
        const e = new Error("render aborted (client disconnected)"); e.statusCode = 499;
        reject(e);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    queue.push(waiter);
  });
}
// Release a slot and hand it to the next waiter (keeping `active` balanced:
// we don't decrement when a waiter immediately takes the freed slot).
function releaseSlot() {
  const next = queue.shift();
  if (next) { detach(next); next.resolve(); }
  else active--;
}

// One validating egress proxy per process for the in-process browser, started
// with the first launch. Its resolver honors the network guard, so a test that
// points the guard at a loopback fixture gets the same answer from the proxy.
let inProcessProxy = null;
function startInProcessProxy() {
  if (!inProcessProxy) {
    inProcessProxy = import("../../worker/egress-proxy.js").then(({ startEgressProxy, resolvePinned }) => startEgressProxy({
      resolve: async (host) => {
        if (guard === PUBLIC_GUARD) return resolvePinned(host);
        if (!(await guard.hostIsPublic(host))) throw new Error(`blocked: ${host} is not a public host`);
        const { address, family } = await dnsLookup(host, { order: "ipv4first" });
        return { address, family };
      },
    })).then((proxy) => { proxy.server.unref(); return proxy; })
      .catch((e) => { inProcessProxy = null; throw e; });
  }
  return inProcessProxy;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("playwright")
      .then(async ({ chromium }) => {
        // F04: when the worker starts a validating egress proxy (RENDER_EGRESS_
        // PROXY_URL), route ALL Chromium traffic through it so DNS resolution +
        // destination pinning happen in ONE place Chromium can't bypass. Unset
        // (in-process) => no proxy; the render.js route guard still applies.
        // WebRTC may not send UDP outside the proxy: neither the route guard nor
        // the egress proxy sees STUN/TURN traffic.
        const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];
        // Without one (the in-process self-host path), start the same proxy here:
        // context.route does not see redirect hops or a popup's first request,
        // so the proxy is what checks every connection Chromium makes.
        let egressProxy = (process.env.RENDER_EGRESS_PROXY_URL || "").trim();
        if (!egressProxy) egressProxy = (await startInProcessProxy()).url;
        if (egressProxy) {
          launchArgs.push(`--proxy-server=${egressProxy}`);
          // Chromium implicitly bypasses the proxy for loopback + link-local
          // literals (incl. the 169.254.169.254 metadata IP). "<-loopback>"
          // removes that implicit bypass so those ALSO traverse the validating
          // proxy — making the proxy the single egress chokepoint rather than
          // relying on the app-layer route guard for literal-IP metadata reach.
          launchArgs.push('--proxy-bypass-list=<-loopback>');
        }
        const browser = await chromium.launch({ args: launchArgs });
        // Self-heal: if Chromium dies (OOM, crash), the next call relaunches
        // instead of serving errors until the process restarts.
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((e) => {
        browserPromise = null;
        const err = new Error(`Browser unavailable: ${e.message}`);
        err.statusCode = 503;
        throw err;
      });
  }
  return browserPromise;
}

// Run `body(context)` in one pool slot with a fresh browser context, under the
// exec deadline. Shared by every pool user (withPage for public URLs, and the
// sandboxed html-frames renderer), so admission, the deadline and the R-09
// force-close-before-release live in one place.
async function inSlot(contextOptions, body, { signal } = {}) {
  // Bounded admission: throws 503 (full/timeout) or 499 (disconnected) instead
  // of joining an unbounded queue or waiting forever.
  await acquireSlot(signal);
  let deadlineTimer = null;
  let context = null;   // hoisted so the deadline path can force-close it (R-09)
  let timedOut = false;
  try {
    const run = (async () => {
      const browser = await getBrowser();
      context = await browser.newContext(contextOptions);
      try {
        return await body(context);
      } finally {
        await context.close().catch(() => {});
        context = null;
      }
    })();
    // Hard ceiling over the whole in-slot run (nav timeout only bounds a single
    // goto; fn(page) — e.g. a screenshot of a pathological page — could still
    // hang).
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        const e = new Error("render exceeded the execution deadline"); e.statusCode = 504;
        reject(e);
      }, EXEC_DEADLINE_MS);
    });
    try {
      return await Promise.race([run, deadline]);
    } finally {
      // R-09: if the deadline won the race, `run` is STILL executing against a
      // live context. Releasing the slot now (outer finally) would admit a new
      // render while this one's context is still open — briefly exceeding
      // MAX_CONCURRENT live contexts (CPU/RAM exhaustion under a timeout storm).
      // So force the context closed and await the run's own teardown BEFORE the
      // slot is released. Force-closing makes the in-flight goto/fn reject, so
      // the run unwinds promptly; bounded by CLEANUP_DEADLINE_MS so a wedged run
      // can't hold the slot forever.
      if (timedOut) {
        try { if (context) await context.close(); } catch { /* already closing */ }
        await Promise.race([
          run.catch(() => {}),
          new Promise((r) => setTimeout(r, CLEANUP_DEADLINE_MS)),
        ]);
      }
    }
  } finally {
    // The slot is always released, even when newContext/newPage throws or the
    // deadline fires — otherwise crashes would starve every later call.
    if (deadlineTimer) clearTimeout(deadlineTimer);
    releaseSlot();
  }
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// WebSocket connections are not requests context.route sees, so its public-
// host check never runs for them: refuse every one at the context. Each route
// is closed without connecting to the server. A Playwright without
// routeWebSocket leaves the CDP byte budget and the exec deadline as the bound.
async function refuseWebSockets(context) {
  if (typeof context?.routeWebSocket !== "function") return;
  await context.routeWebSocket(() => true, (ws) => Promise.resolve(ws.close({ code: 1008, reason: "blocked" })).catch(() => {}));
}

// Load one public URL in the pool. `contextOptions` overrides the default
// desktop viewport/UA; `beforeGoto({ page, context, cdp })` runs after the
// guards are installed and before navigation (listeners that must see the
// whole load attach there). fn(page, { networkIdle }) runs after the load.
async function withPage(rawUrl, fn, { signal, contextOptions = null, beforeGoto = null } = {}) {
  const url = await guard.assertPublicUrl(rawUrl);
  return inSlot({
    viewport: { width: 1280, height: 800 },
    userAgent: DESKTOP_UA,
    ...(contextOptions || {}),
    // A service worker's own fetches bypass context.route, so the per-request
    // public-host check below would not see them. Never overridable.
    serviceWorkers: "block",
  }, async (context) => {
    await refuseWebSockets(context);
    // The browser does its own DNS resolution, so the upfront assertPublicUrl
    // is not enough (rebinding, redirects, subresources). Re-validate every
    // request the page makes at request time with the same public-IP policy.
    let overBudget = false;
    await context.route("**/*", async (route) => {
      try {
        if (overBudget) return await route.abort("blockedbyclient");
        const u = new URL(route.request().url());
        if ((u.protocol === "http:" || u.protocol === "https:") && !(await guard.hostIsPublic(u.hostname))) {
          return await route.abort("blockedbyclient");
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    const page = await context.newPage();
    // A window the page opens is closed as it appears: its first request is
    // not one context.route sees. Only the page opened here is kept.
    if (typeof context.on === "function") context.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });
    // F03: count ACTUAL transferred bytes via CDP, not Content-Length. A
    // chunked / streamed / no-Content-Length response reports zero to the
    // old header-based accounting and bypasses the cap; WebSocket/EventSource
    // frames aren't responses at all. On either cap we trip the budget —
    // aborting further route hops AND closing the context — so a hostile
    // origin can't grow Chromium's RSS unbounded past the deadline.
    const budget = makeByteBudget(PER_RESOURCE_MAX, PAGE_BYTE_BUDGET, () => {
      overBudget = true;
      context.close().catch(() => {}); // aborts the in-flight navigation / fn
    });
    let cdp = null;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      cdp.on("Network.dataReceived", (e) => budget.account(e.requestId, e.encodedDataLength || e.dataLength || 0));
      cdp.on("Network.webSocketFrameReceived", (e) => budget.account(`ws:${e.requestId}`, e.response?.payloadData?.length || 0));
      cdp.on("Network.webSocketFrameSent", (e) => budget.account(`ws:${e.requestId}`, e.response?.payloadData?.length || 0));
    } catch { cdp = null; /* CDP unavailable (non-Chromium engine) — route guard + exec deadline still bound the render */ }
    if (beforeGoto) await beforeGoto({ page, context, cdp });
    let networkIdle = true;
    try {
      await page.goto(url.href, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    } catch {
      networkIdle = false;
      // networkidle never settles on some sites; fall back to whatever loaded
      if (page.url() === "about:blank") {
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      }
    }
    return await fn(page, { networkIdle });
  }, { signal });
}

/**
 * Render a page in headless Chromium (JavaScript executed) and extract the
 * readable content as markdown. Works on SPAs where plain fetch returns an
 * empty shell.
 */
export async function renderArticle(rawUrl, { signal } = {}) {
  return withPage(rawUrl, async (page) => {
    const html = await page.content();
    const result = await htmlToArticle(html, page.url());
    result.rendered = true;
    return result;
  }, { signal });
}

/**
 * Screenshot a page in headless Chromium. Returns a PNG buffer.
 */
export async function screenshotPage(rawUrl, { fullPage = false, signal } = {}) {
  return withPage(rawUrl, async (page) => {
    return page.screenshot({ type: "png", fullPage });
  }, { signal });
}

// ---- page-speed: one lab measurement of one public URL ---------------------

// Bounds on what one measurement records and returns.
export const PAGE_SPEED_LIMITS = Object.freeze({
  maxResourcesTracked: 1000, // requests whose bytes are attributed per URL
  maxRenderBlocking: 20,
  maxConsoleErrors: 20,
  heaviest: 5,
  maxUrlChars: 300,
  maxTextChars: 300,
  settleMs: 1000,            // after the load, so late LCP/CLS entries land
  maxImages: 200,            // <img> elements read for the opportunities
  maxFontFaces: 50,
  maxStyleRules: 3000,       // CSS rules walked for image sizing and @font-face
  maxShifts: 200,
  maxLongFrames: 200,
});

export const PAGE_SPEED_DEVICES = Object.freeze({
  desktop: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: DESKTOP_UA },
  mobile: {
    viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  },
});

const clip = (s, n) => { const v = String(s ?? ""); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const ms = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);

// Runs in the page before any of its own script. Standard PerformanceObserver
// entry types only; CLS is the largest session window (1 s gap, 5 s cap).
// Also keeps what the opportunities need: the LCP entry's node and URL, each
// layout shift's moved nodes (as selectors, taken as they shift), and long
// animation frames with their script attribution.
function pageSpeedObserver() {
  const s = { lcp: null, lcpElement: null, lcpNode: null, lcpUrl: null, lcpSize: null, fcp: null, cls: 0, win: 0, winStart: 0, winLast: 0, longTasks: [], shifts: [], longFrames: [] };
  const sel = (el) => {
    try {
      if (!el || el.nodeType !== 1) return null;
      const parts = [];
      let n = el;
      for (let depth = 0; n && n.nodeType === 1 && depth < 4; depth++) {
        const tag = n.tagName.toLowerCase();
        if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift(`${tag}#${n.id}`); break; }
        let part = tag;
        const cls = Array.from(n.classList || []).find((c) => /^[A-Za-z_][\w-]*$/.test(c));
        if (cls) part += `.${cls}`;
        const parent = n.parentElement;
        if (parent) {
          const sib = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
          if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(n) + 1})`;
        }
        parts.unshift(part);
        if (tag === "body" || tag === "html") break;
        n = parent;
      }
      return parts.join(" > ").slice(0, 160);
    } catch { return null; }
  };
  s.sel = sel;
  Object.defineProperty(window, "__a402ps", { value: s, enumerable: false });
  try { performance.setResourceTimingBufferSize(1000); } catch { /* older engines */ }
  const obs = (type, cb) => {
    try { new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({ type, buffered: true }); } catch { /* unsupported entry type */ }
  };
  obs("paint", (e) => { if (e.name === "first-contentful-paint") s.fcp = e.startTime; });
  obs("largest-contentful-paint", (e) => {
    s.lcp = e.renderTime || e.loadTime || e.startTime;
    s.lcpElement = e.element ? e.element.tagName.toLowerCase() : null;
    s.lcpNode = e.element || null; s.lcpUrl = e.url || null; s.lcpSize = e.size || null;
  });
  obs("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    if (s.win && (e.startTime - s.winLast > 1000 || e.startTime - s.winStart > 5000)) s.win = 0;
    if (!s.win) s.winStart = e.startTime;
    s.win += e.value; s.winLast = e.startTime;
    if (s.win > s.cls) s.cls = s.win;
    if (s.shifts.length < 200) s.shifts.push({ startMs: e.startTime, value: e.value, elements: Array.from(e.sources || []).slice(0, 3).map((src) => sel(src.node)) });
  });
  obs("longtask", (e) => { if (s.longTasks.length < 2000) s.longTasks.push([e.startTime, e.duration]); });
  obs("long-animation-frame", (e) => {
    if (e.duration <= 50 || s.longFrames.length >= 200) return;
    const scripts = Array.from(e.scripts || []).map((x) => ({ sourceURL: x.sourceURL || null, invoker: x.invoker || null, invokerType: x.invokerType || null, durationMs: x.duration }))
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 3);
    s.longFrames.push({ startMs: e.startTime, durationMs: e.duration, blockingMs: e.blockingDuration || 0, scripts });
  });
}

// Runs in the page after the load settled: what the DOM says about the head,
// the images, the fonts and the LCP element. Pure reads, nothing mutated.
function pageSpeedReadDom(L) {
  const s = window.__a402ps || {};
  const sel = typeof s.sel === "function" ? s.sel : () => null;
  const nav = performance.getEntriesByType("navigation")[0] || null;
  const res = performance.getEntriesByType("resource");
  const blocking = res.filter((r) => r.renderBlockingStatus === "blocking")
    .map((r) => ({ url: r.name, type: r.initiatorType, durationMs: r.duration }));
  const timing = {};
  for (const r of res.slice(0, 1000)) if (!(r.name in timing)) timing[r.name] = { durationMs: r.duration, initiatorType: r.initiatorType, renderBlocking: r.renderBlockingStatus === "blocking" };
  const fcp = s.fcp;
  let tbt = 0, longTaskCount = 0;
  for (const [start, dur] of s.longTasks || []) {
    longTaskCount++;
    if (fcp == null || start + dur > fcp) tbt += Math.max(0, dur - 50);
  }
  const head = document.head || document.createElement("head");
  const headScripts = Array.from(head.querySelectorAll("script[src]"))
    .filter((el) => !el.async && !el.defer && !/^module$/i.test(el.getAttribute("type") || "") && /^https?:/i.test(el.src))
    .map((el) => ({ url: el.src }));
  const headStyles = Array.from(head.querySelectorAll("link[rel~=stylesheet][href]"))
    .filter((el) => { const m = (el.getAttribute("media") || "").trim(); return !el.disabled && /^https?:/i.test(el.href) && (!m || m === "all" || (window.matchMedia && matchMedia(m).matches)); })
    .map((el) => ({ url: el.href, media: (el.getAttribute("media") || "").trim() || null }));
  // Author CSS that sizes an element: width and height on a rule that matches it.
  const sizingRules = [];
  const fontFaces = [];
  let rulesSeen = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // a cross-origin sheet without CORS cannot be read
    if (!rules) continue;
    const walk = (list) => {
      for (const rule of Array.from(list)) {
        if (rulesSeen++ >= L.maxStyleRules) return;
        if (rule instanceof CSSFontFaceRule && fontFaces.length < L.maxFontFaces) {
          const src = rule.style.getPropertyValue("src") || "";
          const m = /url\((["']?)([^"')]+)\1\)/.exec(src);
          let url = m ? m[2] : null;
          try { if (url) url = new URL(url, sheet.href || location.href).href; } catch { /* keep as written */ }
          fontFaces.push({ family: (rule.style.getPropertyValue("font-family") || "").replace(/^["']|["']$/g, "").trim(), display: (rule.style.getPropertyValue("font-display") || "").trim() || null, url });
        } else if (rule instanceof CSSStyleRule && rule.style.width && rule.style.height && rule.selectorText) {
          sizingRules.push(rule.selectorText);
        } else if (rule.cssRules) { // @media, @supports, @layer, @container
          walk(rule.cssRules);
        }
      }
    };
    walk(rules);
  }
  const sizedByCss = (el) => {
    if (el.style && el.style.width && el.style.height) return true;
    for (const sl of sizingRules) { try { if (el.matches(sl)) return true; } catch { /* unsupported selector */ } }
    return false;
  };
  const images = Array.from(document.images).slice(0, L.maxImages).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      selector: sel(el), url: el.currentSrc || el.src || null,
      sized: (el.hasAttribute("width") && el.hasAttribute("height")) || (cs.aspectRatio && cs.aspectRatio !== "auto") || sizedByCss(el),
      naturalWidth: el.naturalWidth || 0, naturalHeight: el.naturalHeight || 0,
      width: r.width, height: r.height, lazy: el.loading === "lazy",
    };
  });
  let lcp = null;
  if (s.lcp) {
    const el = s.lcpNode;
    let lcpInfo = { tag: s.lcpElement || null, selector: null, url: s.lcpUrl || null, sizePx: s.lcpSize || null, width: null, height: null, lazy: null, text: !s.lcpUrl, fontFamily: null, webFont: false };
    try {
      if (el && el.nodeType === 1) {
        const r = el.getBoundingClientRect();
        lcpInfo.selector = sel(el); lcpInfo.width = r.width; lcpInfo.height = r.height;
        lcpInfo.lazy = el.tagName === "IMG" ? el.loading === "lazy" : null;
        if (!s.lcpUrl) {
          const fam = (getComputedStyle(el).fontFamily || "").split(",")[0].replace(/^\s*["']?|["']?\s*$/g, "").trim();
          lcpInfo.fontFamily = fam || null;
          lcpInfo.webFont = !!fam && Array.from(document.fonts || []).some((f) => f.status === "loaded" && String(f.family).replace(/^["']|["']$/g, "") === fam);
        }
      }
    } catch { /* detached node */ }
    lcp = lcpInfo;
  }
  return {
    nav: nav ? { ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd } : null,
    lcp: s.lcp, lcpElement: s.lcpElement, fcp, cls: s.cls || 0, tbt, longTaskCount,
    renderBlockingSupported: res.length === 0 || "renderBlockingStatus" in res[0],
    blocking,
    facts: {
      timing, headScripts, headStyles, images, fontFaces, lcp: lcp ? { ...lcp, ms: s.lcp } : null,
      longFrames: (s.longFrames || []).slice(0, L.maxLongFrames),
      longTasks: (s.longTasks || []).map(([start, dur]) => ({ startMs: start, durationMs: dur })),
      shifts: (s.shifts || []).slice(0, L.maxShifts),
      dpr: window.devicePixelRatio || 1,
    },
  };
}

/**
 * Load one public URL once and report what that load measured: navigation
 * timings, Web Vitals read from the page's own PerformanceObserver entries,
 * transfer bytes and request count from the browser's network events, the
 * heaviest resources, render-blocking resources and console errors.
 * A single lab measurement, not field data.
 */
export async function measurePageSpeed(rawUrl, { device = "mobile", signal } = {}) {
  const profile = PAGE_SPEED_DEVICES[device];
  if (!profile) throw Object.assign(new Error('"device" must be "mobile" or "desktop"'), { statusCode: 400 });
  const L = PAGE_SPEED_LIMITS;
  const net = new Map(); // requestId -> { url, type, bytes, status }
  let requestCount = 0, failedRequests = 0, totalBytes = 0, untracked = 0;
  const consoleErrors = [];
  let consoleErrorCount = 0;
  let mainStatus = null;
  const pushConsole = (text, source, at = null) => {
    consoleErrorCount++;
    if (consoleErrors.length < L.maxConsoleErrors) consoleErrors.push({ source, text: clip(text, L.maxTextChars), url: at ? clip(at, L.maxUrlChars) : null });
  };
  try {
    return await withPage(rawUrl, async (page, { networkIdle }) => {
      await page.waitForTimeout(L.settleMs);
      const m = await page.evaluate(pageSpeedReadDom, L);
      const recorded = [...net.values()].filter((r) => r.bytes > 0);
      const heaviest = recorded.sort((a, b) => b.bytes - a.bytes).slice(0, L.heaviest)
        .map((r) => ({ url: clip(r.url, L.maxUrlChars), type: r.type, bytes: r.bytes }));
      const blockingItems = m.blocking.slice(0, L.maxRenderBlocking)
        .map((r) => ({ url: clip(r.url, L.maxUrlChars), type: r.type, durationMs: ms(r.durationMs) ?? 0 }));
      return {
        url: rawUrl,
        finalUrl: clip(page.url(), L.maxUrlChars),
        status: mainStatus,
        device,
        viewport: profile.viewport,
        networkIdle,
        timings: {
          ttfbMs: ms(m.nav?.ttfb),
          domContentLoadedMs: ms(m.nav?.dcl),
          loadMs: ms(m.nav?.load),
        },
        webVitals: {
          lcpMs: ms(m.lcp),
          lcpElement: m.lcpElement,
          fcpMs: ms(m.fcp),
          cls: Math.round((m.cls || 0) * 10000) / 10000,
          totalBlockingTimeMs: Math.round(m.tbt),
          longTaskCount: m.longTaskCount,
        },
        transfer: { totalBytes, requestCount, failedRequests },
        heaviestResources: heaviest,
        heaviestResourcesPartial: partialFields(recorded.length + untracked, heaviest.length),
        renderBlocking: m.renderBlockingSupported ? blockingItems : null,
        renderBlockingPartial: m.renderBlockingSupported ? partialFields(m.blocking.length, blockingItems.length) : null,
        consoleErrors,
        consoleErrorsPartial: partialFields(consoleErrorCount, consoleErrors.length),
        measurement: PAGE_SPEED_MEASUREMENT,
        untrustedContent: true,
        ...pageSpeedOpportunitiesOf(m.facts, { docUrl: page.url(), net, consoleErrors }, L),
      };
    }, {
      signal,
      contextOptions: { viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, isMobile: profile.isMobile, hasTouch: profile.hasTouch, userAgent: profile.userAgent },
      beforeGoto: async ({ page, cdp }) => {
        await page.addInitScript(pageSpeedObserver);
        page.on("console", (msg) => { if (msg.type() === "error") pushConsole(msg.text(), "console", msg.location()?.url || null); });
        page.on("pageerror", (err) => pushConsole(err?.message || String(err), "uncaught"));
        // Last main-frame navigation response wins: after redirects that is the document served.
        page.on("response", (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) mainStatus = r.status(); } catch { /* frame detached */ } });
        if (!cdp) return;
        cdp.on("Network.requestWillBeSent", (e) => {
          if (!/^https?:/i.test(e.request?.url || "")) return;
          if (e.redirectResponse) return; // same requestId continues after a redirect
          requestCount++;
          if (net.size < L.maxResourcesTracked) net.set(e.requestId, { url: e.request.url, type: String(e.type || "other").toLowerCase(), bytes: 0 });
          else untracked++;
        });
        cdp.on("Network.responseReceived", (e) => {
          const r = net.get(e.requestId);
          if (!r || !e.response) return;
          r.status = e.response.status;
          r.mimeType = e.response.mimeType || null;
          r.fromCache = !!(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache);
          const h = {};
          for (const [k, v] of Object.entries(e.response.headers || {})) h[k.toLowerCase()] = String(v);
          r.headers = h;
        });
        cdp.on("Network.loadingFinished", (e) => {
          const n = Number(e.encodedDataLength) || 0;
          totalBytes += n;
          const r = net.get(e.requestId);
          if (r) r.bytes = n;
        });
        cdp.on("Network.loadingFailed", () => { failedRequests++; });
      },
    });
  } catch (err) {
    if (err?.statusCode) throw err;
    throw Object.assign(new Error(`page could not be loaded: ${clip(err?.message || err, 200)}`), { statusCode: 502, attribution: "upstream" });
  }
}

// Opportunities from the same load: the page facts plus the network records,
// URLs and text clipped like every other field of the answer.
function pageSpeedOpportunitiesOf(facts, { docUrl, net, consoleErrors }, L) {
  const resources = [...net.values()].map((r) => ({ url: r.url, type: r.type, bytes: r.bytes || 0, status: r.status ?? null, headers: r.headers || {}, mimeType: r.mimeType || null, fromCache: !!r.fromCache }));
  const { opportunities, opportunitiesPartial } = buildOpportunities({ ...(facts || {}), docUrl, resources, consoleErrors });
  for (const o of opportunities) {
    if (typeof o.url === "string") o.url = clip(o.url, L.maxUrlChars);
    if (typeof o.element === "string") o.element = clip(o.element, L.maxTextChars);
    o.detail = clip(o.detail, 2 * L.maxTextChars);
  }
  return { opportunities, opportunitiesPartial };
}

export const PAGE_SPEED_MEASUREMENT = Object.freeze({
  kind: "lab-single-run",
  runs: 1,
  source: "one load in a headless Chromium from one server location, on shared infrastructure, with no network or CPU throttling",
  fieldData: false,
  lighthouseScore: false,
  note: "A single measurement from one server location under shared load. It is a single lab measurement, not field data from real users; repeat the call and compare runs before drawing conclusions.",
});

// ---- html-frames: render a self-contained document at given times ---------

export const HTML_FRAMES_LIMITS = Object.freeze({
  maxHtmlBytes: 512 * 1024,
  minFrames: 1,
  maxFrames: 12,
  maxWidth: 1280,
  maxHeight: 720,
  minSide: 16,
  maxTimeSeconds: 3600,
  maxOutputBytes: 8 * 1024 * 1024, // frames + contact sheet, raw PNG bytes
  loadTimeoutMs: 10_000,
  frameTimeoutMs: 5_000,
  // Load plus every renderAt together: a document that fails late answers 400
  // (uncharged), so this bounds how long one unpaid run holds a browser slot.
  totalTimeoutMs: 25_000,
  sheetThumbWidth: 320,
  sheetMaxColumns: 4,
});

// The document may only run its own inline script and style, and use data:
// and blob: URLs it builds itself. Everything that reaches the network
// (fetch, XHR, WebSocket, EventSource, images, fonts, frames, workers, forms)
// is refused by the policy, and the request router aborts anything that gets
// past it (navigations, popups) except the one fulfilled document.
export const HTML_FRAMES_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// A reserved TLD: never resolvable, and every request is answered by the
// router before it could reach a resolver.
const FRAMES_DOC_URL = "https://document.frames.invalid/";

// Runs before the document's script: removes the peer-to-peer and beacon
// paths a content policy does not cover, and counts policy refusals.
function framesSandboxInit() {
  const s = { violations: 0 };
  Object.defineProperty(window, "__a402fr", { value: s, enumerable: false });
  document.addEventListener("securitypolicyviolation", () => { s.violations++; });
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch { /* already gone */ }
  }
  try { Object.defineProperty(Navigator.prototype, "sendBeacon", { value: () => false, configurable: false, writable: false }); } catch { /* unsupported */ }
}

function framesError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Lay out the contact sheet: thumbnails in a grid, each with its time label.
export function contactSheetLayout(count, width, height, L = HTML_FRAMES_LIMITS) {
  const columns = Math.min(L.sheetMaxColumns, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);
  const thumbW = Math.min(width, L.sheetThumbWidth);
  const thumbH = Math.max(1, Math.round(height * (thumbW / width)));
  const gap = 8, label = 18;
  return {
    columns, rows, thumbW, thumbH, gap, label,
    width: columns * thumbW + (columns + 1) * gap,
    height: rows * (thumbH + label) + (rows + 1) * gap,
  };
}

/**
 * Render a buyer-supplied, self-contained HTML document in the pool with all
 * network access refused, call window.renderAt(t) for each time and capture
 * a PNG still after each, plus one contact-sheet PNG of all stills.
 * Inputs are validated by the caller (html-frames kit); this bounds the run.
 */
export async function renderHtmlFrames(html, times, { width, height, signal } = {}) {
  const L = HTML_FRAMES_LIMITS;
  return inSlot({
    viewport: { width, height },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    acceptDownloads: false,
    userAgent: DESKTOP_UA,
  }, async (context) => {
    await refuseWebSockets(context);
    let blockedRequests = 0;
    let served = false;
    await context.route("**/*", async (route) => {
      const req = route.request();
      if (!served && req.url() === FRAMES_DOC_URL && req.isNavigationRequest()) {
        served = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "content-security-policy": HTML_FRAMES_CSP, "x-dns-prefetch-control": "off", "referrer-policy": "no-referrer" },
          body: html,
        }).catch(() => {});
      }
      blockedRequests++;
      // A navigation away (location, meta refresh, a link, a popup) is
      // answered 204 No Content, which leaves the page where it is: an
      // aborted navigation would replace the document with an error page.
      if (req.isNavigationRequest()) return route.fulfill({ status: 204, body: "" }).catch(() => {});
      return route.abort("blockedbyclient").catch(() => {});
    });
    // On the context, so a window the document opens gets the sandbox too; and
    // any such window is closed as it opens. Only a page we open ourselves is
    // let through, one per `allowPages` token; the first opens before any
    // buyer script exists, the sheet after the document's page is closed.
    await context.addInitScript(framesSandboxInit);
    let allowPages = 1;
    context.on("page", (p) => { if (allowPages > 0) { allowPages--; return; } p.close().catch(() => {}); });
    const page = await context.newPage();
    const runStarted = Date.now();
    const leftMs = () => L.totalTimeoutMs - (Date.now() - runStarted);
    const pageErrors = [];
    page.on("pageerror", (err) => { if (pageErrors.length < 5) pageErrors.push(clip(err?.message || String(err), 300)); });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(FRAMES_DOC_URL, { waitUntil: "load", timeout: L.loadTimeoutMs });
    } catch (e) {
      throw framesError(`the document did not finish loading within ${L.loadTimeoutMs / 1000} s: ${clip(e?.message || e, 160)}`);
    }
    if (pageErrors.length) throw framesError(`the document's script threw while loading: ${pageErrors[0]}`);
    const hasRenderAt = await page.evaluate(() => typeof window.renderAt === "function");
    if (!hasRenderAt) throw framesError("the document does not define window.renderAt(t) as a function");
    await page.evaluate(() => document.fonts?.ready).catch(() => {});

    const frames = [];
    let totalBytes = 0;
    for (const t of times) {
      const frameMs = Math.min(L.frameTimeoutMs, leftMs());
      if (frameMs <= 0) throw framesError(`the document used its ${L.totalTimeoutMs / 1000} s budget for loading and renderAt before renderAt(${t})`);
      let timer = null;
      const outcome = await Promise.race([
        page.evaluate(async (time) => {
          try {
            await window.renderAt(time);
          } catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
          }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { ok: true };
        }, t).catch((e) => ({ ok: false, message: clip(e?.message || e, 300) })),
        new Promise((r) => { timer = setTimeout(() => r({ ok: false, timeout: true }), frameMs); }),
      ]);
      clearTimeout(timer);
      if (outcome.timeout) throw framesError(frameMs < L.frameTimeoutMs
        ? `renderAt(${t}) did not finish within the document's ${L.totalTimeoutMs / 1000} s budget`
        : `renderAt(${t}) did not finish within ${L.frameTimeoutMs / 1000} s`);
      if (!outcome.ok) throw framesError(`renderAt(${t}) threw: ${clip(outcome.message, 300)}`);
      if (pageErrors.length) throw framesError(`the document's script threw during renderAt(${t}): ${pageErrors[0]}`);
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height }, caret: "hide" });
      totalBytes += png.length;
      if (totalBytes > L.maxOutputBytes) {
        throw framesError(`the stills exceed the ${L.maxOutputBytes / (1024 * 1024)} MB output cap; request fewer times or a smaller width and height`, 413);
      }
      frames.push({ t, png });
    }

    const lay = contactSheetLayout(frames.length, width, height, L);
    const cells = frames.map((f, i) => {
      const col = i % lay.columns, row = Math.floor(i / lay.columns);
      const x = lay.gap + col * (lay.thumbW + lay.gap);
      const y = lay.gap + row * (lay.thumbH + lay.label + lay.gap);
      return `<figure style="left:${x}px;top:${y}px;width:${lay.thumbW}px"><img src="data:image/png;base64,${f.png.toString("base64")}" width="${lay.thumbW}" height="${lay.thumbH}"><figcaption>t = ${f.t} s</figcaption></figure>`;
    }).join("");
    const violations = await page.evaluate(() => window.__a402fr?.violations || 0).catch(() => 0);
    await page.close().catch(() => {});
    allowPages++;
    const sheetPage = await context.newPage();
    await sheetPage.setViewportSize({ width: lay.width, height: lay.height });
    await sheetPage.setContent(`<!doctype html><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${lay.width}px;height:${lay.height}px;background:#1f2328;overflow:hidden}figure{position:absolute}img{display:block;background:#ffffff}figcaption{height:${lay.label}px;line-height:${lay.label}px;font:12px/18px monospace;color:#e6edf3}</style>${cells}`, { waitUntil: "load" });
    await sheetPage.evaluate(() => Promise.all([...document.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })))));
    const sheet = await sheetPage.screenshot({ type: "png", clip: { x: 0, y: 0, width: lay.width, height: lay.height } });
    totalBytes += sheet.length;
    if (totalBytes > L.maxOutputBytes) {
      throw framesError(`the stills and contact sheet exceed the ${L.maxOutputBytes / (1024 * 1024)} MB output cap; request fewer times or a smaller width and height`, 413);
    }
    return {
      width, height,
      frameCount: frames.length,
      frames: frames.map((f) => ({ t: f.t, bytes: f.png.length, pngBase64: f.png.toString("base64") })),
      contactSheet: { columns: lay.columns, rows: lay.rows, width: lay.width, height: lay.height, bytes: sheet.length, pngBase64: sheet.toString("base64") },
      totalBytes,
      network: { blockedRequests: blockedRequests + violations, policy: "all network access refused; only inline script and style, and data: or blob: URLs the document builds itself" },
    };
  }, { signal });
}

/**
 * Rasterize server-owned SVG markup to a PNG (logo, social card). No
 * navigation and no external content — the SSRF route guard is not needed.
 * `size` may be a number (square) or { width, height }.
 */
export async function rasterizeSvg(svg, size = 512) {
  const { width, height } = typeof size === "number" ? { width: size, height: size } : size;
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>*{margin:0;padding:0}svg{display:block}</style>${svg}`);
    // SVGs may embed @font-face data URIs; screenshotting before the face is
    // parsed captures the fallback font, and the result gets cached upstream.
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await context.close().catch(() => {});
  }
}

// Test hooks — exercise the browser-pool admission control (bounded queue,
// deadline, disconnect abort) without launching Chromium. Not used in prod.
export const __test = {
  acquireSlot,
  releaseSlot,
  state: () => ({ active, queued: queue.length }),
  reset: () => { active = 0; queue.length = 0; browserPromise = null; },
  setQueueDeadline: (ms) => { QUEUE_DEADLINE_MS = ms; },
  setExecDeadline: (ms) => { EXEC_DEADLINE_MS = ms; },
  setCleanupDeadline: (ms) => { CLEANUP_DEADLINE_MS = ms; },
  // Inject a fake browser so withPage's context lifecycle (R-09 cancellation)
  // can be exercised without launching Chromium.
  injectBrowser: (fake) => { browserPromise = Promise.resolve(fake); },
  // Replace the network guard for one test (null restores the public guard).
  setNetworkGuard: (g) => { guard = g ? Object.freeze({ ...PUBLIC_GUARD, ...g }) : PUBLIC_GUARD; },
  withPage,
  MAX_CONCURRENT,
  MAX_QUEUE,
};
