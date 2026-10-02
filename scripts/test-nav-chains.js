// Offline contract test: EVERY live rail must appear in the site chrome's
// chain navigation — the hover dropdown AND the mobile hamburger menu.
// Regression this pins: the old ">9 → slice(0,7)" nav ceiling silently
// dropped Stellar, Algorand, and Robinhood from both menus the moment the
// 10th rail shipped (found by the operator on a phone, 2026-07-22, not by CI).
import { ledgerShell, setNavIndexProvider } from "../src/ledger-chrome.js";

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

const RAILS = ["base", "solana", "polygon", "arbitrum", "monad", "celo", "avalanche", "sei", "optimism", "stellar", "algorand", "robinhood"];

// ---- 1. static fallback (no provider): all 12 rails reachable ----
{
  setNavIndexProvider(null);
  const html = ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
  for (const c of RAILS) {
    ok(html.includes(`href="/${c}"`), `static nav links /${c}`);
  }
}

// ---- 2. live provider with all 12 chains: nothing truncated away ----
{
  setNavIndexProvider(() => ({
    chains: RAILS.map((label) => ({ label, href: `/${label}`, sellers: 5, tools: 9, healthy: true })),
  }));
  const html = ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
  for (const c of RAILS) {
    const n = (html.match(new RegExp(`href="/${c}"`, "g")) || []).length;
    ok(n >= 2, `live nav shows /${c} in both dropdown and mobile menu (found ${n})`);
  }
}

// ---- 3. far-future ceiling: >12 chains truncates to 12, never below the roster ----
{
  const many = [...RAILS, "chain13", "chain14"].map((label) => ({ label, href: `/${label}`, sellers: 1, healthy: true }));
  setNavIndexProvider(() => ({ chains: many }));
  const html = ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
  const shown = many.filter((c) => html.includes(`href="/${c.label}"`)).length;
  ok(shown === 12, `14 chains truncate to exactly 12 (got ${shown})`);
}

setNavIndexProvider(null);
if (failed) {
  console.error(`test-nav-chains: ${failed} FAILED`);
  process.exit(1);
}
console.log("test-nav-chains: all assertions passed");
