// /status and /revenue answer first and explain after: at most 50 prose words
// above the first h2, and at most 700 prose words a reader meets with the
// optional detail closed (scripts/lib/page-words.js, its "main" mode, says what counts).
//
// Counted: prose in <main> (headings, paragraphs, list items, labels), a
// closed <details>' summary, an open one whole. Not counted: tables, <pre>
// and <code> (so a route printed as code above a section, such as
// /revenue's "$ GET /api/revenue" kicker, adds no words), a bare figure,
// text hidden until a control shows it, the nav and the footer.
//
// Each page is rendered from a fixture that turns on every optional line it
// can print (every component and rail observed, a stale observer, a rail
// behind its peers, incidents, every live check; on /revenue the batched
// option, card sales, the wallet count, a backfilling ledger, a chart range,
// the MPP and decide tables), so the budget holds on the longest render, not
// on an empty boot.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mainProseWords, wordsBeforeFirstH2, proseText, mainOf } from "./lib/page-words.js";

const ABOVE_H2_MAX = 50;
const BODY_MAX = 700;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// ── The counter itself ──────────────────────────────────────────────────────
{
  const page = (inner) => `<html><body><nav>Home Docs Pricing</nav><main id="main">${inner}<footer>a b c d</footer></main></body></html>`;
  ok(mainProseWords(page("<p>one two three</p>")) === 3, "control: prose in <main> is counted, the nav and footer are not");
  ok(mainProseWords(page("<p>one</p><table><tr><td>alpha beta</td></tr></table><pre>x y</pre><code>z w</code>")) === 1, "control: tables, pre and code are not prose");
  ok(mainProseWords(page("<details><summary>More rules</summary><p>four five six</p></details>")) === 2, "control: a closed details counts its summary only");
  ok(mainProseWords(page("<details open><summary>More</summary><p>four five six</p></details>")) === 4, "control: an open details is read whole");
  ok(mainProseWords(page('<p style="display:none;">hidden words here</p><p>seen</p>')) === 1, "control: a paragraph hidden until a control shows it is not counted");
  ok(mainProseWords(page("<p>100% of 299 probes</p>")) === 2, "control: a bare figure is not a word");
  ok(wordsBeforeFirstH2(page("<h1>Title</h1><p>a b</p><h2>Next</h2><p>c d e</p>")) === 3, "control: words above the first h2 stop at it");
}

// ── /status ────────────────────────────────────────────────────────────────
{
  const { statusSnapshot, statusPage, COMPONENTS, RAIL_COMPONENTS, PAID_CALL_SOURCES } = await import("../src/status.js");
  const T = Date.now();
  const MIN = 60_000, H = 3600_000, DAY = 86400_000;
  const HB = PAID_CALL_SOURCES.heartbeat, CF = PAID_CALL_SOURCES.worker;
  // Rows every six hours for 30 days, with a run of failures on the API so
  // incidents render; the newest row is recent except on the lagging rail.
  const age = (key) => (key === "rail_celo" ? 23 * H : /^rail_|^settlement$/.test(key) ? 30 * MIN : 4 * MIN);
  const rowsFor = (key, since) => {
    const out = [];
    for (let ts = T - 30 * DAY; ts <= T - age(key); ts += 6 * H) if (ts >= since) out.push({ ts, ok: key === "api" && ts > T - 9 * DAY && ts < T - 8 * DAY ? 0 : 1, detail: key === "api" ? "health The operation was aborted" : null, url: null });
    out.push({ ts: T - age(key), ok: 1, detail: null });
    return out;
  };
  const store = {
    probeRows: rowsFor,
    probeCounts: (key, since) => { const r = rowsFor(key, since); return { observed: r.length, up: r.filter((x) => x.ok).length }; },
    latestByComponent: () => [...COMPONENTS, ...RAIL_COMPONENTS].map((c) => ({ component: c.key, ts: T - age(c.key), ok: 1, detail: null })),
    latestBySource: () => [{ source: HB, ts: T - 6.4 * H, ok: 1 }, { source: CF, ts: T - 4 * MIN, ok: 1 }],
    earliestObservation: () => T - 40 * DAY,
    totalObservations: () => 238000,
    statusPersistent: () => true,
  };
  const live = { gateway: "ok", upstreamBuyer: "ok", upstreamBuyerAvm: "ok", upstreamBuyerSvm: "low", upstreamBuyerTempo: "ok" };
  const snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: T, store, live });
  const html = statusPage("https://example.test", { recentCalls: [{ at: new Date(T - 3 * MIN).toISOString(), slug: "hash", paidWith: "usdc" }], onchainRevenueProof: "https://basescan.org/address/0xabc" }, snap);
  ok(snap.incidents.length > 0 && snap.railComponents.every((c) => c.observed > 0), "the fixture renders incidents and every rail observed");
  ok(/Not in the latest paid canary run/.test(html) && /Scheduled heartbeat: not current/.test(html), "the fixture renders a rail behind its peers and a quiet observer");
  const above = wordsBeforeFirstH2(html), total = mainProseWords(html);
  ok(above <= ABOVE_H2_MAX, `/status: ${above} prose words above the first h2 (at most ${ABOVE_H2_MAX})`);
  ok(total <= BODY_MAX, `/status: ${total} prose words in the body with detail closed (at most ${BODY_MAX})`);
  // Short does not mean missing: every status word and figure is still on it.
  for (const c of [...snap.components, ...snap.railComponents]) {
    ok(html.includes(`<span class="comp-n">${c.label}</span>`), `/status still shows ${c.label}`);
  }
  ok(/<details class="method">[\s\S]*Percentages carry their denominator[\s\S]*<\/details>/.test(html), "/status keeps every measurement rule, under a disclosure");
  ok(!/Percentages carry their denominator/.test(proseText(mainOf(html))), "control: the rules are optional detail, closed by default");
}

// ── /revenue ───────────────────────────────────────────────────────────────
{
  const { revenuePage } = await import("../src/revenue-live.js");
  const rails = ["Base", "Solana", "Polygon", "Arbitrum One", "Celo", "Stellar", "Algorand"].map((rail, i) => ({
    rail, asset: "USDC", balance: 1, explorer: `https://explorer.test/${i}`, scanNote: i === 1 ? "partial" : undefined,
    recent: [{ when: "2026-11-26T10:00:00Z", usd: 0.002, external: true }],
  }));
  const html = revenuePage("https://agent402.tools", {
    asOf: "2026-11-27T11:00:00.000Z",
    rails,
    allTime: {
      perChain: { base: { inboundCount: 900, externalCount: 300, externalUsd: 12.5, caughtUp: false, syncedAt: 1780000000 } },
      allTimeInboundCount: 114000, allTimeExternalCount: 52000, allTimeExternalUsd: 700,
      allTimeExternalAllCount: 52869, allTimeExternalAllUsd: 738.6, syncing: true,
      gatewayBatched: { count: 3, externalCount: 2, externalUsd: 0.03 },
    },
    agents: { buyers: 1047, scope: { since: "2026-06-15" }, top5SharePct: 47.2 },
    card: { allTimeCount: 4, allTimeUsd: 11 },
    standing: { sellers: 8292, listings: 308423, x402Rails: 14, tempo: true },
    mpp: { count: 12, rails: { tempo: { count: 10, external: 4, externalUsd: 1, lastAt: "2026-11-26T00:00:00Z", txs: [] }, stripe: { count: 2, external: 2, externalUsd: 1, lastAt: null, txs: [] } } },
    decide: { days: 30, allTime: { decide: { count: 5, external: 2, externalUsd: 0.2 }, "decide-execute": { count: 1, external: 0, externalUsd: 0 } }, window: {} },
    range: { window: { from: "2026-10-29", to: "2026-11-27", preset: "30d" }, firstDay: "2026-06-15", today: "2026-11-27", notice: "bad date", totals: { externalPayments: 18965, externalUsd: 185.73, settlements: 27085, buyers: 391 } },
    hashPriceUsd: 0.001,
  });
  ok(/distinct outside wallets have paid us on-chain/.test(html) && /Circle Gateway batched/.test(html) && /card checkout purchases/.test(html) && /ledger still backfilling/.test(html), "the fixture renders the hero's longest variant");
  const above = wordsBeforeFirstH2(html), total = mainProseWords(html);
  ok(above <= ABOVE_H2_MAX, `/revenue: ${above} prose words above the first h2 (at most ${ABOVE_H2_MAX})`);
  ok(total <= BODY_MAX, `/revenue: ${total} prose words in the body with detail closed (at most ${BODY_MAX})`);
  // The figures lead: the hero comes before any explanatory paragraph.
  const m = mainOf(html);
  ok(m.indexOf('id="rvExternal"') > 0 && m.indexOf('id="rvExternal"') < m.indexOf("floor, not a lifetime total"), "/revenue leads with the figures, the scope sentences follow them");
  ok(/read from the chain, plus card checkout purchases from our card processor/.test(html) && /floor, not a lifetime total/.test(html) && /THE MARKET WE INDEX/.test(html), "/revenue keeps its scope sentences and the standing band");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
