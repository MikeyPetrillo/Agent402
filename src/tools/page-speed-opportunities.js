// page-speed opportunities: what to fix, read from the one load page-speed
// already makes. Pure: takes the facts the load recorded (the page's own DOM
// and performance entries, the browser's network events with response headers)
// and returns the opportunities array. No second load, no outside call.
//
// Each opportunity is { id, element, url, detail, estimate, ...facts }:
//   element   a CSS selector for the node the finding is about, or null
//   url       the resource URL (or the host, for a host-level finding), or null
//   detail    one sentence a reader can act on
//   estimate  the measured bytes or milliseconds this finding carries
//             ({ bytes }, { ms } or both), null when the load measured neither.
//             It is a measurement, never a predicted saving.
import { partialFields } from "../partial-answer.js";

export const OPPORTUNITY_LIMITS = Object.freeze({
  maxOpportunities: 120,
  perClass: 20,
  layoutShifts: 10,
  largeResourceBytes: 100 * 1024,
  compressMinBytes: 1024,
  shortCacheSeconds: 86400,
  oversizedRatio: 1.5,
  longTaskMs: 50,
  minShiftScore: 0.001,
});

const COMPRESSIBLE = /^(text\/|application\/(javascript|x-javascript|ecmascript|json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|manifest\+json|wasm|x-font-ttf|x-font-opentype|font-sfnt)|image\/svg\+xml|font\/(ttf|otf|sfnt))/i;
const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media"]);
// Second-level labels under a two-letter country TLD where the site is the third label.
const CC_SECOND = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "ne", "or", "go"]);

const kb = (n) => `${Math.round((n / 1024) * 10) / 10} KB`;
const px = (w, h) => `${Math.round(w)}x${Math.round(h)} px`;
const msOrNull = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const estimateOf = (bytes, ms) => {
  const out = {};
  if (Number.isFinite(bytes) && bytes > 0) out.bytes = Math.round(bytes);
  if (Number.isFinite(ms) && ms > 0) out.ms = Math.round(ms);
  return Object.keys(out).length ? out : null;
};

/** Registrable site of a host: the last two labels, three under a ccTLD second-level label. */
export function siteOf(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h || /^[\d.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (tld.length === 2 && CC_SECOND.has(second) && labels.length >= 3) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function cacheLifetime(headers) {
  const cc = String(headers?.["cache-control"] || "").toLowerCase();
  if (!cc && !headers?.expires) return { present: false };
  if (/\bno-store\b/.test(cc)) return { present: true, seconds: 0, directive: "no-store" };
  if (/\bno-cache\b/.test(cc)) return { present: true, seconds: 0, directive: "no-cache" };
  const immutable = /\bimmutable\b/.test(cc);
  const sm = /\bs-maxage=(\d+)/.exec(cc);
  const m = /\bmax-age=(\d+)/.exec(cc);
  if (m || sm) return { present: true, seconds: Number((m || sm)[1]), directive: (m || sm)[0], immutable };
  if (headers?.expires) {
    const t = Date.parse(headers.expires);
    return { present: true, seconds: Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : 0, directive: "expires" };
  }
  return { present: true, seconds: null, directive: cc.slice(0, 40) };
}

/**
 * Build the opportunities array from one load's facts.
 * @param {object} f
 *   f.docUrl            final document URL
 *   f.resources         [{ url, type, bytes, status, headers, mimeType, fromCache }] (browser network events)
 *   f.timing            { [url]: { durationMs, initiatorType, renderBlocking } } (resource timing)
 *   f.headScripts       [{ url }]            scripts in <head> without async, defer or type=module
 *   f.headStyles        [{ url, media }]     stylesheets in <head> whose media matches
 *   f.images            [{ selector, url, sized, naturalWidth, naturalHeight, width, height, lazy }]
 *   f.lcp               { tag, selector, url, sizePx, width, height, ms, lazy, text, fontFamily, webFont } | null
 *   f.fontFaces         [{ family, display, url }]
 *   f.longFrames        [{ startMs, durationMs, blockingMs, scripts: [{ sourceURL, invoker, invokerType, durationMs }] }]
 *   f.longTasks         [{ startMs, durationMs }] (the long tasks; frames attribute them to a script)
 *   f.shifts            [{ startMs, value, elements: [selector] }]
 *   f.consoleErrors     [{ source, text, url }]
 *   f.dpr               device pixel ratio
 */
export function buildOpportunities(f, L = OPPORTUNITY_LIMITS) {
  const out = [];
  const counts = new Map();
  let skipped = 0; // findings past a class cap: counted in matched, not returned
  const add = (item, cap = L.perClass) => {
    const n = (counts.get(item.id) || 0) + 1;
    counts.set(item.id, n);
    if (n > cap) { skipped++; return; }
    out.push(item);
  };
  const byUrl = new Map();
  for (const r of f.resources || []) if (r?.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  const timing = f.timing || {};
  const bytesOf = (url) => byUrl.get(url)?.bytes || null;
  const durationOf = (url) => msOrNull(timing[url]?.durationMs);
  const fontByFamily = new Map();
  for (const ff of f.fontFaces || []) if (ff?.family && !fontByFamily.has(ff.family)) fontByFamily.set(ff.family, ff);

  // 1. The LCP element, and what held it back.
  const lcp = f.lcp;
  if (lcp && Number.isFinite(lcp.ms) && lcp.ms > 0) {
    const what = lcp.url ? `an image (${lcp.url})` : lcp.text ? "a text block" : "an element";
    const size = Number.isFinite(lcp.width) && Number.isFinite(lcp.height) ? px(lcp.width, lcp.height) : `${lcp.sizePx || 0} px area`;
    out.push({
      id: "lcp-element", element: lcp.selector, url: lcp.url || null,
      detail: `The largest contentful paint at ${Math.round(lcp.ms)} ms was <${lcp.tag}>, ${what}, ${size}${lcp.lazy ? ", loaded lazily" : ""}${lcp.text && lcp.webFont ? `, set in the web font ${lcp.fontFamily}` : ""}.`,
      estimate: estimateOf(lcp.url ? bytesOf(lcp.url) : null, lcp.ms),
      tag: lcp.tag, sizePx: lcp.sizePx ?? null, lazyLoaded: lcp.lazy ?? null, webFont: lcp.text && lcp.webFont ? lcp.fontFamily : null,
    });
    if (lcp.lazy) {
      out.push({
        id: "lcp-image-lazy-loaded", element: lcp.selector, url: lcp.url || null,
        detail: "The LCP image carries loading=lazy, so the browser deferred its fetch; load it eagerly and consider fetchpriority=high.",
        estimate: estimateOf(null, durationOf(lcp.url)),
      });
    }
    if (lcp.text && lcp.webFont) {
      const face = fontByFamily.get(lcp.fontFamily);
      const fontUrl = face?.url || null;
      out.push({
        id: "lcp-text-behind-web-font", element: lcp.selector, url: fontUrl,
        detail: `The LCP text is set in the web font ${lcp.fontFamily}${fontUrl ? `, fetched from ${fontUrl}` : ""}; the paint waited for that font${face && !/^(swap|optional|fallback)$/i.test(face.display || "") ? ", which has no font-display: swap" : ""}.`,
        estimate: estimateOf(fontUrl ? bytesOf(fontUrl) : null, fontUrl ? durationOf(fontUrl) : null),
      });
    }
  }

  // 2. Render-blocking scripts and stylesheets in <head>.
  for (const s of f.headScripts || []) {
    const d = durationOf(s.url);
    add({
      id: "render-blocking-script", element: null, url: s.url,
      detail: `Script in <head> without async or defer; the parser waited for it${d ? ` (${d} ms to fetch)` : ""}. Add defer, or async when order does not matter.`,
      estimate: estimateOf(bytesOf(s.url), d),
    });
  }
  for (const s of f.headStyles || []) {
    const d = durationOf(s.url);
    add({
      id: "render-blocking-stylesheet", element: null, url: s.url,
      detail: `Stylesheet in <head>${s.media ? ` with media="${s.media}"` : ""} that blocks first paint${d ? ` (${d} ms to fetch)` : ""}. Inline the critical rules or give non-critical sheets a media that does not match at load.`,
      estimate: estimateOf(bytesOf(s.url), d),
    });
  }

  // 3. Fonts without font-display swap (or optional/fallback). A face that
  // only names local() fonts fetches nothing, so it has nothing to swap for;
  // one family in several weights from one file is one finding.
  const seenFaces = new Set();
  for (const ff of f.fontFaces || []) {
    if (!ff?.url || /^(swap|optional|fallback)$/i.test(ff.display || "")) continue;
    const key = `${ff.family}\n${ff.url}`;
    if (seenFaces.has(key)) continue;
    seenFaces.add(key);
    add({
      id: "font-display-missing", element: ff.family, url: ff.url || null,
      detail: `@font-face ${ff.family} declares ${ff.display ? `font-display: ${ff.display}` : "no font-display"}, so text in it can stay invisible until the font arrives. Add font-display: swap.`,
      estimate: estimateOf(ff.url ? bytesOf(ff.url) : null, ff.url ? durationOf(ff.url) : null),
    });
  }

  // 4. Images without reserved space, and images larger than they are shown.
  for (const im of f.images || []) {
    if (!im.sized && im.width > 0) {
      add({
        id: "image-missing-dimensions", element: im.selector, url: im.url || null,
        detail: `<img> shown at ${px(im.width, im.height)} with no width and height attributes or CSS aspect-ratio, so no space is reserved before it loads. Set width and height.`,
        estimate: null,
      });
    }
    const dpr = Number(f.dpr) || 1;
    const natural = (im.naturalWidth || 0) * (im.naturalHeight || 0);
    const shown = (im.width || 0) * dpr * (im.height || 0) * dpr;
    if (natural > 0 && shown > 0 && natural >= shown * L.oversizedRatio) {
      const bytes = bytesOf(im.url);
      add({
        id: "image-oversized", element: im.selector, url: im.url || null,
        detail: `Image is ${px(im.naturalWidth, im.naturalHeight)} but shown at ${px(im.width, im.height)} on a ${dpr}x screen (${Math.round(natural / shown * 10) / 10}x the pixels needed). Serve a version sized for the display.`,
        estimate: estimateOf(bytes ? bytes * (1 - shown / natural) : null, null),
      });
    }
  }

  // 5. Responses without compression, without cache headers, or with a short lifetime.
  for (const r of f.resources || []) {
    if (!r?.url || r.fromCache) continue;
    const enc = String(r.headers?.["content-encoding"] || "").toLowerCase();
    if (r.bytes >= L.compressMinBytes && COMPRESSIBLE.test(r.mimeType || "") && (!enc || enc === "identity")) {
      add({
        id: "uncompressed-response", element: null, url: r.url,
        detail: `${r.mimeType} response of ${kb(r.bytes)} sent with no content-encoding. Serve it with gzip or brotli.`,
        estimate: estimateOf(r.bytes, null),
      });
    }
    if (r.status === 200 && STATIC_TYPES.has(r.type)) {
      const c = cacheLifetime(r.headers);
      if (!c.present) {
        add({
          id: "missing-cache-headers", element: null, url: r.url,
          detail: `${r.type} of ${kb(r.bytes)} served with no cache-control or expires header, so a repeat visit fetches it again. Add cache-control with a max-age.`,
          estimate: estimateOf(r.bytes, null),
        });
      } else if (c.present && !c.immutable && Number.isFinite(c.seconds) && c.seconds < L.shortCacheSeconds) {
        add({
          id: "short-cache-lifetime", element: null, url: r.url,
          detail: `${r.type} of ${kb(r.bytes)} cached for ${c.seconds} s (${c.directive}). Give static assets a long max-age and change the URL when they change.`,
          estimate: estimateOf(r.bytes, null),
        });
      }
    }
  }

  // 6. Bytes by type, the largest resources, and third-party hosts.
  const byType = {};
  const byHost = new Map();
  const docSite = siteOf(hostOf(f.docUrl));
  let total = 0;
  for (const r of f.resources || []) {
    if (!r?.url) continue;
    const t = r.type || "other";
    byType[t] = byType[t] || { bytes: 0, requests: 0 };
    byType[t].bytes += r.bytes || 0; byType[t].requests++;
    total += r.bytes || 0;
    const host = hostOf(r.url);
    if (host && siteOf(host) !== docSite) {
      const h = byHost.get(host) || { bytes: 0, requests: 0 };
      h.bytes += r.bytes || 0; h.requests++;
      byHost.set(host, h);
    }
  }
  if (total > 0) {
    const parts = Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([t, v]) => `${t} ${kb(v.bytes)} in ${v.requests} request${v.requests === 1 ? "" : "s"}`);
    out.push({ id: "transfer-by-type", element: null, url: null, detail: `Transferred ${kb(total)}: ${parts.join(", ")}.`, estimate: estimateOf(total, null), byType });
  }
  const large = (f.resources || []).filter((r) => r?.url && r.bytes >= L.largeResourceBytes).sort((a, b) => b.bytes - a.bytes);
  for (const r of large) {
    add({ id: "large-resource", element: null, url: r.url, detail: `${r.type} of ${kb(r.bytes)} transferred${r.mimeType ? ` (${r.mimeType})` : ""}.`, estimate: estimateOf(r.bytes, null), type: r.type });
  }
  for (const [host, v] of [...byHost.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    add({
      id: "third-party-host", element: null, url: host,
      detail: `${v.requests} request${v.requests === 1 ? "" : "s"} to ${host} (${kb(v.bytes)}), a host outside ${docSite || "the page's site"}.`,
      estimate: estimateOf(v.bytes, null), requests: v.requests,
    });
  }

  // 7. Long tasks (the same entries webVitals.longTaskCount counts), each
  // attributed to the longest script of the animation frame it ran in.
  const frames = f.longFrames || [];
  const tasks = (f.longTasks || []).filter((x) => x.durationMs > L.longTaskMs).sort((a, b) => b.durationMs - a.durationMs);
  for (const t of tasks) {
    const end = t.startMs + t.durationMs;
    const scripts = frames.filter((fr) => fr.startMs < end && fr.startMs + fr.durationMs > t.startMs).flatMap((fr) => fr.scripts || []);
    const top = scripts.slice().sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))[0] || null;
    const url = top?.sourceURL || null;
    const invoker = top?.invoker || top?.invokerType || null;
    add({
      id: "long-task", element: null, url,
      detail: `${Math.round(t.durationMs)} ms long task at ${Math.round(t.startMs)} ms (${Math.max(0, Math.round(t.durationMs - L.longTaskMs))} ms over the ${L.longTaskMs} ms budget)${top ? `; longest script ${Math.round(top.durationMs || 0)} ms, ${invoker}${url && url !== invoker ? ` in ${url}` : ""}` : "; no script attribution for this task"}.`,
      estimate: estimateOf(null, t.durationMs), blockingMs: Math.max(0, Math.round(t.durationMs - L.longTaskMs)), invoker,
    });
  }

  // 8. Layout shifts with the element that moved.
  const shifts = (f.shifts || []).filter((s) => s.value >= L.minShiftScore).sort((a, b) => b.value - a.value);
  for (const s of shifts) {
    const el = (s.elements || []).find(Boolean) || null;
    add({
      id: "layout-shift", element: el, url: null,
      detail: `Layout shift of ${Math.round(s.value * 10000) / 10000} at ${Math.round(s.startMs)} ms${el ? `; moved: ${(s.elements || []).filter(Boolean).slice(0, 3).join(", ")}` : ""}.`,
      estimate: null, score: Math.round(s.value * 10000) / 10000,
    }, L.layoutShifts);
  }

  // 9. Console errors.
  for (const c of f.consoleErrors || []) {
    add({ id: "console-error", element: null, url: c.url || null, detail: `${c.source === "uncaught" ? "Uncaught error" : "Console error"}: ${c.text}`, estimate: null });
  }

  const matched = out.length + skipped;
  const returned = out.slice(0, L.maxOpportunities);
  return { opportunities: returned, opportunitiesPartial: partialFields(matched, returned.length) };
}
