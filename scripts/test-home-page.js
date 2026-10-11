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
    { name: "seller-two.example", totalUsd: 103.432, callsSettled: 9711, uniqueBuyers: 2 },
  ];
  const leaderboardSnapshot = { leaderboard: board, windowLabel: "7d", totalSellers: 824 };
  const html = ledgerHomePage(BASE_URL, catalog, stats, leaderboardSnapshot, Array.from({ length: 42 }));

  ok(html.includes("40,233"), "live counter seeds from the real server-rendered viaUSDC value");
  ok(html.includes("918,422") && html.includes("calls to the free tools (proof-of-work, no payment)"), "free-tier (PoW) count renders");
  // The per-rail tile grid and its footer line left the home page: the tiles
  // left empty cells, and the MPP-wire figure read as a mismatch against the
  // Tempo tile because nothing said MPP also settles off Tempo. Per-rail
  // figures live on /revenue. Pinned as absences.
  ok(!html.includes("Settled on every rail") && !html.includes("per-rail tag") && !html.includes("settled over the MPP wire"), "no per-rail tile grid or tag-count line on the home page");
  // The "What a seller gets" table and its paragraph repeated the section's own
  // meta line and /sell, and carried a hand-typed router-chain row. Gone; one
  // link to /sell stays under the two seller cards.
  const sellSec = html.slice(html.indexOf('id="sell"'), html.indexOf("</section>", html.indexOf('id="sell"')));
  ok(sellSec.length > 200, "control: the seller section was located");
  ok(!/What a seller gets|Cross-chain buyers|No listing fee and no commission/.test(sellSec), "no seller-terms table or paragraph beside it");
  ok(/href="\/sell"[^>]*>everything for sellers → \/sell</.test(sellSec), "one everything-for-sellers link to /sell stays");
  ok(!/\b41\b/.test(sellSec), "no router call count in the seller section");
  ok(!/of [\d,]+ paid calls/.test(sellSec) && !/%/.test(sellSec), "no share-of-our-volume figure in the seller section");
  ok(!html.includes("went buyer wallet to seller wallet"), "the claim that every other paid call bypassed us is gone");
  ok(/nothing deducted/i.test(sellSec) && /buyer wallet → your wallet/i.test(sellSec), "the neutrality claim a seller is asking about is still made, plainly");
  ok(html.includes("Seller-One.example") && html.includes("seller-two.example"), "external leaderboard rows render");
  {
    // The five-column mono table is ~520px wide; at a 375px viewport the card's
    // overflow:hidden clipped the usdc/calls/buyers columns with no way to reach
    // them (reported from outside 2026-09-08). It must sit in its own
    // horizontal scroller so the page never scrolls sideways and the columns
    // stay reachable.
    const start = html.indexOf("OTHER SELLERS");
    const seg = html.slice(start, html.indexOf("full leaderboard", start));
    const wrap = seg.indexOf("overflow-x:auto"), tbl = seg.indexOf("<table");
    ok(wrap >= 0 && tbl > wrap && /tabindex="0"/.test(seg), "the homepage leaderboard table sits inside a keyboard-reachable horizontal scroller");
    ok(/min-width:520px/.test(seg), "the table keeps its natural width inside the scroller (columns scroll, never clip)");
  }
  ok(!html.slice(html.indexOf('$ GET /api/leaderboard'), html.indexOf('$ GET /api/bestsellers')).includes(">Agent402.Tools<"), "Agent402's own row is excluded from the index/leaderboard section");
}

// --- honest fallback when no data is available -------------------------------
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  // "Listening for on-chain payments…" was a widget's waiting state rendered
  // as served copy: a visitor arriving before the ledger warms read it as the
  // site describing itself. The empty state must still not fabricate a 0.
  ok(!/Listening for on-chain payments/.test(html), "no internal widget state string in served copy");
  ok(html.includes("Settlement count loading"), "the empty state says what is missing, in words a visitor can read");
  ok(!/>0</.test(html.slice(html.indexOf('id="hm-counter"'), html.indexOf('id="hm-counter"') + 400)), "counter does not render a fabricated 0 with no data");
  ok(html.includes("unavailable"), "leaderboard section states unavailable rather than rendering an empty table silently");
  const sellerSeg = html.slice(html.indexOf('id="sell"'), html.indexOf("</section>", html.indexOf('id="sell"')));
  ok(sellerSeg.length > 80, "control: the seller section was located in the empty state too");
  ok(!/came through the router|paid calls|%/.test(sellerSeg), "no router-share disclosure to degrade: the figure is not published at all");
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


// --- the hero counter's label must follow its metric --------------------------
// heroCount falls back from settledOnChain (inbound on-chain TRANSFERS to our
// wallets, ours included) to viaUSDC (calls this server SERVED for a stablecoin
// payment). Those differ by about ten thousand in production, and which one a
// visitor sees depends on whether the ledger has warmed since the last deploy.
// A shared label made the most important number on the site mean two things.
// Pinned because the tempting simplification is one nice short label for both.
{
  const stats = { toolCallsServed: { viaUSDC: 35138, viaProofOfWork: 1, viaMPPWire: 0, viaRouter: 0, viaUSDCByNetwork: {} } };
  const chain = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, [], { settledOnChain: 46007 });
  const served = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, [], { settledOnChain: 0 });

  ok(chain.includes("46,007"), "control: with a chain figure the hero renders it");
  ok(/on-chain settlements/.test(chain) && /ours included/i.test(chain),
    "the chain figure is labelled as settlements, and says it includes our own traffic");
  ok(!/on-chain settlements/.test(served), "the served-call fallback does NOT claim to be on-chain settlements");
  ok(served.includes("35,138") && /calls served<\/span><span>paid in stablecoin/.test(served),
    "the fallback renders viaUSDC and is labelled as calls served");
  // A transfer is not a call. Whichever value is in play, the word "calls" may
  // not sit on the chain-derived figure.
  const heroSeg = chain.slice(chain.indexOf("46,007") - 300, chain.indexOf("46,007") + 300);
  ok(!/\bcalls\b/.test(heroSeg), "the chain-derived hero figure is never called a call count");
}

// --- Tempo on the homepage ---------------------------------------------------
// Tempo settles over MPP's own relay, so it is not in RAILS (accepts, the
// on-chain scan). The per-rail section still owes it a row, fed by the same
// viaUSDCByNetwork counter under its "tempo" key, and the rail count in the
// prose has to include it. The hero counter already includes Tempo through
// settledOnChainCount(), which must be the /revenue hero's own arithmetic.
{
  const { railsByVolume } = await import("../src/ledger-home.js");
  const { RAILS } = await import("../src/rails.js");
  const stats = { toolCallsServed: { viaUSDC: 900, viaUSDCByNetwork: { base: 500, tempo: 321 } } };
  const rows = railsByVolume(stats, { tempo: false });
  const t = rows.find((r) => r.name === "Tempo");
  ok(t && t.n === 321 && t.href === "/what-is-mpp", "a Tempo row appears when Tempo has settled traffic, linked to the MPP page");
  ok(rows.length === RAILS.length + 1, "Tempo is added beside the x402 rails, not in place of one");
  ok(!railsByVolume({ toolCallsServed: { viaUSDCByNetwork: { base: 1 } } }, { tempo: false }).some((r) => r.name === "Tempo"),
    "no Tempo row on a server where Tempo is off and never settled");
  ok(railsByVolume({}, { tempo: true }).some((r) => r.name === "Tempo"), "an enabled Tempo rail shows even before its first settle");
  ok(!RAILS.some((r) => /tempo/i.test(r.name)), "Tempo stays out of RAILS itself");

  const html = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, []);
  ok(html.includes(`${RAILS.length + 1} rails live`), "the hero rail count includes Tempo");

  const { readFile } = await import("node:fs/promises");
  const srv = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = srv.slice(srv.indexOf("function settledOnChainCount()"), srv.indexOf("function settledOnChainCount()") + 700);
  ok(/railThroughput\(\{ allTime: ledgerSummary\(/.test(fn), "the homepage hero counter uses the /revenue throughput arithmetic (Tempo once, Base/Celo MPP never twice)");
  const hero = await readFile(new URL("../assets/js/home-hero.js", import.meta.url), "utf8");
  ok(/j\.settledOnChain/.test(hero), "the live poll reads the same settledOnChain figure the server renders");
}


// The hero shows the live payments view (live.agent402.tools/embed), framed;
// the framed page may only be framed by this site, and this site may only frame it.
{
  const html = ledgerHomePage("https://agent402.tools", catalog, {}, {}, []);
  ok(/<iframe id="hm-live" src="https:\/\/live\.agent402\.tools\/embed"/.test(html), "on agent402.tools the hero frames the live payments view");
  const self = ledgerHomePage("http://127.0.0.1:3000", catalog, {}, {}, []);
  ok(!/<iframe id="hm-live"/.test(self) && /id="hm-live-link" href="https:\/\/live\.agent402\.tools"/.test(self), "on any other origin it links instead of framing (the embed refuses other framers)");
  ok(/id="hm-live-n"[\s\S]*id="hm-live-usd"[\s\S]*id="hm-live-buyers"[\s\S]*id="hm-live-pm"/.test(html), "the live panel carries its four hourly figures");
  ok(/every x402 and MPP payment(<span class="hm-live-tail">)? we see on chain/.test(html), "the panel says it shows every seller's payments, not only ours");
  const srv = (await import("node:fs")).readFileSync(new URL("../src/security-headers.js", import.meta.url), "utf8");
  ok(/frame-src 'self' https:\/\/live\.agent402\.tools;/.test(srv), "site CSP frames only itself and the live view");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
