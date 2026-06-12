import { assertPublicUrl, hostIsPublic } from "./fetch-guard.js";
import { htmlToArticle } from "./extract.js";

const NAV_TIMEOUT_MS = 25000;
const MAX_CONCURRENT = 3;

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
      await context.route("**/*", async (route) => {
        try {
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
