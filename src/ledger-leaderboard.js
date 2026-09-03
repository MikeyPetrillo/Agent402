// /leaderboard — the public on-chain x402 seller ranking (Aug 2026 revamp).
// Ranked by real Base USDC settled volume, never self-reported traffic.
// Agent402 is excluded from its own ranking (wallet-matched, the same
// mechanism /api/leaderboard's include=external uses) and disclosed
// separately in a dedicated "for comparison" block, so the neutral-index
// claim is checkable rather than asserted.
//
// The pre-revamp page rendered every row in the snapshot unconditionally -
// the same unbounded-roster shape found and fixed on /marketplace (PR #772,
// measured there at 1,125 rows / 56,000px on a single chain). This snapshot
// can hold hundreds of sellers, and /api/leaderboard itself already caps
// free JSON access at top 50 ("nobody choosing a seller needs rank 400" -
// the derived organic/avg-ticket signals are the paid trending product).
// Rendering an unbounded table here would both reproduce the roster bug and
// undercut that existing revenue boundary for free over HTML. Bounded to a
// curated top N instead, with real "raw JSON" and "browse every seller"
// escape hatches for the rest - matches the design's own top=12 live poll.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { rankBy } from "./leaderboard.js";
import { RAILS } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";
import { hostRowHtml, HOST_EXCLUSION_NOTE } from "./host-entry.js";

const HTML_ROWS = 12;

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtUsd = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortAddr = (a) =>
  typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || "-");

/** Only allow http(s) — seller-supplied homepage data, defense in depth. */
const safeHref = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

/** Top N rows, Agent402 excluded by wallet match (same mechanism as
 * /api/leaderboard's include=external), re-ranked after the filter so ranks
 * stay consecutive - no gap where our own row was removed. Adds avgTicket
 * and organic as computed display columns from the same three real fields
 * every row already carries; neither needs a new aggregation. */
function rankedRows(snapshot, walletAddress, limit = HTML_ROWS) {
  const board = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
  const self = (walletAddress || "").toLowerCase();
  const filtered = self ? board.filter((r) => (r.wallet || "").toLowerCase() !== self) : board;
  const ranked = rankBy(filtered, "usd").slice(0, limit);
  return ranked.map((r) => {
    const calls = Number(r.callsSettled) || 0;
    const buyers = Number(r.uniqueBuyers) || 0;
    const total = Number(r.totalUsd) || 0;
    // Buyers per 100 calls - the cheapest read on whether volume came from
    // many wallets or a couple paying themselves. Shown, not folded into a
    // score, per the design's own reasoning: a thousand calls from two
    // wallets should read differently from a thousand from four hundred,
    // and averaging that into one number would hide exactly the thing this
    // column exists to surface.
    const organicRaw = calls ? (buyers / calls) * 100 : 0;
    return {
      rank: String(r.rank ?? "").padStart(2, "0"),
      name: r.name,
      href: safeHref(r.homepage),
      wallet: (Array.isArray(r.wallets) && r.wallets[0]) || r.wallet || "",
      usd: fmtUsd(total),
      calls: fmtNum(calls),
      buyers: fmtNum(buyers),
      avg: calls ? `$${(total / calls).toFixed(4)}` : "·",
      organic: calls ? (organicRaw < 0.01 ? "<0.01" : organicRaw.toFixed(2)) : "·",
      organicBright: organicRaw >= 1,
    };
  });
}

/** How many of the twelve settlement rails carry any recorded volume yet -
 * same CAIP2_NAMES join as the homepage/what-is-x402 rails tables, but only
 * the count is needed here (the "Agent402, for comparison" block cites it
 * as one line, not a full per-rail grid - that grid already lives on the
 * homepage and would just duplicate it here). */
function railsWithTraffic(stats) {
  const byNet = stats?.toolCallsServed?.viaUSDCByNetwork || {};
  const n = RAILS.filter((r) => Number(byNet[CAIP2_NAMES[r.caip2] || r.name.toLowerCase()]) > 0).length;
  return `${n} of ${RAILS.length}`;
}

export function ledgerLeaderboardPage(baseUrl, snapshot, { stats, walletAddress, host = null } = {}) {
  const board = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
  const hasData = board.length > 0;
  const windowLabel = snapshot?.windowLabel || "24h";
  const scannedSellers = snapshot?.scannedSellers ?? 0;

  // Honesty flag from the scan pipeline (src/leaderboard.js#runLeaderboard):
  // a subset of block-range chunks failed, so this snapshot under-covers the
  // window rather than fully covering it. Never hide this - it's the
  // difference between "no revenue" and "revenue we couldn't see".
  const partialNote = snapshot?.partial
    ? `Partial scan - ${snapshot.windowNote || "some block ranges were unavailable"}; totals are a floor, not the full window.`
    : "";

  const rows = rankedRows(snapshot, walletAddress);

  const served = stats?.toolCallsServed || {};
  const selfPaid = fmtNum(served.viaUSDC);
  const selfPow = fmtNum(served.viaProofOfWork);
  const selfMpp = fmtNum(served.viaMPPWire);
  const selfRails = railsWithTraffic(stats);

  const meta = [
    ["sellers ranked", fmtNum(scannedSellers)],
    ["wallets queried", fmtNum(snapshot?.walletsQueried)],
    ["bazaar listings", fmtNum(snapshot?.bazaarTotal)],
    ["blocks scanned", fmtNum(snapshot?.scannedBlocks)],
    ["window", windowLabel],
    ["per-call ceiling", fmtUsd(snapshot?.maxCallUsd)],
  ];

  const steps = [
    "Discover sellers from the Coinbase CDP Bazaar plus our own crawl, refreshed hourly.",
    "Read each seller's advertised payTo addresses out of its x402 manifest.",
    "Pull settlement transfers to those addresses from Base event logs with eth_getLogs.",
    `Apply a per-call USD ceiling (${fmtUsd(snapshot?.maxCallUsd)}), so ordinary treasury movements are not counted as tool calls.`,
    "Aggregate by payTo, group wallets belonging to one seller, and rank.",
  ];

  const faqs = [
    {
      q: "How is the x402 leaderboard calculated?",
      a: "Sellers are discovered from the Coinbase CDP Bazaar plus Agent402's own crawl, their payTo addresses are read from their x402 manifests, and settlement transfers to those addresses are aggregated from Base event logs via eth_getLogs. A per-call USD ceiling excludes transfers too large to be a single tool call, so ordinary treasury movements do not inflate a seller. The snapshot refreshes hourly and the raw JSON is free at /api/leaderboard.",
    },
    {
      q: "Why is Agent402 excluded from its own leaderboard?",
      a: "The table above excludes our own wallet, the same filter /api/leaderboard applies with include=external. An index that ranks itself first is not evidence of anything, so the neutral view excludes the operator by default and our own figure is published separately, from the same public endpoint.",
    },
    {
      q: "Can the leaderboard be gamed by self-dealing?",
      a: "Volume alone, yes - paying yourself inflates totalUsd for free. That is exactly why each row also carries unique buyers and an organic ratio of buyers to calls. A seller with thousands of calls from two wallets reads very differently from one with hundreds of calls from hundreds of wallets, and both are visible here rather than averaged away.",
    },
  ];

  // --- Ranked table rows -----------------------------------------------------

  const tableRows = rows
    .map((r) => {
      const nameHtml = r.href
        ? `<a href="${esc(r.href)}" target="_blank" rel="noopener nofollow" class="lb-name">${esc(r.name)}</a>`
        : esc(r.name);
      return `<div class="lb-row${r.rank === "01" ? " first" : ""}"><span class="lb-rank">${esc(r.rank)}</span><span>${nameHtml} <span class="lb-addr">· ${esc(shortAddr(r.wallet))}</span></span><span class="lb-usd">${esc(r.usd)}</span><span class="lb-num">${esc(r.calls)}</span><span class="lb-buyers">${esc(r.buyers)}</span><span class="lb-avg">${esc(r.avg)}</span><span class="lb-organic" style="color:${r.organicBright ? "var(--on-dark)" : "var(--dk-muted3)"};">${esc(r.organic)}</span></div>`;
    })
    .join("\n      ");

  const warmingHtml = `<div style="padding:40px 20px;text-align:center;color:var(--dk-muted3);font-family:var(--font-mono);font-size:13px;">Warming up - first snapshot in progress. Refresh in a few seconds.</div>`;

  const metaRowsHtml = meta
    .map(([label, value]) => `<tr style="border-bottom:1px solid var(--dark-border);"><th scope="row" style="text-align:left;font-weight:400;padding:10px 18px;color:var(--dk-muted3);">${esc(label)}</th><td style="padding:10px 18px;text-align:right;color:var(--on-dark);">${esc(value)}</td></tr>`)
    .join("");

  const stepsHtml = steps
    .map((s, i) => `<div style="display:grid;grid-template-columns:26px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${String(i + 1).padStart(2, "0")}</span><span style="font-size:14px;line-height:1.55;color:var(--muted);">${esc(s)}</span></div>`)
    .join("");

  const faqHtml = faqs
    .map((f) => `<article style="padding:24px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:18px;margin:0 0 10px;color:var(--ink);">${esc(f.q)}</h3><p style="font-size:15.5px;line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`)
    .join("");

  // --- Page body ---------------------------------------------------------------

  const body = `
  <header style="border-bottom:1px solid var(--hairline);">
    <div style="max-width:1180px;margin:0 auto;padding:48px 30px 40px;">
      <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">leaderboard</span></nav>
      <div class="lb-2col" style="display:grid;grid-template-columns:1.15fr .85fr;gap:50px;align-items:start;">
        <div>
          <h1 class="lb-h1" style="font-weight:800;font-size:60px;line-height:.95;letter-spacing:-.035em;margin:0 0 22px;color:var(--ink);">Who is actually<br>settling <span style="color:var(--accent);">x402</span>?</h1>
          <p style="font-size:18px;line-height:1.5;color:var(--muted);margin:0 0 18px;">Every x402 seller we can crawl, ranked by <strong style="color:var(--ink);font-weight:700;">real Base USDC settled on chain</strong> - not self-reported traffic, not a press release. Read from event logs, refreshed hourly, and free to query.</p>
          <p style="font-size:15.5px;line-height:1.6;color:var(--faint);margin:0 0 24px;">Agent402 is excluded from this ranking by default. An index that puts itself first is not evidence of anything, so our own figure is published separately below.</p>
          ${partialNote ? `<p style="font-size:13px;font-family:var(--font-mono);color:var(--accent);max-width:620px;margin:0 0 20px;">${esc(partialNote)}</p>` : ""}
          <div style="display:flex;flex-wrap:wrap;gap:11px;">
            <a class="ml-cta" href="/api/leaderboard?include=external" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13.5px;text-decoration:none;padding:12px 18px;">GET /api/leaderboard</a>
            <a class="ml-cta" href="/marketplace" style="background:transparent;border:1.5px solid var(--dash);color:var(--muted);font-family:var(--font-mono);font-weight:700;font-size:13.5px;text-decoration:none;padding:12px 18px;">Browse every seller</a>
          </div>
        </div>
        <div style="border:1px solid var(--hairline);background:var(--surface);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">
            <span>SNAPSHOT</span>
            <span style="display:inline-flex;align-items:center;gap:6px;color:var(--accent-lit);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent-lit);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>HOURLY</span>
          </div>
          <table style="font-family:var(--font-mono);font-size:12.5px;"><tbody>${metaRowsHtml}</tbody></table>
        </div>
      </div>
    </div>
  </header>

  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:16px;">
      <h2 class="lb-h2" style="font-weight:800;font-size:40px;line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Ranked by USDC settled.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">${esc(windowLabel)} window · top ${rows.length} of ${fmtNum(scannedSellers)} · include=external</span>
    </div>
    <p style="font-size:16px;line-height:1.6;color:var(--muted);max-width:760px;margin:0 0 26px;">Volume alone can be manufactured by paying yourself, so every row also carries distinct paying wallets and an organic ratio of buyers to calls. A thousand calls from two wallets reads very differently from a thousand from four hundred.</p>
    <div class="lb-scroll" style="border:1px solid var(--hairline);background:var(--surface);overflow-x:auto;">
      <div class="lb-head" style="display:grid;grid-template-columns:36px 1fr 100px 80px 64px 78px 64px;gap:12px;padding:12px 18px;min-width:820px;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dk-muted3);border-bottom:1.5px solid var(--dark-border2);"><span>#</span><span>seller · payTo</span><span style="text-align:right;">usdc settled</span><span style="text-align:right;">calls</span><span style="text-align:right;">buyers</span><span style="text-align:right;">avg ticket</span><span style="text-align:right;">organic</span></div>
      <div style="min-width:820px;">${hasData ? tableRows : warmingHtml}</div>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:14px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <span>organic = distinct buyers per 100 calls. higher means demand is spread across more wallets.</span>
      <a href="/api/leaderboard?include=external" style="color:var(--accent);text-decoration:none;">raw JSON →</a>
    </div>
    ${hostRowHtml(host, { dark: false })}
  </section>

  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div class="lb-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
      <div style="padding:28px;border-right:1px solid var(--hairline);background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">OUR OWN ROW, DISCLOSED</div>
        <h2 style="font-weight:800;font-size:24px;margin:0 0 14px;color:var(--ink);">Agent402, for comparison</h2>
        <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;">We run the index, so we keep ourselves out of the ranking above. Here is the same figure for us, from the same public endpoint. It counts paid calls in stablecoin only, excluding free proof-of-work calls and our own monitoring probes.</p>
        <table style="font-family:var(--font-mono);font-size:13px;border:1px solid var(--hairline);"><tbody>
          <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">calls paid in stablecoin</th><td style="padding:11px 14px;text-align:right;color:var(--ink);">${esc(selfPaid)}</td></tr>
          <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">free over proof-of-work</th><td style="padding:11px 14px;text-align:right;color:var(--ink);">${esc(selfPow)}</td></tr>
          <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">rails with settled traffic</th><td style="padding:11px 14px;text-align:right;color:var(--ink);">${esc(selfRails)}</td></tr>
          ${host ? `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">settlements from outside buyers, 30 days</th><td style="padding:11px 14px;text-align:right;color:var(--accent);" data-host-ext-30d>${esc(fmtNum(host.external30d.settlements))}</td></tr>
          <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">distinct outside buyers, 30 days</th><td style="padding:11px 14px;text-align:right;color:var(--accent);" data-host-buyers-30d>${esc(fmtNum(host.external30d.buyers))}</td></tr>
          <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">settlements from outside buyers, all time</th><td style="padding:11px 14px;text-align:right;color:var(--accent);" data-host-ext-all>${esc(fmtNum(host.externalAllTime.settlements))}</td></tr>` : ""}
          <tr><th scope="row" style="text-align:left;font-weight:400;padding:11px 14px;color:var(--faint);">settled over the MPP wire</th><td style="padding:11px 14px;text-align:right;color:var(--accent);">${esc(selfMpp)}</td></tr>
        </tbody></table>
        ${host ? `<p style="font-family:var(--font-mono);font-size:11.5px;line-height:1.6;color:var(--faint);margin:14px 0 0;">${esc(HOST_EXCLUSION_NOTE)}</p>` : ""}
        <p style="font-family:var(--font-mono);font-size:11.5px;line-height:1.6;color:var(--faint);margin:14px 0 0;">Most sellers here settle on Base alone. Twelve rails is the difference, and it is checkable on chain.</p>
      </div>
      <div style="padding:28px;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">METHOD</div>
        <h2 style="font-weight:800;font-size:24px;margin:0 0 14px;color:var(--ink);">How the number is built</h2>
        <div style="display:flex;flex-direction:column;gap:0;">${stepsHtml}</div>
        <p style="font-size:13.5px;line-height:1.6;color:var(--faint);margin:16px 0 0;">What this cannot see: settlements on chains other than Base, payments to addresses a seller never advertised, and which specific tool was bought. Those are limits of on-chain data, not of the crawler.</p>
      </div>
    </div>
  </section>

  <section style="max-width:900px;margin:0 auto;padding:56px 30px 0;">
    <h2 class="lb-h2" style="font-weight:800;font-size:36px;line-height:1.02;letter-spacing:-.025em;margin:0 0 26px;color:var(--ink);">Questions about this table.</h2>
    <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
  </section>

  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="background:var(--surface);border:1px solid var(--hairline);padding:48px 44px;position:relative;overflow:hidden;">
      <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
      <div style="position:relative;">
        <h2 class="lb-h2" style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-dark);">Want a row here?</h2>
        <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 26px;max-width:540px;">Serve x402 challenges, register your origin, and the crawler picks you up on the next pass. Free, no signup, nothing deducted from your price.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a class="ml-cta" href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">List your API - free →</a>
          <a class="ml-cta" href="/what-is-x402" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">WHAT IS x402?</a>
        </div>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}`;

  const canonical = `${baseUrl}/leaderboard`;
  const title = "x402 seller leaderboard - ranked by real on-chain USDC settled";
  const description =
    "The public on-chain ranking of every x402 seller by Base USDC settled volume: calls settled, total USD and unique buyers per seller. Hourly snapshot, built from the Coinbase CDP Bazaar and eth_getLogs. Agent402 excluded from its own ranking.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ["https://github.com/MikeyPetrillo/Agent402", "https://x.com/Agent402Tools"] };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Leaderboard", item: canonical },
  ] };
  const datasetLd = { "@type": "Dataset", "@id": `${canonical}#dataset`, name: "x402 seller leaderboard - Base USDC settled volume", description: "Hourly on-chain snapshot ranking every indexed x402 seller by Base USDC settled volume: calls settled, total USD and unique buyers per seller. Pipeline: Coinbase CDP Bazaar discovery, eth_getLogs over recent blocks, a per-call USD ceiling to exclude non-payment transfers, then aggregation by payTo address. Agent402 is excluded from the default view.", creator: { "@id": `${baseUrl}/#organization` }, license: "https://www.gnu.org/licenses/agpl-3.0.html", isAccessibleForFree: true, temporalCoverage: "P7D", measurementTechnique: "On-chain event log aggregation by recipient address", variableMeasured: [
    { "@type": "PropertyValue", name: "totalUsd", description: "USDC settled to the seller's payTo addresses in the window" },
    { "@type": "PropertyValue", name: "callsSettled", description: "Count of settlement transfers observed" },
    { "@type": "PropertyValue", name: "uniqueBuyers", description: "Distinct paying wallets" },
  ], distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${baseUrl}/api/leaderboard` } };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
.lb-row{display:grid;grid-template-columns:36px 1fr 100px 80px 64px 78px 64px;gap:12px;padding:13px 18px;color:var(--on-dark);border-bottom:1px solid var(--dark-border);min-width:820px}
.lb-row:last-child{border-bottom:none}
.lb-row.first{background:linear-gradient(90deg,color-mix(in srgb, var(--accent) 13%, transparent),transparent)}
.lb-rank{color:var(--dk-muted3);font-weight:700}
.lb-row.first .lb-rank{color:var(--accent)}
.lb-name{color:var(--on-dark);text-decoration:none;border-bottom:1px solid transparent}
.lb-addr{color:var(--dk-muted3)}
.lb-usd{text-align:right;color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}
.lb-num{text-align:right;font-variant-numeric:tabular-nums}
.lb-buyers{text-align:right;color:var(--dk-muted2);font-variant-numeric:tabular-nums}
.lb-avg{text-align:right;color:var(--dk-muted3);font-variant-numeric:tabular-nums}
.lb-organic{text-align:right;font-variant-numeric:tabular-nums}
@media (max-width: 900px) {
  .lb-2col { grid-template-columns: minmax(0,1fr) !important; }
}
@media (max-width: 600px) {
  .lb-h1 { font-size: 40px !important; }
  .lb-h2 { font-size: 29px !important; }
}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/leaderboard",
    jsonLd: [orgLd, breadcrumbLd, datasetLd, faqLd],
    extraCss,
    body,
  });
}
