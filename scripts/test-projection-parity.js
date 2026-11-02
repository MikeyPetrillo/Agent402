#!/usr/bin/env node
// The same tool, served by three surfaces, must not have three vocabularies.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-projection-parity.js
//
// WHY: /api/find, /api/route and /api/index/tools all return tool rows. They
// disagreed on field names, and a missing key is indistinguishable from a
// missing value:
//
//   price      served by /api/find and /api/route, absent from /api/index/tools
//   priceUsd   served by /api/index/tools and /api/route, absent from /api/find
//   slug       absent from /api/index/tools, the surface listing 65k rows
//   payable    added to /api/route only, and to nothing else, on the same day
//              as a fix for this exact class of defect
//
// This is the failure mode src/x402-index.js's own header calls out: a field
// present on some accessors and not others is inert on whichever surface
// happens to be read. It was measured wrong twice during one audit because
// reading `price` off /api/index/tools returned undefined for every row and
// looked like "nothing is priced".
//
// A parity test is the only thing that catches it, because each surface is
// individually correct.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const j = async (u) => (await fetch(`${TARGET}${u}`)).json();
const [tools, route, find] = await Promise.all([
  j("/api/index/tools?limit=5"), j("/api/route?q=hash&top=5"), j("/api/find?q=hash"),
]);
const rows = {
  "/api/index/tools": (tools.results || [])[0],
  "/api/route": (route.results || [])[0],
  "/api/find": (find.results || [])[0],
};
for (const [n, r] of Object.entries(rows)) ok(r && typeof r === "object", `${n} returns a row to compare`);

// The identity and price vocabulary every surface must share. Deliberately a
// small set: surfaces legitimately differ in what they add, never in what they
// call the same thing.
const SHARED = ["route", "name", "price", "priceUsd", "slug"];
for (const f of SHARED) {
  const missing = Object.entries(rows).filter(([, r]) => !r || !(f in r)).map(([n]) => n);
  ok(missing.length === 0, `every surface serves "${f}"${missing.length ? ` (missing on ${missing.join(", ")})` : ""}`);
}

// payable is the one added today to a single surface. External rows are where
// it matters, so it must be on the surface that lists them.
ok("payable" in (rows["/api/index/tools"] || {}),
  "the surface listing every third-party row serves `payable`, not only /api/route");
ok("payable" in (rows["/api/route"] || {}), "and /api/route still serves it");

// A price stored as a string must reach priceUsd. Manifest and llms.txt
// catalogues store "$0.002", and the old rule (typeof === "number") nulled all
// of them, so the same tool read priced on one surface and unpriced on another.
const priced = (tools.results || []).filter((r) => r.price != null && String(r.price) !== "");
const dropped = priced.filter((r) => r.priceUsd == null);
ok(dropped.length === 0,
  `a string price still reaches priceUsd (${dropped.length} of ${priced.length} rows had a price but null priceUsd)`);

// The external-row projection cannot be exercised here: without a live crawl
// the index holds no third-party rows, so the assertion above only sees our
// own catalog. Check its RULE statically instead, rather than report coverage
// this run did not have.
const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
const externalRow = src.slice(src.indexOf("ours: false,"), src.indexOf("networks: Array.isArray(t?.networks)"));
ok(/priceUsd: parsePrice\(/.test(externalRow),
  "the external-row projection prices with parsePrice, the same rule as every other surface");
ok(!/priceUsd: typeof t\?\.price === "number"/.test(externalRow),
  "...and not the number-only rule that silently nulled every string price");
ok(/\bprice: t\?\.price \?\? null,/.test(externalRow) && /payable: payabilityOf\(t\)/.test(externalRow),
  "the external row carries price and payable too, not just our own rows");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
