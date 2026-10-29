#!/usr/bin/env node
// The in-process browser contexts (src/tools/render.js) block service workers
// and refuse WebSocket connections: neither is a request context.route sees,
// so the per-request public-host check would never run for them. A fixture
// server on 127.0.0.1:0 serves a page that registers a service worker and
// opens a WebSocket back to the same server; the network guard is pointed at
// the fixture for the test (as test-page-speed-frames.js does), so the only
// thing standing between the page and the socket is the context itself.
// A second fixture pair checks redirect hops and popups, which context.route
// does not see, against the in-process validating egress proxy.
// Needs Playwright's Chromium; under CI a missing browser fails, it never skips.
//
//   node scripts/test-render-isolation.js
import http from "node:http";
import { readFileSync } from "node:fs";
import { __test } from "../src/tools/render.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- source: every in-process context sets the option -------------------------------
{
  const src = readFileSync(new URL("../src/tools/render.js", import.meta.url), "utf8");
  const contexts = (src.match(/newContext\(/g) || []).length;
  ok(contexts === 2, `two newContext call sites (inSlot and rasterizeSvg), found ${contexts}`);
  ok(/\.\.\.\(contextOptions \|\| \{\}\),\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*serviceWorkers: "block",/.test(src), "withPage sets serviceWorkers: block after the caller's options (not overridable)");
  ok(/newContext\(\{ viewport: \{ width, height \}, serviceWorkers: "block" \}\)/.test(src), "rasterizeSvg's context blocks service workers");
  ok((src.match(/await refuseWebSockets\(context\)/g) || []).length === 2, "withPage and html-frames both refuse WebSockets");
}

let wsUpgrades = 0;
const hits = [];
const PAGE = `<!doctype html><title>t</title><script>
window.__result = { sw: "pending", ws: "pending" };
(async () => {
  try {
    if (!navigator.serviceWorker) { window.__result.sw = "unavailable"; }
    else { await navigator.serviceWorker.register("/sw.js"); window.__result.sw = "registered"; }
  } catch (e) { window.__result.sw = "refused"; }
})();
try {
  const ws = new WebSocket("ws://" + location.host + "/ws");
  ws.onopen = () => { window.__result.ws = "open"; };
  ws.onerror = () => { if (window.__result.ws === "pending") window.__result.ws = "error"; };
  ws.onclose = () => { if (window.__result.ws === "pending") window.__result.ws = "closed"; };
} catch (e) { window.__result.ws = "threw"; }
</script>`;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("self.addEventListener('fetch', () => {});"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
server.on("upgrade", (req, socket) => {
  wsUpgrades++;
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

try {
  __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async (h) => h === "127.0.0.1" });
  let result = null;
  try {
    result = await __test.withPage(`${BASE}/`, async (page) => {
      await page.waitForFunction(() => window.__result && window.__result.sw !== "pending" && window.__result.ws !== "pending", null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      return { ...(await page.evaluate(() => window.__result)), workers: page.context().serviceWorkers().length };
    });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch|Browser unavailable/i.test(String(e?.message))) {
      const msg = `Chromium is not installed (${String(e.message).split("\n")[0]})`;
      if (process.env.CI) { console.error(`FAIL - ${msg}`); process.exit(1); }
      console.log(`SKIP - ${msg}`); process.exit(0);
    }
    throw e;
  }
  // Playwright's block stubs register() (it may still resolve): what counts is
  // that no worker exists and its script was never fetched.
  ok(result && result.workers === 0 && !hits.includes("/sw.js"), `no service worker runs and its script is never fetched (workers ${result?.workers}, register ${result?.sw}, fetched ${hits.includes("/sw.js")})`);
  ok(wsUpgrades === 0 && result?.ws !== "open", `the page's WebSocket never reaches the server (upgrades ${wsUpgrades}, socket ${result?.ws})`);
  ok(hits.includes("/"), "(control) the page itself was served through the guard");
} finally {
  __test.setNetworkGuard(null);
  server.close();
}

// --- redirects and popups: hops context.route does not see ---------------------------
// "Public" is 127.0.0.1 and "private" is localhost (the guard is pointed at the
// fixture as above). A top-level 302 and a subresource 302 to the private
// server, and a popup opened at it, must never reach it: with no render worker
// configured the browser runs through the in-process validating proxy, which
// checks every connection, and a popup window is closed as it opens.
if (!process.env.RENDER_EGRESS_PROXY_URL) {
  const privHits = [];
  const priv = http.createServer((req, res) => { privHits.push(req.url); res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><article><h1>PRIVATE</h1></article></body></html>"); });
  await new Promise((r) => priv.listen(0, "127.0.0.1", r));
  const PRIV = `http://localhost:${priv.address().port}`;
  const pubHits = [];
  const pub = http.createServer((req, res) => {
    pubHits.push(req.url);
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body><article><h1>Public page</h1><p>public body text</p></article></body></html>"); }
    if (req.url === "/redir") { res.writeHead(302, { location: `${PRIV}/via-redirect` }); return res.end(); }
    if (req.url === "/subredir") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<html><body><img src="/redir-img"><p>x</p></body></html>'); }
    if (req.url === "/redir-img") { res.writeHead(302, { location: `${PRIV}/via-subresource-redirect` }); return res.end(); }
    if (req.url === "/popup-pub") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<html><body><p>x</p><script>window.open("/popup-target")</script></body></html>'); }
    if (req.url === "/popup-target") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<html><body><p>t</p><script>setTimeout(() => { new Image().src = "/popup-alive"; }, 200)</script></body></html>'); }
    if (req.url === "/popup-alive") { res.writeHead(204); return res.end(); }
    if (req.url === "/popup") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><body><p>x</p><script>window.open(${JSON.stringify(`${PRIV}/via-popup`)})</script></body></html>`); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => pub.listen(0, "127.0.0.1", r));
  const PUB = `http://127.0.0.1:${pub.address().port}`;
  try {
    __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async (h) => h === "127.0.0.1" });
    const html = await __test.withPage(`${PUB}/ok`, (page) => page.content());
    ok(/public body text/.test(html), "(control) a public page renders through the in-process proxy");
    for (const path of ["/redir", "/subredir", "/popup"]) {
      await __test.withPage(`${PUB}${path}`, async (page) => { await page.waitForTimeout(500); return page.content(); }).catch(() => null);
    }
    ok(privHits.length === 0, `redirect hops and popups never reach a private host (private hits: ${JSON.stringify(privHits)})`);
    // A popup to a public page is closed as it opens: its script never runs.
    await __test.withPage(`${PUB}/popup-pub`, async (page) => { await page.waitForTimeout(1000); return page.content(); }).catch(() => null);
    ok(pubHits.includes("/popup-pub") && !pubHits.includes("/popup-alive"), `a popup window is closed as it opens (public hits: ${JSON.stringify(pubHits.filter((u) => u.startsWith("/popup")))})`);
  } finally {
    __test.setNetworkGuard(null);
    pub.close();
    priv.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
