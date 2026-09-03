// Offline unit tests for the homepage renderer (src/ledger-home.js, Aug 2026
// revamp). Fixture data only - no server, no network. Covers what
// the removed /index page block did not: real data bindings
// (rails, leaderboard, router-share disclosure), the commercial-sensitivity
// rule, JSON-LD honesty, and copy hygiene.
import { ledgerHomePage } from "../src/ledger-home.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const catalog = {
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text", tags: [] },
  "POST /api/search": { name: "Web search", slug: "search", category: "search", price: "$0.01", description: "Search the web", tags: [] },
  "POST /api/answer": { name: "Answer", slug: "answer", category: "search", price: "$0.01", description: "Cited answer", tags: [] },
};

// --- real data rendering: rails, counter, router-share disclosure -----------
{
  const stats = {
    toolCallsServed: {
      viaUSDC: 40233,
      viaProofOfWork: 918422,
      viaMPPWire: 69,
      viaRouter: 41,
      viaUSDCByNetwork: { base: 30112, solana: 6100, "robinhood (USDG)": 214 },
    },
  };
  const board = [
    { name: "Agent402.Tools", totalUsd: 900.5, callsSettled: 30000, uniqueBuyers: 300 },
    { name: "Seller-One.example", totalUsd: 21422.22932, callsSettled: 1127246, uniqueBuyers: 166 },
    { name: "agents.chain.link", totalUsd: 103.432, callsSettled: 9711, uniqueBuyers: 2 },
  ];
  const leaderboardSnapshot = { leaderboard: board, windowLabel: "7d", totalSellers: 824 };
  const html = ledgerHomePage(BASE_URL, catalog, stats, leaderboardSnapshot, Array.from({ length: 42 }));

  ok(html.includes("40,233"), "live counter seeds from the real server-rendered viaUSDC value");
  ok(html.includes("918,422") && html.includes("more served free over proof-of-work"), "free-tier (PoW) count renders");
  ok(html.includes("30,112") && html.includes(">Base<"), "per-rail settlement grid shows real per-network counts");
  ok(html.includes("214") && html.includes(">Robinhood Chain<") && html.includes(">USDG<"), "Robinhood Chain renders with its real count and USDG asset, not USDC");
  ok(html.includes(">·<"), "a rail with zero recorded settlements renders as a dash placeholder, never a fabricated 0");
  ok(html.includes("69") && html.includes("settled over the MPP wire"), "MPP wire count renders");
  ok(html.includes(">41</strong> of 40,233 paid calls"), "router-share disclosure renders the real viaRouter/viaUSDC numbers");
  ok(html.includes("Seller-One.example") && html.includes("agents.chain.link"), "external leaderboard rows render");
  ok(!html.slice(html.indexOf('$ GET /api/leaderboard'), html.indexOf('$ GET /api/bestsellers')).includes(">Agent402.Tools<"), "Agent402's own row is excluded from the index/leaderboard section");
}

// --- honest fallback when no data is available -------------------------------
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  ok(html.includes("Listening for on-chain payments"), "empty-state counter pulse renders instead of a bare 0");
  ok(!/>0</.test(html.slice(html.indexOf('id="hm-counter"'), html.indexOf('id="hm-counter"') + 400)), "counter does not render a fabricated 0 with no data");
  ok(html.includes("unavailable"), "leaderboard section states unavailable rather than rendering an empty table silently");
  ok(html.includes(">0</strong> of 0 paid calls"), "router-share disclosure degrades to real zeros, not hidden or fabricated, with no data");
}

// --- commercial sensitivity: no tool slug next to a purchase count ----------
// Same rule as /sell (see PR #774): per-tool purchase counts are the paid
// /api/bestsellers product. The pre-revamp design draft for this section
// rendered exact slug+count pairs sourced from a since-removed stats field -
// lock that the port never reintroduces that shape.
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  ok(!/\b\d{1,3}(,\d{3})*\s*(purchases|sales|buyers bought|times bought)\b/i.test(html), "no purchase-count phrasing anywhere on the homepage");
  ok(html.includes("Hashing &amp; encoding") || html.includes("Hashing & encoding"), "demand section shows lane-level categories, not per-tool rankings");
  ok(!/topPaidTools/.test(html), "no reference to the removed topPaidTools field");
  // The one WALLET_ONLY_SLUGS member guaranteed to exist must never appear
  // paired with a bare integer immediately after it (the slug+count shape).
  const paidSlug = [...WALLET_ONLY_SLUGS][0];
  ok(paidSlug && !new RegExp(`${paidSlug}[^a-zA-Z]{0,20}\\d+\\s*(calls|purchases|sales)`, "i").test(html), "a real paid slug never appears paired with a purchase/call count");
}

// --- structured data ----------------------------------------------------------
{
  const stats = { toolCallsServed: { viaUSDC: 100, viaProofOfWork: 200, viaMPPWire: 1, viaRouter: 1, viaUSDCByNetwork: {} } };
  const html = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, []);
  ok(html.includes('"@type":"Organization"') && html.includes('"Havok Holdings LLC"'), "Organization JSON-LD present, credits Havok Holdings LLC");
  ok(html.includes('"@type":"WebSite"') && html.includes('"@type":"SearchAction"'), "WebSite + SearchAction JSON-LD present");
  ok(html.includes('"@type":"SoftwareApplication"') && html.includes('"@type":"AggregateOffer"'), "SoftwareApplication + AggregateOffer JSON-LD present");
  ok(html.includes('"@type":"Dataset"') && html.includes('"@type":"DataDownload"'), "Dataset + DataDownload JSON-LD present for the leaderboard");
  ok(html.includes('"@type":"ItemList"'), "ItemList JSON-LD present for the free discovery primitives");

  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<summary style=/g) || []).length;
  // 4 since 2026-08-18: the Agentic Finance (AIFI) definition leads the FAQ.
  ok(faqLdCount === 6, `FAQPage JSON-LD carries exactly 6 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 6, `visible FAQ prose carries exactly 6 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
}

// --- copy hygiene --------------------------------------------------------------
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  ok(!html.includes("—"), "no em dashes anywhere in the page copy");
}

// --- CDN script tags: pinned versions + SRI, no wildcard trust --------------
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  // 2026-08-22 redesign: the dot-map (d3 + topojson from unpkg) is gone; the
  // homepage loads NO third-party script at all. If one ever returns it must be
  // version-pinned with an SRI hash - the old assertion shape - but the
  // stronger invariant now is its absence.
  ok(!/<script src="https?:\/\//.test(html), "homepage loads no third-party script (no CDN tags)");
  ok(html.includes('<script src="/js/home-hero.js">'), "homepage behavior script is first-party");
  ok(html.includes("No account. No API key. No card on file.") && html.includes("Pay for any API call"), "hero leads with the one sentence: pay for any API call without an account, key or card on file");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
