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
// A buyer's retry carries roughly the challenge plus its own signature and
// authorization (~700 bytes measured), so budget below the common 8 KB limit.
const MAX_HEADER_BYTES = Number(process.env.MAX_CHALLENGE_HEADER_BYTES) || 12_000;
const WARN_HEADER_BYTES = Number(process.env.WARN_CHALLENGE_HEADER_BYTES) || 9_000;
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
      res = await fetch(`${TARGET}${t.path}`, {
        method: t.method,
        headers: { "content-type": "application/json" },
        body: t.method === "POST" ? "{}" : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) { skipped.push(`${t.slug}: ${String(e.message).slice(0, 40)}`); continue; }
    if (res.status !== 402) continue; // free tier, or FREE_MODE: nothing to bound
    const h = res.headers.get("payment-required") || "";
    if (!h) { rows.push({ slug: t.slug, bytes: -1 }); continue; }
    rows.push({ slug: t.slug, bytes: h.length });
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

const over = sized.filter((r) => r.bytes > MAX_HEADER_BYTES);
ok(over.length === 0, `no challenge over the ${MAX_HEADER_BYTES}-byte ceiling${over.length ? `: ${over.slice(0, 5).map((r) => `${r.slug} ${r.bytes}`).join(", ")} - a buyer echoes this back and proxies refuse oversized headers` : ` (${sized.length} paid routes probed)`}`);

const warn = sized.filter((r) => r.bytes > WARN_HEADER_BYTES && r.bytes <= MAX_HEADER_BYTES);
console.log(`\nlargest challenge: ${sized[0].slug} at ${sized[0].bytes} bytes (smallest ${sized[sized.length - 1].bytes})`);
if (warn.length) {
  console.log(`WARNING: ${warn.length} route(s) past the ${WARN_HEADER_BYTES}-byte watch line - trim an extension before adding a rail`);
  for (const r of warn.slice(0, 10)) console.log(`   ${String(r.bytes).padStart(6)}  ${r.slug}`);
}
if (skipped.length) console.log(`(${skipped.length} route(s) could not be probed: ${skipped.slice(0, 3).join("; ")})`);
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
