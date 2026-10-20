#!/usr/bin/env node
// page-speed and html-frames on the real Chromium pool (src/tools/render.js
// via src/tools/browser-measure-kit.js). Needs Playwright's Chromium; under CI
// a missing browser fails, it never skips.
//
// page-speed: a fixture server on port 0 serves a page with a render-blocking
// stylesheet and script, a heavy image, a console error, a layout shift and a
// long task. The public guard must refuse the loopback URL; with the guard
// pointed at the fixture for the test, the measurement must report each of
// those, the honest-measurement field and the caps.
//
// opportunities: the same fixture carries one trigger per class (a deferred
// script and a print stylesheet that must NOT be listed, a lazy oversized LCP
// image, an unsized image, a @font-face without font-display, uncompressed and
// uncached responses next to a gzipped immutable one, a second host, a long
// task and a layout shift); a second page has a text LCP set in the web font.
// Every class must be named from that one load, with the measured bytes or ms
// it carries, and nothing that is not a problem may be listed.
//
// html-frames: the document's own requests (fetch, img, navigation, socket)
// must never reach a listening server and must be counted as blocked; a
// renderAt that throws, a load-time error and a missing renderAt answer 400;
// input caps refuse; and every PNG returned decodes at the size asked for.
//
//   node scripts/test-page-speed-frames.js
import http from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { __test, HTML_FRAMES_LIMITS } from "../src/tools/render.js";
import { BROWSER_MEASURE_TOOLS, htmlFramesInput, pageSpeedInput } from "../src/tools/browser-measure-kit.js";
import { buildOpportunities, siteOf, OPPORTUNITY_LIMITS } from "../src/tools/page-speed-opportunities.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const tool = (slug) => BROWSER_MEASURE_TOOLS.find((t) => t.slug === slug);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- fixture server ------------------------------------------------------
let hits = [];
const BIG = Buffer.alloc(600_000, 7);
// A noisy PNG: Chromium ignores low-entropy images as LCP candidates, so the
// pixels vary. 400x300 shown at 200x150 is the oversized case.
function noisyPng(w, h) {
  const png = new PNG({ width: w, height: h });
  let x = 12345;
  for (let i = 0; i < png.data.length; i += 4) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    png.data[i] = x & 255; png.data[i + 1] = (x >> 8) & 255; png.data[i + 2] = (x >> 16) & 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
const BIG_PNG = noisyPng(400, 300);
const SMALL_PNG = noisyPng(40, 30);
const FONT = readFileSync(new URL("../assets/fonts/geist-400-latin.woff2", import.meta.url));
const PAD_JS = "window.__x = 1;" + "\n// " + "pad ".repeat(600);
const GZ_JS = gzipSync(Buffer.from("window.__gz = 1;" + "\n// " + "pad ".repeat(600)));
let THIRD = ""; // set once the port is known
const page = () => `<!doctype html><html><head>
<link rel="stylesheet" href="/blocking.css">
<link rel="stylesheet" href="/print.css" media="print">
<script src="/blocking.js"></script>
<script src="/deferred.js" defer></script>
<script src="/gz.js" defer></script>
<script src="${THIRD}/third.js" async></script>
</head><body><h1 id="h">Fixture page</h1><div id="box" style="height:10px"></div>
<img id="big" src="/big.png" loading="lazy" style="width:200px;height:150px">
<img id="nodims" src="/small.png">
<p style="height:300px;background:silver">Shifted block</p>
<!-- ${"pad ".repeat(300)} -->
<script>
// The big file is read to its end: served to an <img> as non-image bytes,
// the browser may stop the download part way, and the totals depend on when.
fetch("/big.bin").then((r) => r.arrayBuffer());
console.error("fixture console error");
// After first paint: a layout shift, then a long task (both only count after FCP).
setTimeout(() => {
  document.getElementById("box").style.height = "200px";
  setTimeout(() => { const s = Date.now(); while (Date.now() - s < 200) {} }, 50);
}, 300);
</script></body></html>`;
const TEXT_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/blocking.css"></head>
<body><h1 id="t" style="font-size:64px">A heading set in the web font, large enough to be the largest paint on the page</h1></body></html>`;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
  if (req.url === "/text") { res.writeHead(200, { "content-type": "text/html" }); return res.end(TEXT_PAGE); }
  if (req.url === "/blocking.css") {
    res.writeHead(200, { "content-type": "text/css", "cache-control": "public, max-age=31536000, immutable" });
    return res.end('@font-face{font-family:"Fixture Sans";src:url(/font.woff2) format("woff2")}body{font-family:"Fixture Sans",sans-serif}');
  }
  if (req.url === "/print.css") { res.writeHead(200, { "content-type": "text/css", "cache-control": "max-age=31536000" }); return res.end("body{color:black}"); }
  if (req.url === "/blocking.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(PAD_JS); }
  if (req.url === "/deferred.js") { res.writeHead(200, { "content-type": "application/javascript", "cache-control": "max-age=31536000" }); return res.end("window.__d = 1;"); }
  if (req.url === "/gz.js") { res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip", "cache-control": "max-age=31536000" }); return res.end(GZ_JS); }
  if (req.url === "/third.js") { res.writeHead(200, { "content-type": "application/javascript", "cache-control": "max-age=31536000" }); return res.end("window.__t = 1;"); }
  if (req.url === "/big.png") { res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" }); return res.end(BIG_PNG); }
  if (req.url === "/small.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(SMALL_PNG); }
  if (req.url === "/font.woff2") { res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=31536000" }); return res.end(FONT); }
  if (req.url === "/big.bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(BIG); }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
THIRD = `http://localhost:${PORT}`; // the same server by another name: a second host to the page

try {
  // ---- offline input validation -------------------------------------------
  ok(pageSpeedInput({ url: "https://a.example/" }).device === "mobile", "page-speed defaults to the mobile profile");
  ok((await rejects(Promise.resolve().then(() => pageSpeedInput({ url: "ftp://x" }))))?.statusCode === 400, "page-speed refuses a non-http URL with 400");
  ok((await rejects(Promise.resolve().then(() => pageSpeedInput({ url: "https://x", device: "tv" }))))?.statusCode === 400, "page-speed refuses an unknown device with 400");
  const big = "<!doctype html>" + "x".repeat(512 * 1024);
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: big, times: [0] }))))?.statusCode === 413, "html-frames refuses a document over 512 KB");
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times: Array(13).fill(0) }))))?.statusCode === 400, "html-frames refuses more than 12 times");
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times: [] }))))?.statusCode === 400, "html-frames refuses an empty times list");
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times: [0], width: 1281 }))))?.statusCode === 400, "html-frames refuses width over 1280");
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times: [0], height: 721 }))))?.statusCode === 400, "html-frames refuses height over 720");
  ok((await rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times: [-1] }))))?.statusCode === 400, "html-frames refuses a negative time");
  ok(!FREE_TIER_SLUGS.has("page-speed") && !FREE_TIER_SLUGS.has("html-frames"), "neither tool is on the free-tier allowlist");
  // Opportunities builder, offline: site grouping and honest caps.
  ok(siteOf("cdn.example.com") === "example.com" && siteOf("a.b.example.co.uk") === "example.co.uk" && siteOf("127.0.0.1") === "127.0.0.1", "a host's site is its registrable part");
  const capped = buildOpportunities({ docUrl: "https://a.example/", consoleErrors: Array.from({ length: OPPORTUNITY_LIMITS.perClass + 5 }, (_, i) => ({ source: "console", text: `e${i}`, url: null })) });
  ok(capped.opportunities.length === OPPORTUNITY_LIMITS.perClass && capped.opportunitiesPartial.matched === OPPORTUNITY_LIMITS.perClass + 5 && capped.opportunitiesPartial.truncated === true, "a class past its cap is counted in matched and marked truncated");
  const empty = buildOpportunities({ docUrl: "https://a.example/" });
  ok(empty.opportunities.length === 0 && empty.opportunitiesPartial.complete === true, "a load with nothing to report answers an empty, complete list");

  // ---- page-speed: the public guard refuses loopback ------------------------
  hits = [];
  const blocked = await rejects(tool("page-speed").handler({ url: `${BASE}/` }));
  ok(blocked?.statusCode === 400 && /private/i.test(blocked.message), `page-speed refuses a loopback URL through the public guard (${blocked?.statusCode} ${blocked?.message})`);
  ok(hits.length === 0, "the refused URL was never fetched");

  // ---- page-speed: measure the fixture with the guard pointed at it ---------
  __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async (h) => h === "127.0.0.1" || h === "localhost" });
  try {
    const r = await tool("page-speed").handler({ url: `${BASE}/`, device: "desktop" });
    ok(r.status === 200 && r.device === "desktop" && r.viewport.width === 1350, "desktop profile and the document status are reported");
    ok(r.measurement?.kind === "lab-single-run" && r.measurement.runs === 1 && r.measurement.fieldData === false && r.measurement.lighthouseScore === false, "measurement field says one lab run, not field data, not a Lighthouse score");
    ok(/not field data/i.test(r.measurement.note) && /single lab measurement/i.test(r.measurement.note), "measurement note states the limits in words");
    ok(Number.isFinite(r.timings.ttfbMs) && r.timings.domContentLoadedMs >= r.timings.ttfbMs && r.timings.loadMs >= r.timings.domContentLoadedMs, `navigation timings are ordered (${JSON.stringify(r.timings)})`);
    ok(r.webVitals.fcpMs > 0 && r.webVitals.lcpMs > 0, `FCP and LCP are measured (${r.webVitals.fcpMs}, ${r.webVitals.lcpMs})`);
    ok(r.webVitals.cls > 0, `the layout shift is counted in CLS (${r.webVitals.cls})`);
    ok(r.webVitals.longTaskCount >= 1 && r.webVitals.totalBlockingTimeMs >= 100, `the long task shows in total blocking time (${r.webVitals.totalBlockingTimeMs} ms over ${r.webVitals.longTaskCount} tasks)`);
    ok(r.transfer.requestCount >= 4 && r.transfer.totalBytes >= BIG.length, `request count and transfer bytes cover the page (${r.transfer.requestCount} requests, ${r.transfer.totalBytes} bytes)`);
    ok(r.heaviestResources[0]?.url.endsWith("/big.bin") && r.heaviestResources[0].bytes >= BIG.length, "the heaviest resource is the big file");
    ok(r.heaviestResources.length <= 5 && r.heaviestResourcesPartial.returned === r.heaviestResources.length, "heaviest list is capped at 5 and says how many it holds");
    const rb = (r.renderBlocking || []).map((x) => x.url);
    ok(rb.some((u) => u.endsWith("/blocking.css")) && rb.some((u) => u.endsWith("/blocking.js")), `render-blocking stylesheet and script are listed (${rb.join(", ")})`);
    ok(r.consoleErrors.some((e) => /fixture console error/.test(e.text)), "the console error is captured");
    ok(r.untrustedContent === true, "page-derived text is marked untrustedContent");

    // ---- opportunities from the same load ----------------------------------
    const ops = r.opportunities;
    const byId = (id) => ops.filter((o) => o.id === id);
    const urls = (id) => byId(id).map((o) => o.url || "");
    const endsWith = (id, suffix) => urls(id).some((u) => u.endsWith(suffix));
    ok(Array.isArray(ops) && ops.length >= 12 && r.opportunitiesPartial.returned === ops.length && r.opportunitiesPartial.matched >= ops.length, `opportunities is a list with its partial fields (${ops.length} returned, ${r.opportunitiesPartial?.matched} matched)`);
    const shaped = ops.every((o) => typeof o.id === "string" && "element" in o && "url" in o && typeof o.detail === "string" && o.detail.length > 0 && "estimate" in o
      && (o.estimate === null || (typeof o.estimate === "object" && Object.keys(o.estimate).every((k) => (k === "bytes" || k === "ms") && Number.isFinite(o.estimate[k]) && o.estimate[k] > 0))));
    ok(shaped, "every opportunity carries id, element, url, detail and an estimate that is null or measured bytes/ms");
    ok(urls("render-blocking-script").length === 1 && endsWith("render-blocking-script", "/blocking.js"), `the head script without async or defer is the one render-blocking script (${urls("render-blocking-script").join(", ")})`);
    ok(!endsWith("render-blocking-script", "/deferred.js") && !endsWith("render-blocking-script", "/third.js") && !endsWith("render-blocking-script", "/gz.js"), "deferred and async scripts are not listed as render-blocking");
    ok(urls("render-blocking-stylesheet").length === 1 && endsWith("render-blocking-stylesheet", "/blocking.css"), `the matching stylesheet is the one render-blocking stylesheet, the print sheet is not (${urls("render-blocking-stylesheet").join(", ")})`);
    const rbs = byId("render-blocking-script")[0];
    ok(rbs.estimate?.bytes > 1000 && rbs.estimate?.ms > 0, `a render-blocking script carries its transfer bytes and fetch time (${JSON.stringify(rbs.estimate)})`);
    const fd = byId("font-display-missing");
    ok(fd.length === 1 && fd[0].element === "Fixture Sans" && fd[0].url.endsWith("/font.woff2") && fd[0].estimate?.bytes > 1000, `the @font-face without font-display is named with its file and bytes (${JSON.stringify(fd[0])})`);
    ok(byId("image-missing-dimensions").length === 1 && byId("image-missing-dimensions")[0].element === "img#nodims", `the unsized image is named by selector and the CSS-sized one is not (${byId("image-missing-dimensions").map((o) => o.element).join(", ")})`);
    const ov = byId("image-oversized");
    ok(ov.length === 1 && ov[0].element === "img#big" && ov[0].estimate?.bytes > 0 && ov[0].estimate.bytes < BIG_PNG.length && /400x300 px/.test(ov[0].detail) && /200x150 px/.test(ov[0].detail), `the oversized image names natural and shown sizes and the bytes beyond the shown pixels (${JSON.stringify(ov[0])})`);
    const lcp = byId("lcp-element")[0];
    ok(lcp && lcp.element === "img#big" && lcp.url.endsWith("/big.png") && lcp.lazyLoaded === true && lcp.estimate?.ms === r.webVitals.lcpMs && lcp.tag === "img", `the LCP element is the lazy image, with its selector, URL and the measured LCP ms (${JSON.stringify(lcp)})`);
    ok(byId("lcp-image-lazy-loaded").length === 1 && byId("lcp-image-lazy-loaded")[0].element === "img#big", "a lazy LCP image is its own opportunity");
    ok(endsWith("uncompressed-response", "/blocking.js") && urls("uncompressed-response").some((u) => u === `${BASE}/`), `uncompressed text responses are listed (${urls("uncompressed-response").join(", ")})`);
    ok(!endsWith("uncompressed-response", "/gz.js") && !endsWith("uncompressed-response", "/big.bin") && !endsWith("uncompressed-response", "/big.png"), "a gzipped response and binary bytes are not called uncompressed");
    ok(endsWith("missing-cache-headers", "/blocking.js") && endsWith("missing-cache-headers", "/small.png"), `static responses with no cache header are listed (${urls("missing-cache-headers").join(", ")})`);
    ok(!endsWith("missing-cache-headers", "/blocking.css") && !endsWith("missing-cache-headers", "/gz.js") && !urls("missing-cache-headers").some((u) => u === `${BASE}/`), "cached assets and the document are not listed as uncached");
    ok(urls("short-cache-lifetime").length === 1 && endsWith("short-cache-lifetime", "/big.png") && /60 s/.test(byId("short-cache-lifetime")[0].detail), `a one-minute max-age is a short lifetime (${urls("short-cache-lifetime").join(", ")})`);
    const tbt = byId("transfer-by-type")[0];
    ok(tbt && tbt.byType.image?.requests >= 2 && tbt.byType.script?.requests >= 4 && tbt.byType.font?.requests === 1 && tbt.estimate?.bytes >= BIG.length, `bytes by resource type cover the load (${JSON.stringify(tbt?.byType)})`);
    ok(endsWith("large-resource", "/big.bin") && endsWith("large-resource", "/big.png") && byId("large-resource").every((o) => o.estimate?.bytes >= 100 * 1024), `resources over 100 KB are listed with their bytes (${urls("large-resource").join(", ")})`);
    const tp = byId("third-party-host");
    ok(tp.length === 1 && tp[0].url === "localhost" && tp[0].requests >= 1 && tp[0].estimate?.bytes > 0, `the second host is counted as third party with its requests and bytes (${JSON.stringify(tp)})`);
    ok(tp.every((o) => o.url !== "127.0.0.1"), "the page's own host is not third party");
    const lt = byId("long-task");
    ok(lt.length >= 1 && lt[0].estimate?.ms >= 150 && lt[0].blockingMs >= 100, `the long task is listed with its duration (${JSON.stringify(lt[0])})`);
    ok(typeof lt[0]?.url === "string" && lt[0].url.startsWith(BASE), `the long task is attributed to the script that ran (${lt[0]?.url})`);
    const ls = byId("layout-shift");
    ok(ls.length >= 1 && ls[0].score > 0 && typeof ls[0].element === "string" && ls[0].element.length > 0, `the layout shift names the element that moved (${JSON.stringify(ls[0])})`);
    ok(byId("console-error").some((o) => /fixture console error/.test(o.detail)), "the console error is an opportunity");
    ok(byId("lcp-text-behind-web-font").length === 0, "an image LCP is not called text behind a font");
    const mobile = await tool("page-speed").handler({ url: `${BASE}/`, device: "mobile" });
    ok(mobile.viewport.width === 412 && mobile.device === "mobile", "mobile profile uses the mobile viewport");
    // At 1.75x, 200x150 CSS px need 350x263 image px: a 400x300 image is within 1.5x of that, so it is not oversized there.
    const mo = mobile.opportunities.find((o) => o.id === "image-oversized" && o.element === "img#big");
    ok(!mo && mobile.opportunities.some((o) => o.id === "lcp-element" && o.element === "img#big"), `the mobile profile judges image size at its own pixel ratio (${mo ? mo.detail : "not oversized at 1.75x"})`);
    // A text LCP set in a web font: the font that held the paint is named.
    const t = await tool("page-speed").handler({ url: `${BASE}/text`, device: "desktop" });
    const tl = t.opportunities.find((o) => o.id === "lcp-element");
    const tf = t.opportunities.find((o) => o.id === "lcp-text-behind-web-font");
    ok(tl && tl.tag === "h1" && tl.element === "h1#t" && tl.url === null && tl.webFont === "Fixture Sans", `a text LCP names its element and web font (${JSON.stringify(tl)})`);
    ok(tf && tf.element === "h1#t" && tf.url.endsWith("/font.woff2") && tf.estimate?.bytes > 1000 && /no font-display: swap/.test(tf.detail), `the font behind a text LCP is an opportunity with the font's bytes (${JSON.stringify(tf)})`);
    ok(!t.opportunities.some((o) => o.id === "lcp-image-lazy-loaded"), "a text LCP is not called a lazy image");
  } finally {
    __test.setNetworkGuard(null);
  }

  // ---- html-frames ----------------------------------------------------------
  hits = [];
  const leakDoc = `<!doctype html><html><body style="margin:0;background:#000">
<img src="${BASE}/img-leak.png">
<script>
try { fetch("${BASE}/fetch-leak").catch(() => {}); } catch (e) {}
try { new WebSocket("ws://127.0.0.1:${PORT}/ws-leak"); } catch (e) {}
try { navigator.sendBeacon("${BASE}/beacon-leak", "x"); } catch (e) {}
window.renderAt = function (t) {
  document.body.style.background = t >= 1 ? "rgb(255,0,0)" : "rgb(0,0,255)";
  if (t === 1) { location.href = "${BASE}/nav-leak"; }
};
</script></body></html>`;
  const fr = await tool("html-frames").handler({ html: leakDoc, times: [0, 1, 2], width: 64, height: 48 });
  await new Promise((r) => setTimeout(r, 300));
  ok(hits.length === 0, `no request from the document reached the listening server (${hits.join(", ") || "none"})`);
  ok(fr.network.blockedRequests >= 1, `blocked requests are counted (${fr.network.blockedRequests})`);
  ok(fr.frameCount === 3 && fr.frames.map((f) => f.t).join(",") === "0,1,2", "one still per requested time, in order");
  let decoded = 0;
  for (const f of fr.frames) {
    const png = PNG.sync.read(Buffer.from(f.pngBase64, "base64"));
    if (png.width === 64 && png.height === 48) decoded++;
  }
  ok(decoded === 3, "every still decodes as a PNG at the requested size");
  const p0 = PNG.sync.read(Buffer.from(fr.frames[0].pngBase64, "base64"));
  const p2 = PNG.sync.read(Buffer.from(fr.frames[2].pngBase64, "base64"));
  const px = (png, x, y) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
  const [r0, , b0] = px(p0, 60, 44), [r2, , b2] = px(p2, 60, 44);
  ok(b0 > 200 && r0 < 50 && r2 > 200 && b2 < 50, `renderAt(t) changed what each still shows (blue at 0, red at 2: ${px(p0, 60, 44)} / ${px(p2, 60, 44)})`);
  const sheet = PNG.sync.read(Buffer.from(fr.contactSheet.pngBase64, "base64"));
  ok(sheet.width === fr.contactSheet.width && sheet.height === fr.contactSheet.height && fr.contactSheet.columns === 2 && fr.contactSheet.rows === 2, `contact sheet decodes at its stated grid size (${sheet.width}x${sheet.height})`);
  ok(fr.totalBytes === fr.frames.reduce((a, f) => a + f.bytes, 0) + fr.contactSheet.bytes, "totalBytes adds up the stills and the sheet");

  // A window the document opens runs the same sandbox (no WebRTC, whose
  // STUN/TURN traffic no route guard sees) and is closed as it opens.
  const popupDoc = `<!doctype html><script>
var w = window.open("about:blank");
var seen = { rtc: w ? typeof w.RTCPeerConnection : "none", closedLater: null };
window.renderAt = async function () { await new Promise((r) => setTimeout(r, 300)); seen.closedLater = w ? w.closed : true; throw new Error("POPUP " + JSON.stringify(seen)); };
</script>`;
  const popup = await rejects(tool("html-frames").handler({ html: popupDoc, times: [0] }));
  const seen = JSON.parse((/POPUP (\{.*\})/.exec(popup?.message || "") || [, "{}"])[1]);
  ok(seen.rtc !== "function", `a popup has no RTCPeerConnection (${seen.rtc})`);
  ok(seen.closedLater === true, `a popup is closed as it opens (${seen.closedLater})`);
  const threw = await rejects(tool("html-frames").handler({ html: "<!doctype html><script>window.renderAt=function(t){ if (t > 0) throw new Error('boom at ' + t); };</script>", times: [0, 1] }));
  ok(threw?.statusCode === 400 && /renderAt\(1\) threw: boom at 1/.test(threw.message), `a renderAt that throws answers 400 naming the error (${threw?.message})`);
  const asyncThrew = await rejects(tool("html-frames").handler({ html: "<!doctype html><script>window.renderAt=async function(t){ await 0; throw new Error('async boom'); };</script>", times: [0] }));
  ok(asyncThrew?.statusCode === 400 && /async boom/.test(asyncThrew.message), "an async renderAt rejection answers 400");
  const loadErr = await rejects(tool("html-frames").handler({ html: "<!doctype html><script>undefinedThing.call();</script>", times: [0] }));
  ok(loadErr?.statusCode === 400 && /while loading/.test(loadErr.message), `a script error while loading answers 400 (${loadErr?.message})`);
  const missing = await rejects(tool("html-frames").handler({ html: "<!doctype html><p>no function</p>", times: [0] }));
  ok(missing?.statusCode === 400 && /renderAt/.test(missing.message), "a document without renderAt answers 400");
  const hang = await rejects(tool("html-frames").handler({ html: "<!doctype html><script>window.renderAt=()=>new Promise(()=>{});</script>", times: [0] }));
  ok(hang?.statusCode === 400 && /did not finish/.test(hang.message), "a renderAt that never resolves answers 400 at the per-frame limit");
  // Every frame just under the per-frame limit: the document's total budget
  // ends the run, so one unpaid run cannot hold a slot for twelve frame limits.
  const slowStart = Date.now();
  const slow = await rejects(tool("html-frames").handler({ html: `<!doctype html><script>window.renderAt=()=>new Promise((r)=>setTimeout(r, ${HTML_FRAMES_LIMITS.frameTimeoutMs - 500}));</script>`, times: Array(12).fill(0).map((_, i) => i) }));
  const slowMs = Date.now() - slowStart;
  ok(slow?.statusCode === 400 && /budget/.test(slow.message), `a run past the document's total budget answers 400 (${slow?.message})`);
  ok(slowMs < HTML_FRAMES_LIMITS.totalTimeoutMs + 8_000, `and ends near the total budget, not after twelve frame limits (${slowMs} ms)`);
  // A saturated pool answers 503 with a retry delay (the binder sends it as Retry-After).
  for (let i = 0; i < __test.MAX_CONCURRENT; i++) await __test.acquireSlot();
  __test.setQueueDeadline(50);
  try {
    const busy = await rejects(tool("html-frames").handler({ html: "<!doctype html><script>window.renderAt=()=>{}</script>", times: [0] }));
    ok(busy?.statusCode === 503 && Number.isInteger(busy.retryAfter) && busy.retryAfter > 0, `a saturated pool answers 503 with retryAfter (${busy?.statusCode}, ${busy?.retryAfter})`);
    const busyPs = await rejects(tool("page-speed").handler({ url: "https://93.184.216.34/" }));
    ok(busyPs?.statusCode === 503 && Number.isInteger(busyPs.retryAfter), "page-speed shares the same pool limit");
  } finally {
    for (let i = 0; i < __test.MAX_CONCURRENT; i++) __test.releaseSlot();
    __test.setQueueDeadline(20_000);
  }
  const st = __test.state();
  ok(st.active === 0 && st.queued === 0, `every pool slot was released (${JSON.stringify(st)})`);
} catch (e) {
  fail++;
  console.log(`FAIL - suite crashed: ${e?.stack || e}`);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
