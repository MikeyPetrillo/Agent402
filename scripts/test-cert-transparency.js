// Offline regression test for cert-transparency's hedged crt.sh + certspotter
// lookup. crt.sh is chronically slow (8-9s even when healthy) and frequently
// down; a live probe hitting that used to time out or 502. The handler now
// HEDGES: it fires crt.sh, and if crt.sh hasn't answered within ~1.5s it also
// fires certspotter and returns whichever CT log succeeds first — so the endpoint
// is always fast and never depends on one flaky upstream. This pins that by
// stubbing globalThis.fetch (the handler passes ssrfDispatcher, but the call is
// the global fetch) — no network, deterministic.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { NETWORK_TOOLS2, CERTSPOTTER_HOURLY_MAX, takeCertspotterRead, resetCertspotterReads } from "../src/tools/network-kit2.js";
import { CRTSH_ATTRIBUTION, CYMRU_ATTRIBUTION, withoutAnswerOnlyFields } from "../src/data-attribution.js";
import { isHost } from "./lib/url-host.js";

const tool = NETWORK_TOOLS2.find((t) => t.slug === "cert-transparency");
const realFetch = globalThis.fetch;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

const jsonRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const errRes = (status) => ({ ok: false, status, text: async () => "upstream error" });

const CRT_ROWS = [
  { id: 1, serial_number: "AA", issuer_name: "Let's Encrypt", common_name: "a.example.com",
    name_value: "a.example.com\nb.example.com", not_before: "2026-01-01", not_after: "2026-04-01" },
];
const CS_ROWS = [
  { id: "9", cert_sha256: "deadbeef", dns_names: ["a.example.com", "c.example.com"],
    issuer: { name: "C=US, O=Let's Encrypt, CN=R3" }, not_before: "2026-01-01", not_after: "2999-01-01" },
];

let lastInit = null;
const stub = (handler) => { globalThis.fetch = (url, init) => { if (String(url).includes("certspotter")) lastInit = init; return handler(String(url)); }; };
const restore = () => { globalThis.fetch = realFetch; };
const never = () => new Promise(() => {}); // pending forever — simulates a hung crt.sh

const KEY = "test-certspotter-key";
try {
  // The hedge cases below run with a Cert Spotter key set.
  process.env.CERTSPOTTER_API_KEY = KEY;
  // 1. crt.sh answers fast → served from crt.sh, certspotter never fired.
  let csHit = false;
  stub((url) => {
    if (isHost(url, "crt.sh")) return Promise.resolve(jsonRes(CRT_ROWS));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  let t0 = Date.now();
  let r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh", "crt.sh fast → source=crt.sh");
  ok(!csHit, "crt.sh fast → certspotter NOT fired (no wasted hedge)");
  ok(Date.now() - t0 < 500, "crt.sh fast → returns quickly (no hedge delay)");
  ok(r.subdomains.includes("a.example.com") && r.subdomains.includes("b.example.com"), "crt.sh SANs → subdomains");
  ok(r.credit === CRTSH_ATTRIBUTION, "a crt.sh answer carries crt.sh's credit");

  // 2. crt.sh HANGS → hedge fires certspotter after ~1.5s and returns fast via it.
  //    This is the core fix: a slow crt.sh no longer stalls the endpoint.
  stub((url) => {
    if (isHost(url, "crt.sh")) return never();
    if (url.includes("certspotter")) return Promise.resolve(jsonRes(CS_ROWS));
    return Promise.reject(new Error("unexpected host"));
  });
  t0 = Date.now();
  r = await tool.handler({ domain: "example.com" });
  const elapsed = Date.now() - t0;
  ok(r.source === "certspotter", "crt.sh hangs → hedge falls to certspotter");
  // Lower bound 1400, not 1500: setTimeout + Date.now() rounding can land a
  // hair under the nominal 1.5s hedge delay (a CI run measured 1499ms and
  // failed the exact bound). The assertion's point is "waited ~the hedge
  // delay instead of answering immediately or stalling to crt.sh's 10s".
  ok(elapsed >= 1400 && elapsed < 4000, "crt.sh hangs → returns ~hedge-delay, not the 10s crt.sh timeout (" + elapsed + "ms)");
  ok(r.subdomains.some((d) => d === "c.example.com"), "certspotter dns_names → subdomains");
  ok(!("credit" in r), "a certspotter answer carries no crt.sh credit");
  ok(lastInit?.headers?.Authorization === `Bearer ${KEY}`, "the certspotter leg is read under the deployment's key (Bearer)");

  // 3. crt.sh fails FAST (502) → certspotter serves immediately (no hedge wait).
  stub((url) => isHost(url, "crt.sh") ? Promise.resolve(errRes(502)) : Promise.resolve(jsonRes(CS_ROWS)));
  t0 = Date.now();
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "certspotter", "crt.sh fast-fail → source=certspotter");
  ok(Date.now() - t0 < 1500, "crt.sh fast-fail → certspotter served without waiting the full hedge delay");

  // 4. Both sources down → clean 502 (not a hang, not a 500).
  stub(() => Promise.resolve(errRes(503)));
  let threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502, "both sources down → 502 (was: " + (threw && threw.statusCode) + ")");

  // 4b. Both logs rate-limit this server (429) → 502, an upstream failure,
  //     not a 422 that blames the caller's domain.
  stub(() => Promise.resolve(errRes(429)));
  threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502, "both sources rate-limited (429) → 502 (was: " + (threw && threw.statusCode) + ")");

  // 5. certspotter honors includeExpired=false (drops an expired cert).
  stub((url) => isHost(url, "crt.sh") ? Promise.resolve(errRes(502))
    : Promise.resolve(jsonRes([{ id: "x", cert_sha256: "old", dns_names: ["old.example.com"], not_after: "2000-01-01" }])));
  r = await tool.handler({ domain: "example.com" });
  ok(r.count === 0, "certspotter drops expired cert when includeExpired=false");

  // 5b. NO key: the certspotter leg never runs. A hung crt.sh is waited for
  //     (no hedge), a failed crt.sh is the answer's 502.
  delete process.env.CERTSPOTTER_API_KEY;
  csHit = false;
  stub((url) => {
    if (isHost(url, "crt.sh")) return Promise.resolve(errRes(502));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 502 && !csHit, `no key: crt.sh failing is a 502 and certspotter is never asked (${threw?.statusCode}, asked=${csHit})`);
  let crtCalls = 0;
  stub((url) => {
    if (isHost(url, "crt.sh")) return Promise.resolve(++crtCalls === 1 ? errRes(404) : jsonRes(CRT_ROWS));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh" && crtCalls === 2 && !csHit, `no key: a fast crt.sh failure is asked once more (${crtCalls} reads)`);
  crtCalls = 0;
  stub((url) => { if (isHost(url, "crt.sh")) { crtCalls++; return Promise.resolve(errRes(502)); } csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); });
  threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 502 && crtCalls === 2 && !csHit, `no key: two failures answer 502, never a third read (${crtCalls})`);
  stub((url) => {
    if (isHost(url, "crt.sh")) return new Promise((res) => setTimeout(() => res(jsonRes(CRT_ROWS)), 1700));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh" && !csHit && r.credit === CRTSH_ATTRIBUTION, "no key: a slow crt.sh is waited for past the hedge delay and answers with its credit");
  process.env.CERTSPOTTER_API_KEY = "   ";
  try { await tool.handler({ domain: "example.com" }); } catch { /* crt.sh answers */ }
  ok(!csHit, "a blank key is no key");

  // 5c. The hour's reads: at most CERTSPOTTER_HOURLY_MAX, then crt.sh alone.
  process.env.CERTSPOTTER_API_KEY = KEY;
  resetCertspotterReads();
  const t = Date.parse("2026-11-23T00:00:00Z");
  let taken = 0;
  for (let i = 0; i < CERTSPOTTER_HOURLY_MAX + 5; i++) if (takeCertspotterRead(t + i)) taken++;
  ok(CERTSPOTTER_HOURLY_MAX === 100 && taken === 100, `the limiter grants 100 reads in an hour (${taken})`);
  ok(takeCertspotterRead(t + 3_600_000 + 1), "a read an hour after the first is granted again");
  resetCertspotterReads();
  for (let i = 0; i < CERTSPOTTER_HOURLY_MAX; i++) takeCertspotterRead();
  csHit = false;
  stub((url) => {
    if (isHost(url, "crt.sh")) return Promise.resolve(errRes(502));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 502 && !csHit && /crt\.sh returned HTTP 502/.test(threw.message), `hour's reads spent: certspotter not asked, crt.sh's own error answers (${threw?.message})`);
  resetCertspotterReads();

  // 6. Missing domain → 400 before any fetch (client error, no upstream call).
  let fetched = false;
  stub(() => { fetched = true; return Promise.resolve(jsonRes([])); });
  let bad400 = null;
  try { await tool.handler({}); } catch (e) { bad400 = e; }
  ok(bad400 && bad400.statusCode === 400 && !fetched, "missing domain → 400, no upstream call");
} finally {
  restore();
  delete process.env.CERTSPOTTER_API_KEY;
}

// Credits ride answers and /openapi.json's example, never the description or
// the 402 sample.
{
  const asn = NETWORK_TOOLS2.find((t) => t.slug === "asn-info");
  ok(tool.discovery.output.example.credit === CRTSH_ATTRIBUTION && asn.discovery.output.example.credit === CYMRU_ATTRIBUTION, "the published examples carry the credits");
  ok(!("credit" in withoutAnswerOnlyFields(tool.discovery.output.example)) && !("credit" in withoutAnswerOnlyFields(asn.discovery.output.example)), "the 402 sample is read without them");
  ok(!tool.description.includes("crt.sh") && !asn.description.includes("Team Cymru"), "the descriptions carry no credit");
  const { setCymruLookups } = await import("../src/tools/network-kit2.js");
  setCymruLookups({ primary: async (n) => (n.includes("origin") ? [["15169 | 8.8.8.0/24 | US | arin | 1992-12-01"]] : [["15169 | US | arin | 2000-03-30 | GOOGLE, US"]]) });
  try {
    const a = await asn.handler({ ip: "8.8.8.8" });
    ok(a.asn === "AS15169" && a.credit === CYMRU_ATTRIBUTION, "an asn-info answer carries Team Cymru's credit");
  } finally { setCymruLookups(null); }
}

// The description must match the hedge: it answered from either CT search
// while saying "(via crt.sh)" (2026-10-02). It now names no single source and
// points at the `source` field, which the published example documents.
// A 200 that is not a list (a degraded front end's error object) is an
// upstream failure, never a false "no certificates"; an empty list stays a
// real answer.
try {
  delete process.env.CERTSPOTTER_API_KEY;
  let crtCalls = 0;
  stub((url) => { if (isHost(url, "crt.sh")) { crtCalls++; return Promise.resolve(jsonRes({ error: "database busy" })); } return Promise.reject(new Error("unexpected host")); });
  let threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 502, `crt.sh answering an object, not a list, is a 502, not an empty answer (${threw?.statusCode ?? "answered"})`);
  ok(crtCalls === 2, `that failure is asked once more like any fast failure (${crtCalls} reads)`);
  stub((url) => isHost(url, "crt.sh") ? Promise.resolve(jsonRes([])) : Promise.reject(new Error("unexpected host")));
  const empty = await tool.handler({ domain: "example.com" });
  ok(empty.count === 0 && Array.isArray(empty.subdomains) && empty.subdomains.length === 0, "a real empty list is still a valid answer");
  process.env.CERTSPOTTER_API_KEY = KEY;
  resetCertspotterReads();
  stub((url) => isHost(url, "crt.sh") ? Promise.resolve(errRes(502)) : Promise.resolve(jsonRes({ message: "rate limited" })));
  threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 502, `certspotter answering an object while crt.sh fails is a 502, not an empty answer (${threw?.statusCode ?? "answered"})`);
} finally { restore(); }

ok(!/via crt\.sh|via certspotter/i.test(tool.description), "description does not attribute every answer to one CT search");
ok(/`source`/.test(tool.description) && "source" in tool.discovery.output.example, "description and example document the `source` field");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
