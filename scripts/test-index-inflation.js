#!/usr/bin/env node
// `sellers` counts ORIGINS. Publishing only that number under the word
// "sellers" is instance inflation — the exact thing we document about
// third-party registries.
//
//   node scripts/test-index-inflation.js
//
// WHY: measured on our own live index 2026-07-31 — 858 of 2,008 origins
// carrying a Base payTo shared that address with at least one other origin, and
// a single address spanned 144 origins. /api/index reported sellerCount 2258
// against ~789 distinct payees in the sample. Both numbers are true; only one
// of them answers "how many operators are out there", and we were publishing
// the other one under a label that implies it.
//
// So the operator-level proxy is published BESIDE the origin count, never
// instead of it, and this pins the arithmetic — especially that addresses
// differing only in checksum case are one payee, since folding them wrongly
// (or failing to) moves the headline number.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { loadPersistedIndexCache, indexSnapshot } from "../src/x402-index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BASE = "eip155:8453";
const A_LOWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const A_UPPER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBbbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";

const seller = (origin, payTo) => [origin, {
  origin, fetchedAt: Date.now(), health: 1,
  tools: [{ slug: "t", name: "t", price: 0.002, method: "GET", url: `${origin}/api/t`,
    networks: [BASE], ...(payTo ? { payToByNetwork: { [BASE]: payTo } } : {}) }],
}];

const dir = mkdtempSync(join(tmpdir(), "a402-infl-"));
const file = join(dir, "cache.json");
writeFileSync(file, JSON.stringify({
  entries: [
    seller("https://one.example", A_LOWER),   // same operator…
    seller("https://two.example", A_UPPER),   // …different hostname AND different case
    seller("https://three.example", B),
    seller("https://four.example", null),     // advertises no Base payTo
  ],
}));
loadPersistedIndexCache(file);
const t = indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "x" }).totals;

ok(t.sellers === 5, `origin count includes every hostname plus self (got ${t.sellers})`);
ok(t.distinctBasePayees === 2,
  `three payTo-bearing origins across two operators collapse to 2 payees (got ${t.distinctBasePayees})`);
ok(t.distinctBasePayees < t.sellers,
  "the operator proxy is reported ALONGSIDE the origin count, and is the smaller of the two");

// The case fold is the whole ballgame: EVM addresses are case-insensitive, so
// failing to fold would report 3 operators where there are 2 — inflation by a
// different route. (base58/Stellar must never be folded; this counter is
// Base-only for exactly that reason — see src/payer.js.)
ok(t.distinctBasePayees !== 3, "checksum case does not create a phantom operator");

// An origin advertising no payTo must not be counted as an operator, and must
// not crash the count either.
ok(Number.isInteger(t.distinctBasePayees), "the count is an integer even with payTo-less origins present");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
