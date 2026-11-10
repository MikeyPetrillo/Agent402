#!/usr/bin/env node
// No reader of a request header may hold the event loop on a long adversarial
// value, on a path anyone can call without paying. The sibling of
// scripts/test-redos-free-tier.js, which sends its corpus to tool inputs only:
// here the same shapes ride in the request headers.
//
//   node scripts/test-redos-request-headers.js      (boots its own server, port 0)
//   REDOS_HEADERS_ONLY=user-agent,cookie node scripts/test-redos-request-headers.js
//
// HOW: a paid-mode server (x402 and MPP gates mounted, an operator token set,
// one trusted proxy hop) boots with scripts/lib/loop-gap-preload.js, which
// measures inside the server process the longest time one event-loop turn held
// the thread, on the clock a busy host does not inflate
// (scripts/lib/ours-clock.js). Each call sends one header one shape, filled to
// the server's header limit, to one unpaid surface: a page, a free API route,
// a paid route's 402, /api/find, /api/route, /mcp, an unknown API path (the
// retired-route answer reads the client from its headers) and the model
// tiers' flat and metered 402. A call whose
// turn runs past the bound is repeated, and fails if the least of its readings
// is still past it (a reader that goes quadratic is slow on every run). It
// also fails when any answer is a 500, or when the server refuses the request
// before a reader sees it (a 431, which would make the run measure nothing).
//
// The header readers that run only with a telemetry key set, and the ones the
// surfaces do not reach, are timed directly below on the same shapes.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { request } from "node:http";
import { bootPaidServer } from "./lib/paid-boot.js";
import { bound, leastOurs, OURS_READING } from "./lib/ours-clock.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ONLY = process.env.REDOS_HEADERS_ONLY ? new Set(process.env.REDOS_HEADERS_ONLY.split(",").map((s) => s.trim().toLowerCase())) : null;
const REPROBES = 3;

// Node refuses a header block past 16 KB (431); the fill leaves room for the
// request line and the other headers.
const FILL = 15_000;
// The shapes of the tool-input corpus that a header can carry (a header value
// holds no line break: the newline run rides as tabs), and runs of the
// separators header grammars split on.
function corpus(n) {
  return {
    a: "a".repeat(n),
    dotsAt: "x@" + ".".repeat(n - 3) + " y",
    aDot: "a.".repeat(n / 2) + "-",
    spaces: "a" + " ".repeat(n - 2) + "!",
    digits: "1".repeat(n - 1) + "x",
    dash: "a-".repeat(n / 2) + "!",
    lt: "<a".repeat(n / 2),
    tabs: "a\t".repeat(n / 2) + "!",
    commas: "a,".repeat(n / 2) + "!",
    commaSpace: ", ".repeat(n / 2) + "a",
    semis: "a;".repeat(n / 2) + "!",
    equals: "a=".repeat(n / 2) + "!",
    quotes: "\"".repeat(n - 1) + "a",
    slashes: "a/".repeat(n / 2) + "!",
    parens: "(".repeat(n - 1) + "a",
    dotsLetter: ".".repeat(n - 1) + "x",
    // Two bytes each on the wire when the request carries a body.
    latin1: "\u00e9".repeat(Math.floor(n / 2) - 200),
  };
}
// Values shaped like the header they ride in, so the reader gets past its
// first check and into its parse.
const b64 = (s) => Buffer.from(s).toString("base64");
const fit = (unit, n, tail = "") => unit.repeat(Math.max(1, Math.floor((n - tail.length) / unit.length))) + tail;
function shaped(n) {
  const deepJson = b64("[".repeat(Math.floor(n * 0.7)));
  const longJson = b64(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: { signature: "0x" + "a".repeat(Math.floor(n * 0.6)), authorization: { from: "0x" + "1".repeat(40), to: "0x" + "2".repeat(40), value: "1", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "3".repeat(64) } } }));
  const manyKeys = b64(`{${Array.from({ length: Math.floor(n / 14) }, (_, i) => `"k${i}":1`).join(",")}}`).slice(0, n);
  return {
    "user-agent": {
      products: fit("a/1.0 ", n), comments: "Mozilla/5.0 (" + fit("x; ", n - 20) + ")", versions: "bot/" + fit("1.", n - 8, "x"), trailingDigits: "bot" + fit("-1", n - 6, "x"),
      dotsDigits: "a" + fit(".1", n - 4, "!"), underscores: "a" + fit("_1", n - 4, "v"), plus: "curl" + fit("+", n - 8) + "/1",
    },
    accept: {
      types: fit("text/html;q=0.9, ", n), params: "text/html" + fit(";a=b", n - 12), wildcards: fit("*/*,", n), quality: "text/html;q=" + fit("0", n - 16) + "1", stream: "application/json, text/event-stream" + fit(" ,", n - 40),
    },
    "accept-language": { tags: fit("en-US;q=0.8, ", n), subtags: "en" + fit("-a", n - 4), quality: "en;q=0." + fit("9", n - 10) },
    referer: { hostLabels: "https://" + fit("a.", n - 14) + "com/", path: "https://example.com/" + fit("a/", n - 24), query: "https://example.com/?" + fit("a=b&", n - 24), noScheme: fit("a.", n), userinfo: "https://" + fit("a:", n - 24) + "@example.com/" },
    origin: { hostLabels: "https://" + fit("a.", n - 12) + "com", ports: "https://example.com:" + fit("1", n - 24), nulls: fit("null ", n) },
    "x-forwarded-for": { many: fit("10.0.0.1, ", n), v6: fit("::ffff:10.0.0.1,", n), junk: fit("a, ", n), ports: fit("10.0.0.1:80,", n), brackets: fit("[::1],", n), digits: fit("1", n) },
    authorization: {
      bearer: "Bearer " + "a".repeat(n - 7), bearerDots: "Bearer " + fit("a.", n - 7), credits: "Bearer a402_" + "a".repeat(n - 12), basic: "Basic " + b64(fit("a:", Math.floor(n * 0.7))),
      payment: "Payment " + "a".repeat(n - 8), paymentParams: "Payment " + fit("a=\"b\", ", n - 8), paymentCredential: "Payment " + b64(JSON.stringify({ challenge: { id: "a".repeat(64), realm: "x", method: "evm", intent: "charge", request: "a".repeat(Math.floor(n * 0.5)) }, payload: {} })),
      paymentQuotes: "Payment id=\"" + fit("\\\"", n - 14), paymentList: fit("Payment a=\"b\", ", n), spaces: "Bearer" + " ".repeat(n - 7) + "a",
    },
    "x-payment": { deepJson, longJson, manyKeys, notBase64: fit("!", n), padding: fit("=", n), dots: fit("a.", n) },
    "payment-signature": { deepJson, longJson, manyKeys, notBase64: fit("!", n), padding: fit("=", n), dots: fit("a.", n) },
    "x-operator-token": { long: "a".repeat(n), spaces: "a" + " ".repeat(n - 2) + "a" },
    cookie: { pairs: fit("a=b; ", n), session: "a402_op=" + "a".repeat(n - 8), sessions: fit("a402_op=a; ", n), noValue: fit("a; ", n), equals: "a402_op" + fit("=", n - 8), encoded: "a=" + fit("%20", n - 2), spaces: "a=b;" + " ".repeat(n - 14) + "a402_op=x" },
    "if-none-match": { tags: fit("\"a\", ", n), weak: fit("W/\"a\",", n), star: fit("*,", n), open: "\"" + "a".repeat(n - 1), spaces: "\"a\"," + " ".repeat(n - 8) + "\"b\"" },
    range: { many: "bytes=" + fit("0-1,", n - 6), overlapping: "bytes=" + fit("0-999,", n - 6), suffix: "bytes=" + fit("-1,", n - 6), digits: "bytes=0-" + fit("9", n - 8), spaces: "bytes=" + fit(" ,", n - 8) + "0-1", unit: fit("a", n - 4) + "=0-1" },
    "idempotency-key": { long: "a".repeat(n), dashes: fit("a-", n), spaces: "a" + " ".repeat(n - 2) + "a", colons: fit("a:", n) },
  };
}
const HEADERS = ["user-agent", "accept", "accept-language", "referer", "origin", "x-forwarded-for", "authorization", "x-payment", "payment-signature", "x-operator-token", "cookie", "if-none-match", "range", "idempotency-key"];
// Further headers a gate, the connector or the edge code reads; each gets the
// general shapes.
const MORE_HEADERS = ["prefer", "x-pow-solution", "x-forwarded-host", "x-forwarded-proto", "forwarded", "mcp-session-id", "mcp-protocol-version", "last-event-id", "x-request-id", "cf-connecting-ip", "x-origin-auth", "if-modified-since", "accept-encoding", "x-credits-key", "payment-receipt"];

// --- the readers the surfaces do not reach, timed directly --------------------
// Synchronous functions, so a reading is the time this thread had a core.
{
  const DIRECT = bound(Number(process.env.REDOS_HEADERS_DIRECT_BOUND_MS) || 50, 3);
  console.log(`# direct readers timed as ${OURS_READING}; ${DIRECT.note}`);
  const posthog = await import("../src/posthog.js");
  const refusals = await import("../src/discovery-refusals.js");
  const traffic = await import("../src/traffic-classifier.js");
  const readers = {
    "posthog uaFamilyOf": (v) => posthog.uaFamilyOf(v),
    "posthog toolGoneSourceOf (user-agent)": (v) => posthog.toolGoneSourceOf({ headers: { "user-agent": v } }),
    "posthog toolGoneSourceOf (authorization)": (v) => posthog.toolGoneSourceOf({ headers: { authorization: v } }),
    "posthog toolGoneSourceOf (referer)": (v) => posthog.toolGoneSourceOf({ headers: { referer: v } }),
    "discovery-refusals uaFamilyOf": (v) => refusals.uaFamilyOf(v),
  };
  for (const [name, fn] of Object.entries(traffic)) {
    // Every exported reader of the traffic classifier that takes one string.
    if (typeof fn === "function" && fn.length === 1 && /ua|agent|bot|browser|indexer|classif/i.test(name)) readers[`traffic-classifier ${name}`] = (v) => fn(v);
  }
  const big = 100_000; // well past any header a server accepts: a pattern that is quadratic shows at this size
  const values = { ...corpus(big) };
  for (const h of ["user-agent", "referer", "authorization"]) for (const [k, v] of Object.entries(shaped(big)[h])) values[`${h}.${k}`] = v;
  const slow = [];
  let timed = 0;
  for (const [name, fn] of Object.entries(readers)) {
    for (const [shape, value] of Object.entries(values)) {
      let threw = null;
      const { ms } = leastOurs(() => { try { return fn(value); } catch (e) { threw = e; return null; } }, { attempts: 3, enough: DIRECT.ms / 4, giveUp: DIRECT.ms * 4 });
      timed++;
      if (threw) slow.push(`${name} on ${shape}: threw ${String(threw?.message || threw).slice(0, 80)}`);
      else if (ms > DIRECT.ms) slow.push(`${name} on ${shape}: ${ms.toFixed(1)} ms`);
    }
  }
  for (const s of slow) console.error(`  slow: ${s}`);
  ok(Object.keys(readers).length >= 5 && slow.length === 0, `${Object.keys(readers).length} header readers answer a ${big}-character value of each shape inside ${DIRECT.ms} ms without throwing (${timed} readings)`);
}

// --- the booted server ----------------------------------------------------------
// A turn on these surfaces reads under 20 ms with any header on a laptop (the
// longest of the whole corpus about 10 ms); the reader this suite was written
// after held one for 237 ms.
const LOOP = bound(Number(process.env.REDOS_HEADERS_BOUND_MS) || 50, 3);
const TOKEN = "redos-headers-operator-token-0123456789";
const srv = await bootPaidServer({
  label: "redos-headers", ipc: true, args: ["--import", "./scripts/lib/loop-gap-preload.js"],
  env: {
    AGENT402_OPERATOR_TOKEN: TOKEN, TRUST_PROXY_HOPS: "1", MPP_SECRET_KEY: "redos-headers-local-secret",
    X402_PAYWALL_PROBES_PER_CYCLE: "0", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
  },
});

const waiting = new Map();
srv.child.on("message", (m) => { const w = m && waiting.get(`${m.loopGap}:${m.id}`); if (w) { waiting.delete(`${m.loopGap}:${m.id}`); w(m); } });
let seq = 0;
const meter = (verb, reply) => new Promise((resolve, reject) => {
  const id = ++seq;
  const t = setTimeout(() => { waiting.delete(`${reply}:${id}`); reject(new Error(`the server did not answer the loop meter (${verb}) within 60 s`)); }, 60_000);
  waiting.set(`${reply}:${id}`, (m) => { clearTimeout(t); resolve(m); });
  srv.child.send({ loopGap: verb, id });
});

let caller = 0;
const nextAddress = () => { caller++; return `10.${(caller >> 16) & 255}.${(caller >> 8) & 255}.${caller & 255}`; };
// node:http, so each header goes out exactly as written.
const send = (surface, extra) => new Promise((resolve) => {
  const body = surface.body ? JSON.stringify(surface.body) : null;
  const headers = { "x-forwarded-for": nextAddress(), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...(surface.headers || {}), ...extra };
  let req;
  try { req = request(`${srv.url}${surface.path}`, { method: surface.method, headers, timeout: 60_000, maxHeaderSize: 262_144 }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); res.on("error", () => resolve({ status: "ERR" })); }); }
  catch (e) { return resolve({ status: "UNSENT", why: String(e?.message || e).slice(0, 80) }); }
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => resolve({ status: "ERR", why: String(e?.message || e).slice(0, 80) }));
  req.end(body || undefined);
});
const timed = async (surface, extra) => {
  await meter("start", "started");
  const answer = await send(surface, extra);
  const gap = await meter("stop", "result");
  return { ...answer, worst: gap.worst, worstWall: gap.worstWall, reading: gap.reading };
};

const SURFACES = [
  { name: "page", method: "GET", path: "/", expect: [200] },
  { name: "free API", method: "GET", path: "/api/pricing", expect: [200] },
  { name: "paid 402", method: "POST", path: "/api/extract", body: { url: "https://example.com" }, expect: [402] },
  { name: "find", method: "GET", path: "/api/find?q=hash%20a%20string", expect: [200] },
  { name: "route", method: "GET", path: "/api/route?q=hash%20a%20string", expect: [200] },
  { name: "mcp", method: "POST", path: "/mcp", headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, expect: [200] },
  { name: "unknown API path", method: "GET", path: "/api/no-such-tool-here", expect: [404] },
  { name: "model tier 402", method: "POST", path: "/v1/chat/completions", body: { model: "agent402/auto", messages: [{ role: "user", content: "hi" }] }, expect: [402] },
  { name: "metered quote", method: "POST", path: "/v1/metered/chat/completions", body: { model: "agent402/auto", messages: [{ role: "user", content: "hi" }] }, expect: [402] },
];

try {
  console.log(`# event-loop turns read inside the server; ${LOOP.note}`);
  // Control: each surface answers as expected with plain headers, inside the
  // bound, or the bound is measuring the surface rather than a header reader.
  for (const s of SURFACES) {
    await send(s, {}); // first render
    let c = await timed(s, { "user-agent": "redos-headers-control/1.0" });
    for (let again = 0; again < REPROBES && c.worst > LOOP.ms; again++) { const r = await timed(s, { "user-agent": "redos-headers-control/1.0" }); if (r.worst < c.worst) c = r; }
    ok(s.expect.includes(c.status), `control: ${s.name} (${s.method} ${s.path.split("?")[0]}) answers ${s.expect.join("/")} with plain headers (${c.status})`);
    ok(c.worst >= 0 && c.worst <= LOOP.ms, `control: ${s.name} holds no turn past the bound with plain headers (${c.worst.toFixed(1)} ms, read as ${c.reading})`);
  }

  const jobs = [];
  const generic = corpus(FILL), own = shaped(FILL);
  for (const h of [...HEADERS, ...MORE_HEADERS]) {
    if (ONLY && !ONLY.has(h)) continue;
    const values = { ...generic, ...Object.fromEntries(Object.entries(own[h] || {}).map(([k, v]) => [`${h}.${k}`, v])) };
    for (const [shape, value] of Object.entries(values)) for (const s of SURFACES) jobs.push({ s, h, shape, value });
  }
  ok(jobs.length >= (ONLY ? 1 : 3500), `${jobs.length} calls: ${ONLY ? ONLY.size : HEADERS.length + MORE_HEADERS.length} headers, each shape, on ${SURFACES.length} surfaces`);

  const slow = [], faults = [], unseen = [];
  const statuses = new Map();
  let longest = { ms: 0, label: "none" };
  const t0 = Date.now();
  for (const j of jobs) {
    let r = await timed(j.s, { [j.h]: j.value });
    for (let again = 0; again < REPROBES && r.worst > LOOP.ms; again++) { const n = await timed(j.s, { [j.h]: j.value }); if (n.worst < r.worst) r = n; }
    const label = `${j.h} ${j.shape} on ${j.s.name}`;
    statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
    if (r.worst > longest.ms) longest = { ms: r.worst, label };
    if (r.worst > LOOP.ms) slow.push(`${label}: a turn held ${r.worst.toFixed(1)} ms (status ${r.status})`);
    if (r.status === 500 || r.status === "ERR") faults.push(`${label}: ${r.status}${r.why ? ` ${r.why}` : ""}`);
    if (r.status === 431 || r.status === "UNSENT") unseen.push(`${label}: ${r.status}${r.why ? ` ${r.why}` : ""}`);
  }
  console.log(`# answers by status: ${[...statuses].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} x${n}`).join(", ")}`);
  console.log(`# longest turn: ${longest.ms.toFixed(1)} ms (${longest.label})`);
  for (const s of slow.slice(0, 60)) console.error(`  slow: ${s}`);
  ok(slow.length === 0, `no header value holds an event-loop turn past ${LOOP.ms} ms (${jobs.length} calls in ${Math.round((Date.now() - t0) / 1000)} s, ${slow.length} did)`);
  for (const s of faults.slice(0, 60)) console.error(`  fault: ${s}`);
  ok(faults.length === 0, `no answer is a 500 or a dropped connection (${faults.length} of ${jobs.length})`);
  for (const s of unseen.slice(0, 20)) console.error(`  unseen: ${s}`);
  ok(unseen.length === 0, `every value reached the server's readers: none refused as too large, none unsendable (${unseen.length})`);

  // The server still serves a plain request, and the right operator token
  // still reads an operator route (the wrong ones above spent no shared budget).
  const after = await send(SURFACES[1], {});
  ok(after.status === 200 && srv.exited() === null, `the server answers a plain request after the corpus (${after.status})`);
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  console.error(srv.log().slice(-1500));
} finally {
  await srv.stop();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
