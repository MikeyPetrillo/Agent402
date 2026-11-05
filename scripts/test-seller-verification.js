#!/usr/bin/env node
// Keeping what a PAID call to an external seller returned.
//
// The daily dataset records supply - who exists, what they advertise, what
// settled to their wallet - and every row of it comes from documents sellers
// publish about themselves or from public chain reads. None of it can say
// whether paying a seller produces what they promised. The sweep answers that
// by spending real money, and until now the answer expired with the Actions
// run that produced it: three sweeps' worth of paid observations, gone.
//
// What this stores is therefore the one part of the dataset that cost money to
// make, and the rules below are about not overclaiming with it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// A bucket that records what it was asked to write, so the projection and the
// manifest can be asserted without S3.
const written = new Map();
const { recordSellerVerification, sellerVerificationStatus, VERIFICATION_PREFIX } = await import("../src/seller-verification.js");
// Deps are INJECTED rather than module-patched: ES module bindings are
// read-only, and a store that can only be tested by reaching into another
// module's exports is a store nobody will test.
const stub = { put: async (k, b) => { written.set(k, b); }, configured: () => true };

const row = (o) => ({ origin: "https://s.example", route: "/r", method: "POST", verdict: "paid_delivers", listedUsd: 0.002, quotedUsd: 0.002, paidStatus: 200, ms: 120, ...o });

// --- the projection is an ALLOWLIST -----------------------------------------
{
  const src = readFileSync(new URL("../src/seller-verification.js", import.meta.url), "utf8");
  ok(/const ROW_COLUMNS = \[/.test(src), "rows are projected through a named column list");
  ok(!/bodyKeys.*ROW_COLUMNS|ROW_COLUMNS.*bodyKeys/s.test(src.split("const ROW_COLUMNS")[1].split("]")[0]),
     "bodyKeys is NOT a stored column - a seller's response content is theirs, and what we publish is what we observed about the contract they publish");
  ok(/delete out\.bodyKeys/.test(src), "...and it is deleted even if a future driver puts it in the row");
  ok(/never a denylist/i.test(src), "the source says why it is an allowlist: a field added to the sweep must not silently become a published column");
}

// --- the manifest states the limit of the claim ------------------------------
{
  const src = readFileSync(new URL("../src/seller-verification.js", import.meta.url), "utf8");
  ok(/The claim stops at SHAPE/.test(src),
     "the manifest says the claim is SHAPE only - a seller returning every promised key with wrong values reads as delivering, and a buyer must not read this as a quality rating");
  ok(/never a rating/i.test(src), "...and that a row is one observation on one date with one input, not a score");
  ok(/No response bodies are stored/.test(src), "and that no seller's content is kept");
  ok(/every row here cost money/i.test(src), "the manifest says what makes it different from a crawl");
}

// --- the workflow must not hold bucket credentials --------------------------
{
  const wf = readFileSync(new URL("../.github/workflows/seller-sweep.yml", import.meta.url), "utf8");
  ok(!/BACKUP_S3/.test(wf),
     "the sweep workflow has NO bucket credentials: it runs with a funded spending key, and giving that job write access to our dataset storage would widen what one compromised workflow reaches, for nothing");
  ok(/AGENT402_OPERATOR_TOKEN/.test(wf), "it posts what it observed and the server decides what to keep - the /api/status/probe split");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const i = srv.indexOf('"/__operator/seller-verification"');
  ok(i > 0 && /operatorAuthed\(req\)/.test(srv.slice(i, i + 300)), "and the endpoint that accepts it is operator-authed");
}

// --- a run that paid must never be failed by a failed handoff ---------------
{
  const drv = readFileSync(new URL("./seller-sweep.mjs", import.meta.url), "utf8");
  const tail = drv.slice(drv.indexOf("__operator/seller-verification"));
  ok(/catch \(e\)/.test(tail), "the handoff is wrapped: a run that already spent money must not fail because the record could not be posted");
  ok(/artifact still has everything/i.test(tail), "...and says so, because the artifact is still the fallback");
  ok(/if \(LIVE && process\.env\.AGENT402_OPERATOR_TOKEN\)/.test(drv), "a DRY run posts nothing - only a run that actually paid produces a record");
}

// --- the write itself --------------------------------------------------------
{
  const payload = { spentUsd: 1.25, capUsd: 0.02, rows: [
    row({}), row({ origin: "https://b.example", verdict: "paid_hollow", missingKeys: ["ok"] }),
    row({ origin: "https://c.example", verdict: "not_a_real_verdict" }),  // refused
    row({ origin: null }),                                                 // refused
    { garbage: true },                                                     // refused
  ] };
  const usable = payload.rows.filter((r) => r && typeof r === "object" && typeof r.origin === "string" && ["paid_delivers", "paid_hollow"].includes(r.verdict));
  eq(usable.length, 2, "control: only two of the five seeded rows are usable, so the filter has something to prove");
  try {
    const out = await recordSellerVerification(payload, { ...stub, now: () => Date.parse("2026-09-12T10:00:00Z") });
    eq(out.sellers, 2, "an unknown verdict and a row with no origin are REFUSED, not stored with a null");
    eq(out.day, "2026-09-12", "the object is dated by the day the sweep ran");
    ok(written.has(`${VERIFICATION_PREFIX}/dt=2026-09-12/verification.ndjson`), "rows are written as dated NDJSON, like every other table");
    ok(written.has(`${VERIFICATION_PREFIX}/dt=2026-09-12/manifest.json`), "with a manifest beside them");
    const m = JSON.parse(written.get(`${VERIFICATION_PREFIX}/dt=2026-09-12/manifest.json`).toString());
    eq(m.tally, { paid_delivers: 1, paid_hollow: 1 }, "the manifest carries the tally");
    eq(m.paidSellers, 2, "and how many actually took payment, which is the denominator every other figure needs");
    eq(sellerVerificationStatus().sellers, 2, "the operator surface reports the last write, counts only");
    const nd = written.get(`${VERIFICATION_PREFIX}/dt=2026-09-12/verification.ndjson`).toString().trim().split("\n").map(JSON.parse);
    ok(nd.every((r) => !("bodyKeys" in r)), "no stored row carries a response body or its keys");
    ok(nd.every((r) => "verdict" in r && "origin" in r), "every stored row carries the two fields that make it meaningful");
  } finally { /* injected deps: nothing to restore */ }
}

// --- nothing usable is an error, never an empty dated object ----------------
{
  let threw = null;
  const neverWrite = { configured: () => true, put: async () => { throw new Error("should not be called"); } };
  try { await recordSellerVerification({ rows: [{ garbage: true }] }, neverWrite); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 400,
     "a payload with no usable rows is REFUSED: writing an empty dated object would publish 'we swept and found nothing' on a day we swept nothing");
}

console.log(`test-seller-verification: ${n} assertions OK`);
