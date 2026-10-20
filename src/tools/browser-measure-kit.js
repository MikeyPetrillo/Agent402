// Browser measurement kit: two tools on the shared headless Chromium pool in
// render.js (same admission control, exec deadline and slot accounting as
// render and screenshot). Deterministic code: no model, no outside API, no key.
//
//   page-speed   one lab load of a public URL through the same SSRF guard
//                render uses (assertPublicUrl up front, hostIsPublic on every
//                request the page makes), reporting what that load measured.
//   html-frames  a buyer-supplied self-contained HTML document rendered with
//                every network request refused, stepped through
//                window.renderAt(t), returned as PNG stills plus a contact sheet.
//
// Both are wallet-only: neither is on the free-tier allowlist (src/free-tier.js).
// This module imports only render.js and pure helpers, so the secretless worker
// (worker/server.js) runs these handlers unchanged.
import {
  measurePageSpeed, renderHtmlFrames,
  PAGE_SPEED_DEVICES, PAGE_SPEED_MEASUREMENT, HTML_FRAMES_LIMITS,
} from "./render.js";

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

/** Validate html-frames input. Returns { html, times, width, height }. Pure. */
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
  return { html, times, width, height };
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
              url: "https://live.agent402.tools/logo/v2/x402%3A0x325bdf6f7efab24a2210c48c1b64cab2eae1d430",
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
    route: "POST /api/html-frames", name: "HTML frames (render at times)", slug: "html-frames", category: "web", price: "$0.02",
    description:
      `Render a self-contained HTML document in headless Chromium with all network access refused, call its window.renderAt(t) for each requested time in seconds, and return a PNG still per time (base64) plus one contact-sheet PNG of every still in a grid. For previews of canvas, SVG or CSS animations an agent wrote itself. The document must carry everything inline: every request it makes (fetch, images, fonts, frames, sockets, navigations) is refused and counted; data: and blob: URLs it builds itself work. A script error while loading, a missing renderAt or a renderAt that throws answers 400. Limits: html up to ${HTML_FRAMES_LIMITS.maxHtmlBytes / 1024} KB, ${HTML_FRAMES_LIMITS.minFrames} to ${HTML_FRAMES_LIMITS.maxFrames} times, width up to ${HTML_FRAMES_LIMITS.maxWidth} and height up to ${HTML_FRAMES_LIMITS.maxHeight} (default 640x360), ${HTML_FRAMES_LIMITS.frameTimeoutMs / 1000} s per renderAt and ${HTML_FRAMES_LIMITS.totalTimeoutMs / 1000} s for loading and every renderAt together, ${HTML_FRAMES_LIMITS.maxOutputBytes / (1024 * 1024)} MB of PNG output in all. Deterministic code, no model. Body: {"html":"<!doctype html>…","times":[0,0.5,1],"width":640?,"height":360?}.`,
    tags: ["browser", "html", "render", "frames", "animation", "png", "canvas", "contact-sheet"],
    discovery: {
      bodyType: "json",
      input: { html: FRAMES_EXAMPLE_HTML, times: [0, 1, 2], width: 320, height: 180 },
      inputSchema: {
        properties: {
          html: { type: "string", description: `A self-contained HTML document (max ${HTML_FRAMES_LIMITS.maxHtmlBytes / 1024} KB) that defines window.renderAt(t); it may return a promise` },
          times: { type: "array", items: { type: "number" }, description: `${HTML_FRAMES_LIMITS.minFrames} to ${HTML_FRAMES_LIMITS.maxFrames} times in seconds (0 to ${HTML_FRAMES_LIMITS.maxTimeSeconds}), one still each` },
          width: { type: "integer", description: `Viewport width in px, ${HTML_FRAMES_LIMITS.minSide} to ${HTML_FRAMES_LIMITS.maxWidth} (default 640)` },
          height: { type: "integer", description: `Viewport height in px, ${HTML_FRAMES_LIMITS.minSide} to ${HTML_FRAMES_LIMITS.maxHeight} (default 360)` },
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
      const { html, times, width, height } = htmlFramesInput(input);
      return renderHtmlFrames(html, times, { width, height, signal: abortSignalOf(ctx) });
    },
  },
];
