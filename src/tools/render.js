import { assertPublicUrl, hostIsPublic } from "./fetch-guard.js";
import { htmlToArticle } from "./extract.js";

const NAV_TIMEOUT_MS = 25000;
const MAX_CONCURRENT = 3;
// Admission control for the shared Chromium pool (security audit A402-08). The
// wait queue was unbounded: a burst of paid render/screenshot calls could grow
// it without limit (memory) and make callers wait indefinitely. Now at most
// MAX_QUEUE waiters, each with a QUEUE_DEADLINE_MS cap and abort-on-disconnect,
// plus an EXEC_DEADLINE_MS ceiling over the whole in-slot run.
const MAX_QUEUE = 24;
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
    e.statusCode = 503;
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null, signal, onAbort: null };
    waiter.timer = setTimeout(() => {
      dropFromQueue(waiter);
      const e = new Error("timed out waiting for a browser slot, retry shortly"); e.statusCode = 503;
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

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("playwright")
      .then(async ({ chromium }) => {
        // F04: when the worker starts a validating egress proxy (RENDER_EGRESS_
        // PROXY_URL), route ALL Chromium traffic through it so DNS resolution +
        // destination pinning happen in ONE place Chromium can't bypass. Unset
        // (in-process) => no proxy; the render.js route guard still applies.
        const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage"];
        const egressProxy = (process.env.RENDER_EGRESS_PROXY_URL || "").trim();
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

async function withPage(rawUrl, fn, { signal } = {}) {
  const url = await assertPublicUrl(rawUrl);
  // Bounded admission: throws 503 (full/timeout) or 499 (disconnected) instead
  // of joining an unbounded queue or waiting forever.
  await acquireSlot(signal);
  let deadlineTimer = null;
  let context = null;   // hoisted so the deadline path can force-close it (R-09)
  let timedOut = false;
  try {
    const run = (async () => {
      const browser = await getBrowser();
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });
      try {
        // The browser does its own DNS resolution, so the upfront assertPublicUrl
        // is not enough (rebinding, redirects, subresources). Re-validate every
        // request the page makes at request time with the same public-IP policy.
        let overBudget = false;
        await context.route("**/*", async (route) => {
          try {
            if (overBudget) return await route.abort("blockedbyclient");
            const u = new URL(route.request().url());
            if ((u.protocol === "http:" || u.protocol === "https:") && !(await hostIsPublic(u.hostname))) {
              return await route.abort("blockedbyclient");
            }
            await route.continue();
          } catch {
            await route.abort("blockedbyclient").catch(() => {});
          }
        });
        const page = await context.newPage();
        // F03: count ACTUAL transferred bytes via CDP, not Content-Length. A
        // chunked / streamed / no-Content-Length response reports zero to the
        // old header-based accounting and bypasses the cap; WebSocket/EventSource
        // frames aren't responses at all. On either cap we trip the budget —
        // aborting further route hops AND closing the context — so a hostile
        // origin can't grow Chromium's RSS unbounded past the deadline.
        const budget = makeByteBudget(PER_RESOURCE_MAX, PAGE_BYTE_BUDGET, () => {
          overBudget = true;
          context?.close().catch(() => {}); // aborts the in-flight navigation / fn
        });
        try {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          cdp.on("Network.dataReceived", (e) => budget.account(e.requestId, e.encodedDataLength || e.dataLength || 0));
          cdp.on("Network.webSocketFrameReceived", (e) => budget.account(`ws:${e.requestId}`, e.response?.payloadData?.length || 0));
          cdp.on("Network.webSocketFrameSent", (e) => budget.account(`ws:${e.requestId}`, e.response?.payloadData?.length || 0));
        } catch { /* CDP unavailable (non-Chromium engine) — route guard + exec deadline still bound the render */ }
        try {
          await page.goto(url.href, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        } catch {
          // networkidle never settles on some sites; fall back to whatever loaded
          if (page.url() === "about:blank") {
            await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          }
        }
        return await fn(page);
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

/**
 * Rasterize server-owned SVG markup to a PNG (logo, social card). No
 * navigation and no external content — the SSRF route guard is not needed.
 * `size` may be a number (square) or { width, height }.
 */
export async function rasterizeSvg(svg, size = 512) {
  const { width, height } = typeof size === "number" ? { width: size, height: size } : size;
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height } });
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
  withPage,
  MAX_CONCURRENT,
  MAX_QUEUE,
};
