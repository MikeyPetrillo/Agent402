// Chain chips: offline unit tests. No network. Every rail is named in plain
// text, each chip links to that chain's page, and no network's logo (an <svg>
// or an <img>) is drawn on the home page, /marketplace or a chain page.
//
//   node scripts/test-chain-logos.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import * as chips from "../src/chain-logos.js";
import { RAILS, railKey, countWord } from "../src/rails.js";

const { CHAIN_ORDER, chainLogoStrip, chainChipTitle, RAIL_COUNT_WORD } = chips;
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

ok(CHAIN_ORDER.length === RAILS.length, `every rail in CHAIN_ORDER (got ${CHAIN_ORDER.length} of ${RAILS.length})`);
ok(!("CHAIN_MARKS" in chips) && !("chainMark" in chips), "no logo artwork is exported");
ok(CHAIN_ORDER.every(([k], i) => k === railKey(RAILS[i])), "chip keys are the rails' fixed keys");

const strip = chainLogoStrip({});
for (const [slug, name] of CHAIN_ORDER) {
  ok(strip.includes(`href="/${slug}"`), `strip links /${slug}`);
  ok(strip.includes(`>${name}</span>`), `strip names ${name} in text`);
  ok(strip.includes(`title="${chainChipTitle(name)}"`), `${name}: the chip's title names our page, not the network's marketplace`);
}
ok(!/<svg|<img/i.test(strip), "strip draws no logo");
ok(!/x402 marketplace/.test(strip), "no chip calls a network's page its marketplace");
ok(strip.includes(`Settles natively on ${RAIL_COUNT_WORD} networks`) && RAIL_COUNT_WORD === countWord(RAILS.length), `strip label counts the rails (${RAIL_COUNT_WORD})`);
ok(chainLogoStrip({ label: "Custom label here" }).includes("Custom label here"), "custom label flows through");

// The pages that once drew the marks import no artwork and name no chain page
// "<Chain> x402 marketplace".
for (const f of ["src/ledger-home.js", "src/market-page.js"]) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  ok(!/chainMark\(|CHAIN_MARKS/.test(src), `${f}: draws no chain logo`);
  ok(!/\$\{(?:esc\()?(?:C\.chainName|name|r\.name)\)?\} x402 marketplace/.test(src), `${f}: no "<Chain> x402 marketplace" name`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
