// Offline regression test for cert-transparency's hedged crt.sh + certspotter
// lookup. crt.sh is chronically slow (8-9s even when healthy) and frequently
// down; a live probe hitting that used to time out or 502. The handler now
// HEDGES: it fires crt.sh, and if crt.sh hasn't answered within ~1.5s it also
// fires certspotter and returns whichever CT log succeeds first — so the endpoint
// is always fast and never depends on one flaky upstream. This pins that by
// stubbing globalThis.fetch (the handler passes ssrfDispatcher, but the call is
// the global fetch) — no network, deterministic.
import { NETWORK_TOOLS2 } from "../src/tools/network-kit2.js";

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

const stub = (handler) => { globalThis.fetch = (url) => handler(String(url)); };
const restore = () => { globalThis.fetch = realFetch; };
const never = () => new Promise(() => {}); // pending forever — simulates a hung crt.sh

try {
  // 1. crt.sh answers fast → served from crt.sh, certspotter never fired.
  let csHit = false;
  stub((url) => {
    if (url.includes("crt.sh")) return Promise.resolve(jsonRes(CRT_ROWS));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  let t0 = Date.now();
  let r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh", "crt.sh fast → source=crt.sh");
  ok(!csHit, "crt.sh fast → certspotter NOT fired (no wasted hedge)");
  ok(Date.now() - t0 < 500, "crt.sh fast → returns quickly (no hedge delay)");
  ok(r.subdomains.includes("a.example.com") && r.subdomains.includes("b.example.com"), "crt.sh SANs → subdomains");

  // 2. crt.sh HANGS → hedge fires certspotter after ~1.5s and returns fast via it.
  //    This is the core fix: a slow crt.sh no longer stalls the endpoint.
  stub((url) => {
    if (url.includes("crt.sh")) return never();
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
  ok(r.subdomains.includes("c.example.com"), "certspotter dns_names → subdomains");

  // 3. crt.sh fails FAST (502) → certspotter serves immediately (no hedge wait).
  stub((url) => url.includes("crt.sh") ? Promise.resolve(errRes(502)) : Promise.resolve(jsonRes(CS_ROWS)));
  t0 = Date.now();
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "certspotter", "crt.sh fast-fail → source=certspotter");
  ok(Date.now() - t0 < 1500, "crt.sh fast-fail → certspotter served without waiting the full hedge delay");

  // 4. Both sources down → clean 502 (not a hang, not a 500).
  stub(() => Promise.resolve(errRes(503)));
  let threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502, "both sources down → 502 (was: " + (threw && threw.statusCode) + ")");

  // 5. certspotter honors includeExpired=false (drops an expired cert).
  stub((url) => url.includes("crt.sh") ? Promise.resolve(errRes(502))
    : Promise.resolve(jsonRes([{ id: "x", cert_sha256: "old", dns_names: ["old.example.com"], not_after: "2000-01-01" }])));
  r = await tool.handler({ domain: "example.com" });
  ok(r.count === 0, "certspotter drops expired cert when includeExpired=false");

  // 6. Missing domain → 400 before any fetch (client error, no upstream call).
  let fetched = false;
  stub(() => { fetched = true; return Promise.resolve(jsonRes([])); });
  let bad400 = null;
  try { await tool.handler({}); } catch (e) { bad400 = e; }
  ok(bad400 && bad400.statusCode === 400 && !fetched, "missing domain → 400, no upstream call");
} finally {
  restore();
}

// The description must match the hedge: it answered from either CT search
// while saying "(via crt.sh)" (2026-10-02). It now names no single source and
// points at the `source` field, which the published example documents.
ok(!/via crt\.sh|via certspotter/i.test(tool.description), "description does not attribute every answer to one CT search");
ok(/`source`/.test(tool.description) && "source" in tool.discovery.output.example, "description and example document the `source` field");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
