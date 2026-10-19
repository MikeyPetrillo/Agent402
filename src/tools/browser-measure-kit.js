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
      "Load one public URL once in headless Chromium and report what that load measured: navigation timings (TTFB, DOMContentLoaded, load), Web Vitals read from the page's own performance entries (LCP, FCP, CLS, total blocking time from long tasks), total transfer bytes, request count, the 5 heaviest resources, render-blocking scripts and styles, and console errors. Mobile or desktop viewport. This is a single measurement from one server location under shared load, with no throttling: it is a single lab measurement, not field data from real users, and the answer says so in its measurement field. Deterministic code, no model. Body: {\"url\":\"https://…\",\"device\":\"mobile\"|\"desktop\"?}.",
    tags: ["browser", "performance", "web-vitals", "lcp", "cls", "page-speed", "ttfb", "audit"],
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
          viewport: { width: 412, height: 823 },
          networkIdle: true,
          timings: { ttfbMs: 182, domContentLoadedMs: 401, loadMs: 655 },
          webVitals: { lcpMs: 512, lcpElement: "h1", fcpMs: 430, cls: 0.0012, totalBlockingTimeMs: 0, longTaskCount: 0 },
          transfer: { totalBytes: 98123, requestCount: 9, failedRequests: 0 },
          heaviestResources: [{ url: "https://agent402.tools/", type: "document", bytes: 41210 }],
          heaviestResourcesPartial: { returned: 1, matched: 9, complete: false, truncated: true },
          renderBlocking: [],
          renderBlockingPartial: { returned: 0, matched: 0, complete: true, truncated: false },
          consoleErrors: [],
          consoleErrorsPartial: { returned: 0, matched: 0, complete: true, truncated: false },
          measurement: PAGE_SPEED_MEASUREMENT,
          untrustedContent: true,
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
