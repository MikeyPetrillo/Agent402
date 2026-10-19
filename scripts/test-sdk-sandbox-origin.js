// The SDK playground's eval document (/sdk-playground/sandbox) runs code only
// for the page that frames it. A page on another origin that opens it (or
// frames it) must not get code run there, and the document must carry an
// opaque origin however it is reached. The playground's own Run button must
// keep working. Real Chromium against a booted server.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-sdk-sandbox-origin.js
import http from "node:http";
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The other origin: same loopback, different host name and port.
const target = new URL(BASE);
const attackerPage = `<!doctype html><meta charset="utf-8"><body><script>
window.results = { opener: [], frame: [] };
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (d && d.pwned) window.results[d.via].push(d);
});
var code = "var o = window.opener || window.parent; o.postMessage({pwned: true, via: VIA, origin: String(self.origin)}, '*');";
window.openIt = function () {
  var w = window.open(${JSON.stringify(BASE)} + '/sdk-playground/sandbox');
  var n = 0;
  var t = setInterval(function () {
    try { w.postMessage({ type: 'run', code: code.replace('VIA', '"opener"') }, '*'); } catch (e) {}
    if (++n > 20) clearInterval(t);
  }, 100);
};
window.frameIt = function () {
  var f = document.createElement('iframe');
  f.src = ${JSON.stringify(BASE)} + '/sdk-playground/sandbox';
  document.body.appendChild(f);
  var n = 0;
  var t = setInterval(function () {
    try { f.contentWindow.postMessage({ type: 'run', code: code.replace('VIA', '"frame"') }, '*'); } catch (e) {}
    if (++n > 20) clearInterval(t);
  }, 100);
};
</script></body>`;
const attacker = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(attackerPage); });
await new Promise((r) => attacker.listen(0, "127.0.0.1", r));
const otherHost = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
const ATTACKER = `http://${otherHost}:${attacker.address().port}/`;

const browser = await chromium.launch();
try {
  // Response headers: the document is sandboxed by its own CSP.
  const res = await fetch(`${BASE}/sdk-playground/sandbox`);
  const csp = res.headers.get("content-security-policy") || "";
  ok(/(^|;)\s*sandbox allow-scripts\s*(;|$)/.test(csp), `CSP sandboxes the document with scripts only (got ${csp})`);
  ok(!/allow-same-origin/.test(csp), "CSP never grants allow-same-origin");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(ATTACKER);

  // Opener path: open the sandbox in a new window and post a run message.
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.evaluate(() => window.openIt())]);
  await popup.waitForLoadState("load");
  await page.waitForTimeout(2500);
  const viaOpener = await page.evaluate(() => window.results.opener);
  ok(viaOpener.length === 0, `an opener on another origin cannot run code in the sandbox (got ${JSON.stringify(viaOpener)})`);
  const popupOrigin = await popup.evaluate(() => String(self.origin));
  ok(popupOrigin === "null", `a top-level visit gets an opaque origin (got ${popupOrigin})`);
  await popup.close();

  // Frame path: another origin frames it without the sandbox attribute.
  await page.evaluate(() => window.frameIt());
  await page.waitForTimeout(2500);
  const viaFrame = await page.evaluate(() => window.results.frame);
  ok(viaFrame.length === 0, `a frame on another origin cannot run code in the sandbox (got ${JSON.stringify(viaFrame)})`);

  // The playground's own Run button still runs code in the sandbox.
  const own = await ctx.newPage();
  await own.goto(`${BASE}/sdk-playground`, { waitUntil: "load" });
  await own.fill("#spCode", "console.log('sandbox-alive-' + (6 * 7));");
  await own.click("#spRun");
  await own.waitForFunction(() => /sandbox-alive-42/.test(document.getElementById("spResult").textContent), null, { timeout: 15000 }).catch(() => {});
  const out = await own.evaluate(() => document.getElementById("spResult").textContent);
  ok(/sandbox-alive-42/.test(out), `the playground's Run still runs code (output ${JSON.stringify(out.slice(0, 120))})`);
} finally {
  await browser.close();
  attacker.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
