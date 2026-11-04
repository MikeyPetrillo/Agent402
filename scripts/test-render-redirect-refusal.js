// A page whose main navigation the egress policy refuses fails the call.
//
// The route guard in render.js does not see redirect hops; the validating
// egress proxy does, and refuses them. Before, Chromium rendered the proxy's
// refusal as the page and render answered 200 with that text. Now:
//   1. the proxy answers every refusal with one fixed text, whatever the
//      reason (a name that does not resolve and a private address read the
//      same), on the plain-HTTP path and on CONNECT;
//   2. render and screenshot answer 400 (never charged) when any hop of the
//      page's main navigation was refused, over http and https, and the
//      answer never names the refused host or the reason;
//   3. (control) a public page, and a public page that redirects to another
//      public page, still render.
// "Public" is 127.0.0.1 and "private" is localhost: the network guard is
// pointed at the fixture through the test seam, and the in-process proxy
// honors that guard. Needs Playwright's Chromium; under CI a missing browser
// fails, it never skips.
//
//   node scripts/test-render-redirect-refusal.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import net from "node:net";
import { resolvePinned, startEgressProxy, EGRESS_REFUSAL } from "../worker/egress-proxy.js";
import { __test, renderArticle, screenshotPage } from "../src/tools/render.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- 1. the proxy's refusal text --------------------------------------------
ok(typeof EGRESS_REFUSAL === "string" && EGRESS_REFUSAL.length > 0, "the proxy exports one refusal text");
const reasonOf = async (host) => { try { await resolvePinned(host); return null; } catch (e) { return e.message; } };
const reasons = await Promise.all(["127.0.0.1", "localhost", "nonexistent-zz9.invalid", "10.0.0.1", "fd00::1"].map(reasonOf));
ok(reasons.every((r) => r === EGRESS_REFUSAL), `resolvePinned refuses a private literal, a private name and a name that does not resolve with the same text (${JSON.stringify([...new Set(reasons)])})`);
{
  const proxy = await startEgressProxy();
  const raw = (payload) => new Promise((resolve) => {
    const s = net.connect(proxy.port, "127.0.0.1", () => s.write(payload));
    let buf = "";
    s.on("data", (d) => { buf += d; });
    s.on("close", () => resolve(buf));
    s.on("error", () => resolve(buf));
    setTimeout(() => { try { s.destroy(); } catch { /* */ } resolve(buf); }, 4000);
  });
  const bodyOf = (r) => r.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const plain = await Promise.all(["localhost", "nonexistent-zz9.invalid", "127.0.0.1"].map((h) => raw(`GET http://${h}/x HTTP/1.1\r\nHost: ${h}\r\nConnection: close\r\n\r\n`)));
  ok(plain.every((r) => /^HTTP\/1\.1 403/.test(r)) && plain.every((r) => bodyOf(r) === EGRESS_REFUSAL),
    `plain-HTTP refusals are 403 with the same body for every reason (${JSON.stringify([...new Set(plain.map(bodyOf))])})`);
  const tunnel = await Promise.all(["localhost:443", "nonexistent-zz9.invalid:443", "169.254.169.254:80"].map((t) => raw(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`)));
  ok(tunnel.every((r) => /^HTTP\/1\.1 403/.test(r)) && tunnel.every((r) => bodyOf(r) === EGRESS_REFUSAL),
    `CONNECT refusals are 403 with the same body for every reason (${JSON.stringify([...new Set(tunnel.map(bodyOf))])})`);
  const ftp = await raw("GET ftp://example.com/x HTTP/1.1\r\nHost: example.com\r\n\r\n");
  ok(/^HTTP\/1\.1 403/.test(ftp) && bodyOf(ftp) === EGRESS_REFUSAL, "a non-http target through the plain path reads the same refusal");
  await proxy.close();
}

// ---- 2 and 3. render and screenshot through the in-process proxy -------------
if (process.env.RENDER_EGRESS_PROXY_URL) {
  ok(false, "run without RENDER_EGRESS_PROXY_URL: this suite drives the in-process proxy");
} else {
  let chromiumOk = true;
  try { const { chromium } = await import("playwright"); const b = await chromium.launch(); await b.close(); } catch (e) { chromiumOk = false; var launchErr = e; }
  if (!chromiumOk) {
    const msg = `Playwright Chromium is not available (${String(launchErr?.message || launchErr).split("\n")[0]})`;
    if (process.env.CI) ok(false, msg); else console.log(`SKIP - ${msg}`);
  } else {
    const privHits = [];
    const priv = http.createServer((req, res) => { privHits.push(req.url); res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><article><h1>PRIVATE</h1></article></body></html>"); });
    await new Promise((r) => priv.listen(0, "127.0.0.1", r));
    const privPort = priv.address().port;
    const pub = http.createServer((req, res) => {
      const page = (t) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<html><head><title>${t}</title></head><body><article><h1>${t}</h1><p>${t} body text, long enough to read as an article.</p></article></body></html>`); };
      if (req.url === "/ok") return page("Public page");
      if (req.url === "/to-public") { res.writeHead(302, { location: "/ok" }); return res.end(); }
      if (req.url === "/to-private") { res.writeHead(302, { location: `http://localhost:${privPort}/via-redirect` }); return res.end(); }
      if (req.url === "/to-unresolvable") { res.writeHead(302, { location: "http://nonexistent-zz9.invalid/x" }); return res.end(); }
      if (req.url === "/to-private-tls") { res.writeHead(302, { location: `https://localhost:${privPort}/via-tls` }); return res.end(); }
      if (req.url === "/two-hops") { res.writeHead(302, { location: "/to-private" }); return res.end(); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => pub.listen(0, "127.0.0.1", r));
    const PUB = `http://127.0.0.1:${pub.address().port}`;
    const outcome = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };
    try {
      __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async (h) => h === "127.0.0.1" });
      const okPage = await outcome(() => renderArticle(`${PUB}/ok`));
      ok(okPage.value && /Public page body text/.test(okPage.value.markdown || okPage.value.text || JSON.stringify(okPage.value)), `(control) a public page renders (${okPage.error?.message || "200"})`);
      const hop = await outcome(() => renderArticle(`${PUB}/to-public`));
      ok(hop.value && /Public page body text/.test(JSON.stringify(hop.value)), `(control) a public redirect to a public page renders (${hop.error?.message || "200"})`);

      const answers = {};
      for (const path of ["/to-private", "/to-unresolvable", "/to-private-tls", "/two-hops"]) {
        const r = await outcome(() => renderArticle(`${PUB}${path}`));
        answers[path] = r;
        ok(r.error && r.error.statusCode === 400, `render of a page whose navigation ${path.slice(1)} answers 400, not a charged 200 (${r.error ? `${r.error.statusCode} ${r.error.message}` : `200 ${JSON.stringify(r.value).slice(0, 120)}`})`);
        ok(!/localhost|nonexistent|private\/reserved|cannot resolve|not a public host|blocked/.test(r.error ? r.error.message : JSON.stringify(r.value)), `the ${path.slice(1)} answer names neither the refused host nor the reason`);
      }
      const msgs = new Set(Object.values(answers).map((r) => r.error?.message));
      ok(msgs.size === 1, `a private target and a name that does not resolve answer the same text (${JSON.stringify([...msgs])})`);
      const shot = await outcome(() => screenshotPage(`${PUB}/to-private`));
      ok(shot.error && shot.error.statusCode === 400, `screenshot of the redirecting page answers 400 (${shot.error ? shot.error.statusCode : "200"})`);
      ok(privHits.length === 0, `the private host is never reached (hits: ${JSON.stringify(privHits)})`);
    } finally {
      __test.setNetworkGuard(null);
      pub.close();
      priv.close();
    }
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
