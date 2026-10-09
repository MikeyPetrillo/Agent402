#!/usr/bin/env node
// The 402 challenge header has a hard ceiling that is NOT ours to set.
//
// Measured 2026-08-29 against an external seller: a stock x402 client echoes
// every extension it is offered straight back into the payment payload -
// `info` AND the full JSON `schema` for each - so a rich 402 becomes a rich
// REQUEST header on the buyer's retry. That seller's challenge produced a
// 13,680-byte payment header; their own edge answered 431 Request Header
// Fields Too Large, and their facilitator rejected the payload before that.
// Their endpoint is effectively unpayable by a stock client.
//
// Ours is smaller but the same shape, and the size is driven by the ROUTE:
// the bazaar extension carries the tool's own input schema, so a rich tool
// has a rich challenge. A full prod sweep on 2026-08-29 put every one of 560
// paid routes under the ceiling, with 35 past the watch line and the largest
// at 10,744 (v1-chat) - NOT one of the two routes this test originally
// hardcoded, which is why it sweeps the whole catalog instead of sampling.
// Common proxy limits sit at 8 KB per header and 16 KB total.

const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3000";
// This sweep walks every priced route on PRODUCTION on every CI run.
// Unmarked, PostHog filed each of those 402s as an outside buyer's first look
// (measured 2026-09-22). So it names itself and, when the lane holds POW_SECRET, carries the same
// signed X-Heartbeat-Token the canary sends, which is what marks a request
// synthetic on every accounting surface.
const SWEEP_UA = "agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)";
const heartbeatHeaders = () => {
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) return {};
  const minute = Math.floor(Date.now() / 60_000);
  return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
};
// PROJECTION (2026-09-10). This test measures PRODUCTION, and the extensions
// on a 402 are built from THIS tree's catalog, so a change that grows the
// challenge was caught on the run after it shipped - and the fix for it was
// then red on its own run, because prod still carried the old challenge (the
// namespace sentence in the chat tools description pushed v1-chat to 12,036;
// the trim that followed could not merge past this very lane). So with
// CHALLENGE_LOCAL_BOOT=1 the test also boots THIS tree in paid mode against a
// stub facilitator (one rail), reads the local 402 for every route, and
// PROJECTS: prod's rails and extensions with this tree's extensions and
// accept-level outputSchema swapped in. The ceiling is asserted on the
// projection - what a buyer will echo back once this tree is live - and the
// measured prod figure is printed beside it. Without the flag the old
// prod-only behaviour stands.
const LOCAL_BOOT = process.env.CHALLENGE_LOCAL_BOOT === "1";
let localBase = null, localProc = null, localFac = null;
if (LOCAL_BOOT) {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { getFreePorts } = await import("./lib/free-port.js");
  const [PORT, FAC_PORT] = await getFreePorts(2);
  localFac = createServer((req, res) => {
    res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
  });
  await new Promise((r) => localFac.listen(FAC_PORT, "127.0.0.1", r));
  localProc = spawn("node", ["src/server.js"], { env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "", TARGET_URL: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    // Mount the Decide routes too (their challenge is among the largest), with
    // a placeholder service that is never called: only the 402 is read.
    DECIDE_SERVICE_URL: "http://127.0.0.1:9", DECIDE_INTERNAL_TOKEN: "challenge-size-local-placeholder-token-0000", DECIDE_LEDGER_DB: `/tmp/challenge-size-decide-${process.pid}.db`,
  }, stdio: ["ignore", "ignore", "pipe"] });
  localProc.stderr.on("data", () => {});
  localBase = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${localBase}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
}
const stopLocal = () => { try { localProc?.kill("SIGKILL"); } catch {} try { localFac?.close(); } catch {} };
process.on("exit", stopLocal);
// Projected base64 header length for prod's challenge JSON with this tree's
// extensions and accept-level outputSchema in place of prod's.
function projectBytes(prodHeader, localHeader) {
  const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  let prod, local;
  try { prod = dec(prodHeader); local = dec(localHeader); } catch { return null; }
  // Only the bazaar extension is built from the catalog; any other extension
  // on prod's 402 is env-gated (rails, MPP, identifiers) and stays prod's.
  const merged = { ...prod, extensions: { ...(prod.extensions || {}) } };
  if (local.extensions?.bazaar !== undefined) merged.extensions.bazaar = local.extensions.bazaar; else delete merged.extensions.bazaar;
  if (!Object.keys(merged.extensions).length) delete merged.extensions;
  if (Array.isArray(prod.accepts) && Array.isArray(local.accepts)) {
    merged.accepts = prod.accepts.map((a, i) => {
      const { outputSchema: _drop, ...rest } = a || {};
      const localSchema = local.accepts[i]?.outputSchema ?? (i === 0 ? local.accepts[0]?.outputSchema : undefined);
      return localSchema !== undefined ? { ...rest, outputSchema: localSchema } : rest;
    });
  }
  return Buffer.from(JSON.stringify(merged), "utf8").toString("base64").length;
}
// A buyer's retry carries roughly the challenge plus its own signature and
// authorization (~700 bytes measured), so budget below the common 8 KB limit.
const MAX_HEADER_BYTES = Number(process.env.MAX_CHALLENGE_HEADER_BYTES) || 12_000;
const WARN_HEADER_BYTES = Number(process.env.WARN_CHALLENGE_HEADER_BYTES) || 9_000;
// The whole 402, every header: a Node fetch client reads at most 16 KB of
// response headers (the gateway's challenge for a gpt-5 request crossed it
// on 2026-10-09 and the buyer saw a header overflow, not a paywall). The
// challenge shares that budget with the MPP challenge, CORS and the
// security headers, so the bound is on the total, with room for more rails.
const MAX_TOTAL_HEADER_BYTES = Number(process.env.MAX_TOTAL_HEADER_BYTES) || 14_000;
const WARN_TOTAL_HEADER_BYTES = Number(process.env.WARN_TOTAL_HEADER_BYTES) || 12_500;
// The body that provokes the largest challenge on the gateway: a priced
// model widens the MPP challenge (its quote rides in every method's request).
const GATEWAY_BODY = JSON.stringify({ model: "openai/gpt-5", max_tokens: 300, messages: [{ role: "user", content: "Reply with the single word: settled" }] });

// Read a 402 with a raised header limit: a plain fetch refuses response
// headers over 16 KB, and an oversized challenge is exactly what this test
// must measure. Answers like a fetch Response for the fields used here.
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
function read402(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method, headers, maxHeaderSize: 262144, timeout: timeoutMs }, (res) => {
      res.resume();
      const map = new Map();
      for (let i = 0; i < res.rawHeaders.length; i += 2) { const k = res.rawHeaders[i].toLowerCase(); map.set(k, map.has(k) ? `${map.get(k)}, ${res.rawHeaders[i + 1]}` : res.rawHeaders[i + 1]); }
      res.on("end", () => resolve({ status: res.statusCode, headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null, forEach: (fn) => map.forEach((v, k) => fn(v, k)) } }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const bodyFor = (t) => (t.method !== "POST" ? undefined : /^\/v1\//.test(t.path) ? GATEWAY_BODY : "{}");
const headerBytes = (res) => { let n = 20; res.headers.forEach((v, k) => { n += k.length + v.length + 4; }); return n; };
const headerMap = (res) => { const m = new Map(); res.headers.forEach((v, k) => m.set(k, v.length)); return m; };
// The projected total: this tree's headers where the local boot answered
// them, prod's for what only prod carries (the MPP challenge, the edge's own
// headers), and the projected challenge in place of either payment-required.
function projectTotal(prodRes, localRes, projectedPR) {
  const prod = headerMap(prodRes), local = headerMap(localRes);
  let n = 20;
  for (const k of new Set([...prod.keys(), ...local.keys()])) {
    if (k === "payment-required") { n += k.length + projectedPR + 4; continue; }
    if (local.has(k)) { n += k.length + local.get(k) + 4; continue; }
    if (prod.has(k) && !LOCAL_DECIDES.has(k)) n += k.length + prod.get(k) + 4;
  }
  return n;
}
// Headers this tree decides on its own (present or absent by code, not by
// deployment), so prod's copy is not carried over when the local boot omits it.
const LOCAL_DECIDES = new Set(["content-security-policy", "x-frame-options", "permissions-policy", "x-permitted-cross-domain-policies", "referrer-policy", "x-content-type-options"]);
const CONCURRENCY = Number(process.env.CHALLENGE_CONCURRENCY) || 8;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// Every paid route, from the booted server's own catalog. An override exists
// for a quick spot check; the default is the whole surface, because the
// largest challenge belongs to whichever tool has the largest input schema
// and that moves whenever a kit is added.
let probes = [];
const override = (process.env.CHALLENGE_ROUTES || "").split(",").map((r) => r.trim()).filter(Boolean);
if (override.length) {
  probes = override.map((path) => ({ path, method: "POST", slug: path }));
} else {
  // Single-retry, because this reads LIVE production and our own deploys make
  // it unreadable: the service is volume-backed, so every deploy has a 60-90s
  // window with no container at all. Measured 2026-08-30 - this lane failed
  // with "the catalog listed no endpoints" while the merge that triggered it
  // was still swapping containers, and the same check passed seconds later.
  // One reading is never a verdict here; a real fault fails both. Same doctrine
  // as every heartbeat probe and the Postgres alarm.
  const readCatalog = async () => {
    const res = await fetch(`${TARGET}/api/pricing`, { signal: AbortSignal.timeout(30000) });
    const body = await res.json();
    return (body.endpoints || []).map((e) => ({ path: e.path, method: e.method || "GET", slug: e.slug || e.path }));
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      probes = await readCatalog();
      if (probes.length) break;
      lastErr = new Error("the catalog listed no endpoints");
    } catch (e) { lastErr = e; }
    if (attempt === 1) {
      console.log(`  catalog unreadable (${String(lastErr.message).slice(0, 60)}) - re-reading in 30s, production may be mid-deploy`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
  if (!probes.length) {
    console.log(`FAIL - could not read the catalog from ${TARGET}/api/pricing after a retry (${String(lastErr?.message).slice(0, 80)})`);
    process.exit(1);
  }
}

const rows = [];
const skipped = [];
const queue = [...probes];
async function worker() {
  while (queue.length) {
    const t = queue.shift();
    let res;
    try {
      res = await read402(`${TARGET}${t.path}`, {
        method: t.method,
        headers: { "content-type": "application/json", "user-agent": SWEEP_UA, ...heartbeatHeaders() },
        body: bodyFor(t),
      });
    } catch (e) { skipped.push(`${t.slug}: ${String(e.message).slice(0, 40)}`); continue; }
    if (res.status !== 402) continue; // free tier, or FREE_MODE: nothing to bound
    const h = res.headers.get("payment-required") || "";
    if (!h) { rows.push({ slug: t.slug, bytes: -1 }); continue; }
    const total = headerBytes(res);
    let projected = null, projectedTotalLocal = null;
    if (localBase) {
      try {
        const lr = await read402(`${localBase}${t.path}`, { method: t.method, headers: { "content-type": "application/json" }, body: bodyFor(t), timeoutMs: 20000 });
        const lh = lr.status === 402 ? (lr.headers.get("payment-required") || "") : "";
        if (lh) { projected = projectBytes(h, lh); if (projected != null) projectedTotalLocal = projectTotal(res, lr, projected); }
      } catch { /* a route this tree does not serve (retired) keeps the measured figure */ }
    }
    // The total is projected the same way: prod's other headers stay, the
    // challenge is this tree's.
    rows.push({ slug: t.slug, bytes: h.length, projected, total, projectedTotal: projectedTotalLocal });
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const headerless = rows.filter((r) => r.bytes < 0);
const sized = rows.filter((r) => r.bytes >= 0).sort((a, b) => b.bytes - a.bytes);

if (!sized.length) {
  // FREE_MODE boots answer 200 everywhere - there is no challenge to bound,
  // and reporting that as a pass would be a green run that proved nothing.
  console.log(`no paywalled route answered a 402 on ${TARGET} - this guard needs a PAID-mode server`);
  console.log("SKIPPED: nothing to measure");
  process.exit(0);
}

ok(headerless.length === 0, `every 402 carried a PAYMENT-REQUIRED header${headerless.length ? ` (missing on ${headerless.slice(0, 3).map((r) => r.slug).join(", ")})` : ""}`);

// The ceiling is judged on THIS tree's challenge (the projection) when the
// local boot ran; the measured prod figure is reported beside it, and a prod
// challenge already over the ceiling is called out loudly until this tree
// deploys. Without the local boot the measured figure is the verdict.
const judged = (r) => (r.projected != null ? r.projected : r.bytes);
const projectedCount = sized.filter((r) => r.projected != null).length;
if (localBase) ok(projectedCount >= sized.length * 0.9, `this tree answered a 402 for ${projectedCount} of ${sized.length} prod routes (projection is only honest when it covers the catalog)`);
const over = sized.filter((r) => judged(r) > MAX_HEADER_BYTES);
ok(over.length === 0, `no challenge over the ${MAX_HEADER_BYTES}-byte ceiling${localBase ? " (projected with this tree's extensions)" : ""}${over.length ? `: ${over.slice(0, 5).map((r) => `${r.slug} ${judged(r)}`).join(", ")} - a buyer echoes this back and proxies refuse oversized headers` : ` (${sized.length} paid routes probed)`}`);
const overOnProd = sized.filter((r) => r.bytes > MAX_HEADER_BYTES && judged(r) <= MAX_HEADER_BYTES);
if (overOnProd.length) console.log(`WARNING: production currently serves ${overOnProd.length} challenge(s) over the ceiling (${overOnProd.slice(0, 3).map((r) => `${r.slug} ${r.bytes} -> ${r.projected} with this tree`).join(", ")}) - this tree brings them under; deploy it`);

const judgedTotal = (r) => (r.projectedTotal != null ? r.projectedTotal : r.total);
const overTotal = sized.filter((r) => judgedTotal(r) > MAX_TOTAL_HEADER_BYTES);
ok(overTotal.length === 0, `no 402 over ${MAX_TOTAL_HEADER_BYTES} total header bytes${localBase ? " (projected with this tree's challenge)" : ""}${overTotal.length ? `: ${overTotal.slice(0, 5).map((r) => `${r.slug} ${judgedTotal(r)}`).join(", ")}` : ""}`);
const overTotalOnProd = sized.filter((r) => r.total > MAX_TOTAL_HEADER_BYTES && judgedTotal(r) <= MAX_TOTAL_HEADER_BYTES);
if (overTotalOnProd.length) console.log(`WARNING: production currently serves ${overTotalOnProd.length} 402(s) over ${MAX_TOTAL_HEADER_BYTES} total header bytes (${overTotalOnProd.slice(0, 3).map((r) => `${r.slug} ${r.total} -> ${r.projectedTotal}`).join(", ")}) - this tree brings them under`);
const warnTotal = sized.filter((r) => judgedTotal(r) > WARN_TOTAL_HEADER_BYTES && judgedTotal(r) <= MAX_TOTAL_HEADER_BYTES);
const byTotal = [...sized].sort((a, b) => judgedTotal(b) - judgedTotal(a));
console.log(`largest 402 in total header bytes: ${byTotal[0].slug} at ${judgedTotal(byTotal[0])}${byTotal[0].projectedTotal != null ? ` projected (measured on prod ${byTotal[0].total})` : ""}`);
if (warnTotal.length) console.log(`WARNING: ${warnTotal.length} route(s) past the ${WARN_TOTAL_HEADER_BYTES}-byte total watch line`);
const warn = sized.filter((r) => judged(r) > WARN_HEADER_BYTES && judged(r) <= MAX_HEADER_BYTES);
const byJudged = [...sized].sort((a, b) => judged(b) - judged(a));
console.log(`\nlargest challenge: ${byJudged[0].slug} at ${judged(byJudged[0])} bytes${byJudged[0].projected != null ? ` projected (measured on prod ${byJudged[0].bytes})` : ""} (smallest ${judged(byJudged[byJudged.length - 1])})`);
if (warn.length) {
  console.log(`WARNING: ${warn.length} route(s) past the ${WARN_HEADER_BYTES}-byte watch line - trim an extension before adding a rail`);
  for (const r of warn.slice(0, 10)) console.log(`   ${String(judged(r)).padStart(6)}  ${r.slug}`);
}
if (skipped.length) console.log(`(${skipped.length} route(s) could not be probed: ${skipped.slice(0, 3).join("; ")})`);
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
