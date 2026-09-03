// Offline unit tests for the /what-is-x402 SEO pillar page renderer
// (Aug 2026 revamp). Fixture data — no server, no network.
import { whatIsX402Page } from "../src/what-is-x402.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- real data rendering ---------------------------------------------------
const stats = { toolCallsServed: { viaUSDCByNetwork: { base: 7619, solana: 3025, "robinhood (USDG)": 114 }, viaMPPWire: 69 } };
const board = [
  { name: "Agent402.Tools", totalUsd: 900.5, callsSettled: 30000, uniqueBuyers: 300 },
  { name: "Seller-One.example", totalUsd: 21422.22932, callsSettled: 1127246, uniqueBuyers: 166 },
  { name: "agents.chain.link", totalUsd: 103.432, callsSettled: 9711, uniqueBuyers: 2 },
];
const leaderboardSnapshot = { leaderboard: board, windowLabel: "7d", totalSellers: 824 };
let html = whatIsX402Page("https://agent402.tools", { stats, leaderboardSnapshot });

ok(html.includes("What are <span") && html.includes(">x402</span>"), "hero H1 renders");
ok(html.includes("7,619") && html.includes(">Base<"), "rails table shows real per-network settled counts");
ok(html.includes("114") && html.includes(">Robinhood Chain<") && html.includes(">USDG<"), "Robinhood Chain rendered with its real count and USDG asset, not USDC");
ok(html.includes(">·<"), "a rail with zero recorded settlements renders as a dash placeholder, never a fabricated 0");
ok(html.includes("69") && html.includes("settled over the MPP wire"), "MPP wire count renders");

// --- adoption table excludes Agent402's own row ----------------------------
// Scoped to the #who section specifically - "Agent402.Tools" also appears
// unrelated in the page footer's own brand name, which would false-positive
// a whole-page substring check.
{
  const start = html.indexOf('id="who"');
  const end = html.indexOf('id="start"');
  const whoSection = html.slice(start, end);
  ok(!whoSection.includes("Agent402.Tools"), "Agent402's own row is excluded from the third-party adoption table");
  ok(whoSection.includes(">Seller-One.example<") && whoSection.includes(">agents.chain.link<"), "external sellers appear in the adoption table");
  ok(whoSection.includes("824") && whoSection.includes("sellers scanned"), "seller-scanned count renders from the live snapshot");
}

// --- honest fallback when no data is available -----------------------------
html = whatIsX402Page("https://agent402.tools", {});
ok(html.includes(">·<"), "every rail reads as a placeholder, never a fabricated 0, when stats are absent");
ok(html.includes("unavailable"), "adoption table states unavailable rather than rendering an empty table silently");
ok(html.includes("seller count unavailable"), "seller-scanned line states unavailable rather than omitting or fabricating a count");

// --- structured data --------------------------------------------------------
html = whatIsX402Page("https://agent402.tools", { stats, leaderboardSnapshot });
ok(html.includes('"@type":"TechArticle"'), "TechArticle JSON-LD present");
ok(html.includes('"@type":"DefinedTermSet"') && html.includes('"name":"x402"'), "DefinedTermSet JSON-LD present, defines x402");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present");
const faqMatches = html.match(/"@type":"Question"/g) || [];
ok(faqMatches.length === 9, `FAQPage JSON-LD carries all 9 questions (got ${faqMatches.length})`);
const visibleFaqArticles = (html.match(/<article style="padding:26px 0/g) || []).length;
ok(visibleFaqArticles === 9, `visible FAQ prose also carries exactly 9 questions, matching the schema 1:1 (got ${visibleFaqArticles})`);

// --- comparison table --------------------------------------------------------
ok(html.includes(">MPP</th>") && html.includes("X-PAYMENT header"), "x402 vs MPP comparison table renders");

// --- copy hygiene -----------------------------------------------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
