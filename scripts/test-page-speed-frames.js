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
// html-frames: the document's own requests (fetch, img, navigation, socket)
// must never reach a listening server and must be counted as blocked; a
// renderAt that throws, a load-time error and a missing renderAt answer 400;
// input caps refuse; and every PNG returned decodes at the size asked for.
//
// frame check (compare): identical baseline stills score similarity 1 with
// no changed regions; a moved shape scores below 1 and lists a region that
// covers it; a frame without a baseline is returned uncompared; the caps
// (still count, still size, total bytes) are the tool's own; a loopback
// baselineUrl is refused by the public-URL guard with nothing fetched, and
// with the fetch pointed at the fixture the second document renders under the
// same contract; only that body is quoted at twice the price.
//
//   node scripts/test-page-speed-frames.js
import http from "node:http";
import { PNG } from "pngjs";
import { __test, HTML_FRAMES_LIMITS } from "../src/tools/render.js";
import { BROWSER_MEASURE_TOOLS, htmlFramesInput, pageSpeedInput, __test as kitTest } from "../src/tools/browser-measure-kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const tool = (slug) => BROWSER_MEASURE_TOOLS.find((t) => t.slug === slug);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
// A document under the render contract: a 12 px square at x = shift + 20 t.
const contractDoc = (shift) => `<!doctype html><html><body style="margin:0"><canvas id="c" width="64" height="48"></canvas><script>
const x = document.getElementById('c').getContext('2d');
window.renderAt = function (t) { x.fillStyle = '#10243e'; x.fillRect(0, 0, 64, 48); x.fillStyle = '#4cc38a'; x.fillRect(${shift} + t * 20, 14, 12, 12); };
</script></body></html>`;
const solidPng = (w, h, rgb) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h * 4; i += 4) { p.data[i] = rgb[0]; p.data[i + 1] = rgb[1]; p.data[i + 2] = rgb[2]; p.data[i + 3] = 255; } return PNG.sync.write(p); };
const b64 = (buf) => buf.toString("base64");

// ---- fixture server ------------------------------------------------------
let hits = [];
const BIG = Buffer.alloc(300_000, 7);
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head>
<link rel="stylesheet" href="/blocking.css">
<script src="/blocking.js"></script>
</head><body><h1 id="h">Fixture page</h1><div id="box" style="height:10px"></div>
<p style="height:300px;background:silver">Shifted block</p>
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
</script></body></html>`);
  }
  if (req.url === "/blocking.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end("body{font-family:sans-serif}"); }
  if (req.url === "/blocking.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("window.__x = 1;"); }
  if (req.url === "/big.bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(BIG); }
  // Baseline documents for the frame check by baselineUrl.
  if (req.url === "/contract.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(contractDoc(28)); }
  if (req.url === "/no-contract.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><p>no function</p>"); }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

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

  // ---- compare: the frame-check input, offline -------------------------------
  const tiny = solidPng(16, 16, [0, 0, 0]);
  const cmp = (compare, times = [0, 1], L) => rejects(Promise.resolve().then(() => htmlFramesInput({ html: "<p>", times, compare }, L)));
  ok(htmlFramesInput({ html: "<p>", times: [0] }).compare === null, "no compare validates to null; the other fields keep their defaults");
  ok((await cmp({ baseline: [{ t: 0, png: b64(tiny) }], baselineUrl: "https://x" }))?.statusCode === 400, "compare refuses baseline and baselineUrl together");
  ok((await cmp({}))?.statusCode === 400 && (await cmp("x"))?.statusCode === 400, "compare refuses an empty object and a non-object");
  const many = await cmp({ baseline: Array(HTML_FRAMES_LIMITS.maxFrames + 1).fill({ t: 0, png: b64(tiny) }) });
  ok(many?.statusCode === 400 && new RegExp(`cap is ${HTML_FRAMES_LIMITS.maxFrames}`).test(many.message), `compare.baseline refuses more stills than the times cap (${many?.message})`);
  ok((await cmp({ baseline: [{ t: 2, png: b64(tiny) }] }))?.statusCode === 400, "a baseline t outside the requested times is refused");
  ok((await cmp({ baseline: [{ t: 0, png: b64(tiny) }, { t: 0, png: b64(tiny) }] }))?.statusCode === 400, "a duplicate baseline t is refused");
  ok((await cmp({ baseline: [{ t: 0, png: b64(Buffer.from("not a png")) }] }))?.statusCode === 400, "a baseline that is not a PNG is refused");
  ok((await cmp({ baseline: [{ t: 0 }] }))?.statusCode === 400, "a baseline entry without png is refused");
  const wide = Buffer.from(tiny); wide.writeUInt32BE(HTML_FRAMES_LIMITS.maxWidth + 1, 16);
  const tall = Buffer.from(tiny); tall.writeUInt32BE(HTML_FRAMES_LIMITS.maxHeight + 1, 20);
  ok((await cmp({ baseline: [{ t: 0, png: b64(wide) }] }))?.statusCode === 413 && (await cmp({ baseline: [{ t: 0, png: b64(tall) }] }))?.statusCode === 413, `a baseline whose header declares a side over ${HTML_FRAMES_LIMITS.maxWidth}x${HTML_FRAMES_LIMITS.maxHeight} is refused by its header with 413`);
  const overBytes = await cmp({ baseline: [{ t: 0, png: b64(tiny) }] }, [0], { ...HTML_FRAMES_LIMITS, maxOutputBytes: tiny.length - 1 });
  ok(overBytes?.statusCode === 413 && /MB of PNG/.test(overBytes.message), "baseline bytes past the output cap answer 413");
  ok(HTML_FRAMES_LIMITS.maxOutputBytes === 8 * 1024 * 1024 && HTML_FRAMES_LIMITS.maxFrames === 12, "the compare caps are the tool's own caps (12 stills, 8 MB)");
  ok((await cmp({ baselineUrl: "ftp://x" }))?.statusCode === 400 && (await cmp({ baselineUrl: "   " }))?.statusCode === 400, "baselineUrl must be an http(s) URL");
  const dataUrl = htmlFramesInput({ html: "<p>", times: [0], compare: { baseline: [{ t: "0", png: `data:image/png;base64,${b64(tiny)}` }] } }).compare.baseline[0];
  ok(dataUrl.t === 0 && Buffer.isBuffer(dataUrl.png) && dataUrl.png.length === tiny.length, "a baseline still may be a data URL and its t a numeric string");
  ok(htmlFramesInput({ html: "<p>", times: [0], compare: { baselineUrl: " https://a.example/x " } }).compare.baselineUrl === "https://a.example/x", "baselineUrl is trimmed");
  // The quote: twice the listed price only when a second document is rendered.
  const def = tool("html-frames");
  const P = Number(def.price.replace("$", ""));
  ok(P > 0 && def.quote({ html: "x", times: [0] }) === P && def.quote({ compare: { baseline: [{ t: 0, png: "x" }] } }) === P, "a plain call and a compare by stills are quoted at the listed price");
  ok(def.quote({ compare: { baselineUrl: "https://x" } }) === 2 * P && def.quoteMaxUsd === 2 * P, "a compare by baselineUrl is quoted at twice the listed price, the declared ceiling");
  ok(def.description.includes(`$${2 * P}`) && /twice the listed price/.test(def.description), "the description says so with the derived figure");
  ok(/^Freeze frames of an animation under the render contract: the page defines window\.renderAt\(t\)\. The tool/.test(def.description), "the first sentence states the contract, whole, in under 120 characters");
  ok(["render-contract", "renderat", "contact-sheet", "frame-check", "freeze-frames"].every((a) => def.aliases.includes(a)), "aliases carry the render-contract vocabulary");
  ok(def.discovery.inputSchema.properties.compare?.properties?.baseline && def.discovery.inputSchema.properties.compare?.properties?.baselineUrl && def.discovery.inputSchema.required.join() === "html,times", "compare is in the schema and optional");

  // ---- page-speed: the public guard refuses loopback ------------------------
  hits = [];
  const blocked = await rejects(tool("page-speed").handler({ url: `${BASE}/` }));
  ok(blocked?.statusCode === 400 && /private/i.test(blocked.message), `page-speed refuses a loopback URL through the public guard (${blocked?.statusCode} ${blocked?.message})`);
  ok(hits.length === 0, "the refused URL was never fetched");

  // ---- page-speed: measure the fixture with the guard pointed at it ---------
  __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async (h) => h === "127.0.0.1" });
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
    const mobile = await tool("page-speed").handler({ url: `${BASE}/`, device: "mobile" });
    ok(mobile.viewport.width === 412 && mobile.device === "mobile", "mobile profile uses the mobile viewport");
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

  // ---- frame check (compare) --------------------------------------------------
  const run = (html, extra = {}) => tool("html-frames").handler({ html, times: [0, 1], width: 64, height: 48, ...extra });
  const ref = await run(contractDoc(4));
  ok(!("compare" in ref) && !("similarity" in ref.frames[0]), "without compare the answer carries no compare fields");
  // Identical baseline: the stills of an earlier call of the same document.
  const same = await run(contractDoc(4), { compare: { baseline: ref.frames.map((f) => ({ t: f.t, png: f.pngBase64 })) } });
  ok(same.frames.every((f) => f.similarity === 1 && f.changedCells === 0 && f.changedRegions.length === 0), `identical baselines score 1 with no changed regions (${same.frames.map((f) => f.similarity).join(",")})`);
  ok(same.compare.source === "baseline" && same.compare.framesCompared === 2 && same.compare.framesWithoutBaseline === 0 && same.compare.minSimilarity === 1 && same.frames[0].changedRegionsPartial.complete === true, "the compare block counts the frames compared and the minimum");
  ok(same.frameCount === 2 && same.contactSheet.pngBase64 && same.totalBytes > 0, "the stills and the sheet are still returned");
  // Changed baseline: the square sits 24 px to the right at t = 0.
  const moved = await run(contractDoc(28));
  const changed = await run(contractDoc(4), { compare: { baseline: [{ t: 0, png: moved.frames[0].pngBase64 }] } });
  const c0 = changed.frames[0];
  ok(c0.similarity > 0 && c0.similarity < 1 && c0.changedCells > 0 && c0.changedRegions.length >= 1, `a moved shape lowers similarity and lists regions (${c0.similarity}, ${c0.changedRegions.length} regions)`);
  const box = c0.changedRegions[0];
  const covers = (b, x0, x1) => b.x <= x0 && b.x + b.width >= x1 && b.y <= 14 && b.y + b.height >= 26;
  ok(c0.changedRegions.some((b) => covers(b, 4, 16)) && c0.changedRegions.some((b) => covers(b, 28, 40)), `the regions cover both positions of the square (${JSON.stringify(c0.changedRegions)})`);
  ok(Number.isInteger(box.x) && Number.isInteger(box.y) && box.width > 0 && box.height > 0 && box.x + box.width <= 64 && box.y + box.height <= 48 && box.meanDelta > 0, "a region is a pixel box inside the still with its mean delta");
  ok(changed.frames[1].similarity === null && changed.frames[1].changedRegions === null, "a frame with no baseline still is returned uncompared");
  ok(changed.compare.framesCompared === 1 && changed.compare.framesWithoutBaseline === 1 && changed.compare.minSimilarity === c0.similarity, "counts and the minimum follow the compared frames");
  // A baseline of another size compares on the same grid (a solid dark still
  // at a quarter of the size: the square is the only difference).
  const small = await run(contractDoc(4), { compare: { baseline: [{ t: 1, png: b64(solidPng(32, 24, [0x10, 0x24, 0x3e])) }] } });
  ok(small.frames[1].similarity < 1 && small.frames[1].changedRegions.some((b) => covers(b, 24, 36)), `a baseline still of another size is compared by region (${JSON.stringify(small.frames[1].changedRegions)})`);
  // baselineUrl: a loopback URL is refused by the public-URL guard, nothing fetched.
  hits = [];
  const refused = await rejects(run(contractDoc(4), { compare: { baselineUrl: `${BASE}/contract.html` } }));
  ok(refused?.statusCode === 400 && /private/i.test(refused.message) && /baselineUrl/.test(refused.message), `a loopback baselineUrl is refused by the public-URL guard (${refused?.statusCode} ${refused?.message})`);
  ok(hits.length === 0, "and nothing was fetched");
  // With the fetch pointed at the fixture: the second document renders under
  // the same contract, at the same times and size.
  kitTest.setBaselineFetch(async (url) => { const r = await fetch(url); return { html: await r.text(), finalUrl: url }; });
  try {
    hits = [];
    const viaUrl = await run(contractDoc(4), { compare: { baselineUrl: `${BASE}/contract.html` } });
    ok(hits.filter((h) => h === "/contract.html").length === 1, `the baseline document was fetched once (${hits.join(", ")})`);
    ok(viaUrl.compare.source === "baselineUrl" && viaUrl.compare.baselineUrl === `${BASE}/contract.html` && viaUrl.compare.baselineRender.frameCount === 2 && viaUrl.compare.baselineRender.network.blockedRequests === 0 && viaUrl.compare.framesCompared === 2 && !("pngBase64" in viaUrl.compare.baselineRender), "both frames compared against the second document, whose stills are not returned");
    ok(same.compare.baselineStills === 2 && changed.compare.baselineStills === 1, "a compare by stills reports how many stills it was given");
    ok(viaUrl.frames.every((f) => f.similarity < 1 && f.changedRegions.length >= 1), `the shifted document differs at every t (${viaUrl.frames.map((f) => f.similarity).join(",")})`);
    const sameUrl = await run(contractDoc(28), { compare: { baselineUrl: `${BASE}/contract.html` } });
    ok(sameUrl.frames.every((f) => f.similarity === 1 && f.changedRegions.length === 0), "the same document by URL scores 1 at every t");
    const badBase = await rejects(run(contractDoc(4), { compare: { baselineUrl: `${BASE}/no-contract.html` } }));
    ok(badBase?.statusCode === 400 && /baselineUrl/.test(badBase.message) && /renderAt/.test(badBase.message), `a baseline document without renderAt answers 400 naming the baseline (${badBase?.message})`);
    const missingBase = await rejects(run(contractDoc(4), { compare: { baselineUrl: `${BASE}/missing.html` } }));
    ok(missingBase?.statusCode === 400 && /baselineUrl/.test(missingBase.message) && /renderAt/.test(missingBase.message), "a baseline URL that answers a page without the contract is refused the same way");
  } finally {
    kitTest.setBaselineFetch(null);
  }
  const st0 = __test.state();
  ok(st0.active === 0 && st0.queued === 0, `every frame-check run released its pool slots (${JSON.stringify(st0)})`);

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
