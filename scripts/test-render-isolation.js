#!/usr/bin/env node
// The in-process browser contexts (src/tools/render.js) block service workers
// and refuse WebSocket connections: neither is a request context.route sees,
// so the per-request public-host check would never run for them. A fixture
// server on 127.0.0.1:0 serves a page that registers a service worker and
// opens a WebSocket back to the same server; the network guard is pointed at
// the fixture for the test (as test-page-speed-frames.js does), so the only
// thing standing between the page and the socket is the context itself.
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
