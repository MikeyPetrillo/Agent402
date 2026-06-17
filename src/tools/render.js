import { assertPublicUrl, hostIsPublic } from "./fetch-guard.js";
import { htmlToArticle } from "./extract.js";

const NAV_TIMEOUT_MS = 25000;
const MAX_CONCURRENT = 3;
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
const queue = [];

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

async function withPage(rawUrl, fn) {
  const url = await assertPublicUrl(rawUrl);
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => queue.push(resolve));
  }
  active++;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
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
    }
  } finally {
    // The slot is always released, even when newContext/newPage throws —
    // otherwise three browser crashes would queue every later call forever.
    active--;
    queue.shift()?.();
  }
}

/**
 * Render a page in headless Chromium (JavaScript executed) and extract the
 * readable content as markdown. Works on SPAs where plain fetch returns an
 * empty shell.
 */
export async function renderArticle(rawUrl) {
  return withPage(rawUrl, async (page) => {
    const html = await page.content();
    const result = htmlToArticle(html, page.url());
    result.rendered = true;
    return result;
  });
}

/**
 * Screenshot a page in headless Chromium. Returns a PNG buffer.
 */
export async function screenshotPage(rawUrl, { fullPage = false } = {}) {
  return withPage(rawUrl, async (page) => {
    return page.screenshot({ type: "png", fullPage });
  });
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
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await context.close().catch(() => {});
  }
}
