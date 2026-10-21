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

// ---- 3. far-future ceiling: >16 chains truncates to 16, never below the roster (12 rails + a gated one fit) ----
{
  const many = [...RAILS, ...Array.from({ length: 8 }, (_, i) => `chain${13 + i}`)].map((label) => ({ label, href: `/${label}`, sellers: 1, healthy: true }));
  setNavIndexProvider(() => ({ chains: many }));
  const html = ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
  const shown = many.filter((c) => html.includes(`href="/${c.label}"`)).length;
  ok(shown === 16, `20 chains truncate to exactly 16 (got ${shown})`);
  const thirteen = many.slice(0, 13);
  setNavIndexProvider(() => ({ chains: thirteen }));
  const html13 = ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
  ok(thirteen.every((c) => html13.includes(`href="/${c.label}"`)), "13 chains (12 rails plus a gated rail in the live offer) are all shown");
}

setNavIndexProvider(null);
if (failed) {
  console.error(`test-nav-chains: ${failed} FAILED`);
  process.exit(1);
}
console.log("test-nav-chains: all assertions passed");
