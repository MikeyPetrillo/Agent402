// Offline unit tests for /marketplace's all-chains view (marketPageAll in
// src/market-page.js, Aug 2026 revamp). Covers what test-market-pages.js's
// existing all-view assertions don't: the new "Markets by chain" grid,
// real 4-stat row, methodology + FAQ sections, and JSON-LD - all built from
// real per-chain computation (marketSellers/marketOperatorCount), never the
// design source's frozen per-seller lookup tables. No server, no network.
import { marketPage, CHAIN_PAGES } from "../src/market-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 8, tools: [] };

// Extract one chain card's HTML by index-based search rather than a
// fixed-width regex window - chain SVG marks vary wildly in size (Base's
// circle is ~150 chars, Solana's/Arbitrum's multi-path marks run 1000+),
// so a regex quantifier bound enough for one chain silently fails to reach
// the closing tag for another.
function chainCard(html, slug) {
  const start = html.indexOf(`href="/${slug}" title="`);
  if (start === -1) return null;
  const end = html.indexOf("</a>", start);
  return end === -1 ? null : html.slice(start, end);
}

// --- real per-chain grid, no hardcoded lookup table --------------------------
{
  const sellers = [
    LOCAL,
    { origin: "https://a.example", displayName: "SellerA", homepage: "https://a.example", local: false, toolCount: 5, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xaaa" } },
    { origin: "https://b.example", displayName: "SellerB", homepage: "https://b.example", local: false, toolCount: 3, routable: true, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], payToByNetwork: { "eip155:8453": "0xbbb", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "sol111" } },
  ];
  const html = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });

  ok(html.includes("Markets by chain"), "the new 'Markets by chain' section renders");
  // Base: LOCAL + SellerA + SellerB all advertise a Base network -> 3 sellers, 5+3+8=16 tools.
  const baseCard = chainCard(html, "base");
  ok(baseCard && /<span[^>]*color:var\(--green\)[^>]*>3</.test(baseCard), "Base card shows the real seller count (3), not a hardcoded design number");
  ok(baseCard && />16</.test(baseCard), "Base card shows the real summed tool count (16), computed from marketSellers/toolCount");
  // Solana: LOCAL (qualifies on every chain by design - see marketSellers'
  // own comment) + SellerB -> 2 sellers.
  const solCard = chainCard(html, "solana");
  ok(solCard && /<span[^>]*color:var\(--green\)[^>]*>2</.test(solCard), "Solana card shows the real seller count (2: LOCAL + SellerB)");
  // Celo: no external seller advertises it, but LOCAL still qualifies on
  // every chain - so the real floor here is 1, never a fabricated 0.
  const celoCard = chainCard(html, "celo");
  ok(celoCard && /<span[^>]*color:var\(--green\)[^>]*>1</.test(celoCard), "a chain with no external sellers still shows the real local-only count (1), not 0 or omitted");
  ok((html.match(/href="\/[a-z]+" title="[^"]+ x402 marketplace"/g) || []).length === 12, "all 12 chain cards render, one per CHAIN_PAGES entry");
}

// --- grammar: a chain with exactly 1 seller reads "1 seller", not "1 sellers" --
// Same class of bug already fixed at the roster's 4 call sites (PR #772);
// found live in this stage's own "Markets by chain" cards during visual
// verification, plus a pre-existing 5th, untouched instance in the nav
// dropdown (src/ledger-chrome.js) - fixed both.
{
  const sellers = [LOCAL];
  const html = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  const celoCard = chainCard(html, "celo");
  ok(celoCard && /seller<\/span>/.test(celoCard) && !/sellers<\/span>/.test(celoCard), "a chain card with exactly 1 seller reads the singular 'seller', never '1 sellers'");
}

// --- no hardcoded third-party company descriptions --------------------------
// The design source's own JS hand-authored blurbs for 6 named companies
// (real third-party sellers) - contradicts its own "Crawled, not
// curated" copy, and no such field exists in the real crawled seller data.
// Lock that none of those names ever appear (a symptom of the hardcoded
// table leaking back in) unless a fixture seller happens to share the name.
{
  const html = marketPage(null, BASE_URL, { snapshot: { sellers: [LOCAL] }, leaderboardSnap: { leaderboard: [] } });
  ok(!html.includes("Routing and payment layer for AI"), "no hardcoded third-party seller blurb (a real seller's design copy) leaked in");
  ok(!html.includes("Company and contact enrichment for agents"), "no hardcoded third-party seller blurb (StableEnrich's design copy) leaked in");
  ok(html.includes("Crawled, not curated"), "the methodology section states the real discovery model");
}

// --- real, non-fabricated hero subhead ---------------------------------------
// The design source freezes "1,494 sellers on Base alone" at generation
// time. The port must compute this live via marketOperatorCount, so a
// fixture with a known seller count proves it, not a hardcoded string.
{
  const sellers = [LOCAL, ...Array.from({ length: 4 }, (_, i) => ({ origin: `https://s${i}.example`, displayName: `S${i}`, homepage: `https://s${i}.example`, local: false, toolCount: 1, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": `0x${i}` } }))];
  const html = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  ok(html.includes("5 sellers on Base alone"), "hero subhead cites the real, live-computed Base seller count (5), not the design's frozen 1,494");
}

// --- real 4-stat row, including the new TOOL LISTINGS card -------------------
{
  const sellers = [LOCAL, { origin: "https://c.example", displayName: "C", homepage: "https://c.example", local: false, toolCount: 12, routable: true, networks: ["eip155:8453"], payToByNetwork: {} }];
  const html = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  ok(html.includes("TOOL LISTINGS"), "the new TOOL LISTINGS stat card renders");
  ok(/TOOL LISTINGS<\/div><div[^>]*>20</.test(html), "TOOL LISTINGS sums real toolCount across every seller (8+12=20)");
  ok(html.includes("SELLERS LISTED"), "the existing SELLERS LISTED card is preserved");
  ok(html.includes("CHAINS SUPPORTED"), "the existing CHAINS SUPPORTED card is preserved");
}

// --- methodology + router sections --------------------------------------------
{
  const html = marketPage(null, BASE_URL, { snapshot: { sellers: [LOCAL] }, leaderboardSnap: { leaderboard: [] } });
  ok(html.includes("Or skip the browsing") && html.includes("POST /api/route"), "the router-skip section renders");
  ok(html.includes("Discovery: the Coinbase CDP Bazaar"), "the methodology steps render");
}

// --- FAQ + structured data ------------------------------------------------------
{
  const html = marketPage(null, BASE_URL, { snapshot: { sellers: [LOCAL] }, leaderboardSnap: { leaderboard: [] } });
  ok(html.includes("About this index."), "FAQ section heading renders");
  const faqVisibleCount = (html.match(/<article style="padding:22px 0/g) || []).length;
  ok(faqVisibleCount === 4, `visible FAQ carries exactly 4 questions (got ${faqVisibleCount})`);
  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  ok(faqLdCount === 4, `FAQPage JSON-LD carries exactly 4 questions, matching the visible content 1:1 (got ${faqLdCount})`);
  ok(html.includes('"@type":"Dataset"') && html.includes('"@type":"DataDownload"'), "Dataset + DataDownload JSON-LD present");
  const chainListMatch = html.match(/"@id":"https:\/\/agent402\.tools\/marketplace#chains"[\s\S]*?"itemListElement":(\[[\s\S]*?\])\}/);
  const chainListCount = chainListMatch ? (chainListMatch[1].match(/"@type":"ListItem"/g) || []).length : 0;
  ok(chainListCount === 12, `ItemList JSON-LD carries all 12 chains (got ${chainListCount})`);
  ok(html.includes('"@type":"CollectionPage"'), "CollectionPage JSON-LD still present (pre-existing, unchanged)");
  ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD still present (pre-existing, unchanged)");
}

// --- per-chain pages unaffected (marketPage's shared rendering path) --------
{
  const chainHtml = marketPage("base", BASE_URL, { snapshot: { sellers: [LOCAL] }, rail: null, activity: null, wallet: "0xabc" });
  ok(!chainHtml.includes("Markets by chain"), "a per-chain page does NOT render the all-chains-only 'Markets by chain' grid");
  ok(chainHtml.includes("The Base x402 marketplace"), "a per-chain page still renders its own real title, unaffected by the all-chains changes");
}

// --- copy hygiene --------------------------------------------------------------
{
  const html = marketPage(null, BASE_URL, { snapshot: { sellers: [LOCAL] }, leaderboardSnap: { leaderboard: [] } });
  ok(!html.includes("—"), "no em dashes anywhere in the new page copy");
}


// --- the host's own entry (2026-08-28): a labelled card outside the roster, never counted ---
{
  const sellers = [
    { origin: "https://agent402.tools", local: true, displayName: "Agent402", homepage: BASE_URL, toolCount: 560, networks: [], tools: [] },
    { origin: "https://a.example", displayName: "A", homepage: "https://a.example", toolCount: 3, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xaaa" }, routable: true },
  ];
  const HOSTF = { baseUrl: BASE_URL, toolCount: 560, recordingSince: "2026-06-15T00:00:00.000Z", external30d: { settlements: 109, buyers: 7, tools: 21 }, externalAllTime: { settlements: 3945, buyers: 250, tools: 105 } };
  const without = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  const withHost = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] }, host: HOSTF });
  ok(!without.includes("data-host-card") && withHost.includes("data-host-card"), "host card renders only when host figures are supplied");
  ok(withHost.includes("NOT RANKED, NOT COUNTED") && withHost.includes(">109<") && withHost.includes(">250<"), "host card carries the external-only 30d and all-time figures");
  ok(withHost.includes("canary and volume runs are excluded"), "host card states that our own runs are excluded");
  const count = (h) => (h.match(/SELLERS LISTED<\/div><div[^>]*>([0-9,]+)/) || [])[1];
  ok(count(without) === count(withHost), `the SELLERS LISTED count is identical with and without the host card (${count(without)} vs ${count(withHost)})`);
  ok(withHost.indexOf("data-host-card") < withHost.indexOf('class="mfb"'), "host card sits above the roster filter bar and rows, not inside them");
  // per-rail card on a chain page (2026-08-28): the same card, that rail's outside buyers only
  const HOSTB = { ...HOSTF, network: "base", networkLabel: "Base", external30d: { settlements: 41, buyers: 5, tools: null }, externalAllTime: { settlements: 900, buyers: 90, tools: null } };
  const chainWith = marketPage("base", BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] }, host: HOSTB });
  const chainWithout = marketPage("base", BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  ok(chainWith.includes("data-host-card") && chainWith.includes("outside buyers on Base only") && chainWith.includes(">41<") && chainWith.includes(">900<"), "a chain page carries the host card with THAT rail's outside-buyer figures");
  ok(!chainWithout.includes("data-host-card"), "a chain page without host figures renders no card");
  ok(count(chainWithout) === count(chainWith), "the chain page's seller count is unchanged by the host card");
}

// --- dispatch legend + badge (2026-09-02) ------------------------------------
{
  const sellers = [
    LOCAL,
    { origin: "https://a.example", displayName: "Eligible Co", homepage: "https://a.example", local: false, toolCount: 5, routable: true, networks: ["eip155:8453"], routerDispatchEligible: true, routerDispatchReason: "eligible" },
    { origin: "https://b.example", displayName: "NoNet Co", homepage: "https://b.example", local: false, toolCount: 3, routable: true, networks: [], routerDispatchEligible: false, routerDispatchReason: "network_unknown" },
    { origin: "https://c.example", displayName: "Unlabelled Co", homepage: "https://c.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"] },
  ];
  const html = marketPage(null, BASE_URL, { snapshot: { sellers }, leaderboardSnap: { leaderboard: [] } });
  ok(/mfb-legend/.test(html) && /the last crawl of the origin succeeded, nothing more/.test(html) && /routerDispatchReason/.test(html), "the roster carries a legend saying healthy is crawl readiness and naming the API field");
  ok(/Eligible Co[\s\S]{0,600}class="mlr-dispatch" title="the router will pay/.test(html), "an eligible seller shows the dispatch badge");
  ok(/NoNet Co[\s\S]{0,600}class="mlr-dispatch off"[^>]*>no dispatch &middot; network unknown</.test(html), "a non-eligible seller shows the reason in words");
  const unl = html.slice(html.indexOf("Unlabelled Co"), html.indexOf("Unlabelled Co") + 900);
  ok(!/mlr-dispatch/.test(unl), "a seller the handler did not label gets NO badge (never a guessed one)");
  const loc = html.slice(html.indexOf("THIS HOST") - 400, html.indexOf("THIS HOST") + 400);
  ok(!/mlr-dispatch/.test(loc), "the host's own row carries no dispatch badge");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
