// Offline contract test: the site chrome names the chains through ONE link,
// "Marketplace by chain" (/marketplace), in the hover dropdown and the mobile
// menu. The per-chain lists were removed from the menus; every rail stays
// reachable from the marketplace directory. This pins that the menus neither
// list a chain nor drop the single link, whatever the live index reports.
import { ledgerShell, setNavIndexProvider } from "../src/ledger-chrome.js";
import { RAILS as RAIL_TABLE, railKey } from "../src/rails.js";

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

const RAILS = RAIL_TABLE.map(railKey);
const shellFor = (provider) => {
  setNavIndexProvider(provider);
  return ledgerShell({ title: "t", description: "d", canonical: "https://x/", baseUrl: "https://x", body: "" });
};
const liveChains = (labels) => () => ({ chains: labels.map((label) => ({ label, href: `/${label}`, sellers: 5, tools: 9, healthy: true })) });
const scenarios = [
  ["static fallback", null],
  ["live index with every rail", liveChains(RAILS)],
  ["live index with 24 chains", liveChains([...RAILS, ...Array.from({ length: 11 }, (_, i) => `chain${13 + i}`)])],
];

for (const [name, provider] of scenarios) {
  const html = shellFor(provider);
  const marketLinks = (html.match(/href="\/marketplace"/g) || []).length;
  ok(marketLinks >= 2 && html.includes("Marketplace by chain"), `${name}: "Marketplace by chain" is in the dropdown and the mobile menu (found ${marketLinks} /marketplace links)`);
  const chainLinks = RAILS.filter((c) => html.includes(`href="/${c}"`)).length;
  ok(chainLinks === 0 && !html.includes('class="ml-mm-chip'), `${name}: no per-chain link is listed in the site menus (found ${chainLinks})`);
}

setNavIndexProvider(null);
if (failed) {
  console.error(`test-nav-chains: ${failed} FAILED`);
  process.exit(1);
}
console.log("test-nav-chains: all assertions passed");
