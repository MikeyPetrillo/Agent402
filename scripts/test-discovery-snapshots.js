// The free discovery documents (/.well-known/x402 and its aliases,
// /openapi.json, /llms.txt, /llms-full.txt, /api/pricing) are answered from
// their last good copy while the load gate sheds free work, instead of a 503:
// an agent reading how to buy is the first step of a purchase
// (src/discovery-snapshots.js, wired in src/server.js).
//
// Caller path: a FREE_MODE boot with SHED_INFLIGHT=4. Each document is read
// once while the server is idle (its copy is kept), then four paid-route POSTs
// are held open mid-body (protected routes, so they pass the gate and count in
// flight), and each document is read again: it must answer 200 with the same
// bytes, marked with its age, while an unprotected page is still shed 503.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { request } from "node:http";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Unit: the store itself.
{
  const { createDiscoverySnapshots, DISCOVERY_SNAPSHOT_PATHS } = await import("../src/discovery-snapshots.js");
  for (const p of ["/.well-known/x402", "/.well-known/x402.json", "/.well-known/x402-services.json", "/openapi.json", "/llms.txt", "/llms-full.txt", "/api/pricing"]) ok(DISCOVERY_SNAPSHOT_PATHS.has(p), `${p} is a discovery document kept for load`);
  ok(!DISCOVERY_SNAPSHOT_PATHS.has("/api/find") && !DISCOVERY_SNAPSHOT_PATHS.has("/") && !DISCOVERY_SNAPSHOT_PATHS.has("/tools"), "searches and pages are not");
  let t = 1_000_000;
  const s = createDiscoverySnapshots({ maxAgeMs: 60_000, now: () => t });
  const fakeRes = () => {
    const headers = {}; let status = 200, body = null, ended = false;
    return {
      headers, get code() { return status; }, get body() { return body; }, get ended() { return ended; },
      statusCode: 200,
      set(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      status(c) { status = c; this.statusCode = c; return this; },
      end(b) { body = b ?? null; ended = true; return this; },
    };
  };
  ok(s.serve({ method: "GET", path: "/llms.txt", originalUrl: "/llms.txt", headers: {} }, fakeRes()) === false, "nothing kept yet: not served (the gate sheds as before)");
  s.keep("/llms.txt", Buffer.from("hello"), { "content-type": "text/plain", "cache-control": "public, max-age=3600", etag: '"e1"', "x-other": "no" });
  t += 30_000;
  let r = fakeRes();
  ok(s.serve({ method: "GET", path: "/llms.txt", originalUrl: "/llms.txt", headers: {} }, r) === true && r.code === 200 && String(r.body) === "hello" && r.headers["content-type"] === "text/plain" && r.headers.age === "30" && !("x-other" in r.headers), "a kept copy is served with its own headers and its age");
  r = fakeRes();
  ok(s.serve({ method: "GET", path: "/llms.txt", originalUrl: "/llms.txt", headers: { "if-none-match": '"e1"' } }, r) === true && r.code === 304, "a matching ETag answers 304");
  r = fakeRes();
  ok(s.serve({ method: "HEAD", path: "/llms.txt", originalUrl: "/llms.txt", headers: {} }, r) === true && r.code === 200 && r.body === null, "HEAD answers headers only");
  ok(s.serve({ method: "GET", path: "/llms.txt", originalUrl: "/llms.txt?x=1", headers: {} }, fakeRes()) === false, "a request with a query is not answered from the copy");
  ok(s.serve({ method: "POST", path: "/llms.txt", originalUrl: "/llms.txt", headers: {} }, fakeRes()) === false, "a POST is not");
  t += 31_000;
  ok(s.serve({ method: "GET", path: "/llms.txt", originalUrl: "/llms.txt", headers: {} }, fakeRes()) === false, "a copy past its age bound is not served");
  ok(s.status().served === 3 && s.status().kept === 1, `served and kept are counted (${JSON.stringify(s.status())})`);
}

// Caller path.
const srv = await bootServer({ env: { FREE_MODE: "true", SHED_INFLIGHT: "4", SHED_LAG_MS: "1000000", LOAD_SHED: "" }, stores: "discovery-snapshots" });
const held = [];
try {
  const DOCS = ["/.well-known/x402", "/openapi.json", "/llms.txt", "/llms-full.txt", "/api/pricing"];
  const first = {};
  for (const p of DOCS) {
    const r = await fetch(`${srv.url}${p}`);
    first[p] = await r.text();
    ok(r.status === 200 && first[p].length > 100, `idle: ${p} answers 200 (${r.status}, ${first[p].length} bytes)`);
  }
  const idlePage = await fetch(`${srv.url}/terms`);
  ok(idlePage.status === 200, `control: an unprotected page answers 200 while idle (${idlePage.status})`);
  // Hold four paid-route POSTs open mid-body: they pass the gate (a priced
  // route is protected) and stay in flight while the body never finishes.
  const { port } = new URL(srv.url);
  for (let i = 0; i < 4; i++) {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/hash", headers: { "content-type": "application/json", "content-length": "100000" } });
    req.on("error", () => {});
    req.write('{"text":"');
    held.push(req);
  }
  await new Promise((r) => setTimeout(r, 500));
  const shedPage = await fetch(`${srv.url}/terms`);
  ok(shedPage.status === 503, `under load an unprotected page is shed (${shedPage.status})`);
  for (const p of DOCS) {
    const r = await fetch(`${srv.url}${p}`);
    const body = await r.text();
    ok(r.status === 200 && body === first[p] && /^\d+$/.test(r.headers.get("age") || ""), `under load ${p} answers its kept copy, 200 with an Age header (${r.status}, age ${r.headers.get("age")})`);
  }
  const withQuery = await fetch(`${srv.url}/openapi.json?x=1`);
  ok(withQuery.status === 503, `a document asked with a query is shed as before (${withQuery.status})`);
} finally {
  for (const r of held) { try { r.destroy(); } catch { /* closed */ } }
  await srv.stop();
}

console.log(`\ntest-discovery-snapshots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
