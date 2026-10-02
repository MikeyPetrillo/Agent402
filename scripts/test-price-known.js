#!/usr/bin/env node
// "priceUsd: 0" MEANT TWO THINGS AND COULD NOT BE TOLD APART.
//
// /api/route has published priceUsd since long before this, computed by
// parsePrice, which returns 0 for anything it cannot parse. So a route whose
// price we failed to read is advertised at zero - free - and a consumer has no
// way to distinguish that from a route that really is free.
//
// Measured live 2026-09-21: 16 of 286 distinct external rows read priceUsd 0,
// and 14 of them carry `price: null`, meaning we never read a price at all.
// Two are "$free" and really are free.
//
// The file already knew. priceToMicroUsd's own comment, three lines below
// parsePrice, says its null is deliberate and "never parsePrice's 0, which
// would publish 'free' for 'we could not read it'". The right reader existed
// and this surface kept calling the wrong one.
//
// NOT FIXED BY CHANGING priceUsd (operator decision, 2026-09-21): someone
// reads that field today and a 0 turning into null breaks them. Publishing a wrong number is our mistake to disclose, not theirs to
// absorb. priceUsd keeps its meaning exactly; priceKnown says whether to
// believe it.
//
//   node scripts/test-price-known.js
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { priceToMicroUsd } from "../src/x402-index.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

// The parser the OLD field uses, copied verbatim from x402-index.js so the two
// readings can be compared here without exporting a function we are retiring
// the use of rather than the function itself.
const parsePrice = (p) => {
  if (typeof p === "number") return p;
  const v = parseFloat(String(p ?? "").replace(/[^0-9.]/g, ""));
  return isFinite(v) ? v : 0;
};
const known = (price) => priceToMicroUsd(price) != null;

// --- the shapes a real crawl produces ---------------------------------------
//
// Each row: [published price, parsePrice's answer, is the price knowable].
// The cases that matter are the ones where parsePrice says 0.
const CASES = [
  [0.032, 0.032, true, "a bare number"],
  ["$0.093", 0.093, true, "a display string"],
  ["0.05", 0.05, true, "a numeric string"],
  ["$1,000.00", 1000, true, "thousands separators"],
  ["0.05 USDC", 0.05, true, "a price with a unit"],
  [{ usd: 0.05 }, 0, true, "an OBJECT price - parsePrice reads 0, the crawler reads $0.05"],
  [{ amountMinor: 50, currency: "USD" }, 0, true, "Stripe-style minor units - same disagreement"],
  [null, 0, false, "no price at all"],
  ["", 0, false, "an empty price"],
  ["abc", 0, false, "an unparseable price"],
];

for (const [price, expectParsed, expectKnown, label] of CASES) {
  eq(parsePrice(price), expectParsed, `parsePrice: ${label}`);
  eq(known(price), expectKnown, `priceKnown: ${label}`);
}

// The point of the field, stated as an assertion: every case where parsePrice
// says 0, priceKnown separates the two meanings.
{
  const zeros = CASES.filter(([, parsed]) => parsed === 0);
  ok(zeros.length >= 5, `control: the corpus really does contain parsePrice-zero cases (${zeros.length})`);
  ok(zeros.some(([, , k]) => k === true) && zeros.some(([, , k]) => k === false),
     "...and they split BOTH ways, which is the whole reason a second field is needed rather than a rename");
}

// A genuinely free route is knowable and zero. It must NOT read as unknown:
// that would trade one wrong answer for another.
{
  eq(known(0), true, "an explicit 0 is a KNOWN price, not an unreadable one");
  eq(priceToMicroUsd(0), 0, "...and it reads as zero micro-dollars");
}

// --- the old field is untouched ---------------------------------------------
//
// The whole constraint. A source pin, because the danger is a later edit
// "tidying" priceUsd onto the better parser and silently changing a published
// number from 0 to null for somebody's running code.
{
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/priceUsd: parsePrice\(t\.price\)/.test(src),
     "/api/route still computes priceUsd with parsePrice - its published meaning does not move");
  ok(/function priceKnownProjection/.test(src) && /priceToMicroUsd\(t\?\.price\) != null/.test(src),
     "...while priceKnown is computed from priceToMicroUsd, the reader the crawler itself trusts");
  const calls = (src.match(/\.\.\.priceKnownProjection\(t\),/g) || []).length;
  eq(calls, 3, "and it rides all THREE row surfaces (sellerDetail, route, index-tools), not just the one that drifted");
}

console.log(`\nOK: ${n} passed`);
