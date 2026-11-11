// Buyer scorecard: GET /api/scorecard and /scorecard.
//
// Per UTC calendar month (the current month to date and the six before it):
// outside paying wallets, how many of them paid in an earlier month too or on
// two or more days of the month, settled paid calls and USD by network. Every
// figure comes from the sales ledger (buyerScorecardAsync in
// src/sales-ledger.js), which leaves out our own traffic: the heartbeat token
// (canary, probes, CI), every wallet of ours by address (burners, the canary,
// the spending wallets route-execute buys with), free proof-of-work calls and
// calls with no recorded paying wallet.
//
// Aggregates only. No wallet address, no per-wallet figure. A count from 1 to
// 2 reads "<3", and a month with fewer than 3 paying wallets publishes its
// wallet bucket and nothing else, because its totals would be one or two
// wallets' own. Networks with fewer than 3 wallets are folded into "other"
// by the ledger read. Sample settlement transactions (explorer links) are
// listed only when SCORECARD_PUBLISH_TX=on, and always in the operator view:
// an outside buyer's transaction resolves to its payer on chain.
//
// Computed off the request path: shortly after boot and every
// SCORECARD_REFRESH_MS (default 900000), a paged ledger read spread over
// event-loop turns. A read before the first computation waits for it (one
// computation in flight at a time).
import { explorerTxUrl, chainOf, lookupKeys } from "./refund-lookup.js";
import { partialFields } from "./partial-answer.js";
import { ledgerShell, ledgerFooterCompact, esc, fmtNum, breadcrumbTrail } from "./ledger-chrome.js";

export const SCORECARD_MONTHS = 7;
export const SCORECARD_MIN_GROUP = 3;
export const SCORECARD_SAMPLES = 3;
export const SMALL = "<3";

export function scorecardRefreshMs(env = process.env) {
  const n = Number(env.SCORECARD_REFRESH_MS);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 900_000;
}
export function scorecardPublishesTx(env = process.env) {
  return String(env.SCORECARD_PUBLISH_TX || "").toLowerCase() === "on";
}

/** The network a row counts under: the chain's friendly name (one row per chain, whatever spelling the ledger recorded). */
export function scorecardNetworkKey(network) {
  return chainOf(network) || String(network || "unknown");
}

/** A transaction the scorecard may link: hash-shaped and on a network an explorer reads. */
export function sampleOk(network, tx) {
  return Boolean(lookupKeys(tx)) && Boolean(explorerTxUrl(network, tx));
}

const bucket = (n) => (n === 0 ? 0 : n < SCORECARD_MIN_GROUP ? SMALL : n);
const share = (num, den) => (typeof num === "number" && typeof den === "number" && den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
const usd2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const METHOD = Object.freeze({
  source: "The sales ledger: one row per settled paid call, written after the call answered 200 and its payment settled.",
  counted: "Outside paid calls on a paying rail with a recorded paying wallet (x402 on every chain, MPP).",
  excluded: [
    "our own traffic: the signed heartbeat token (canary, probes, CI)",
    "every wallet of ours, by address: burners, the canary and the spending wallets the router buys with",
    "free proof-of-work and trial calls",
    "card and prepaid-credit calls (no paying wallet)",
  ],
  month: "UTC calendar month; the current month runs to asOf.",
  wallets: "Distinct paying wallets in the month.",
  returningWallets: "Wallets in the month that also paid in any earlier month.",
  multiDayWallets: "Wallets in the month with paid calls on 2 or more distinct UTC days.",
  settledCalls: "Paid calls settled in the month.",
  usd: "USD settled in the month, at the price paid on the settling chain.",
  networks: "Calls and USD by settlement network; a network with fewer than 3 wallets in the month is folded into other.",
  smallCounts: "A count of 1 or 2 reads \"<3\". A month with fewer than 3 paying wallets publishes that and nothing else.",
  proof: "settlementsWithTx counts the month's calls that carry a settlement transaction. Sample settlements are the month's first by ledger id on a network an explorer reads, the same pick on every read.",
});

/** The public (or operator) JSON body from one ledger read. Pure. */
export function scorecardBody(raw, { asOf = new Date().toISOString(), refreshMs = scorecardRefreshMs(), publishTx = scorecardPublishesTx(), firstRecordedAt = null } = {}) {
  const months = (raw?.months || []).map((m, i, all) => {
    const monthToDate = i === all.length - 1;
    const from = `${m.month}-01T00:00:00.000Z`;
    const to = monthToDate ? asOf : new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 1)).toISOString();
    const base = { month: m.month, monthToDate, from, to };
    if (m.wallets > 0 && m.wallets < SCORECARD_MIN_GROUP) {
      return { ...base, wallets: SMALL, withheld: true, withheldReason: "fewer than 3 paying wallets", returningWallets: null, returningShare: null, multiDayWallets: null, multiDayShare: null, settledCalls: null, usd: null, networks: [], proof: null };
    }
    const wallets = m.wallets;
    const returning = bucket(m.returningWallets);
    const multi = bucket(m.multiDayWallets);
    const samples = publishTx ? (m.samples || []).filter((s) => sampleOk(s.network, s.tx)).map((s) => ({ network: s.network, chain: chainOf(s.network), tx: s.tx, url: explorerTxUrl(s.network, s.tx) })) : [];
    return {
      ...base,
      wallets,
      withheld: false,
      returningWallets: returning,
      returningShare: share(returning, wallets),
      multiDayWallets: multi,
      multiDayShare: share(multi, wallets),
      settledCalls: m.calls,
      usd: usd2(m.usd),
      networks: (m.networks || []).map((n) => ({ network: n.network, ...(n.networks ? { includes: n.networks } : {}), wallets: bucket(n.wallets), settledCalls: n.calls, usd: usd2(n.usd) })),
      proof: {
        published: publishTx,
        ...(publishTx ? {} : { withheldReason: "an outside buyer's transaction resolves to its payer on chain" }),
        settlementsWithTx: m.settlementsWithTx || 0,
        samples,
        ...partialFields(m.settlementsWithTx || 0, samples.length),
      },
    };
  });
  return {
    name: "Agent402 buyer scorecard",
    asOf,
    refreshesEverySeconds: Math.round(refreshMs / 1000),
    firstRecordedAt,
    months,
    ...partialFields(months.length, months.length),
    method: METHOD,
    verify: { transactions: "/revenue", receipts: "/proof", status: "/status" },
  };
}

/**
 * The refresh loop and its cache. `compute()` resolves the ledger read;
 * `get()` answers the cached body (waiting for the first computation).
 */
export function createScorecard({ compute, env = process.env, now = () => Date.now(), log = console } = {}) {
  let cached = null, inFlight = null, timer = null, warned = 0, lastMs = null;
  const refresh = () => {
    if (inFlight) return inFlight;
    const started = performance.now();
    inFlight = Promise.resolve().then(compute).then((v) => {
      cached = { value: v, at: now() };
      lastMs = performance.now() - started;
      return cached;
    }).catch((e) => {
      const t = now();
      if (t - warned > 3_600_000) { warned = t; try { log.warn(`[scorecard] read failed (${String(e?.message || e).slice(0, 120)}); keeping the last figures`); } catch { /* logging only */ } }
      if (!cached) throw e;
      return cached;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    refresh,
    async get() { return cached || refresh(); },
    lastComputeMs: () => lastMs,
    start({ firstMs = 15_000 } = {}) {
      if (timer) return;
      const first = setTimeout(() => {
        void refresh().catch(() => {});
        timer = setInterval(() => { void refresh().catch(() => {}); }, scorecardRefreshMs(env));
        timer.unref?.();
      }, Math.max(0, firstMs));
      first.unref?.();
      timer = first;
    },
  };
}

const cell = (v) => (v === null || v === undefined ? "n/a" : typeof v === "number" ? fmtNum(v) : String(v));
const pctCell = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
const usdCell = (v) => (v === null || v === undefined ? "n/a" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function monthRowHtml(m) {
  const label = `${esc(monthName(m.month))}${m.monthToDate ? ` <span style="color:var(--faint);">to date</span>` : ""}`;
  return `<tr>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);white-space:nowrap;">${label}</td>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">${esc(cell(m.wallets))}</td>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">${esc(cell(m.returningWallets))}${m.returningShare != null ? ` <span style="color:var(--faint);">${esc(pctCell(m.returningShare))}</span>` : ""}</td>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">${esc(cell(m.multiDayWallets))}${m.multiDayShare != null ? ` <span style="color:var(--faint);">${esc(pctCell(m.multiDayShare))}</span>` : ""}</td>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">${esc(cell(m.settledCalls))}</td>
    <td style="padding:10px 12px;border-top:1px solid var(--hairline);text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">${esc(usdCell(m.usd))}</td>
  </tr>`;
}

function monthDetailHtml(m) {
  if (m.withheld) return `<p style="margin:0;color:var(--muted);font-size:var(--fs-base);">${esc(monthName(m.month))}: fewer than 3 paying wallets, so only that is published.</p>`;
  if (!m.wallets) return `<p style="margin:0;color:var(--muted);font-size:var(--fs-base);">${esc(monthName(m.month))}: no outside paid calls recorded.</p>`;
  const nets = m.networks.map((n) => `<span>${esc(n.network)}${n.includes ? ` (${esc(n.includes.join(", "))})` : ""}: ${esc(cell(n.settledCalls))} calls, ${esc(usdCell(n.usd))}, ${esc(cell(n.wallets))} wallets</span>`).join("");
  const proof = m.proof?.samples?.length
    ? m.proof.samples.map((s) => `<a href="${esc(s.url)}" rel="noopener" style="color:var(--ink);word-break:break-all;">${esc(s.chain || s.network)} ${esc(s.tx.slice(0, 10))}...${esc(s.tx.slice(-6))}</a>`).join("")
    : "";
  return `<div style="background:var(--card);border:1px solid var(--hairline);border-radius:var(--radius);padding:18px 22px;">
    <h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 10px;color:var(--ink);">${esc(monthName(m.month))}${m.monthToDate ? " to date" : ""}</h3>
    <p class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);margin:0;">${nets}</p>
    ${proof ? `<p class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-sm);margin:10px 0 0;">${proof}</p>` : ""}
  </div>`;
}

export function scorecardPage(baseUrl, body) {
  const canonical = `${baseUrl}/scorecard`;
  const title = "Buyer scorecard: paying wallets by month";
  const description = "Outside paying wallets, repeat buyers, settled paid calls and USD by network, per UTC month, from our sales ledger. Our own wallets and test traffic are left out.";
  const months = [...(body?.months || [])].reverse();
  const asOf = body?.asOf ? `${body.asOf.slice(0, 16).replace("T", " ")} UTC` : "n/a";
  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], ["Buyer scorecard", "/scorecard"]], { style: "margin-bottom:22px;" });
  const page = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    ${crumbs.nav}
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 20px;color:var(--ink);max-width:900px;text-wrap:balance;">Who pays, month by month.</h1>
    <p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0;">Outside paying wallets per UTC month, how many came back, and what they settled, read from our sales ledger. Our own wallets, canary and test traffic are left out. Counts of 1 or 2 read &lt;3. Machine-readable: <a href="/api/scorecard" style="color:var(--ink);">/api/scorecard</a>.</p>
  </div>
</header>
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:var(--fs-md);color:var(--ink);">
      <thead><tr style="font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.12em;color:var(--faint);">
        <th style="text-align:left;padding:8px 12px;font-weight:400;">month</th>
        <th style="text-align:right;padding:8px 12px;font-weight:400;">wallets</th>
        <th style="text-align:right;padding:8px 12px;font-weight:400;">returning</th>
        <th style="text-align:right;padding:8px 12px;font-weight:400;">2+ days</th>
        <th style="text-align:right;padding:8px 12px;font-weight:400;">calls</th>
        <th style="text-align:right;padding:8px 12px;font-weight:400;">usd</th>
      </tr></thead>
      <tbody>${months.map(monthRowHtml).join("")}</tbody>
    </table>
  </div>
  <p class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:14px 0 0;"><span>as of ${esc(asOf)}</span><span>refreshes every ${esc(String(Math.round((body?.refreshesEverySeconds || 0) / 60)))} min</span></p>
</section>
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 56px;display:grid;gap:14px;">
  <h2 style="font-weight:700;font-size:var(--fs-2xl);margin:0 0 4px;color:var(--ink);">By network</h2>
  ${months.map(monthDetailHtml).join("")}
  <p class="ml-measure" style="font-size:var(--fs-md);line-height:1.6;color:var(--muted);margin:10px 0 0;">Returning wallets also paid in an earlier month; 2+ days counts wallets with paid calls on two or more days of the month. Every settlement is checkable on chain: our receiving wallets and transactions by rail are on <a href="/revenue" style="color:var(--ink);">/revenue</a>, metered receipts on <a href="/proof" style="color:var(--ink);">/proof</a>.</p>
</section>
${ledgerFooterCompact()}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/scorecard", body: page, jsonLd: [crumbs.ld] });
}
