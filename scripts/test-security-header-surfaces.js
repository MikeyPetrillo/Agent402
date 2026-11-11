#!/usr/bin/env node
// The security header set, per surface class, on a booted paid-mode server:
// a page, an API 200, an unpaid 402, a 404 (page and API), an operator 404,
// /mcp, the static documents, a redirect, a body the JSON parser refuses, and
// a request the HTTP parser itself refuses (answered before any middleware).
//
//   node scripts/test-security-header-surfaces.js
//
// Every answer carries nosniff, a referrer policy and Strict-Transport-Security
// (sent on plain http too: a browser ignores it there, and it never depends on
// the proxy hop count; see src/security-headers.js). An HTML answer also
// carries a CSP with frame-ancestors, X-Frame-Options and a permissions
// policy. A JSON answer carries none of the document headers, so the 402
// challenge stays as small as it was. The headers a buyer's client reads
// (PAYMENT-REQUIRED, the exposed-header list, cache policy) are asserted next
// to them, so a header change that cost one of those fails here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import net from "node:net";
import { bootPaidServer } from "./lib/paid-boot.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const ALWAYS = { "x-content-type-options": (v) => v === "nosniff", "referrer-policy": (v) => v === "strict-origin-when-cross-origin" || v === "no-referrer", "strict-transport-security": (v) => { const m = /^max-age=(\d+)/.exec(v || ""); return !!m && Number(m[1]) >= 31_536_000 && v.includes("includeSubDomains"); } };
const DOC = ["content-security-policy", "x-frame-options", "permissions-policy"];
const missingAlways = (get) => Object.entries(ALWAYS).filter(([h, good]) => !good(get(h))).map(([h]) => h);
const framing = (csp) => /(?:^|;)\s*frame-ancestors\s+'(?:self|none)'\s*(?:;|$)/.test(csp || "");
const exposed = (r) => (r.headers.get("access-control-expose-headers") || "").toLowerCase().split(",").map((s) => s.trim());

const TOKEN = "header-surfaces-operator-token-0123456789";
const srv = await bootPaidServer({ label: "header-surfaces", env: { AGENT402_OPERATOR_TOKEN: TOKEN, TRUST_PROXY_HOPS: "" } });
const J = { "content-type": "application/json" };
const get = async (path, init = {}) => {
  const r = await fetch(srv.url + path, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init });
  return { r, text: await r.text() };
};
// One request written to a socket as it is, for the answers the HTTP parser
// writes itself; resolves with the raw head once the server closes.
const raw = (bytes) => new Promise((resolve, reject) => {
  const s = net.connect(srv.port, "127.0.0.1", () => s.write(bytes));
  let out = "";
  const t = setTimeout(() => { s.destroy(); reject(new Error("the server did not close the connection within 10 s")); }, 10_000);
  s.on("data", (d) => { out += d; });
  s.on("error", () => { /* a reset after the answer still ends in close */ });
  s.on("close", () => { clearTimeout(t); resolve(out); });
});
const rawHeaders = (head) => {
  const lines = head.split("\r\n");
  const map = new Map();
  for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) map.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()); }
  return { status: Number((lines[0] || "").split(" ")[1]) || 0, get: (h) => map.get(h) ?? null };
};

try {
  // Pages: the full document set, framing refused to other origins, cacheable as before.
  for (const path of ["/", "/privacy", "/status", "/x402-test"]) {
    const { r } = await get(path);
    const h = (n) => r.headers.get(n);
    ok(r.status === 200 && /text\/html/.test(h("content-type") || ""), `${path} is an HTML page (${r.status})`);
    ok(missingAlways(h).length === 0, `${path}: always-on headers (${missingAlways(h).join(", ") || "all"})`);
    ok(DOC.every((d) => h(d)), `${path}: CSP, X-Frame-Options and a permissions policy`);
    ok(framing(h("content-security-policy")) && /^(SAMEORIGIN|DENY)$/i.test(h("x-frame-options") || ""), `${path}: framing is kept to this origin (frame-ancestors and X-Frame-Options)`);
    ok(/\bpublic\b/.test(h("cache-control") || "") && !/no-store/.test(h("cache-control") || ""), `${path}: still publicly cacheable (${h("cache-control")})`);
  }
  // A page with a policy of its own still refuses other origins' frames.
  {
    const { r } = await get("/sdk-playground/sandbox");
    ok(r.status === 200 && framing(r.headers.get("content-security-policy")) && missingAlways((n) => r.headers.get(n)).length === 0, `/sdk-playground/sandbox keeps its own policy with frame-ancestors and the always-on headers (${r.status})`);
  }

  // API 200: the lean set, and the exposed headers a browser buyer reads.
  for (const path of ["/api/pricing", "/api/find?q=hash%20a%20string", "/api/gateway-status"]) {
    const { r } = await get(path);
    const h = (n) => r.headers.get(n);
    ok(r.status === 200 && /application\/json/.test(h("content-type") || ""), `${path} is a JSON 200 (${r.status})`);
    ok(missingAlways(h).length === 0, `${path}: always-on headers (${missingAlways(h).join(", ") || "all"})`);
    ok(DOC.every((d) => !h(d)), `${path}: no document-only header on a JSON answer`);
    const ex = exposed(r);
    ok(["payment-required", "www-authenticate", "x-cache"].every((n) => ex.includes(n)) && h("access-control-allow-origin") === "*", `${path}: CORS still exposes PAYMENT-REQUIRED, WWW-Authenticate and X-Cache`);
  }

  // The unpaid 402: challenge header and body intact, never stored, lean header set.
  for (const [path, body] of [["/api/extract", { url: "https://example.com" }], ["/api/hash", { text: "a" }]]) {
    const { r, text } = await get(path, { method: "POST", headers: J, body: JSON.stringify(body) });
    const h = (n) => r.headers.get(n);
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* asserted below */ }
    let challenge = null; try { challenge = JSON.parse(Buffer.from(h("payment-required") || "", "base64").toString("utf8")); } catch { /* asserted below */ }
    ok(r.status === 402, `${path} unpaid answers 402 (${r.status})`);
    ok(missingAlways(h).length === 0, `${path} 402: always-on headers (${missingAlways(h).join(", ") || "all"})`);
    ok(DOC.every((d) => !h(d)), `${path} 402: no document-only header added to the challenge`);
    ok(Array.isArray(challenge?.accepts) && challenge.accepts.length > 0 && challenge.x402Version === 2, `${path} 402: PAYMENT-REQUIRED still decodes to an x402 v2 challenge with accepts`);
    ok(parsed && typeof parsed === "object" && parsed.howToCall && /application\/json/.test(h("content-type") || ""), `${path} 402: the JSON body still carries howToCall`);
    ok(/no-store/.test(h("cache-control") || ""), `${path} 402: never stored (${h("cache-control")})`);
    const ex = exposed(r);
    // A 402 exposes the listed headers it carries (src/cors.js), no others.
    ok(ex.includes("payment-required") && ex.every((n) => h(n) !== null) && h("access-control-allow-origin") === "*", `${path} 402: the challenge header is exposed to a browser client (${ex.join(", ")})`);
  }

  // 404: a page 404 is a document, an API 404 is JSON.
  {
    const page = await get("/no-such-page-here", { headers: { accept: "text/html" } });
    const ph = (n) => page.r.headers.get(n);
    ok(page.r.status === 404 && missingAlways(ph).length === 0 && DOC.every((d) => ph(d)) && framing(ph("content-security-policy")), `a page 404 carries the full set (${page.r.status})`);
    const api = await get("/api/no-such-tool-here");
    const ah = (n) => api.r.headers.get(n);
    ok(api.r.status === 404 && missingAlways(ah).length === 0 && DOC.every((d) => !ah(d)), `an API 404 carries the always-on headers and no document header (${api.r.status})`);
  }

  // Operator 404 (no token): the same headers as any answer, never stored;
  // the token (live control) gets the page.
  for (const path of ["/__operator", "/__operator/stats", "/__operator/not-a-route"]) {
    const { r } = await get(path);
    const h = (n) => r.headers.get(n);
    ok(r.status === 404 && missingAlways(h).length === 0, `${path} without the token: 404 with the always-on headers (${r.status}; ${missingAlways(h).join(", ") || "all"})`);
    ok(/no-store/.test(h("cache-control") || "") && /private/.test(h("cache-control") || ""), `${path} without the token: private, no-store`);
    ok(!h("content-security-policy") || framing(h("content-security-policy")), `${path} without the token: any CSP it carries refuses other origins' frames`);
  }
  {
    const { r } = await get("/__operator", { headers: { "x-operator-token": TOKEN } });
    const h = (n) => r.headers.get(n);
    ok(r.status === 200 && missingAlways(h).length === 0 && DOC.every((d) => h(d)) && framing(h("content-security-policy")) && /no-store/.test(h("cache-control") || ""), `control: /__operator with the token is a 200 page with the full set, never stored (${r.status})`);
  }

  // /mcp: JSON-RPC answers, the preflight and the method refusal.
  {
    const list = await get("/mcp", { method: "POST", headers: { ...J, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const lh = (n) => list.r.headers.get(n);
    ok(list.r.status === 200 && missingAlways(lh).length === 0 && DOC.every((d) => !lh(d)), `/mcp tools/list: always-on headers, no document header (${list.r.status}; ${missingAlways(lh).join(", ") || "all"})`);
    ok(exposed(list.r).includes("mcp-session-id") && lh("access-control-allow-origin") === "*" && !lh("access-control-allow-credentials"), "/mcp: CORS unchanged (any origin, Mcp-Session-Id exposed, no credentials)");
    const pre = await get("/mcp", { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST" } });
    ok(pre.r.status === 204 && missingAlways((n) => pre.r.headers.get(n)).length === 0, `/mcp preflight: always-on headers (${pre.r.status})`);
    const bad = await get("/mcp", { method: "POST", headers: J, body: "{not json" });
    ok(bad.r.status === 400 && missingAlways((n) => bad.r.headers.get(n)).length === 0, `/mcp parse error: always-on headers (${bad.r.status})`);
    const wrong = await get("/mcp");
    ok(wrong.r.status >= 400 && wrong.r.status < 500 && missingAlways((n) => wrong.r.headers.get(n)).length === 0, `/mcp GET refusal: always-on headers (${wrong.r.status})`);
  }

  // Static documents, whatever their type.
  for (const path of ["/llms.txt", "/openapi.json", "/robots.txt", "/sitemap.xml", "/.well-known/x402", "/.well-known/security.txt", "/js/ga-loader.js", "/health"]) {
    const { r } = await get(path);
    const h = (n) => r.headers.get(n);
    ok(r.status === 200 && missingAlways(h).length === 0, `${path}: 200 with the always-on headers (${r.status}; ${missingAlways(h).join(", ") || "all"})`);
    ok(!h("content-security-policy") || framing(h("content-security-policy")), `${path}: any CSP it carries has frame-ancestors`);
  }

  // Redirects.
  for (const path of ["/tollbooth/waitlist", "/favicon.ico"]) {
    const { r } = await get(path);
    const h = (n) => r.headers.get(n);
    ok(r.status >= 301 && r.status <= 308 && !!h("location") && missingAlways(h).length === 0, `${path}: a redirect with the always-on headers (${r.status}; ${missingAlways(h).join(", ") || "all"})`);
  }

  // Errors raised before a handler: a body the JSON parser refuses.
  {
    const { r } = await get("/api/hash", { method: "POST", headers: J, body: "{not json" });
    ok(r.status === 400 && missingAlways((n) => r.headers.get(n)).length === 0, `a malformed JSON body: 400 with the always-on headers (${r.status})`);
  }

  // Requests the HTTP parser refuses: answered by the server itself, before
  // any middleware.
  {
    const malformed = rawHeaders(await raw("GET / HTTP/1.1\r\nHost: localhost\r\nNo Colon Here\r\n\r\n"));
    ok(malformed.status === 400, `a malformed header line answers 400 (${malformed.status})`);
    ok(missingAlways(malformed.get).length === 0, `the parser's 400 carries the always-on headers (missing: ${missingAlways(malformed.get).join(", ") || "none"})`);
    ok(malformed.get("connection") === "close" && malformed.get("content-length") === "0", "the parser's 400 closes the connection with an empty body");
    const big = rawHeaders(await raw(`GET / HTTP/1.1\r\nHost: localhost\r\nX-Fill: ${"a".repeat(40_000)}\r\n\r\n`));
    ok(big.status === 431, `a header block past the limit answers 431 (${big.status})`);
    ok(missingAlways(big.get).length === 0, `the parser's 431 carries the always-on headers (missing: ${missingAlways(big.get).join(", ") || "none"})`);
    // The server still answers after both.
    const { r } = await get("/health");
    ok(r.status === 200 && srv.exited() === null, "the server answers /health after the refused requests");
  }
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  console.error(srv.log().slice(-1500));
} finally {
  await srv.stop();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
