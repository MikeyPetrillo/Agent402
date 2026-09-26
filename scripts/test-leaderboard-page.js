// Offline unit tests for the /leaderboard page renderer (src/ledger-leaderboard.js,
// Aug 2026 revamp). Fixture data only - no server, no network.
import { ledgerLeaderboardPage } from "../src/ledger-leaderboard.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const SELF_WALLET = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";

// --- real data rendering, self-exclusion, computed columns -------------------
{
  const snapshot = {
    windowLabel: "7d",
    scannedSellers: 824,
    walletsQueried: 1040,
    bazaarTotal: 14866,
    scannedBlocks: 302400,
    maxCallUsd: 0.75,
    leaderboard: [
      // Our own row - highest volume, must be excluded from the ranked table.
      { rank: 1, name: "Agent402.Tools", wallet: SELF_WALLET.toLowerCase(), homepage: "https://agent402.tools", totalUsd: 900.5, callsSettled: 30000, uniqueBuyers: 300 },
      { rank: 2, name: "Seller-One.example", wallet: "0xbbb", homepage: "https://seller-one.example", totalUsd: 21422.22932, callsSettled: 1127246, uniqueBuyers: 166 },
      { rank: 3, name: "agents.chain.link", wallet: "0xccc", homepage: "https://agents.chain.link", totalUsd: 103.432, callsSettled: 9711, uniqueBuyers: 2 },
    ],
  };
  const stats = { toolCallsServed: { viaUSDC: 28200, viaProofOfWork: 7608, viaMPPWire: 69, viaUSDCByNetwork: { base: 28200 } } };
  const html = ledgerLeaderboardPage(BASE_URL, snapshot, { stats, walletAddress: SELF_WALLET });

  ok(html.includes("Who is actually") && html.includes("settling <span"), "hero H1 renders");
  ok(!html.slice(0, html.indexOf("Agent402, for comparison")).includes(">Agent402.Tools<"), "Agent402's own row is excluded from the ranked table (wallet-matched)");
  ok(html.includes(">Seller-One.example<") && html.includes(">agents.chain.link<"), "external sellers render in the ranked table");
  // Re-ranked after exclusion: Seller-One.example (was rank 2) must now read 01.
  const sellerOneRow = html.split("lb-row").find((s) => s.includes("Seller-One.example"));
  ok(sellerOneRow && />01</.test(sellerOneRow), "ranks are consecutive after Agent402's row is filtered out, not left with a gap");
  ok(html.includes("$21,422.23"), "real USDC settled renders with real formatting");
  // avg ticket = totalUsd / callsSettled = 21422.22932 / 1127246 = 0.0190...
  ok(/\$0\.0190/.test(html), "avg ticket is computed from real totalUsd/callsSettled");
  // organic = uniqueBuyers/callsSettled*100: Seller-One 166/1127246*100 = 0.0147 -> "0.01"; agents.chain.link 2/9711*100=0.0206 -> "0.02"
  ok(html.includes("0.01"), "organic ratio for a high-volume, low-buyer seller computes correctly");
  ok(html.includes("0.02"), "organic ratio for a low-buyer seller computes correctly");
  ok(html.includes("824") && html.includes("1,040") && html.includes("14,866") && html.includes("302,400"), "snapshot meta table renders real scan figures");
  ok(html.includes("28,200") && html.includes("7,608") && html.includes("69"), "Agent402's own comparison figures render from real stats");
  ok(/\d+ of 12/.test(html), "rails-with-traffic count renders as 'N of 12'");
}

// --- organic ratio: genuinely sub-0.01 case reads as "<0.01", never a
// fabricated 0.00 ------------------------------------------------------------
{
  const snapshot = { leaderboard: [{ rank: 1, name: "Whale Payer", wallet: "0xeee", totalUsd: 5, callsSettled: 10000000, uniqueBuyers: 1 }] };
  const html = ledgerLeaderboardPage(BASE_URL, snapshot, {});
  ok(html.includes("&lt;0.01"), "a genuinely sub-0.01 organic ratio reads as '<0.01' (HTML-escaped), never a fabricated 0.00");
}

// --- honest empty / warming state --------------------------------------------
{
  const html = ledgerLeaderboardPage(BASE_URL, {}, {});
  ok(html.includes("Warming up"), "empty snapshot shows the warming state, not a broken table");
  ok(!/undefined|NaN|\[object Object\]/.test(html), "no template artifacts leak into the empty-state render");
}

// --- partial-scan honesty flag survives the rewrite ---------------------------
{
  const snapshot = { leaderboard: [{ rank: 1, name: "Seller", wallet: "0xaaa", totalUsd: 10, callsSettled: 100, uniqueBuyers: 5 }], partial: true, windowNote: "24h scan, partial: 2 of 8 ranges unavailable" };
  const html = ledgerLeaderboardPage(BASE_URL, snapshot, {});
  ok(html.includes("Partial scan") && html.includes("2 of 8 ranges unavailable"), "partial-scan honesty note renders when the scan pipeline flags it");
}

// --- unbounded-roster guard: never render more than the curated cap ----------
// The pre-revamp page rendered every row unconditionally - the same shape
// fixed on /marketplace (PR #772). Lock that this page stays bounded even
// when the snapshot holds hundreds of sellers.
{
  const many = Array.from({ length: 300 }, (_, i) => ({ rank: i + 1, name: `Seller ${i}`, wallet: `0x${i}`, totalUsd: 300 - i, callsSettled: 100, uniqueBuyers: 10 }));
  const html = ledgerLeaderboardPage(BASE_URL, { leaderboard: many, scannedSellers: 300 }, {});
  const rowCount = (html.match(/class="lb-row/g) || []).length;
  ok(rowCount > 0 && rowCount <= 12, `ranked table renders a bounded top N, not all 300 sellers (got ${rowCount} rows)`);
  ok(html.includes("top 12 of 300"), "the cap is disclosed honestly, not hidden");
}

// --- structured data -----------------------------------------------------------
{
  const html = ledgerLeaderboardPage(BASE_URL, {}, {});
  ok(html.includes('"@type":"Organization"'), "Organization JSON-LD present");
  ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present");
  ok(html.includes('"@type":"Dataset"') && html.includes('"@type":"DataDownload"'), "Dataset + DataDownload JSON-LD present");
  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<article style="padding:24px 0/g) || []).length;
  ok(faqLdCount === 3, `FAQPage JSON-LD carries exactly 3 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 3, `visible FAQ prose carries exactly 3 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
}

// --- copy hygiene + safety -----------------------------------------------------
{
  const html = ledgerLeaderboardPage(BASE_URL, {}, {});
  ok(!html.includes("—"), "no em dashes anywhere in the page copy");
}
{
  // F23-style seller homepage href scheme guard (dormant legacy shape, same
  // check ported from the old renderer).
  const snapshot = { leaderboard: [{ rank: 1, name: "Evil Seller", wallet: "0xdead", homepage: "javascript:alert(1)", totalUsd: 1, callsSettled: 1, uniqueBuyers: 1 }] };
  const html = ledgerLeaderboardPage(BASE_URL, snapshot, {});
  ok(!/href="javascript:/i.test(html), "a javascript: seller homepage never becomes an href");
  ok(html.includes("Evil Seller"), "the seller still renders, just with no clickable link");
}


// --- the host's own entry (2026-08-28): external-only rows + a pinned unnumbered row ---
{
  const snapshot = { windowLabel: "7d", scannedSellers: 2, leaderboard: [
    { rank: 1, name: "Agent402.Tools", wallet: SELF_WALLET.toLowerCase(), homepage: "https://agent402.tools", totalUsd: 900.5, callsSettled: 30000, uniqueBuyers: 300 },
    { rank: 2, name: "Seller-One.example", wallet: "0xbbb", homepage: "https://seller-one.example", totalUsd: 21.2, callsSettled: 1127, uniqueBuyers: 16 },
  ] };
  const stats = { toolCallsServed: { viaUSDC: 28200, viaProofOfWork: 7608, viaMPPWire: 69, viaUSDCByNetwork: { base: 28200 } } };
  const HOSTF = { baseUrl: BASE_URL, toolCount: 560, recordingSince: "2026-06-15T00:00:00.000Z", external30d: { settlements: 109, buyers: 7, tools: 21 }, externalAllTime: { settlements: 3945, buyers: 250, tools: 105 } };
  const without = ledgerLeaderboardPage(BASE_URL, snapshot, { stats, walletAddress: SELF_WALLET });
  const html = ledgerLeaderboardPage(BASE_URL, snapshot, { stats, walletAddress: SELF_WALLET, host: HOSTF });
  ok(!without.includes("data-host-row") && html.includes("data-host-row"), "pinned host row renders only with host figures");
  ok(/data-host-ext-30d>109</.test(html) && /data-host-buyers-30d>7</.test(html) && /data-host-ext-all>3,945</.test(html), "disclosed panel carries external-only 30d settlements, 30d buyers and all-time settlements");
  ok(html.includes("canary and volume runs are excluded"), "the exclusion note is stated");
  const row = html.slice(html.indexOf("data-host-row"), html.indexOf("data-host-row") + 900);
  ok(!/lb-rank/.test(row) && /NOT RANKED/.test(row), "host row carries no rank and says so");
  ok(!html.slice(0, html.indexOf("Agent402, for comparison")).includes(">Agent402.Tools<"), "ranked table still excludes the host");
}
// --- the JSON honours the commitment the HTML already honoured --------------
// /sell states: "We publish how the ranking works, and exclude ourselves from
// our own leaderboard." Until 2026-09-13 the HTML page did and the JSON did
// not: the default (include=all) ranked the host at #11, unflagged, under a
// tool name - on the very URL the homepage's Dataset JSON-LD names as its
// distribution. That row is also inflated by our own canary and volume runs,
// which is the exact criticism /transparency levels at other people's counts.
// Pinned from source, because the whole behaviour is one ternary.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const include = req\.query\.include === "all" \? "all" : "external";/.test(src),
     "the leaderboard JSON DEFAULTS to external, matching the commitment on /sell");
  ok(!/const include = req\.query\.include === "external" \? "external" : "all";/.test(src),
     "...and the old host-including default cannot come back");
  ok(/include === "all" && self\) board = board\.map\(/.test(src),
     "on the full board the host's own row is flagged self:true, so no consumer can mistake it for a third party");
}

// The Solana section: Base's columns (USDC settled, calls, buyers, avg ticket,
// organic), our own payTo left out, a partial scan and a still-loading window
// said, hostile origin text escaped, a javascript: origin never linked.
{
  const w = (calls, usd, buyers) => ({ callsSettled: calls, totalUsd: usd, uniqueBuyers: buyers });
  const sol = {
    window: "7d", windowComplete: false, stale: false, scanned: 600, scanCandidates: 700, scanCoversAll: false,
    rows: [
      { payTo: "Bd2xS189uhhnxUeBeVF3JFXrg8zQgrvqZtpqh8hgkCEQ", origins: ["https://busy.example", "https://busy2.example"], ...w(36150, 4512.25, 13), self: false, backfilling: true },
      { payTo: "SELFSELFSELFSELFSELFSELFSELFSELFSELFSELF1111", origins: ["https://agent402.tools"], ...w(900, 1, 5), self: true },
      { payTo: "Hx9Qe1111111111111111111111111111111111111", origins: ["https://evil.example/<script>alert(1)</script>"], ...w(40, 2, 20), self: false },
      { payTo: "Js111111111111111111111111111111111111111111", origins: ["javascript:alert(1)"], ...w(3, 0.003, 3), self: false },
      { payTo: "Zero111111111111111111111111111111111111111", origins: ["https://idle.example"], ...w(0, 0, 0), self: false },
    ],
  };
  const html = ledgerLeaderboardPage(BASE_URL, { leaderboard: [], scannedSellers: 0 }, { solana: sol });
  ok(/id="solana"/.test(html) && /Solana, ranked by USDC settled/.test(html), "the page carries a Solana section");
  ok(/36,150/.test(html) && /\$4,512\.25/.test(html) && /\$0\.1248/.test(html), "a busy seller shows every payment, the dollars and the average ticket (no cap)");
  ok(!/SELFSELF/.test(html), "our own Solana payTo is left out of the ranking, as on the Base table");
  ok(!/idle\.example/.test(html), "a seller with no payments in the window is not ranked");
  ok(/scanned 600 of 700 seller payTos/.test(html) && /history still loading/.test(html), "a partial scan and an incomplete window both say so");
  ok(!/<script>alert/.test(html), "seller-controlled origin text is escaped");
  ok(!/href="javascript:/i.test(html), "a non-http origin is shown, never linked");
  ok(/busy\.example<\/a> \+1/.test(html), "a seller with several origins shows the first and a count");
  ok(/usdc settled<\/span><span[^>]*>calls<\/span><span[^>]*>buyers<\/span><span[^>]*>avg ticket<\/span><span[^>]*>organic/.test(html.slice(html.indexOf('id="solana"'))), "the Solana table has the Base table's columns");
  const empty = ledgerLeaderboardPage(BASE_URL, {}, { solana: { window: "7d", rows: [] } });
  ok(/No Solana seller has settled a payment/.test(empty), "an empty board says so instead of rendering nothing");
  ok(!/id="solana"/.test(ledgerLeaderboardPage(BASE_URL, {}, {})), "no Solana snapshot, no section");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
