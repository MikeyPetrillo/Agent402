// Chain page ("/base", "/celo", "/robinhood", ...) layout must be geometrically
// IDENTICAL across chains at a given viewport width, regardless of how long
// the chain's display name is. Before this fix, "The Robinhood Chain x402
// marketplace" wrapped to 3 lines while "The Celo x402 marketplace" wrapped
// to 2, and the "RAIL MANIFEST" ticker row doubled in height for any label
// long enough to wrap - so everything below shifted up or down depending on
// which chain you clicked to, even though nothing else on the page changed.
// Measured live (Playwright, desktop 1440px + mobile 390px) before fixing:
// the RAIL MANIFEST ticker's Y position was a rock-steady 156px on desktop
// for every one of the 12 chains, but on mobile it ranged from 689px to
// 720px purely from wrap-count differences in chain-name-length-dependent
// text (the H1, and a "paid canary ... (facilitator: X)" line whose
// facilitator name length varies per chain).
//
// Requires a booted server (same TARGET_URL convention as test-market-pages.js):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-chain-page-layout-stability.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { CHAIN_PAGES } from "../src/market-page.js";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const chains = Object.keys(CHAIN_PAGES);
ok(chains.length >= 10, `covers a substantial chain set (got ${chains.length})`);

const pages = new Map();
await Promise.all(chains.map(async (c) => {
  const html = await (await fetch(`${BASE}/${c}`)).text();
  pages.set(c, html);
}));

// --- the H1 wrap div: reserved-height class present on every chain, not just
// some (a partial rollout would silently un-fix exactly the chains most
// likely to have a long name). ---
{
  const missing = chains.filter((c) => !/class="ml-chain-h1-wrap"/.test(pages.get(c)));
  ok(missing.length === 0, `every chain page's H1 wrapper carries the reserved-height class${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
}

// --- the CSS rule itself: both the base (2-line) reservation and the
// narrow-viewport (3-line) override must ship, or the class above is inert. ---
{
  const missingBase = chains.filter((c) => !/\.ml-chain-h1-wrap\{min-height:80px\}/.test(pages.get(c)));
  ok(missingBase.length === 0, `desktop-width H1 reservation (2 lines) ships on every chain page${missingBase.length ? ` (missing: ${missingBase.join(", ")})` : ""}`);
  const missingNarrow = chains.filter((c) => !/@media \(max-width: 900px\) \{ \.ml-chain-h1-wrap\{min-height:120px\} \}/.test(pages.get(c)));
  ok(missingNarrow.length === 0, `narrow-viewport H1 reservation (3 lines) ships on every chain page${missingNarrow.length ? ` (missing: ${missingNarrow.join(", ")})` : ""}`);
}

// --- the RAIL MANIFEST ticker row: must be a deterministic-height stacked
// layout (flex-direction:column), never the old conditional-wrap shape
// (flex-wrap:wrap + justify-content:space-between) that let a long label
// silently double the row's height only for chains long enough to trigger it. ---
{
  const stillOldShape = chains.filter((c) => {
    const html = pages.get(c);
    const m = html.match(/<div style="[^"]*RAIL MANIFEST[^"]*"[^>]*>/);
    // The ticker row div itself - find it by proximity to the "RAIL MANIFEST" text.
    const idx = html.indexOf("RAIL MANIFEST");
    const rowStart = html.lastIndexOf("<div", idx);
    const rowTag = html.slice(rowStart, idx);
    return /flex-wrap:wrap/.test(rowTag) || /justify-content:space-between/.test(rowTag);
  });
  ok(stillOldShape.length === 0, `RAIL MANIFEST ticker row never uses the old conditional-wrap layout${stillOldShape.length ? ` (still old shape: ${stillOldShape.join(", ")})` : ""}`);
  const missingColumn = chains.filter((c) => {
    const html = pages.get(c);
    const idx = html.indexOf("RAIL MANIFEST");
    const rowStart = html.lastIndexOf("<div", idx);
    const rowTag = html.slice(rowStart, idx);
    return !/flex-direction:column/.test(rowTag);
  });
  ok(missingColumn.length === 0, `RAIL MANIFEST ticker row uses the deterministic stacked layout${missingColumn.length ? ` (missing on: ${missingColumn.join(", ")})` : ""}`);
}

// --- the canary line: reserved height so a short facilitator name (e.g. Sei's
// "PayAI", 2 lines) doesn't render shorter than a long one (e.g. Algorand's
// "GoPlausible, fees sponsored", 3 lines). ---
{
  const noReservation = chains.filter((c) => {
    const html = pages.get(c);
    const idx = html.indexOf("A paid canary buys tools");
    const tagStart = html.lastIndexOf("<p", idx);
    const tag = html.slice(tagStart, idx);
    return idx === -1 || !/min-height:56px/.test(tag);
  });
  ok(noReservation.length === 0, `canary-line paragraph carries a fixed min-height on every chain${noReservation.length ? ` (missing: ${noReservation.join(", ")})` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
