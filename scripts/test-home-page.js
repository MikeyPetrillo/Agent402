// Offline unit tests for the homepage renderer (src/ledger-home.js, Aug 2026
// revamp). Fixture data only - no server, no network. Covers what
// the removed /index page block did not: real data bindings
// (rails, leaderboard, router-share disclosure), the commercial-sensitivity
// rule, JSON-LD honesty, and copy hygiene.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { ledgerHomePage } from "../src/ledger-home.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { CATEGORY_LINE, LEAD_SENTENCE } from "../src/positioning.js";
import { homeProofFigures } from "../src/home-proof.js";

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
    // A name read from a crawled page can be that page's title; the row
    // shows the seller's host instead.
    { name: "Acme Tools - Home | preview of the API docs", origins: ["https://acme-tools.example/api"], homepage: "https://acme-tools.example", totalUsd: 9.5, callsSettled: 40, uniqueBuyers: 3 },
  ];
  const leaderboardSnapshot = { leaderboard: board, windowLabel: "7d", totalSellers: 824 };
  const html = ledgerHomePage(BASE_URL, catalog, stats, leaderboardSnapshot, Array.from({ length: 42 }));

  // The hero's paid figure is external payments only (src/home-proof.js); the
  // served-call tally, which includes our own test purchases, is not a figure.
  ok(!html.includes("40,233"), "the served-call tally (our own purchases included) is not drawn as a hero figure");
  ok(html.includes("918,422") && html.includes("free calls via proof-of-work"), "free-tier (PoW) count renders");
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
  // 2026-11 trim: the seller section is two lines and one link; the register
  // form lives on /sell, the board on /leaderboard (linked, not repeated).
  ok(!/<input|<button|<pre/.test(sellSec), "the seller section carries no form or shell snippet (both live on /sell)");
  ok(/href="\/leaderboard"/.test(sellSec) && !/Seller-One\.example|seller-two\.example|OTHER SELLERS/.test(html), "the home page links the seller board instead of rendering its rows");
  // The free tier is two lines in the agents card, pointing at the playground
  // where the free tools run; the in-page demo and its shell snippet are gone.
  ok(/The pure-CPU tools are free:[\s\S]{0,400}<a class="btn btn-secondary btn-sm" href="\/playground"/.test(html) && !/id="hm-demo-/.test(html), "the free tier is stated in the agents card and links /playground");
}

// --- honest fallback when no data is available -------------------------------
{
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  // "Listening for on-chain payments…" was a widget's waiting state rendered
  // as served copy: a visitor arriving before the ledger warms read it as the
  // site describing itself. The empty state must still not fabricate a 0.
  ok(!/Listening for on-chain payments/.test(html), "no internal widget state string in served copy");
  // A figure with no reading is left out (src/home-proof.js): no loading
  // line and no dash is served in its place.
  ok(!/Settlement count loading/.test(html) && !/>\s*-\s*</.test(html.slice(html.indexOf("<header"), html.indexOf("</header>"))), "the empty state serves no loading line and no dash placeholder");
  ok(!/class="hm-own"/.test(html), "with no reading, no figure grid is served (never a fabricated 0)");
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
  // The demand lanes left the home page in the 2026-11 trim; the agents table
  // links the paid per-tool ranking instead. Even with topTools present the
  // page shows no slug next to a count.
  const top = Object.values(catalog)[0];
  const ranked = ledgerHomePage(BASE_URL, catalog, { topTools: [{ slug: top.slug, n: 9 }] }, {}, []);
  ok(!new RegExp(`${top.slug}[^<]{0,20}\\b9\\b`).test(ranked) && !/What agents call most/.test(ranked), "no lane or per-tool row with its count");
  ok(/href="\/tools\/bestsellers"[^>]*><span>GET \/api\/bestsellers<\/span>/.test(ranked), "the agents table links the per-tool ranking product");
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
  // The board left the home page (2026-11), so its Dataset markup did too:
  // structured data describes what the page renders.
  ok(!html.includes('"@type":"Dataset"'), "no leaderboard Dataset JSON-LD on a page that no longer renders the board");
  ok(html.includes('"@type":"ItemList"'), "ItemList JSON-LD present for the free discovery primitives");

  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<summary style=/g) || []).length;
  // 4 since the 2026-11 trim: selling, card reports and failed reports are
  // answered by the sections above them; the rest are on /faq.
  ok(faqLdCount === 4, `FAQPage JSON-LD carries exactly 4 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 4, `visible FAQ prose carries exactly 4 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
  ok(/What is agentic finance\?/.test(html) && /href="\/agentic-finance"/.test(html), "agentic finance is defined lower down and linked, not in the hero");
  ok(/How does an agent call a model\?[\s\S]{0,600}settlement never exceeds that quote/.test(html.replace(/<[^>]+>/g, " ")), "the model FAQ leads with the metered route and its quote");
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
  const heroText = html.slice(html.indexOf("<header"), html.indexOf("</header>")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  ok(heroText.includes(CATEGORY_LINE) && heroText.includes(LEAD_SENTENCE) && heroText.includes("Web search, browser rendering, SEC filings, market data and more: an agent sends a request, gets a price back") && !/plus [\d,]+ utilities/.test(html), "the hero states the category, then the lead sentence (500+ tools), then what they do and how a call is paid");
  const proof = homeProofFigures({ external: { value: { count: 40000 }, at: Date.UTC(2026, 10, 11) } });
  const withExt = ledgerHomePage(BASE_URL, catalog, { toolCallsServed: { viaUSDC: 35138, viaProofOfWork: 1, viaMPPWire: 0, viaRouter: 0, viaUSDCByNetwork: {} } }, { leaderboard: [] }, [], { settledOnChain: 46007, external: { count: 40000, usd: 1234.5 }, proof });
  ok(/external payments/.test(withExt) && withExt.includes("40,000") && /of our own test purchases are not counted/.test(withExt) && !/>46,007</.test(withExt),
    "with the external split the hero leads with external payments and footnotes our own test purchases");
}


// --- the hero's paid figure is external payments, or nothing ------------------
// settledOnChain counts inbound on-chain TRANSFERS to our wallets (ours
// included) and viaUSDC counts calls this server SERVED for a stablecoin
// payment. Neither is the external figure, so without an external reading
// neither is drawn: the figure is left out rather than changing meaning.
{
  const stats = { toolCallsServed: { viaUSDC: 35138, viaProofOfWork: 1, viaMPPWire: 0, viaRouter: 0, viaUSDCByNetwork: {} } };
  const chain = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, [], { settledOnChain: 46007 });
  const served = ledgerHomePage(BASE_URL, catalog, stats, { leaderboard: [] }, [], { settledOnChain: 0 });
  ok(!chain.includes("46,007") && !/on-chain settlements received/.test(chain), "a settled total that includes our own wallets is not drawn as the hero figure");
  ok(!served.includes("35,138") && !/calls served<\/span><span>paid in stablecoin/.test(served), "the served-call tally is not drawn as the hero figure either");
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
  ok(html.includes(`${RAILS.length} chains + Tempo live`), "the hero names the x402 chains plus Tempo, one noun for both counts");

  const { readFile } = await import("node:fs/promises");
  const srv = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const store = srv.slice(srv.indexOf("const storeSettledCount"), srv.indexOf("const storeSettledCount") + 300);
  const fn = srv.slice(srv.indexOf("function settledOnChainCount()"), srv.indexOf("function settledOnChainCount()") + 900);
  const shared = srv.slice(srv.indexOf("const revenueAllTime = "), srv.indexOf("const revenueAllTime = ") + 400);
  ok(/railThroughput\(\{ allTime, mpp \}\)/.test(store) && /storeSettledCount\(\{ allTime: ledgerSummary\(/.test(fn) && /revenueAllTime\(\{ awaitRebuild: true \}\)\.then\(storeSettledCount\)/.test(fn) && /ledgerSummary(Async)?\(/.test(shared) && /mppSales\(\{ detailed: false \}\)/.test(shared), "the homepage hero counter uses the /revenue throughput arithmetic (Tempo once, Base/Celo MPP never twice)");
  const hero = await readFile(new URL("../assets/js/home-hero.js", import.meta.url), "utf8");
  ok(/j\.settledExternal/.test(hero) && !/j\.settledOnChain/.test(hero), "the live poll refreshes the external figure the server renders, never the total that includes our own wallets");
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

// The hero script's live read, run against a live view that never answers:
// it is given up after 8 s (the request is aborted and its timer cleared),
// and the figures are left as they were. Timers are driven by hand.
{
  const vm = await import("node:vm");
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(new URL("../assets/js/home-hero.js", import.meta.url), "utf8");
  const timers = [];
  const cleared = new Set();
  const live = [];
  const els = { "hm-live-n": { textContent: "-" }, "hm-live-usd": { textContent: "-" }, "hm-live-buyers": { textContent: "-" }, "hm-live-pm": { textContent: "-" } };
  const sandbox = {
    AbortController, performance, Promise,
    document: { getElementById: (id) => els[id] || null },
    window: { matchMedia: () => ({ matches: true }), addEventListener() {} },
    requestAnimationFrame() {},
    setInterval() {},
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) cleared.add(t); },
    fetch: (url, init) => {
      if (!/^https:\/\/live\.agent402\.tools\//.test(String(url))) return new Promise(() => {});
      const read = { url, signal: init && init.signal, aborted: false };
      live.push(read);
      // Never answers; only an abort ends it.
      return new Promise((_resolve, reject) => { if (read.signal) read.signal.addEventListener("abort", () => { read.aborted = true; reject(new Error("aborted")); }); });
    },
  };
  vm.runInNewContext(code, sandbox);
  ok(live.length === 1, `the hero reads the live view once on load (${live.length})`);
  const giveUp = timers.find((t) => t.ms === 8000);
  ok(!!giveUp && !!live[0]?.signal, `the read carries an abort signal and an 8 s give-up timer (${timers.map((t) => t.ms).join(", ") || "no timers"})`);
  if (giveUp) giveUp.fn();
  await new Promise((r) => setImmediate(r));
  ok(live[0]?.aborted === true && cleared.has(giveUp), "at 8 s the unanswered read is aborted and its timer cleared");
  ok(Object.values(els).every((e) => e.textContent === "-"), "the live figures are left as they were");
}

// --- claims read from their sources -----------------------------------------
{
  const { RAILS_SHORT, RAILS } = await import("../src/rails.js");
  const { routerPayChains } = await import("../src/tools/route-execute.js");
  const { CHAIN_ORDER } = await import("../src/chain-logos.js");
  const html = ledgerHomePage(BASE_URL, catalog, {}, {}, []);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  ok(text.includes(RAILS_SHORT) && !/USDC on \d+ chains/.test(text), "the agents card names the rails from RAILS_SHORT, not 'USDC on N chains'");
  ok(!/\d+ rails live/.test(text) && new RegExp(`${RAILS.length} chains( \\+ Tempo)? live`).test(text), "the hero counts chains (plus Tempo), the noun every other surface uses");
  ok(/whole x402 \+ MPP ecosystem/.test(text), "the live panel states its scope in a label that shows at every width");
  const { chainDisplayName } = await import("../src/rails.js");
  const chains = routerPayChains().map(chainDisplayName).join(", ");
  ok(text.includes(`pays you on ${chains}`), "the seller card's router chains are read from the live router chain set");
  // An EVM chain SOR_EVM_CHAINS lists is named by its display name, read per render.
  {
    const prev = process.env.SOR_EVM_CHAINS;
    process.env.SOR_EVM_CHAINS = "robinhood";
    try {
      const t = ledgerHomePage(BASE_URL, catalog, {}, {}, []).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
      const m = t.match(/pays you on ([^.]+)\./);
      ok(m && /\bRobinhood Chain\b/.test(m[1]), `the seller card names a listed EVM chain by its display name (got: ${m && m[1]})`);
    } finally {
      if (prev === undefined) delete process.env.SOR_EVM_CHAINS; else process.env.SOR_EVM_CHAINS = prev;
    }
  }
  ok(!/our own \d[\d,]* tools|all \d[\d,]* tools/.test(text), "marketing blocks say 500+, not the exact live count");
  ok(CHAIN_ORDER.length === RAILS.length && CHAIN_ORDER.every(([k, n], i) => n === RAILS[i].name), "the chip row is RAILS, names and order");
  const marks = (html.match(/<div class="hm-marks">[\s\S]*?<\/div>/) || [""])[0];
  ok(CHAIN_ORDER.every(([k, n]) => marks.includes(`href="/${k}"`) && marks.includes(`aria-label="${n}"`)), "the compact mark row links every chain's page, each named for screen readers");
  ok(!/fifteen lines|~15 lines/.test(html), "no unverifiable size claim for contributing a tool");
  ok(/href="\/tools\/v1-chat-metered"[^>]*><span>POST \/v1\/metered\/chat\/completions/.test(html), "the metered row links to the metered tier's page");
  const rows = [...html.matchAll(/<span>((?:GET|POST) \/[^<]*)<\/span>/g)].map((m) => m[1]);
  ok(rows[0] === "POST /v1/metered/chat/completions", `the agents table leads with the metered route (${rows[0]})`);
  const { WHY_POINTS } = await import("../src/why.js");
  const fail02 = WHY_POINTS.find((w) => w.id === "never-charged");
  ok(/x402/.test(fail02.t) && !fail02.links.some(([h]) => h === "/status"), "the failure claim is scoped to x402 and links a payment check, not uptime");
  ok(!/^No wallet required/.test(WHY_POINTS.find((w) => w.id === "no-wallet").t), "the no-wallet row is not an absolute");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
