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
//   node scripts/test-page-speed-frames.js
import http from "node:http";
import { PNG } from "pngjs";
import { __test } from "../src/tools/render.js";
import { BROWSER_MEASURE_TOOLS, htmlFramesInput, pageSpeedInput } from "../src/tools/browser-measure-kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const tool = (slug) => BROWSER_MEASURE_TOOLS.find((t) => t.slug === slug);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

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
<p style="height:300px;background:silver">Shifted block</p><img src="/big.bin" width="10" height="10">
<script>
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
    ok(/not field data/i.test(r.measurement.note) && /not a Lighthouse score/i.test(r.measurement.note), "measurement note states the limits in words");
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
