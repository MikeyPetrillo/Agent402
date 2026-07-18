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
    const e = new Error("browser pool is saturated — too many concurrent render requests, retry shortly");
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
        const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
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
        let bytesSeen = 0;
        let budgetBlown = false;
        await context.route("**/*", async (route) => {
          try {
            if (budgetBlown) return await route.abort("blockedbyclient");
            const u = new URL(route.request().url());
            if ((u.protocol === "http:" || u.protocol === "https:") && !(await hostIsPublic(u.hostname))) {
              return await route.abort("blockedbyclient");
            }
            await route.continue();
          } catch {
            await route.abort("blockedbyclient").catch(() => {});
          }
        });
        // Track per-page byte budget. Aborts the next route hop once the cap
        // trips so we don't unbound Chromium's RSS on a hostile origin.
        context.on("response", async (response) => {
          try {
            const lenHdr = response.headers()["content-length"];
            const len = lenHdr ? Number(lenHdr) : 0;
            if (len && len > PER_RESOURCE_MAX) { budgetBlown = true; return; }
            bytesSeen += len || 0;
            if (bytesSeen > PAGE_BYTE_BUDGET) budgetBlown = true;
          } catch { /* ignore */ }
        });
        const page = await context.newPage();
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
    const result = htmlToArticle(html, page.url());
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
