// Chain logo marks — offline unit tests. No network. Verifies each of the
// twelve rails has a mark, the marks are single-tone (currentColor, no baked
// brand colors), and the trust strip links every chain to its marketplace page.
//
//   node scripts/test-chain-logos.js
import { CHAIN_MARKS, CHAIN_ORDER, chainMark, chainLogoStrip, RAIL_COUNT_WORD } from "../src/chain-logos.js";
import { RAILS } from "../src/rails.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const CHAINS = ["base", "solana", "polygon", "arbitrum", "monad", "celo", "avalanche", "sei", "optimism", "arc", "stellar", "algorand", "robinhood"];

// --- every rail has a mark, and it renders to an <svg> ---------------------------
ok(CHAIN_ORDER.length === RAILS.length && CHAINS.length === RAILS.length, `every rail in CHAIN_ORDER (got ${CHAIN_ORDER.length} of ${RAILS.length})`);
for (const c of CHAINS) {
  const svg = chainMark(c);
  ok(svg.startsWith("<svg") && svg.includes("viewBox=") && svg.endsWith("</svg>"), `${c}: renders a complete <svg>`);
  ok(svg.includes('fill="currentColor"'), `${c}: single-tone (currentColor)`);
  // no baked hex/rgb brand color leaks into the mark (would break monochrome)
  ok(!/fill="#|fill:#|rgb\(/.test(svg), `${c}: no hard-coded brand color`);
}

// base is its circle; the rest carry a path
ok(chainMark("base").includes("<circle"), "base mark is a circle");
ok(chainMark("solana").includes("<path"), "solana mark is a path");

// --- unknown slug is a safe empty string (never throws / never a broken tag) -----
ok(chainMark("dogecoin") === "", "unknown slug → empty string");
ok(chainMark(undefined) === "", "undefined slug → empty string");

// --- size override flows through -------------------------------------------------
ok(chainMark("base", 40).includes('width="40"'), "size override applied");

// --- the trust strip links every chain to its /<chain> marketplace page ----------
const strip = chainLogoStrip({});
for (const [slug, name] of CHAIN_ORDER) {
  ok(strip.includes(`href="/${slug}"`), `strip links /${slug}`);
  ok(strip.includes(`>${name}</span>`), `strip labels ${name}`);
}
ok((strip.match(/<svg/g) || []).length === RAILS.length, "strip renders one mark per rail");
ok(strip.includes(`Settles natively on ${RAIL_COUNT_WORD} networks`) && RAIL_COUNT_WORD === "thirteen", `strip label counts the rails (${RAIL_COUNT_WORD})`);
ok(chainLogoStrip({ label: "Custom label here" }).includes("Custom label here"), "custom label flows through");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
