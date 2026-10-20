// Browser measurement kit: two tools on the shared headless Chromium pool in
// render.js (same admission control, exec deadline and slot accounting as
// render and screenshot). Deterministic code: no model, no outside API, no key.
//
//   page-speed   one lab load of a public URL through the same SSRF guard
//                render uses (assertPublicUrl up front, hostIsPublic on every
//                request the page makes), reporting what that load measured.
//   html-frames  the render contract: a buyer-supplied self-contained HTML
//                document that defines window.renderAt(t), rendered with every
//                network request refused, frozen at the requested times and
//                returned as PNG stills plus a contact sheet. An optional
//                `compare` (baseline stills, or a second document fetched
//                through the same public-URL guard and rendered the same way)
//                adds a frame check: per-frame similarity and changed regions
//                (src/tools/frame-diff.js).
//
// Both are wallet-only: neither is on the free-tier allowlist (src/free-tier.js).
// This module imports only render.js, the fetch guard and pure helpers, so the
// secretless worker (worker/server.js) runs these handlers unchanged.
import {
  measurePageSpeed, renderHtmlFrames,
  PAGE_SPEED_DEVICES, PAGE_SPEED_MEASUREMENT, HTML_FRAMES_LIMITS,
} from "./render.js";
import { safeFetch } from "./fetch-guard.js";
import { assertPngWithin, compareStills, decodePng, FRAME_DIFF } from "./frame-diff.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// The buyer's disconnect aborts a queued run (render's rule, audit A402-08):
// `ctx` is the Express request on the in-process path, absent on the worker.
function abortSignalOf(ctx) {
  const res = ctx?.res;
  if (!res || typeof res.on !== "function") return undefined;
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}

/** Validate page-speed input. Returns { url, device }. Pure. */
export function pageSpeedInput(input = {}) {
  const url = String(input?.url ?? "").trim();
  if (!url) throw bad('Missing "url": a public http(s) URL to measure');
  if (!/^https?:\/\//i.test(url)) throw bad('"url" must be an http(s) URL');
  const device = String(input?.device ?? "mobile").trim().toLowerCase();
  if (!Object.hasOwn(PAGE_SPEED_DEVICES, device)) throw bad('"device" must be "mobile" or "desktop"');
  return { url, device };
}

/**
 * Validate the optional `compare` of html-frames. Returns null (no compare),
 * { baselineUrl } or { baseline: [{ t, png: Buffer }] }. Pure: every baseline
 * still is checked by its header (PNG, within the viewport caps) and by total
 * bytes (the output cap) before any browser slot is held.
 */
export function htmlFramesCompareInput(raw, times, L = HTML_FRAMES_LIMITS) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad('"compare" must be an object holding "baseline" (an array of {t, png}) or "baselineUrl"');
  const hasList = raw.baseline !== undefined && raw.baseline !== null;
  const hasUrl = raw.baselineUrl !== undefined && raw.baselineUrl !== null && String(raw.baselineUrl).trim() !== "";
  if (hasList === hasUrl) throw bad('"compare" takes exactly one of "baseline" (an array of {t, png}) or "baselineUrl"');
  if (hasUrl) {
    const url = String(raw.baselineUrl).trim();
    if (!/^https?:\/\//i.test(url)) throw bad('"compare.baselineUrl" must be a public http(s) URL');
    return { baselineUrl: url };
  }
  const list = raw.baseline;
  if (!Array.isArray(list) || list.length < 1) throw bad(`"compare.baseline" must be an array of 1 to ${L.maxFrames} entries {t, png}`);
  if (list.length > L.maxFrames) throw bad(`"compare.baseline" has ${list.length} entries; the cap is ${L.maxFrames}`);
  const wanted = new Set(times);
  const seen = new Set();
  let total = 0;
  const baseline = list.map((e, i) => {
    const t = typeof e?.t === "string" && e.t.trim() !== "" ? Number(e.t) : e?.t;
    if (typeof t !== "number" || !Number.isFinite(t)) throw bad(`"compare.baseline[${i}].t" must be a number of seconds`);
    if (!wanted.has(t)) throw bad(`"compare.baseline[${i}].t" is ${t}, which is not one of the requested times`);
    if (seen.has(t)) throw bad(`"compare.baseline" lists t = ${t} twice`);
    seen.add(t);
    const s = typeof e?.png === "string" ? e.png.replace(/^data:image\/png;base64,/i, "").trim() : "";
    if (!s) throw bad(`"compare.baseline[${i}].png" must be a base64 PNG`);
    const png = Buffer.from(s, "base64");
    total += png.length;
    if (total > L.maxOutputBytes) throw bad(`"compare.baseline" holds more than ${L.maxOutputBytes / (1024 * 1024)} MB of PNG; the cap is the tool's output cap`, 413);
    assertPngWithin(png, { maxWidth: L.maxWidth, maxHeight: L.maxHeight, label: `"compare.baseline[${i}].png"` });
    return { t, png };
  });
  return { baseline };
}

/** True when a body asks for the compare that renders a second document. */
export function htmlFramesRendersBaseline(body) {
  const u = body?.compare?.baselineUrl;
  return typeof u === "string" && u.trim() !== "";
}

/** Validate html-frames input. Returns { html, times, width, height, compare }. Pure. */
export function htmlFramesInput(input = {}, L = HTML_FRAMES_LIMITS) {
  const html = input?.html;
  if (typeof html !== "string" || !html.trim()) throw bad('Missing "html": a self-contained HTML document that defines window.renderAt(t)');
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > L.maxHtmlBytes) throw bad(`"html" is ${bytes} bytes; the cap is ${L.maxHtmlBytes} bytes (${L.maxHtmlBytes / 1024} KB)`, 413);
  const raw = input?.times;
  if (!Array.isArray(raw) || raw.length < L.minFrames) throw bad(`"times" must be an array of ${L.minFrames} to ${L.maxFrames} numbers (seconds)`);
  if (raw.length > L.maxFrames) throw bad(`"times" has ${raw.length} entries; the cap is ${L.maxFrames}`);
  const times = raw.map((t) => (typeof t === "string" && t.trim() !== "" ? Number(t) : t));
  for (const t of times) {
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > L.maxTimeSeconds) {
      throw bad(`every entry of "times" must be a number of seconds from 0 to ${L.maxTimeSeconds}`);
    }
  }
  const side = (v, dflt, max, name) => {
    if (v === undefined || v === null || v === "") return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < L.minSide || n > max) throw bad(`"${name}" must be a whole number of pixels from ${L.minSide} to ${max}`);
    return n;
  };
  const width = side(input?.width, 640, L.maxWidth, "width");
  const height = side(input?.height, 360, L.maxHeight, "height");
  const compare = htmlFramesCompareInput(input?.compare, times, L);
  return { html, times, width, height, compare };
}

const FRAMES_PRICE_USD = 0.02;
const usd = (n) => `$${Number(n.toFixed(4))}`;
const FRAME_CHECK_METHOD = `grayscale mean per cell of a ${FRAME_DIFF.columns}x${FRAME_DIFF.rows} grid over each still; similarity is 1 minus the mean absolute difference of the cell means on a 0 to 255 scale; a cell is changed past a difference of ${FRAME_DIFF.changedCellDelta}; changed cells are grouped into 4-connected regions, largest first`;

/**
 * Fetch the baseline document of a compare by baselineUrl through the public
 * URL guard (private hosts refused, redirects re-checked), under the html cap.
 * Runs before any browser slot is held: a refused or absent URL costs nothing.
 */
async function fetchBaselineDocument(url, L = HTML_FRAMES_LIMITS) {
  let got;
  try {
    got = await safeFetch(url, { maxBytes: L.maxHtmlBytes, timeoutMs: L.loadTimeoutMs });
  } catch (e) {
    if (e?.statusCode === 413) throw bad(`"compare.baselineUrl" document is over the ${L.maxHtmlBytes / 1024} KB cap`, 413);
    throw bad(`"compare.baselineUrl": ${e?.message || e}`, e?.statusCode || 502);
  }
  const html = typeof got?.html === "string" ? got.html : "";
  if (!html.trim()) throw bad('"compare.baselineUrl" answered an empty document', 422);
  return { html, finalUrl: got.finalUrl || url };
}

// Test hook: the frames test stands a fixture server on loopback, which the
// public-URL guard refuses by design, so it substitutes the fetch to prove
// the rest of the baselineUrl path (second render, error naming, quote).
let baselineFetch = fetchBaselineDocument;
export const __test = { setBaselineFetch: (fn) => { baselineFetch = fn || fetchBaselineDocument; } };

/**
 * The frame check: each candidate still against the baseline still of the
 * same t. Mutates `result` (adds the per-frame fields and `compare`).
 */
function attachFrameCheck(result, baselineByT, { width, height, source, baselineInfo }) {
  const L = HTML_FRAMES_LIMITS;
  let compared = 0;
  let minSimilarity = null;
  for (const f of result.frames) {
    const b = baselineByT.get(f.t);
    if (!b) { Object.assign(f, { similarity: null, changedCells: null, changedRegions: null, changedRegionsPartial: null }); continue; }
    const candidate = decodePng(Buffer.from(f.pngBase64, "base64"), { maxWidth: L.maxWidth, maxHeight: L.maxHeight, label: `the still at t = ${f.t}` });
    const baseline = decodePng(b.png, { maxWidth: L.maxWidth, maxHeight: L.maxHeight, label: `the baseline still at t = ${f.t}` });
    const d = compareStills(candidate, baseline);
    Object.assign(f, { similarity: d.similarity, changedCells: d.changedCells, changedRegions: d.changedRegions, changedRegionsPartial: d.changedRegionsPartial });
    compared++;
    minSimilarity = minSimilarity === null ? d.similarity : Math.min(minSimilarity, d.similarity);
  }
  result.compare = {
    source,
    ...baselineInfo,
    framesCompared: compared,
    framesWithoutBaseline: result.frames.length - compared,
    minSimilarity,
    grid: { columns: FRAME_DIFF.columns, rows: FRAME_DIFF.rows },
    changedCellDelta: FRAME_DIFF.changedCellDelta,
    method: FRAME_CHECK_METHOD,
    viewport: { width, height },
  };
  return result;
}

const FRAMES_EXAMPLE_HTML =
  "<!doctype html><html><body style=\"margin:0\"><canvas id=\"c\" width=\"320\" height=\"180\"></canvas><script>" +
  "const x=document.getElementById('c').getContext('2d');" +
  "window.renderAt=function(t){x.fillStyle='#10243e';x.fillRect(0,0,320,180);x.fillStyle='#4cc38a';x.fillRect(20+t*100,70,40,40);};" +
  "</script></body></html>";

export const BROWSER_MEASURE_TOOLS = [
  {
    route: "POST /api/page-speed", name: "Page speed (one lab measurement)", slug: "page-speed", category: "web", price: "$0.01",
    description:
      "Load one public URL once in headless Chromium and report what that load measured: navigation timings (TTFB, DOMContentLoaded, load), Web Vitals read from the page's own performance entries (LCP, FCP, CLS, total blocking time from long tasks), total transfer bytes, request count, the 5 heaviest resources, render-blocking scripts and styles, console errors, and an opportunities array computed from that same load: what to fix and where. Each opportunity names the element (a CSS selector) or the URL, says in one sentence what was measured, and carries the measured bytes or milliseconds behind it (null where the load measured neither). The ids cover the LCP element (tag, selector, size, whether it was lazy-loaded or waited for a web font), render-blocking scripts and stylesheets in the head, images without reserved dimensions or larger than they are shown, fonts without font-display swap, bytes by resource type and resources over 100 KB, responses sent uncompressed or without cache headers, requests to other hosts, long tasks with the script that ran, layout shifts with the element that moved, and console errors. The one paid call returns the measurement and the opportunities together, so an audit-fix-rescore loop needs no browser of its own. Mobile or desktop viewport. This is a single measurement from one server location under shared load, with no throttling: it is a single lab measurement, not field data from real users, and the answer says so in its measurement field. Deterministic code, no model. Body: {\"url\":\"https://…\",\"device\":\"mobile\"|\"desktop\"?}.",
    tags: ["browser", "performance", "web-vitals", "lcp", "cls", "page-speed", "ttfb", "audit", "opportunities", "render-blocking", "cache-headers"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools", device: "mobile" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public http(s) URL to load and measure" },
          device: { type: "string", enum: ["mobile", "desktop"], description: "Viewport profile: mobile (412x823, touch) or desktop (1350x940). Default mobile" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://agent402.tools",
          finalUrl: "https://agent402.tools/",
          status: 200,
          device: "mobile",
          viewport: {
            width: 412,
            height: 823
          },
          networkIdle: true,
          timings: {
            ttfbMs: 176,
            domContentLoadedMs: 443,
            loadMs: 1090
          },
          webVitals: {
            lcpMs: 380,
            lcpElement: "p",
            fcpMs: 380,
            cls: 0,
            totalBlockingTimeMs: 0,
            longTaskCount: 0
          },
          transfer: {
            totalBytes: 582458,
            requestCount: 43,
            failedRequests: 1
          },
          heaviestResources: [
            {
              url: "https://agent402.tools/",
              type: "document",
              bytes: 37659
            }
          ],
          heaviestResourcesPartial: {
            returned: 1,
            matched: 41,
            complete: false,
            truncated: true
          },
          renderBlocking: [
            {
              url: "https://agent402.tools/js/theme-init.js?v=a017322",
              type: "script",
              durationMs: 139
            }
          ],
          renderBlockingPartial: {
            returned: 1,
            matched: 1,
            complete: true,
            truncated: false
          },
          consoleErrors: [],
          consoleErrorsPartial: {
            returned: 0,
            matched: 0,
            complete: true,
            truncated: false
          },
          measurement: PAGE_SPEED_MEASUREMENT,
          untrustedContent: true,
          opportunities: [
            {
              id: "lcp-element",
              element: "div > div.hm-hero > div.ml-stagger:nth-of-type(1) > p.hm-lede",
              url: null,
              detail: "The largest contentful paint at 380 ms was <p>, a text block, 380x132 px, set in the web font Geist.",
              estimate: {
                ms: 380
              },
              tag: "p",
              sizePx: 47488,
              lazyLoaded: null,
              webFont: "Geist"
            },
            {
              id: "lcp-text-behind-web-font",
              element: "div > div.hm-hero > div.ml-stagger:nth-of-type(1) > p.hm-lede",
              url: "https://agent402.tools/fonts/geist-300-latin.woff2",
              detail: "The LCP text is set in the web font Geist, fetched from https://agent402.tools/fonts/geist-300-latin.woff2; the paint waited for that font.",
              estimate: {
                bytes: 13920,
                ms: 118
              }
            },
            {
              id: "render-blocking-script",
              element: null,
              url: "https://agent402.tools/js/theme-init.js?v=a017322",
              detail: "Script in <head> without async or defer; the parser waited for it (139 ms to fetch). Add defer, or async when order does not matter.",
              estimate: {
                bytes: 453,
                ms: 139
              }
            },
            {
              id: "short-cache-lifetime",
              element: null,
              url: "https://agent402.tools/js/home-hero.js",
              detail: "script of 5.1 KB cached for 300 s (max-age=300). Give static assets a long max-age and change the URL when they change.",
              estimate: {
                bytes: 5243
              }
            },
            {
              id: "uncompressed-response",
              element: null,
              url: "https://agent402.tools/x-header.svg",
              detail: "image/svg+xml response of 1.3 KB sent with no content-encoding. Serve it with gzip or brotli.",
              estimate: {
                bytes: 1379
              }
            },
            {
              id: "transfer-by-type",
              element: null,
              url: null,
              detail: "Transferred 568.8 KB: script 327.5 KB in 12 requests, font 147.8 KB in 12 requests, image 50 KB in 14 requests, document 41.6 KB in 2 requests, fetch 1.9 KB in 2 requests, eventsource 0 KB in 1 request.",
              estimate: {
                bytes: 582458
              },
              byType: {
                document: {
                  bytes: 42612,
                  requests: 2
                },
                script: {
                  bytes: 335322,
                  requests: 12
                },
                font: {
                  bytes: 151385,
                  requests: 12
                },
                fetch: {
                  bytes: 1904,
                  requests: 2
                },
                image: {
                  bytes: 51235,
                  requests: 14
                },
                eventsource: {
                  bytes: 0,
                  requests: 1
                }
              }
            },
            {
              id: "large-resource",
              element: null,
              url: "https://agent402.tools/e/static/array.js",
              detail: "script of 103.7 KB transferred (application/javascript).",
              estimate: {
                bytes: 106160
              },
              type: "script"
            },
            {
              id: "third-party-host",
              element: null,
              url: "www.googletagmanager.com",
              detail: "1 request to www.googletagmanager.com (176.9 KB), a host outside agent402.tools.",
              estimate: {
                bytes: 181162
              },
              requests: 1
            }
          ],
          opportunitiesPartial: {
            returned: 8,
            matched: 29,
            complete: false,
            truncated: true
          }
        },
      },
    },
    handler: async (input, ctx) => {
      const { url, device } = pageSpeedInput(input);
      return measurePageSpeed(url, { device, signal: abortSignalOf(ctx) });
    },
  },
  {
    route: "POST /api/html-frames", name: "HTML frames (render contract, frame check)", slug: "html-frames", category: "web", price: usd(FRAMES_PRICE_USD),
    aliases: ["render-contract", "renderat", "renderat-frames", "contact-sheet", "frame-check", "motion-design-frame-check", "freeze-frames", "animation-frames", "animation-stills"],
    // A compare by baselineUrl renders a second document on the browser pool,
    // so that body is quoted at twice the listed price; every other body,
    // including a compare by baseline stills, is quoted at the listed price.
    quote: (body) => (htmlFramesRendersBaseline(body) ? 2 : 1) * FRAMES_PRICE_USD,
    quoteMaxUsd: 2 * FRAMES_PRICE_USD,
    description:
      `Freeze frames of an animation under the render contract: the page defines window.renderAt(t). The tool renders the self-contained HTML document in headless Chromium with all network access refused, calls renderAt for each requested time in seconds and returns a PNG still per time (base64) plus one contact-sheet PNG of every still in a grid. For previews and frame checks of canvas, SVG or CSS animations an agent wrote itself (motion design, motion graphics, generative art). Frame check: the optional compare input holds either baseline, an array of {t, png} stills (base64 PNG, one per requested time, from an earlier call or another renderer), or baselineUrl, the public URL of a second document under the same contract, fetched through the same public-URL guard as page-speed and rendered the same way; each compared frame then carries similarity (0 to 1 from the ${FRAME_DIFF.columns}x${FRAME_DIFF.rows} grid of grayscale cell means; identical stills score 1) and changedRegions (bounding boxes of the differing cells in pixels, largest first, up to ${FRAME_DIFF.maxRegions} with changedRegionsPartial saying how many there were). A compare by baselineUrl renders two documents, so that call is quoted at twice the listed price (${usd(2 * FRAMES_PRICE_USD)}) in its 402; a compare by baseline stills is quoted at the listed price. The document must carry everything inline: every request it makes (fetch, images, fonts, frames, sockets, navigations) is refused and counted; data: and blob: URLs it builds itself work. A script error while loading, a missing renderAt or a renderAt that throws answers 400. Limits: html up to ${HTML_FRAMES_LIMITS.maxHtmlBytes / 1024} KB, ${HTML_FRAMES_LIMITS.minFrames} to ${HTML_FRAMES_LIMITS.maxFrames} times, width up to ${HTML_FRAMES_LIMITS.maxWidth} and height up to ${HTML_FRAMES_LIMITS.maxHeight} (default 640x360), ${HTML_FRAMES_LIMITS.frameTimeoutMs / 1000} s per renderAt and ${HTML_FRAMES_LIMITS.totalTimeoutMs / 1000} s for loading and every renderAt together, ${HTML_FRAMES_LIMITS.maxOutputBytes / (1024 * 1024)} MB of PNG output in all; a baseline of up to ${HTML_FRAMES_LIMITS.maxFrames} stills and ${HTML_FRAMES_LIMITS.maxOutputBytes / (1024 * 1024)} MB of PNG, each still at most ${HTML_FRAMES_LIMITS.maxWidth}x${HTML_FRAMES_LIMITS.maxHeight}. Deterministic code, no model. Body: {"html":"<!doctype html>…","times":[0,0.5,1],"width":640?,"height":360?,"compare":{"baseline":[{"t":0,"png":"iVBORw0KGgo…"}]}?} or "compare":{"baselineUrl":"https://…"}.`,
    tags: ["browser", "html", "render", "frames", "animation", "png", "canvas", "contact-sheet", "contract", "motion", "baseline", "diff"],
    discovery: {
      bodyType: "json",
      input: { html: FRAMES_EXAMPLE_HTML, times: [0, 1, 2], width: 320, height: 180 },
      inputSchema: {
        properties: {
          html: { type: "string", description: `A self-contained HTML document (max ${HTML_FRAMES_LIMITS.maxHtmlBytes / 1024} KB) that defines window.renderAt(t); it may return a promise` },
          times: { type: "array", items: { type: "number" }, description: `${HTML_FRAMES_LIMITS.minFrames} to ${HTML_FRAMES_LIMITS.maxFrames} times in seconds (0 to ${HTML_FRAMES_LIMITS.maxTimeSeconds}), one still each` },
          width: { type: "integer", description: `Viewport width in px, ${HTML_FRAMES_LIMITS.minSide} to ${HTML_FRAMES_LIMITS.maxWidth} (default 640)` },
          height: { type: "integer", description: `Viewport height in px, ${HTML_FRAMES_LIMITS.minSide} to ${HTML_FRAMES_LIMITS.maxHeight} (default 360)` },
          compare: {
            type: "object",
            description: `Optional frame check: exactly one of baseline or baselineUrl. Adds similarity (0 to 1) and changedRegions to each compared frame. A baselineUrl renders a second document and is quoted at twice the listed price (${usd(2 * FRAMES_PRICE_USD)})`,
            properties: {
              baseline: {
                type: "array",
                description: `1 to ${HTML_FRAMES_LIMITS.maxFrames} baseline stills, each {t, png}: t one of the requested times, png a base64 PNG at most ${HTML_FRAMES_LIMITS.maxWidth}x${HTML_FRAMES_LIMITS.maxHeight}; ${HTML_FRAMES_LIMITS.maxOutputBytes / (1024 * 1024)} MB of PNG in all. A still of another size is compared on the same grid`,
                items: {
                  type: "object",
                  properties: {
                    t: { type: "number", description: "One of the requested times, in seconds" },
                    png: { type: "string", description: "The baseline still at that time, base64 PNG" },
                  },
                  required: ["t", "png"],
                },
              },
              baselineUrl: { type: "string", description: `Public http(s) URL of a second document under the same contract (defines window.renderAt(t), at most ${HTML_FRAMES_LIMITS.maxHtmlBytes / 1024} KB), fetched through the public-URL guard and rendered at the same times, width and height` },
            },
          },
        },
        required: ["html", "times"],
      },
      output: {
        example: {
          width: 320, height: 180, frameCount: 3,
          frames: [{ t: 0, bytes: 645, pngBase64: "iVBORw0KGgo…" }, { t: 1, bytes: 645, pngBase64: "iVBORw0KGgo…" }, { t: 2, bytes: 644, pngBase64: "iVBORw0KGgo…" }],
          contactSheet: { columns: 2, rows: 2, width: 664, height: 420, bytes: 3282, pngBase64: "iVBORw0KGgo…" },
          totalBytes: 5216,
          network: { blockedRequests: 0, policy: "all network access refused; only inline script and style, and data: or blob: URLs the document builds itself" },
        },
      },
    },
    handler: async (input, ctx) => {
      const { html, times, width, height, compare } = htmlFramesInput(input);
      const signal = abortSignalOf(ctx);
      // The baseline document is fetched before any browser slot is held.
      const baselineDoc = compare?.baselineUrl ? await baselineFetch(compare.baselineUrl) : null;
      const result = await renderHtmlFrames(html, times, { width, height, signal });
      if (!compare) return result;
      const baselineByT = new Map();
      if (baselineDoc) {
        let b;
        try {
          b = await renderHtmlFrames(baselineDoc.html, times, { width, height, signal });
        } catch (e) {
          if (e?.statusCode === 400) e.message = `"compare.baselineUrl" document: ${e.message}`;
          throw e;
        }
        for (const f of b.frames) baselineByT.set(f.t, { png: Buffer.from(f.pngBase64, "base64") });
        return attachFrameCheck(result, baselineByT, {
          width, height, source: "baselineUrl",
          baselineInfo: { baselineUrl: compare.baselineUrl, baselineFinalUrl: baselineDoc.finalUrl, baselineRender: { frameCount: b.frameCount, network: b.network } },
        });
      }
      for (const e of compare.baseline) baselineByT.set(e.t, { png: e.png });
      return attachFrameCheck(result, baselineByT, { width, height, source: "baseline", baselineInfo: { baselineStills: compare.baseline.length } });
    },
  },
];
