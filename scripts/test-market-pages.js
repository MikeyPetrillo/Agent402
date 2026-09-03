// Offline unit tests for the five newest x402 marketplace pages (/base,
// /solana, /polygon, /arbitrum, /robinhood) — the chain-agnostic renderer in
// src/market-page.js already covers /stellar and /algorand (see
// scripts/test-stellar-page.js / test-algorand-page.js); this file locks
// down the CHAIN_PAGES entries added alongside them. No server, no network.
import { marketSellers, marketSellersAll, marketPage, marketPanelHtml, CHAIN_PAGES, marketFilterBar } from "../src/market-page.js";
import { sitemapPages, sitemapXml, llmsTxt } from "../src/seo.js";
import { serviceManifest } from "../src/discovery.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const filterBarScript = readFileSync(fileURLToPath(new URL("../assets/js/market-filter-bar.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const localTools = [
  { slug: "hash", name: "Hash", category: "encoding", price: 0.001 },
  { slug: "search", name: "Web search", category: "search", price: 0.01 },
];
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 2, tools: localTools };

// Per-chain fixtures: mainnet CAIP-2, a corresponding testnet/devnet id that
// must NOT qualify a seller, expected asset + explorer domain, and a fixture
// wallet (these five chains carry no committed public default in
// CHAIN_PAGES — the real address is a Railway secret — so effectiveWallet
// only ever comes from what the route passes).
const NEW_CHAINS = [
  { key: "base", network: "eip155:8453", offNetwork: "eip155:84532", asset: "USDC", explorer: "basescan.org", wallet: "0x1111111111111111111111111111111111111111" },
  { key: "solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", offNetwork: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "USDC", explorer: "solscan.io", wallet: "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o" },
  { key: "polygon", network: "eip155:137", offNetwork: "eip155:80002", asset: "USDC", explorer: "polygonscan.com", wallet: "0x2222222222222222222222222222222222222222" },
  { key: "arbitrum", network: "eip155:42161", offNetwork: "eip155:421614", asset: "USDC", explorer: "arbiscan.io", wallet: "0x3333333333333333333333333333333333333333" },
  { key: "celo", network: "eip155:42220", offNetwork: "eip155:11142220", asset: "USDC", explorer: "celoscan.io", wallet: "0x5555555555555555555555555555555555555555" },
  { key: "avalanche", network: "eip155:43114", offNetwork: "eip155:43113", asset: "USDC", explorer: "snowtrace.io", wallet: "0x6666666666666666666666666666666666666666" },
  { key: "sei", network: "eip155:1329", offNetwork: "eip155:1328", asset: "USDC", explorer: "seiscan.io", wallet: "0x7777777777777777777777777777777777777777" },
  { key: "optimism", network: "eip155:10", offNetwork: "eip155:11155420", asset: "USDC", explorer: "optimistic.etherscan.io", wallet: "0x9999999999999999999999999999999999999999" },
  { key: "robinhood", network: "eip155:4663", offNetwork: "eip155:99999", asset: "USDG", explorer: "robinhoodchain.blockscout.com", wallet: "0x4444444444444444444444444444444444444444" },
];

// 1. All 12 chain pages exist in CHAIN_PAGES.
ok(Object.keys(CHAIN_PAGES).length === 12, `CHAIN_PAGES has 12 entries (got ${Object.keys(CHAIN_PAGES).length})`);
for (const c of NEW_CHAINS) ok(!!CHAIN_PAGES[c.key], `CHAIN_PAGES has a "${c.key}" entry`);

for (const c of NEW_CHAINS) {
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: [c.network] };
  const snapshot = { sellers: [LOCAL, EXT], totals: { sellers: 2 } };
  const rail = { recent: [{ tx: "https://example.com/tx/abc123", when: "2026-07-10T04:15:00Z", usd: 0.001, from: "0xabc" }] };
  const html = marketPage(c.key, "https://agent402.tools", { snapshot, rail, activity: null, wallet: c.wallet });

  ok(html.includes(`The ${CHAIN_PAGES[c.key].chainName} x402 marketplace`), `${c.key}: renders with the correct title`);
  ok(html.includes(`>${c.asset}<`) || html.includes(`${c.asset} on ${CHAIN_PAGES[c.key].chainName}`), `${c.key}: settles in ${c.asset}`);
  ok(html.includes(c.explorer), `${c.key}: correct explorer domain (${c.explorer}) rendered`);
  ok(html.includes("example.com/tx/abc123"), `${c.key}: real receipt tx link rendered, never invented`);

  // Network filter: the offNetwork (testnet/devnet) id must not qualify a
  // seller, and mainnet must.
  ok(marketSellers(c.key, snapshot).length === 2, `${c.key}: mainnet-network seller qualifies`);
  const offSnap = { sellers: [LOCAL, { ...EXT, networks: [c.offNetwork] }] };
  ok(marketSellers(c.key, offSnap).length === 1, `${c.key}: off-network (testnet/devnet) seller excluded`);

  // Null-activity honesty line: no scan yet for these chains, but the
  // caption must name THIS chain's explorer, never a hardcoded one.
  ok(html.includes("activity scan temporarily unavailable"), `${c.key}: honest null-activity line renders`);
  ok(!html.includes("stellar.expert") && !html.includes("allo.info"), `${c.key}: no leaked reference to another chain's explorer`);
}

// Per-seller activity scoping — the roster's "pick a seller to scope the charts"
// feature. Regression guard for the /base…/arbitrum/solana route that used to
// ignore ?seller= entirely (rendered THIS HOST no matter which seller you
// clicked). marketPage must honor selectedSeller: an external pick re-scopes the
// Activity label to the seller's host and its note names the seller's payTo; a
// local pick stays on THIS HOST; and an external pick with no scannable activity
// shows the honest per-seller "unavailable" line instead of the host's charts.
{
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xabc0000000000000000000000000000000000abc" } };
  const snapshot = { sellers: [LOCAL, EXT] };
  const activity = { days: 30, buckets: [{ date: "2026-07-10", tx: 2, usd: 0.5, buyers: 1 }], totals: { tx: 2, usd: 0.5, buyers: 1 } };
  const base = (sel, act) => marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: act, selectedSeller: sel, wallet: "0x1111111111111111111111111111111111111111" });

  ok(/EXT1\.EXAMPLE · PAST 30 DAYS/.test(base({ local: false, host: "ext1.example", name: "Ext One" }, activity)), "base: external selectedSeller re-scopes the Activity label to the seller host");
  ok(base({ local: false, host: "ext1.example", name: "Ext One" }, activity).includes("this seller's advertised x402 payTo wallet"), "base: external scope note names the seller's payTo, not the host wallet");
  ok(/THIS HOST · PAST 30 DAYS/.test(base({ local: true }, activity)), "base: local selection keeps the Activity label on THIS HOST");
  ok(base({ local: false, host: "ext1.example", name: "Ext One" }, null).includes("activity unavailable for this seller"), "base: external pick with no scannable activity shows the honest per-seller unavailable line");
  // marketSellers passes payToByNetwork through so the route can resolve a
  // seller's on-chain address for the scan.
  const sellers = marketSellers("base", snapshot);
  ok(sellers.find((s) => !s.local)?.payToByNetwork?.["eip155:8453"] === "0xabc0000000000000000000000000000000000abc", "base: marketSellers exposes payToByNetwork for the route's activity scan");
}

// Robinhood is the one non-USDC rail — asset must read USDG everywhere, and
// USDC must never leak onto its page.
{
  const snapshot = { sellers: [LOCAL] };
  const html = marketPage("robinhood", "https://agent402.tools", { snapshot, rail: null, activity: null, wallet: "0x4444444444444444444444444444444444444444" });
  ok(html.includes("USDG"), "robinhood: USDG asset present");
  // Scoped to the page's own rail manifest + 402 accept sample - the shared
  // site chrome (ledgerShell's sitewide JSON-LD) legitimately mentions USDC
  // for the other six rails, so a blanket absence check would be wrong.
  ok(html.includes('"asset"</span>: "USDG"'), "robinhood: 402 accept sample carries USDG, not USDC");
  const manifestIdx = html.indexOf("RAIL MANIFEST");
  const manifestBlock = html.slice(manifestIdx, manifestIdx + 1200); // widened for the wires row (x402 + MPP)
  ok(manifestBlock.includes("USDG") && !manifestBlock.includes("USDC"), "robinhood: rail manifest asset row reads USDG, never USDC");
}

// Solana devnet specifically — the fact called out in the task: a devnet
// genesis-hash seller must never count as a mainnet Solana seller.
{
  const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const devnetSnap = { sellers: [LOCAL, { origin: "https://d.example", displayName: "Devnet Only", homepage: "https://d.example", local: false, networks: [SOLANA_DEVNET] }] };
  ok(marketSellers("solana", devnetSnap).length === 1, "solana: devnet-only seller excluded, only local qualifies");
}

// No wallet passed and no config default (these 5 have none) — the explorer
// link must fall back to the bare domain, never literally render "undefined".
{
  const html = marketPage("arbitrum", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(!html.includes("undefined"), "arbitrum: missing wallet never renders the literal string 'undefined'");
  ok(html.includes('href="https://arbiscan.io"'), "arbitrum: explorer link falls back to the bare domain without a wallet");
}

// Switcher strip lists all 7 chains, with the current page marked active.
{
  const html = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  for (const key of Object.keys(CHAIN_PAGES)) ok(html.includes(`href="/${key}"`), `switcher strip links to /${key}`);
  ok(/base<\/a>/.test(html) && html.includes("var(--accent)"), "switcher strip marks the active chain");
}

// Provenance / sell-side copy is genuinely per-chain, not copy-pasted.
{
  const baseHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(baseHtml.includes("Coinbase CDP"), "base: sell copy names the Coinbase CDP facilitator");
  const solanaHtml = marketPage("solana", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(solanaHtml.includes("@x402/svm"), "solana: sell copy names the SVM scheme package");
  const robinhoodHtml = marketPage("robinhood", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(robinhoodHtml.includes("ROBINHOOD_FACILITATOR_URL"), "robinhood: sell copy names the operator-supplied facilitator env");
  ok(baseHtml !== solanaHtml && solanaHtml !== robinhoodHtml, "provenance/sell copy differs page to page, not templated identically");
}

// Seller card + roster transaction counts + panel endpoint parity (the market
// seller-detail feature). A leaderboard snapshot supplies per-seller settled
// counts joined by payTo; the card surfaces the SELECTED seller's own numbers
// (from the scoped activity), distinct from the chain-wide top cards.
{
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xabc0000000000000000000000000000000000abc" } };
  const snapshot = { sellers: [LOCAL, EXT] };
  const leaderboardSnap = { leaderboard: [{ name: "Ext One", homepage: "https://ext1.example", wallet: "0xabc0000000000000000000000000000000000abc", wallets: ["0xabc0000000000000000000000000000000000abc"], callsSettled: 42, totalUsd: 3.5, uniqueBuyers: 7 }] };
  const activity = { days: 30, buckets: [{ date: "2026-07-08", tx: 5, usd: 0.5, buyers: 2 }], totals: { tx: 40, usd: 3.2, buyers: 6 } };
  const sel = { local: false, host: "ext1.example", name: "Ext One" };

  // Roster shows the settled-call count for a seller the leaderboard covers.
  const hostView = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null, leaderboardSnap, wallet: "0x1" });
  ok(/42\s*tx/.test(hostView.replace(/&middot;|·/g, " ")), "base: roster shows the seller's settled-call count (42 tx) from the leaderboard join");

  // Seller card renders the SELECTED seller's own numbers (from scoped activity).
  const cardView = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity, selectedSeller: sel, leaderboardSnap, wallet: "0x1" });
  ok(cardView.includes('id="seller-card"'), "base: seller card renders when a seller is selected");
  ok(cardView.includes("SETTLED CALLS") && cardView.includes("VOLUME") && cardView.includes("BUYERS") && cardView.includes("TOOLS"), "base: seller card has calls/volume/buyers/tools fields");
  ok(cardView.includes("0xabc0000000000000000000000000000000000abc"), "base: seller card shows the payTo");
  // Card headline uses the leaderboard stat (42), NOT the narrower on-chain scan
  // (40) — so the list and the card always show the same number for a seller.
  ok(/SETTLED CALLS[\s\S]{0,140}>42</.test(cardView), "base: seller card headline uses the leaderboard stat (42 calls), matching the roster");
  ok(!/SETTLED CALLS[\s\S]{0,140}>40</.test(cardView), "base: seller card headline does NOT fall back to the scoped on-chain total (40) when a leaderboard row exists");
  ok(/rolling\s+7d\s+totals/i.test(cardView), "base: seller card labels its window (rolling 7d) so leaderboard-scoped totals read honestly");

  // Panel endpoint output matches the in-page panel (same renderer).
  const panel = marketPanelHtml("base", { snapshot, activity, selectedSeller: sel, leaderboardSnap });
  ok(panel.includes('id="seller-card"') && panel.includes('id="activity"'), "base: marketPanelHtml returns the seller card + activity for the /panel endpoint");
  ok(cardView.includes(panel.trim().slice(0, 200)), "base: page panel and endpoint panel render identically");

  // Fallback: a seller with NO leaderboard row falls back to the scoped on-chain
  // scan, and a capped scan is rendered as a floor ("40+") rather than a hard total.
  const EXT2 = { origin: "https://ext2.example", displayName: "Ext Two", homepage: "https://ext2.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xdef0000000000000000000000000000000000def" } };
  const snapshot2 = { sellers: [LOCAL, EXT2] };
  const cappedActivity = { days: 30, truncated: true, buckets: [], totals: { tx: 40, usd: 3.2, buyers: 6 } };
  const sel2 = { local: false, host: "ext2.example", name: "Ext Two" };
  const fallbackCard = marketPanelHtml("base", { snapshot: snapshot2, activity: cappedActivity, selectedSeller: sel2, leaderboardSnap });
  ok(/SETTLED CALLS[\s\S]{0,140}>40\+</.test(fallbackCard), "base: no-leaderboard seller falls back to the on-chain total, marked a floor (40+) when the scan is capped");
  ok(/scan capped/i.test(fallbackCard), "base: capped on-chain fallback surfaces the 'scan capped' floor caveat on the card");

  // Host view (no selection) → no card, just activity.
  const hostPanel = marketPanelHtml("base", { snapshot, activity: null, selectedSeller: { local: true }, leaderboardSnap });
  ok(!hostPanel.includes('id="seller-card"'), "base: host view renders no seller card");
}

// Roster dedup — multiple crawled hosts that settle to the SAME leaderboard
// group (shared payTo, or distinct wallets the leaderboard grouped) collapse
// into ONE roster row, so the group's tx total isn't repeated per host.
{
  const payTo = "0xdup00000000000000000000000000000000dup0";
  const A = { origin: "https://a.example", displayName: "Svc A", homepage: "https://a.example", local: false, toolCount: 50, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo } };
  const B = { origin: "https://svc-b.up.railway.app", displayName: "Svc B", homepage: "https://svc-b.up.railway.app", local: false, toolCount: 4, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo } };
  const snapshot = { sellers: [LOCAL, A, B] };
  const leaderboardSnap = { leaderboard: [{ name: "Grouped", homepage: "https://a.example", wallet: payTo, wallets: [payTo], callsSettled: 999, totalUsd: 5, uniqueBuyers: 3 }] };
  const html = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null, leaderboardSnap, wallet: "0x1" });
  const stripped = html.replace(/&middot;|·/g, " ");
  ok((stripped.match(/999\s*tx/g) || []).length === 1, "base: shared-wallet group's tx total renders once, not per host");
  ok(stripped.includes("a.example"), "base: canonical host (real domain) survives the collapse");
  ok(!/svc-b\.up\.railway\.app/.test(stripped), "base: the platform-subdomain sibling is collapsed away, not a second row");
  ok(/\+1 more endpoint\b/.test(stripped), "base: collapsed sibling is disclosed as '+1 more endpoint', not hidden");
  ok(/SELLERS LISTED<\/div><div[^>]*>2</.test(html), "base: SELLERS count reflects the collapsed roster (LOCAL + 1 group = 2, not 3)");

  // Sellers with NO leaderboard row are the discovery long-tail — never grouped.
  const C1 = { origin: "https://c1.example", displayName: "C1", homepage: "https://c1.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xc1000000000000000000000000000000000000c1" } };
  const C2 = { origin: "https://c2.example", displayName: "C2", homepage: "https://c2.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xc2000000000000000000000000000000000000c2" } };
  const tailHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL, C1, C2] }, rail: null, activity: null, leaderboardSnap: { leaderboard: [] }, wallet: "0x1" });
  ok(tailHtml.includes("c1.example") && tailHtml.includes("c2.example"), "base: no-leaderboard sellers stay individually listed (long-tail not collapsed)");
  ok(/SELLERS LISTED<\/div><div[^>]*>3</.test(tailHtml), "base: SELLERS count keeps ungrouped long-tail sellers distinct (3)");
}

// Market filter bar — shared chain tabs + sort + search, wired client-side.
{
  const all = marketFilterBar(null, "https://agent402.tools");
  ok(/href="\/marketplace"/.test(all), "filter bar: All tab links to /marketplace");
  ok(/data-chain-tab="all"[^>]*class="[^"]*\bon\b/.test(all) || /class="[^"]*\bon\b[^"]*"[^>]*data-chain-tab="all"/.test(all), "filter bar: All tab is active in the all-chains view");
  ok(/href="\/base"/.test(all) && /href="\/robinhood"/.test(all), "filter bar: every chain tab is a link");
  const base = marketFilterBar("base", "https://agent402.tools");
  ok(/data-chain-tab="base"[^>]*\bon\b|\bon\b[^>]*data-chain-tab="base"/.test(base), "filter bar: Base tab active on the Base view");
  ok(/href="\/marketplace"/.test(base), "filter bar: All tab links back to /marketplace from a chain view");
  ok(/Sort/i.test(all), "filter bar: has a Sort control");
  // The roster lists SELLERS and sellers carry no category data — a Category
  // select would be a dead control, so the bar must not render one.
  ok(!/Category/i.test(all) && !/data-mfb-cat/.test(all), "filter bar: no dead Category control");
  // Sort options per the spec: most settled (default), volume, buyers, tools,
  // plus health (cheap — rows already carry routability).
  for (const v of ["calls", "usd", "buyers", "tools", "health"]) ok(all.includes(`option value="${v}"`), `filter bar: sort option '${v}' present`);
  // The wiring script ships as an external file (CSP hardening, 2026-08-16):
  // consumes data-mfb-sort + data-mfb-search over [data-mfb-row] rows,
  // reorders by moving existing nodes (appendChild) and toggles
  // style.display — never innerHTML.
  ok(all.includes('<script src="/js/market-filter-bar.js"></script>'), "filter bar: references the external wiring script");
  ok(filterBarScript.includes("select[data-mfb-sort]") && filterBarScript.includes("addEventListener('change'"), "filter bar: script wires the data-mfb-sort select");
  ok(filterBarScript.includes("input[data-mfb-search]") && filterBarScript.includes("addEventListener('input'"), "filter bar: script wires the data-mfb-search input");
  ok(filterBarScript.includes("data-mfb-row") && filterBarScript.includes("appendChild") && filterBarScript.includes("style.display"), "filter bar: script sorts/filters [data-mfb-row] rows via appendChild + style.display");
  ok(!filterBarScript.includes("innerHTML"), "filter bar: script never assigns innerHTML");
  // Execution-order guard — the bar renders ABOVE the roster, so a script
  // that queries [data-mfb-row] at parse time finds ZERO rows and its early
  // return dead-wires Sort/search on every load (the original bug). The row
  // lookup must be deferred to DOMContentLoaded: the wrapper must exist and
  // textually precede the row query it defers.
  const dclIdx = filterBarScript.indexOf("addEventListener('DOMContentLoaded'");
  ok(dclIdx !== -1 && dclIdx < filterBarScript.indexOf("querySelectorAll('[data-mfb-row]')"), "filter bar: row lookup is deferred to DOMContentLoaded, not run at parse time");
}

// Roster rows carry the numeric data-* payload the filter bar script sorts on
// — on BOTH the all-chains <tr> rows and the per-chain compact rows.
{
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xabc0000000000000000000000000000000000abc" } };
  const leaderboardSnap = { leaderboard: [{ name: "Ext One", homepage: "https://ext1.example", wallet: "0xabc0000000000000000000000000000000000abc", wallets: ["0xabc0000000000000000000000000000000000abc"], callsSettled: 42, totalUsd: 3.5, uniqueBuyers: 7 }] };
  const allHtml = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [LOCAL, EXT] }, leaderboardSnap });
  ok(/<div data-mfb-row data-local="0" data-health="1" data-calls="42" data-usd="3\.5" data-buyers="7" data-tools="3"/.test(allHtml), "all view: roster row carries numeric data-calls/usd/buyers/tools attributes");
  ok(/<div data-mfb-row data-local="1"/.test(allHtml), "all view: local row is marked data-local=1 (stays pinned through client sorts)");
  // Per-chain compact view (>12 sellers forces compact rows).
  const many = Array.from({ length: 14 }, (_, i) => ({ origin: `https://e${i}.example`, displayName: `E${i}`, homepage: `https://e${i}.example`, local: false, toolCount: i, routable: true, networks: ["eip155:8453"], payToByNetwork: {} }));
  const chainHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL, ...many] }, rail: null, activity: null, wallet: "0x1" });
  ok(/<a [^>]*data-mfb-row data-local="0" data-health="1"[^>]*data-tools="13"/.test(chainHtml), "chain view: compact roster rows carry the same data-* payload");
  ok(chainHtml.includes('<script src="/js/market-filter-bar.js"></script>'), "chain view: filter-bar wiring script is emitted on per-chain pages too");
}

// Roster row cap (speed P0) — the all-chains roster renders at most
// ALL_ROW_CAP (100) rows by default with an honest cap note + ?all=1 escape;
// all:true renders every deduped seller. Counts, JSON-LD and the SELLERS card
// stay on the FULL roster either way.
{
  const many = Array.from({ length: 120 }, (_, i) => ({ origin: `https://s${i}.example`, displayName: `Seller ${i}`, homepage: `https://s${i}.example`, local: false, toolCount: 1, routable: true, networks: ["eip155:8453"], payToByNetwork: {} }));
  const snapshot = { sellers: [LOCAL, ...many] }; // 121 deduped sellers
  const capped = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap: { leaderboard: [] } });
  // Count `<div data-mfb-row` (not the bare attribute — the filter-bar script
  // legitimately mentions the attribute name once in its querySelectorAll).
  // THIS HOST is PINNED at the top: the cap applies to the RANKED (non-local)
  // sellers only, so the roster renders the pinned local row + top-100 ranked =
  // 101 rows, and the note counts INDEPENDENT sellers (120 of the 121, since
  // one is the pinned host).
  ok((capped.match(/<div data-mfb-row/g) || []).length === 101, `all view: cap renders pinned local + top 100 ranked (got ${(capped.match(/<div data-mfb-row/g) || []).length})`);
  ok(capped.includes("this host pinned · showing the top 100 of 120 independent sellers"), "all view: cap note discloses the pin + truncation honestly");
  ok(capped.includes('href="/marketplace?all=1"'), "all view: cap note links the ?all=1 escape hatch");
  ok(/<div data-mfb-row data-local="1"/.test(capped), "all view: the local seller survives the cap (ranked or appended, never dropped)");
  ok(/SELLERS LISTED<\/div><div[^>]*>121</.test(capped), "all view: SELLERS LISTED card still counts the full roster (121), not the capped table");
  const full = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap: { leaderboard: [] }, all: true });
  ok((full.match(/<div data-mfb-row/g) || []).length === 121, `all view: all:true renders every roster row (got ${(full.match(/<div data-mfb-row/g) || []).length})`);
  ok(!full.includes("showing the top 100"), "all view: no cap note when the full roster is rendered");
}

// All-chains view — marketPage(null, …) renders the unified "The x402
// marketplace" directory instead of a chain-scoped page: neutral header +
// positioning line, the filter bar with All active, a seller roster over
// EVERY seller (not chain-filtered) with an added Chain column, and none of
// the chain-specific extras (receipt strip / per-seller activity / sell copy).
{
  const LOCAL = { local: true, displayName: "Agent402.Tools", homepage: "https://agent402.tools", toolCount: 1431, routable: true, networks: ["eip155:8453"] };
  const EXT = { origin: "https://ext.example", displayName: "Ext", homepage: "https://ext.example", local: false, toolCount: 3, routable: true, networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], payToByNetwork: {} };
  const snapshot = { sellers: [LOCAL, EXT] };
  ok(marketSellersAll(snapshot).length === 2, "marketSellersAll returns every seller regardless of chain");
  const html = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap: { leaderboard: [] } });
  ok(/The x402 <span[^>]*>marketplace/.test(html) || />The x402 marketplace/.test(html), "all view: header is 'The x402 marketplace'");
  ok(/neutral x402 index/i.test(html), "all view: keeps the neutral-index positioning line");
  ok(/data-chain-tab="all"/.test(html), "all view: renders the filter bar");
  ok(/Chain<\/th>|>Chain</.test(html), "all view: seller list has a Chain column");
  ok(!/first settlement|verify on/.test(html), "all view: no per-chain receipt/verify extras");

  // THIS HOST presents itself like any other seller: its 8 rails fill the
  // Chain column (never a dash) and its own leaderboard row supplies the tx
  // count when the route passes our wallet.
  const LOCAL8 = { ...LOCAL, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:137", "eip155:42161", "eip155:143", "stellar:pubnet", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "eip155:4663"] };
  const OUR_WALLET = "0xfeda7403aabe9a492ed70e810b396d8548a4a022";
  const selfLb = { leaderboard: [{ name: "Agent402.Tools", homepage: "https://agent402.tools", wallet: OUR_WALLET, wallets: [OUR_WALLET], callsSettled: 9876, totalUsd: 42.5, uniqueBuyers: 55 }] };
  const selfHtml = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [LOCAL8, EXT] }, leaderboardSnap: selfLb, wallet: OUR_WALLET });
  ok(/Base\s*<[^>]*>\s*\+7|Base<\/[^>]+>[^<]*\+7|Base[^<]*\+7/.test(selfHtml.replace(/\s+/g, " ")), "all view: THIS HOST's Chain cell shows its rails (Base +7), not a dash");
  ok(/9,876\s*tx/.test(selfHtml.replace(/&middot;|·/g, " ")), "all view: THIS HOST's row carries its own leaderboard tx count");
  // No wallet passed → honest silence (no invented number), never a crash.
  const noWallet = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [LOCAL8, EXT] }, leaderboardSnap: selfLb });
  ok(!/9,876\s*tx/.test(noWallet), "all view: without a route wallet the local row shows no tx (honest omission)");

  // THIS HOST is PINNED at the top (owner call 2026-07-21): even an external
  // seller with far more settled calls renders BELOW the pinned host row. The
  // pin is transparency (badge + tint + note), not a volume-ranking claim;
  // external sellers stay ranked among themselves.
  const BIGEXT = { origin: "https://big.example", displayName: "Big Ext", homepage: "https://big.example", local: false, toolCount: 5, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xb1g0000000000000000000000000000000000b1g" } };
  const bigLb = { leaderboard: [
    { name: "Big Ext", homepage: "https://big.example", wallet: "0xb1g0000000000000000000000000000000000b1g", wallets: ["0xb1g0000000000000000000000000000000000b1g"], callsSettled: 50000, totalUsd: 100, uniqueBuyers: 9 },
    { name: "Agent402.Tools", homepage: "https://agent402.tools", wallet: OUR_WALLET, wallets: [OUR_WALLET], callsSettled: 9876, totalUsd: 42.5, uniqueBuyers: 55 },
  ] };
  const ranked = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [LOCAL8, BIGEXT] }, leaderboardSnap: bigLb, wallet: OUR_WALLET });
  // Compare ROW positions ("THIS HOST" also appears in the subtitle above the
  // table, so anchor on the local row's data attribute instead).
  ok(ranked.indexOf('data-local="1"') < ranked.indexOf("Big Ext"), "all view: THIS HOST is PINNED above a busier external seller (badge/tint mark it, not a ranking claim)");
}

// All-view roster dedup — marketPageAll resolves a seller's payTo by walking
// EVERY network in payToByNetwork (Object.values), unlike the per-chain
// roster which is scoped to one network via C.isNetwork. Exercise that with
// two sellers that share a settlement payTo but advertise it under DIFFERENT
// networks, so the collapse can only work if the all-view actually checks
// every network rather than just the first/matching one.
{
  const payTo = "0xdupmulti0000000000000000000000000dupm";
  const A = { origin: "https://amulti.example", displayName: "Multi A", homepage: "https://amulti.example", local: false, toolCount: 50, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": payTo } };
  const B = { origin: "https://svc-b-multi.up.railway.app", displayName: "Multi B", homepage: "https://svc-b-multi.up.railway.app", local: false, toolCount: 4, routable: true, networks: ["eip155:137"], payToByNetwork: { "eip155:137": payTo } };
  const snapshot = { sellers: [LOCAL, A, B] };
  const leaderboardSnap = { leaderboard: [{ name: "Grouped Multi", homepage: "https://amulti.example", wallet: payTo, wallets: [payTo], callsSettled: 777, totalUsd: 8, uniqueBuyers: 5 }] };
  const html = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap });
  const stripped = html.replace(/&middot;|·/g, " ");

  ok((stripped.match(/777\s*tx/g) || []).length === 1, "all view: shared-payTo group (advertised on two different networks) renders its tx total once, not per host");
  ok(stripped.includes("amulti.example"), "all view: canonical host (real domain) survives the multi-network collapse");
  ok(!/svc-b-multi\.up\.railway\.app/.test(stripped), "all view: the platform-subdomain sibling on the OTHER network is collapsed away, not a second row");
  ok(/\+1 more endpoint\b/.test(stripped), "all view: collapsed sibling is disclosed as '+1 more endpoint', not hidden");
  ok(/SELLERS LISTED<\/div><div[^>]*>2</.test(html), "all view: SELLERS count reflects the collapsed roster (LOCAL + 1 group = 2, not 3)");
}

// /marketplace + per-chain filter bar — the chain views must now carry the
// shared filter bar (Task 3) so a visitor can jump straight to /marketplace
// or another chain without going back through the switcher strip.
{
  const snapshot = { sellers: [{ local: true, displayName: "Agent402.Tools", homepage: "https://agent402.tools", toolCount: 1431, routable: true, networks: ["eip155:8453"] }] };
  const baseView = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null });
  ok(/data-chain-tab="base"[^>]*\bon\b|\bon\b[^>]*data-chain-tab="base"/.test(baseView), "chain view: filter bar present with Base active");
  ok(/href="\/marketplace"/.test(baseView), "chain view: filter bar links back to /marketplace");
}

// Nav collapse (Task 5) — the site chrome carries ONE "Marketplace" entry
// pointing at /marketplace (chains as its dropdown); the old separate "index"
// trigger/panel and its /index links are gone from nav + footer. The word
// "index" may only survive in body positioning copy ("the neutral x402 index").
{
  const html = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] } });
  ok(/href="\/marketplace"[^>]*>\s*[Mm]arketplace/.test(html) || />Marketplace<\/a>/.test(html), "nav: single Marketplace entry → /marketplace");
  ok(!/>index<\/a>/i.test(html.replace(/neutral x402 index/gi, "")), "nav/footer: no user-facing 'index' link");
  ok(/href="\/base"/.test(html), "nav: chain links still reachable (dropdown)");
  ok(/href="\/leaderboard"/.test(html), "nav/footer: leaderboard link survives the index-panel merge");
  ok(!/href="\/index"/.test(html) && !/href="\/marketplaces"/.test(html), "nav/footer: no links to the old /index or /marketplaces URLs");
}

// Sitemap + canonical (Task 7) — the sitemaps must list the unified
// /marketplace surface and must NOT list the legacy /index or /marketplaces
// URLs (both 301 to /marketplace now; a sitemap must never list URLs that
// redirect). Exact-string checks so the legit /api/index JSON endpoint in the
// monolith sitemap doesn't false-positive the /index assertion.
{
  const BASE = "https://agent402.tools";
  for (const [label, xml] of [["sitemap-pages", sitemapPages(BASE, {})], ["sitemap.xml", sitemapXml(BASE, {})]]) {
    ok(xml.includes(`${BASE}/marketplace</loc>`), `${label}: /marketplace listed`);
    ok(!xml.includes(`${BASE}/index</loc>`), `${label}: legacy /index dropped (it 301s)`);
    ok(!xml.includes(`${BASE}/marketplaces</loc>`), `${label}: legacy /marketplaces dropped (it 301s)`);
  }
  // llms.txt is a machine surface too — it must not point agents at the 301s.
  const llms = llmsTxt(BASE, {});
  ok(!llms.includes(`${BASE}/index)`) && !llms.includes(`${BASE}/marketplaces)`), "llms.txt: no links to the legacy /index or /marketplaces URLs");

  // The all-chains view is self-canonical to /marketplace; per-chain pages
  // stay self-canonical (spot-check /base).
  const allHtml = marketPage(null, BASE, { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] } });
  ok(allHtml.includes(`<link rel="canonical" href="${BASE}/marketplace">`), "all view: canonical is /marketplace");
  const baseHtml = marketPage("base", BASE, { snapshot: { sellers: [] }, rail: null, activity: null });
  ok(baseHtml.includes(`<link rel="canonical" href="${BASE}/base">`), "chain view: /base stays self-canonical");

  // The chain pages' breadcrumb JSON-LD and the /.well-known/x402 manifest are
  // machine surfaces too — they must point at /marketplace, not the 301s.
  ok(baseHtml.includes(`"item":"${BASE}/marketplace"`), "chain view: breadcrumb JSON-LD points at /marketplace, not /index");
  ok(!baseHtml.includes(`"item":"${BASE}/index"`), "chain view: breadcrumb JSON-LD has no /index item");
  const manifest = serviceManifest({ baseUrl: BASE, network: "base", networks: ["base"], wallet: "0x1", walletName: "t", catalog: {}, toolCount: 0, powSlugs: [], powDifficulty: 20, prices: [] });
  ok(manifest.discovery.sellerIndexHtml === `${BASE}/marketplace`, ".well-known/x402: sellerIndexHtml points at /marketplace, not the /index 301");
}

// Economy strip (Task 8) — marketPageAll accepts an optional economySnap and
// renders a compact stats strip whose container carries id="economy" (the
// /economy + /x402-economy 301s land on /marketplace#economy, so the anchor
// must exist when a snapshot renders; the footer's own Economy link was
// removed 2026-07-29 as duplicative of the Marketplace link beside it). Bound to x402EconomySnapshot()'s REAL shape — totals.last7d
// {settlements, payers, merchants, volumeUsd} + totals.last30d {settlements} —
// defensively: a missing field drops its cell, never NaN/undefined text.
{
  const AT = "https://agent402.tools";
  const baseOpts = { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] } };
  const economySnap = { totals: { last7d: { settlements: 12345, payers: 734, merchants: 41, volumeUsd: 987.65 }, last30d: { settlements: 54321 } } };
  const html = marketPage(null, AT, { ...baseOpts, economySnap });
  ok(/id="economy"/.test(html), 'all view: economy strip container carries id="economy" (closes the /marketplace#economy anchor)');
  ok(/12,345/.test(html) && /54,321/.test(html), "all view: strip renders 7d + 30d settlements from totals");
  ok(/>734</.test(html), "all view: strip renders 7d unique payers");
  ok(/\$987\.65/.test(html), "all view: strip renders 7d volume in USD");
  ok(/>41</.test(html), "all view: strip renders 7d settling sellers (merchants)");

  // Partial snapshot: only one numeric field → that cell renders, the rest are
  // omitted; the strip region must never contain NaN/undefined text.
  const partial = marketPage(null, AT, { ...baseOpts, economySnap: { totals: { last7d: { settlements: 99 } } } });
  const stripAt = partial.indexOf('id="economy"');
  const stripRegion = partial.slice(stripAt, stripAt + 3000);
  ok(stripAt !== -1 && /(>|\b)99</.test(stripRegion), "all view: partial snapshot still renders its one real field");
  ok(!/NaN|undefined/.test(stripRegion), "all view: partial snapshot never renders NaN/undefined in the strip");

  // Snapshot present but no usable numbers (all queries errored → totals {}):
  // the anchor still exists (the three surfaces link to it) with an honest
  // "unavailable" line, no fabricated zeros.
  const empty = marketPage(null, AT, { ...baseOpts, economySnap: { totals: {}, errors: ["daily: boom"] } });
  ok(/id="economy"/.test(empty) && /unavailable/i.test(empty), "all view: errored snapshot keeps the anchor with an honest unavailable line");

  // No snapshot at all → honest omission: no strip, no crash.
  const noEcon = marketPage(null, AT, baseOpts);
  ok(typeof noEcon === "string" && noEcon.length > 0, "all view: no economy snapshot → page still renders (no crash)");
  ok(!/id="economy"/.test(noEcon), "all view: no economy snapshot → no strip rendered (honest omission)");
}

// --- marketOperatorCount: nav dropdown and roster must speak the same unit ---
// Three sellers on Base, two settling to ONE leaderboard wallet group -> the
// roster collapses them to one row, so the count must be 2, not 3 (the
// "dropdown says 1,554, page says 843" regression class).
{
  const { marketOperatorCount } = await import("../src/market-page.js");
  const W1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const mk = (host, wallet) => ({ origin: `https://${host}`, displayName: host, homepage: `https://${host}`, local: false, toolCount: 1, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": wallet } });
  const snapshot = { sellers: [mk("a.example", W1), mk("b.example", W1), mk("c.example", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")] };
  const lb = { leaderboard: [{ wallet: W1, callsSettled: 5, totalUsd: 1, uniqueBuyers: 2 }] };
  ok(marketOperatorCount("base", snapshot, lb) === 2, "grouped wallets collapse in the operator count (2, not 3)");
  ok(marketOperatorCount("base", snapshot, null) === 3, "no leaderboard -> no grouping evidence -> all count");
  ok(marketOperatorCount(null, snapshot, lb) === 2, "all-chains view collapses the same way");
}

// --- Per-chain roster cap: a busy chain must not render its full roster
// unconditionally (measured live on /base: 1,125 sellers -> a 700KB+ page,
// 56,000px of desktop scroll, 7,500+ DOM nodes before "Sell on Base" is even
// reachable). Mirrors marketPageAll's already-proven ALL_ROW_CAP=100 pattern;
// 100 here must match market-page.js's own (unexported) ALL_ROW_CAP.
{
  const ROW_CAP = 100;
  const many = Array.from({ length: 150 }, (_, i) => ({
    origin: `https://seller${i}.example`, displayName: `Seller ${i}`, homepage: `https://seller${i}.example`,
    local: false, toolCount: 1, routable: true, networks: ["eip155:8453"],
  }));
  const snapshot = { sellers: [LOCAL, ...many] };
  // mlr-host only appears on actual roster rows (compact or card variant,
  // never both in one render) - data-mfb-row was tried first and rejected:
  // it also appears as a literal string inside the filter bar's embedded
  // client-side script (a querySelectorAll call), which isn't a roster row.
  const rowCount = (html) => (html.match(/class="mlr-host"/g) || []).length;

  const capped = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null, wallet: "0x1111111111111111111111111111111111111111" });
  // +1 for the pinned local seller, which is never part of the capped count.
  ok(rowCount(capped) === ROW_CAP + 1, `roster caps at ${ROW_CAP} + pinned local row (got ${rowCount(capped)})`);
  ok(/showing the top 100 of 150 sellers/.test(capped), "cap note states the true total (150), not the capped count");
  ok(/href="\/base\?all=1"/.test(capped), "cap note links to this chain's own ?all=1, not /marketplace");
  ok(/SELLERS LISTED[\s\S]{0,200}151/.test(capped), "SELLERS LISTED stat stays the full honest count (151), unaffected by the render cap");

  const uncapped = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null, wallet: "0x1111111111111111111111111111111111111111", all: true });
  ok(rowCount(uncapped) === 151, `?all=1 renders every seller (got ${rowCount(uncapped)}, want 151)`);
  ok(!/showing the top/.test(uncapped), "?all=1 shows no cap note");
}

// --- MPP badge: a seller whose live paywall probe found a native MPP
// challenge (WWW-Authenticate: Payment, see isMppChallenge in x402-index.js)
// gets an "MPP" tag next to its name. null/false/absent must render nothing -
// this is a live-verified signal, never a default-on claim.
{
  const mkSeller = (host, mpp) => ({ origin: `https://${host}`, displayName: host, homepage: `https://${host}`, local: false, toolCount: 3, routable: true, networks: ["eip155:8453"], mpp });
  const snapshot = { sellers: [LOCAL, mkSeller("mpp-yes.example", true), mkSeller("mpp-no.example", false), mkSeller("mpp-unprobed.example", null), mkSeller("mpp-absent.example", undefined)] };

  // All-chains view.
  const allHtml = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap: { leaderboard: [] } });
  ok(/mpp-yes\.example[\s\S]{0,120}class="mlr-mpp"/.test(allHtml), "all view: seller with mpp:true gets the MPP badge");
  ok(!new RegExp('mpp-no\\.example[\\s\\S]{0,120}class="mlr-mpp"').test(allHtml), "all view: seller with mpp:false gets no badge");
  ok(!new RegExp('mpp-unprobed\\.example[\\s\\S]{0,120}class="mlr-mpp"').test(allHtml), "all view: never-probed (null) seller gets no badge, not a false positive");
  ok(!new RegExp('mpp-absent\\.example[\\s\\S]{0,120}class="mlr-mpp"').test(allHtml), "all view: seller with no mpp field at all gets no badge (undefined !== true)");
  ok(!allHtml.includes('Agent402.Tools (agent402.base.eth)<span class="mlr-mpp"') && !/THIS HOST<\/span>\s*<span class="mlr-mpp"/.test(allHtml), "all view: THIS HOST row (mpp never set) carries no badge either");

  // Per-chain compact view (>12 sellers forces compact rows) - the badge must
  // render there too, not just the all-chains table row shape.
  const many = Array.from({ length: 13 }, (_, i) => mkSeller(`e${i}.example`, i === 0 ? true : false));
  const chainHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL, ...many] }, rail: null, activity: null, wallet: "0x1" });
  ok(/e0\.example[\s\S]{0,120}class="mlr-mpp"/.test(chainHtml), "chain compact view: mpp:true seller gets the badge");
  ok(!new RegExp('e1\\.example[\\s\\S]{0,120}class="mlr-mpp"').test(chainHtml), "chain compact view: mpp:false seller gets no badge");

  // Per-chain card view (<=12 sellers).
  const cardHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL, mkSeller("card-mpp.example", true), mkSeller("card-no.example", false)] }, rail: null, activity: null, wallet: "0x1" });
  ok(/card-mpp\.example[\s\S]{0,120}class="mlr-mpp"/.test(cardHtml), "chain card view: mpp:true seller gets the badge");
  ok(!new RegExp('card-no\\.example[\\s\\S]{0,120}class="mlr-mpp"').test(cardHtml), "chain card view: mpp:false seller gets no badge");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
