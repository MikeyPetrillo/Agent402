#!/usr/bin/env node
// Readiness harness for x402 `batch-settlement` on Robinhood Chain (eip155:4663)
// and Ink (eip155:57073), for the day the facilitator that settles those
// chains advertises it. Nothing here changes what the server offers.
//
// Two halves:
//   1. Offline, always run: a local stub facilitator answers /supported. The
//      harness reads it through the same @x402/core facilitator client the
//      server uses, and finds the batch-settlement kind on a chain only when
//      the stub lists it (a stub that lists exact and upto alone finds none, so
//      the reader cannot pass by matching any kind). The installed @x402/evm
//      ships the server scheme (`batch-settlement`), and it constructs for a
//      receiver address, so registering it is a change to src/payments.js, not
//      a package upgrade.
//   2. Live, operator-run only: with BATCH_SETTLE_FACILITATOR_URL set it reads
//      that facilitator's /supported and reports, per chain, whether
//      batch-settlement is advertised. Without the variable, or when nothing is
//      advertised yet, it is SKIPPED with the reason printed: as of 2026-11-18
//      the chains' facilitator advertises exact and upto on eip155:4663, not
//      batch-settlement. A skip is not a failure: no build depends on it.
//
// When the live half reports READY: register the scheme behind its own switch,
// run one supervised sub-cent buy, then decide (the operator's decision notes).
//
//   node scripts/test-batch-settle-harness.js
//   BATCH_SETTLE_FACILITATOR_URL=https://facilitator.example node scripts/test-batch-settle-harness.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

export const BATCH_SCHEME = "batch-settlement";
export const HARNESS_CHAINS = Object.freeze({ "eip155:4663": "Robinhood Chain", "eip155:57073": "Ink" });

/** The batch-settlement kind a /supported answer lists for `network` (v2 CAIP-2 id), or null. */
export function batchKindOn(supported, network) {
  for (const k of Array.isArray(supported?.kinds) ? supported.kinds : []) {
    if (String(k?.scheme || "").toLowerCase() === BATCH_SCHEME && String(k?.network || "") === network) return k;
  }
  return null;
}

const { HTTPFacilitatorClient } = await import("@x402/core/server");

async function withStub(kinds, fn) {
  const srv = createServer((req, res) => {
    if (req.url === "/supported") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ kinds, extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000aa"] } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

// ---- 1. offline: the reader, through the server's own client --------------------
const today = [
  { x402Version: 2, scheme: "exact", network: "eip155:4663" },
  { x402Version: 2, scheme: "upto", network: "eip155:4663" },
  { x402Version: 2, scheme: "exact", network: "eip155:57073" },
];
await withStub(today, async (url) => {
  const sup = await new HTTPFacilitatorClient({ url }).getSupported();
  ok(Array.isArray(sup?.kinds) && sup.kinds.length === 3, `the stub's /supported is read through @x402/core's facilitator client (${sup?.kinds?.length} kinds)`);
  ok(Object.keys(HARNESS_CHAINS).every((n) => batchKindOn(sup, n) === null), "a facilitator listing exact and upto only: no batch-settlement found on either chain");
});
await withStub([...today, { x402Version: 2, scheme: "batch-settlement", network: "eip155:4663" }], async (url) => {
  const sup = await new HTTPFacilitatorClient({ url }).getSupported();
  ok(batchKindOn(sup, "eip155:4663")?.scheme === BATCH_SCHEME && batchKindOn(sup, "eip155:57073") === null, "once listed on eip155:4663 it is found there, and only there");
  ok(batchKindOn({ kinds: [{ scheme: "batch-settlement", network: "robinhood" }] }, "eip155:4663") === null, "a v1 network name is not taken for the CAIP-2 id");
});
{
  let mod = null;
  try { mod = await import("@x402/evm/batch-settlement/server"); } catch (e) { mod = { error: String(e?.message || e) }; }
  const Scheme = mod?.BatchSettlementEvmScheme;
  let inst = null;
  try { inst = Scheme ? new Scheme("0x000000000000000000000000000000000000dEaD") : null; } catch (e) { inst = { error: String(e?.message || e) }; }
  ok(typeof Scheme === "function" && inst?.scheme === BATCH_SCHEME, `the installed @x402/evm ships the batch-settlement server scheme and it constructs for a receiver (${inst?.scheme || inst?.error || mod?.error})`);
}

// ---- 2. live, operator-run ------------------------------------------------------
const live = String(process.env.BATCH_SETTLE_FACILITATOR_URL || "").trim();
if (!live) {
  console.log("SKIP - live check: set BATCH_SETTLE_FACILITATOR_URL to the Robinhood Chain facilitator to run it. As of 2026-11-18 that facilitator advertises exact and upto on eip155:4663 and not batch-settlement, so there is nothing to test against yet.");
} else if (!/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(live)) {
  ok(false, "BATCH_SETTLE_FACILITATOR_URL is an https URL");
} else {
  let sup = null;
  try { sup = await new HTTPFacilitatorClient({ url: live.replace(/\/+$/, "") }).getSupported(); } catch (e) { sup = { error: String(e?.message || e).slice(0, 160) }; }
  if (!Array.isArray(sup?.kinds)) {
    console.log(`SKIP - live check: the facilitator's /supported could not be read (${sup?.error || "no kinds"}).`);
  } else {
    const found = Object.entries(HARNESS_CHAINS).filter(([n]) => batchKindOn(sup, n));
    if (!found.length) console.log(`SKIP - live check: the facilitator lists ${sup.kinds.length} kinds and no batch-settlement on ${Object.keys(HARNESS_CHAINS).join(" or ")} yet.`);
    else console.log(`READY - batch-settlement advertised on ${found.map(([n, name]) => `${name} (${n})`).join(", ")}: register the scheme behind its own switch and run one supervised sub-cent buy before deciding.`);
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
