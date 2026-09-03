// Public status page (/status) and its JSON twin (/api/status).
//
// WHAT CHANGED AND WHY (2026-07-25)
//   The first version of this page rendered a hardcoded "All systems
//   operational" pill: literally a static string, green whether or not anything
//   worked. Its headline "uptime" was `process.uptime()`, which resets to zero
//   on every deploy, so a healthy service that shipped twice looked worse than a
//   broken one that never did. Both are the failure mode a status page exists to
//   prevent, so both are gone.
//
// THE PREMISE NOW
//   This page is served by the very system it reports on, so it cannot witness
//   its own outage. Every availability figure therefore comes from an observer
//   OUTSIDE the server — the heartbeat workflow on GitHub Actions, probing
//   production every 15 minutes and posting what it saw — and each figure links
//   back to the run that produced it. Numbers that ARE self-reported (the live
//   checks) are grouped separately and labelled as such.
//
//   Three rules keep it from flattering us:
//     1. A day we did not observe renders as "no data", never as uptime.
//     2. A component whose newest observation is stale is "unknown", not
//        "operational" — silence is not health.
//     3. Percentages always carry their observation count, because 100% of
//        three probes and 100% of three thousand are different claims.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import {
  probeRows, latestByComponent, earliestObservation, totalObservations, statusPersistent,
  uptimeFrom, dailyFrom, incidentsFrom, stateFrom,
} from "./status-store.js";
import { RAILS } from "./rails.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";
const HEARTBEAT_RUNS = `${REPO}/actions/workflows/heartbeat.yml`;
const CANARY_RUNS = `${REPO}/actions/workflows/paid-canary.yml`;
const DAY = 86400000;

// Components we know how to describe. The store decides which actually have
// data; a known component with no observations is shown as "not yet measured"
// rather than omitted, so a check that was supposed to run and isn't stays
// visible instead of silently vanishing.
// `staleAfterMs` must track the cadence of whatever observes the component, not
// a single global number. The heartbeat probes every 15 minutes, so 45 minutes
// means "we missed two in a row". The paid canary runs ONCE A DAY, so the same
// 45-minute rule would leave settlement reading "unknown" for 23 hours out of
// every 24 and drag the whole page to "degraded" — a threshold mismatch
// masquerading as an incident.
const QUARTER_HOURLY = 45 * 60_000; // ~3 missed observations at the 5-15 min cadence
// paid-call is the one component NO independent observer covers. The Cloudflare
// cron probe (workers/status-probe) deliberately skips it: solving the 16-bit
// PoW needs POW_SECRET on a second platform, and without that token every probe
// would be counted as genuine external free-tier demand and corrupt the
// free-tier series on /revenue. So its only observer is the GitHub heartbeat,
// whose real delivery cadence is ~hourly (measured 2026-07-27: 60-72 min).
// Sizing it at 45 min would report "unknown" on a healthy paid path every time
// GitHub is merely late, and drag the whole page to "degraded" with it.
const HOURLY_OBSERVER = 3 * 3600_000; // ~3 missed hourly heartbeat runs
const DAILY = 26 * 3600_000; // a day plus slack for a late scheduled run

// Per-rail components (rail_base, rail_stellar, ...), derived from RAILS
// (src/rails.js's single source of truth for chain names) so this can never
// silently drift from what's actually advertised - a new rail added there
// gets a status row here for free. "Robinhood Chain" -> "robinhood" matches
// the key the paid canary's rail legs already use for that chain (see
// scripts/paid-canary.js). Observations arrive once per canary run (up to
// 3x/day via its cron), so DAILY is the right staleness bound, same as the
// existing "settlement" component below.
export const RAIL_COMPONENTS = [
  ...RAILS.map((r) => ({
    key: `rail_${r.name.toLowerCase().replace(/\s+chain$/, "")}`,
    label: r.name,
    blurb: `Real ${r.asset} settlement on ${r.name}, proven daily by the paid canary.`,
    staleAfterMs: DAILY,
  })),
  // Tempo is NOT in RAILS (it settles over its own native MPP relay, never
  // @x402/express — see src/mpp-tempo.js), so it can't derive from the map
  // above. Added by hand, same shape/cadence as every other rail row, keyed
  // to match the paid canary's "rail_" + noteRail("mpp-tempo", ...) prefix
  // exactly (scripts/paid-canary.js) so its daily observation actually
  // lands here instead of being posted and silently going nowhere.
  {
    key: "rail_mpp-tempo",
    label: "Tempo (native MPP)",
    blurb: "Real PathUSD settlement over Tempo's own MPP relay, proven daily by the paid canary.",
    staleAfterMs: DAILY,
  },
  // Not a chain: the catalog's paid UPSTREAM (blockscout-kit pays Blockscout
  // from our spending wallet). Its canary leg failed a third of the time in
  // 2026-08 and paged nobody, because a tool leg is a warning: the buyer is
  // never charged on a 5xx. The consecutive-failure rule in the canary reads
  // this row's recent observations, so the row is what makes it pageable.
  {
    key: "rail_supply-chain",
    label: "Blockscout upstream (paid)",
    blurb: "address-profile buying its Blockscout upstream from the spending wallet, proven daily by the paid canary.",
    staleAfterMs: DAILY,
  },
];

export const COMPONENTS = [
  { key: "api", label: "Tool serving", blurb: "The paid API answering requests: /health reachable and the catalog mounted.", staleAfterMs: QUARTER_HOURLY },
  { key: "catalog", label: "Catalog", blurb: "Every tool route mounted and advertised on /api/pricing.", staleAfterMs: QUARTER_HOURLY },
  { key: "paid-call", label: "Paid call path", blurb: "A real end-to-end purchase from our own wallet: challenge, payment, unlock, payload. A miss here means our canary could not buy, never that a customer was charged.", staleAfterMs: HOURLY_OBSERVER },
  { key: "mcp", label: "MCP connector", blurb: "The hosted /mcp endpoint agents connect through.", staleAfterMs: QUARTER_HOURLY },
  { key: "paywall", label: "Paywall engaged", blurb: "Paid tools still answer 402 when unpaid, so nothing is given away by accident.", staleAfterMs: QUARTER_HOURLY },
  { key: "rails", label: "Payment rails", blurb: "The chains advertised in a live 402 challenge.", staleAfterMs: QUARTER_HOURLY },
  { key: "settlement", label: "Settlement (paid canary)", blurb: "A daily purchase paying real USDC across every supported chain.", staleAfterMs: DAILY },
];

const WINDOWS = [
  { key: "24h", label: "24 hours", ms: DAY },
  { key: "7d", label: "7 days", ms: 7 * DAY },
  { key: "30d", label: "30 days", ms: 30 * DAY },
  { key: "90d", label: "90 days", ms: 90 * DAY },
];

/** Core serving components — only these can force overall "outage".
 *  Settlement / rails outages alone roll up to "degraded" so a single failed
 *  canary rail cannot paint the public page as Active outage while the API
 *  and paywall are fine (2026-08-10 Stellar false alarm). */
export const CORE_STATUS_KEYS = Object.freeze(["api", "catalog", "mcp", "paywall", "paid-call"]);

/** Worst state wins among what we have measured, with core-scoped outage.
 *  Components we have never measured cannot vote. `railComponents` (per-chain,
 *  e.g. rail_monad) can only ever pull the result down to "degraded" — same as
 *  a non-core component — never to "outage"; only CORE_STATUS_KEYS can force
 *  that. Before 2026-08-17 railComponents were computed but never passed
 *  here, so a chain dropping out of the live 402 accepts (caught correctly by
 *  the paid canary and shown as "Outage" on its own card) never moved the
 *  headline off "All systems operational" - the exact gap this closes. */
export function overallState(components, railComponents = []) {
  const voting = components.filter((c) => c.observed > 0);
  const railVoting = railComponents.filter((c) => c.observed > 0);
  if (!voting.length && !railVoting.length) return "unknown";
  const core = new Set(CORE_STATUS_KEYS);
  if (voting.some((c) => core.has(c.key) && c.current?.state === "outage")) return "outage";
  // Everything stale is not "degraded" — degraded asserts we know something is
  // wrong (or that measurement is incomplete). If no component has a fresh
  // observation we simply do not know, and saying so is the honest answer.
  const allUnknown =
    (!voting.length || voting.every((c) => c.current?.state === "unknown")) &&
    (!railVoting.length || railVoting.every((c) => c.current?.state === "unknown"));
  if (allUnknown) return "unknown";
  const bad = (c) => ["outage", "degraded", "unknown"].includes(c.current?.state);
  if (voting.some(bad) || railVoting.some(bad)) return "degraded";
  return "operational";
}

/** Build the whole view. `nowMs` is injectable so the tests can pin an instant. */
export function statusSnapshot({ baseUrl = "", nowMs = Date.now(), historyDays = 90, live = {} } = {}) {
  const latest = new Map(latestByComponent().map((r) => [r.component, r]));
  const since = nowMs - historyDays * DAY;

  // Shared shape between the core components and the per-rail breakdown below
  // - same store functions, same windows, same daily-bar computation, so a
  // rail row means exactly the same thing as any other component row.
  const toComponent = (c) => {
    const rows = probeRows(c.key, since);
    const windows = {};
    for (const w of WINDOWS) windows[w.key] = uptimeFrom(rows.filter((r) => r.ts >= nowMs - w.ms));
    return {
      key: c.key,
      label: c.label,
      blurb: c.blurb,
      observed: rows.length,
      current: stateFrom(latest.get(c.key), { nowMs, staleAfterMs: c.staleAfterMs }),
      // Newest first, last five: lets a prober apply a consecutive-failure rule
      // without any state of its own (the paid canary's upstream legs).
      recentOk: rows.slice(-5).reverse().map((r) => !!r.ok),
      windows,
      daily: dailyFrom(rows, { days: historyDays, nowMs }),
    };
  };
  const components = COMPONENTS.map(toComponent);
  // Rails are informational, not core - a single failed chain never flips
  // overall to "outage" (same doctrine as the existing aggregate "rails"
  // component and CORE_STATUS_KEYS below). They DO still feed overallState()
  // so a real per-chain outage is visible as "degraded", not silently absorbed.
  const railComponents = RAIL_COMPONENTS.map(toComponent);

  // Incidents come from the availability component: the one with full history.
  const incidents = incidentsFrom(probeRows("api", since)).slice(0, 25);
  const firstObs = earliestObservation();

  return {
    service: "Agent402.Tools",
    generatedAt: new Date(nowMs).toISOString(),
    overall: overallState(components, railComponents),
    measurement: {
      observer: "Two independent observers outside production: a Cloudflare cron probe and the GitHub Actions heartbeat",
      cadence: "every 5 minutes (Cloudflare), plus the GitHub heartbeat for the paid-call path",
      verify: HEARTBEAT_RUNS,
      measuringSince: firstObs ? new Date(firstObs).toISOString() : null,
      totalObservations: totalObservations(),
      persistent: statusPersistent(),
      note:
        "Availability is what an outside observer recorded, not a self-report. A day with no " +
        "observation is reported as no data rather than uptime, and a component whose latest " +
        "observation is stale is reported as unknown rather than operational.",
    },
    components,
    railComponents,
    incidents: incidents.map((i) => ({
      startedAt: new Date(i.startedAt).toISOString(),
      endedAt: new Date(i.endedAt).toISOString(),
      durationMinutes: Math.round(i.durationMs / 60000),
      failedProbes: i.probes,
      detail: i.detail,
      url: i.url,
    })),
    live,
    links: {
      heartbeat: HEARTBEAT_RUNS,
      paidCanary: CANARY_RUNS,
      reliability: `${baseUrl}/api/reliability`,
      stats: `${baseUrl}/api/stats`,
    },
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const DOT = { operational: "ok", degraded: "warn", outage: "bad", unknown: "unk" };
const WORD = { operational: "Operational", degraded: "Degraded", outage: "Outage", unknown: "Not measured" };

const fmtPct = (v) => (v === null || v === undefined ? "—" : `${v >= 99.995 ? "100" : v.toFixed(v >= 99.9 ? 3 : 2)}%`);
const plural = (n) => (n === 1 ? "" : "s");

const agoStr = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
};

function bars(daily) {
  return daily
    .map((d) => {
      const cls = d.observed === 0 ? "nodata" : d.down === 0 ? "up" : d.up === 0 ? "down" : "partial";
      const title =
        d.observed === 0
          ? `${d.date}: no observation`
          : `${d.date}: ${fmtPct(d.pct)} of ${d.observed} probe${plural(d.observed)}${d.down ? `, ${d.down} failed` : ""}`;
      return `<i class="b ${cls}" title="${esc(title)}"></i>`;
    })
    .join("");
}

function componentRow(c) {
  const w = c.windows["90d"];
  return `<div class="comp">
  <div class="comp-h">
    <span class="dot ${DOT[c.current.state]}" aria-hidden="true"></span>
    <span class="comp-n">${esc(c.label)}</span>
    <span class="comp-s ${DOT[c.current.state]}">${esc(WORD[c.current.state])}</span>
  </div>
  <p class="comp-b">${esc(c.blurb)}</p>
  ${
    c.observed > 0
      ? `<div class="bars">${bars(c.daily)}</div>
  <div class="comp-f"><span>90 days ago</span><span class="up-n">${fmtPct(w.pct)} <em>of ${w.observed} probe${plural(w.observed)}</em></span><span>today</span></div>`
      : `<p class="nomeasure">Not yet measured. No observations are recorded for this check, so no availability is claimed for it.</p>`
  }
</div>`;
}

function liveSection(live, stats) {
  const rows = [];
  const bucket = (v) => (v === "ok" ? "ok" : v === "low" ? "warn" : "unk");
  if (live.gateway) rows.push(["LLM gateway credit", bucket(live.gateway), esc(String(live.gateway)), "Bucketed upstream balance. The amount is never exposed."]);
  if (live.upstreamBuyer) rows.push(["Upstream buyer wallet, Base", bucket(live.upstreamBuyer), esc(live.upstreamBuyer), "Funds paid upstream calls made on a buyer's behalf."]);
  if (live.upstreamBuyerAvm) rows.push(["Upstream buyer wallet, Algorand", bucket(live.upstreamBuyerAvm), esc(live.upstreamBuyerAvm), "Funds Algorand-side external routing."]);
  const last = stats?.recentCalls?.[0];
  if (last) {
    rows.push(["Last call served", "ok", `${esc(last.slug)} · ${esc(agoStr(last.at))}`, `Paid with ${last.paidWith === "proof-of-work" ? "proof-of-work" : "USDC"}.`]);
  }
  if (!rows.length) return "";
  return `<h2 id="live">Live checks</h2>
<p class="lead">Read from the running service as this page loaded, so unlike the history above these are self-reported. They are here because they lead outages rather than follow them.</p>
<div class="live">
${rows.map(([n, cls, v, b]) => `<div class="lrow"><span class="dot ${cls}"></span><span class="ln">${esc(n)}</span><span class="lv">${v}</span><p class="lb">${esc(b)}</p></div>`).join("\n")}
</div>`;
}

// Raw probe details are terse fragments ("health The operation was aborted",
// " /health") - accurate but not descriptive. Translate the known shapes into
// sentences a visitor can act on; the raw string stays in the cell's title
// attribute so nothing is hidden.
export function humanizeDetail(detail) {
  const d = String(detail || "").trim();
  if (!d) return d;
  const m = /^([A-Za-z-]+|\/[\w/-]*)\s*(.*)$/.exec(d);
  const target = m?.[1] || d;
  const rest = (m?.[2] || "").trim();
  const targetLabel = target.startsWith("/") ? `the ${target} endpoint` : `the ${target} probe`;
  const CAUSES = [
    [/operation was aborted|aborted due to timeout|timed?\s*out/i, "timed out - no answer before the probe's deadline"],
    [/ECONNREFUSED|connection refused/i, "was refused - the server did not accept the connection"],
    [/5\d\d/, (t) => `answered HTTP ${t.match(/5\d\d/)[0]} instead of a healthy response`],
  ];
  for (const [re, out] of CAUSES) {
    if (re.test(rest)) return `${targetLabel} ${typeof out === "function" ? out(rest) : out}`;
  }
  return rest ? `${targetLabel} failed: ${rest}` : `${targetLabel} failed`;
}

function incidentsSection(incidents) {
  if (!incidents.length) {
    return `<h2 id="incidents">Incident history</h2>
<p class="lead">No failed probe in the recorded window. This list is computed from the observations themselves, so it cannot be tidied up after a bad day.</p>`;
  }
  return `<h2 id="incidents">Incident history</h2>
<p class="lead">Computed from failed probes rather than written by hand, so nothing can be quietly left out. Consecutive failures are grouped into a single incident.</p>
<div class="inc-scroll"><table class="inc"><thead><tr><th>Started (UTC)</th><th>Duration</th><th>Failed probes</th><th>What failed</th></tr></thead><tbody>
${incidents
    .map(
      (i) =>
        `<tr><td class="mono" data-l="started" title="${esc(i.startedAt)}">${esc(i.startedAt.slice(0, 16).replace("T", " "))}</td><td class="mono" data-l="duration">${i.durationMinutes >= 1 ? `${i.durationMinutes} min` : "under 1 min"}</td><td class="mono" data-l="failed probes">${i.failedProbes}</td><td data-l="what failed" title="${esc(i.detail || "")}">${i.detail ? esc(humanizeDetail(i.detail)) : '<span class="faint">not recorded</span>'}</td></tr>`,
    )
    .join("\n")}
</tbody></table></div>`;
}

const CSS = `
.st-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.st-h1{font-family:var(--font-body);font-weight:800;font-size:52px;line-height:.98;letter-spacing:-.03em;margin:0 0 10px}
.st-sub{color:var(--muted);margin:0 0 26px;font-size:15px;line-height:1.55}
.st-sub a{color:var(--accent);text-decoration:none}
.st-sub a:hover{text-decoration:underline}
.hero{border:1px solid var(--hairline);border-radius:2px;padding:22px;margin:0 0 26px;background:var(--card);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hero .hw{font-family:var(--font-body);font-weight:700;font-size:22px}
.hero .hm{color:var(--muted);font-size:14px;width:100%;margin:0}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;flex:0 0 auto;background:var(--dash)}
.dot.ok{background:var(--green)}
.dot.warn{background:#C98A12}
.dot.bad{background:var(--accent)}
.dot.unk{background:var(--dash)}
.wins{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 30px;padding:0;list-style:none}
.wins li{border:1px solid var(--hairline);border-radius:2px;padding:10px 14px;background:var(--card);font-family:var(--font-mono);font-size:13px}
.wins b{font-family:var(--font-body)}
.comp{border:1px solid var(--hairline);border-radius:2px;padding:16px 18px;margin:0 0 14px;background:var(--card)}
.comp-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.comp-n{font-weight:700}
.comp-s{margin-left:auto;font-size:12px;font-family:var(--font-mono);color:var(--muted)}
.comp-s.ok{color:var(--green)}
.comp-s.bad{color:var(--accent)}
.comp-b{margin:6px 0 12px;color:var(--muted);font-size:14px}
.bars{display:flex;gap:2px;align-items:stretch;height:34px}
.bars .b{flex:1 1 0;min-width:2px;border-radius:1px;background:var(--dash)}
.bars .b.up{background:var(--green)}
.bars .b.partial{background:#C98A12}
.bars .b.down{background:var(--accent)}
.bars .b.nodata{background:var(--hairline);opacity:.5}
.bar-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:-8px 0 18px}
.bar-legend .b{display:inline-block;width:10px;height:14px;border-radius:1px;background:var(--dash);flex:none}
.bar-legend .b.up{background:var(--green)}
.bar-legend .b.partial{background:#C98A12}
.bar-legend .b.down{background:var(--accent)}
.bar-legend .b.nodata{background:var(--hairline);opacity:.5}
.inc-scroll{overflow-x:auto}
.inc-scroll .inc{min-width:520px}
.comp-f{display:flex;justify-content:space-between;gap:10px;margin-top:7px;font-size:12px;color:var(--faint);font-family:var(--font-mono)}
.comp-f .up-n{color:var(--muted)}
.comp-f em{font-style:normal;color:var(--faint)}
.nomeasure{margin:0;font-size:13px;color:var(--faint);border-left:2px solid var(--dash);padding-left:10px}
.live{display:grid;gap:10px;margin:14px 0 30px}
.lrow{display:grid;grid-template-columns:12px 1fr auto;gap:9px;align-items:center;border:1px solid var(--hairline);border-radius:2px;padding:12px 14px;background:var(--card)}
.lrow .ln{font-weight:600;font-size:14px}
.lrow .lv{font-family:var(--font-mono);font-size:13px;color:var(--muted)}
.lrow .lb{grid-column:2/4;margin:2px 0 0;font-size:13px;color:var(--faint)}
table.inc{width:100%;border-collapse:collapse;margin:12px 0 30px;font-size:14px}
table.inc th,table.inc td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--hairline);vertical-align:top}
table.inc th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.mono{font-family:var(--font-mono);font-size:13px;white-space:nowrap}
.faint{color:var(--faint)}
.lead{color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.6}
.method{border:1px solid var(--hairline);border-radius:2px;padding:6px 22px 16px;background:var(--card);margin:0 0 26px}
.method li{margin:9px 0;color:var(--muted);font-size:14px;line-height:1.6}
h2{font-family:var(--font-body);font-weight:800;letter-spacing:-.02em;margin:34px 0 6px}
.st-links{margin-top:26px;color:var(--faint);font-family:var(--font-mono);font-size:13px}
.st-links a{color:var(--accent);text-decoration:none}
.st-links a:hover{text-decoration:underline}
@media(max-width:640px){.st-h1{font-size:34px}.st-wrap{padding:36px 18px}.bars{height:26px}.comp-s{margin-left:0;width:100%}
/* Incidents reflow to stacked cards on phones: no 520px min-width, no
   left-right scrolling - each row becomes a bordered card with per-cell
   labels (data-l), the timestamp wraps instead of forcing width. */
.inc-scroll{overflow-x:visible}
.inc-scroll .inc{min-width:0}
table.inc thead{display:none}
table.inc,table.inc tbody,table.inc tr,table.inc td{display:block;width:100%}
table.inc tr{border:1px solid var(--hairline);border-radius:2px;background:var(--card);padding:8px 12px;margin:0 0 8px}
table.inc td{border:none;padding:2px 0;text-align:left;white-space:normal}
table.inc td.mono{white-space:normal}
table.inc td::before{content:attr(data-l) ": ";color:var(--faint);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
}
`;

/**
 * @param baseUrl  canonical origin
 * @param stats    /api/stats shape, for the live counters
 * @param snap     statusSnapshot() result
 */
export function statusPage(baseUrl, stats, snap) {
  const api = snap.components.find((c) => c.key === "api");
  const settlement = snap.components.find((c) => c.key === "settlement");
  const headline =
    snap.overall === "operational" ? "All systems operational"
      : snap.overall === "outage" ? "Active outage"
        : snap.overall === "degraded" ? "Degraded"
          : snap.overall === "unknown" ? "Partially measured"
            : "Not yet measured";

  const settlementDetail = settlement?.current?.detail;
  // Prefer naming the specific bad rail(s) directly (always accurate, sourced
  // from the same railComponents overallState() now reads) over relying on
  // settlement's own detail text happening to mention it.
  const badRails = snap.railComponents.filter(
    (c) => c.observed > 0 && ["outage", "degraded", "unknown"].includes(c.current?.state)
  );
  const heroExtra =
    snap.overall === "degraded"
      ? `<p class="hm">${esc(
          badRails.length
            ? `Rail${plural(badRails.length)} affected: ${badRails.map((c) => `${c.label} (${WORD[c.current.state]})`).join(", ")}.`
            : settlementDetail || "See components below for detail."
        )}</p>`
      : "";

  const windowList =
    api && api.observed
      ? `<ul class="wins">${WINDOWS.map((w) => {
        const u = api.windows[w.key];
        return `<li><b>${esc(w.label)}</b> · ${fmtPct(u.pct)} <span class="faint">of ${u.observed} probe${plural(u.observed)}</span></li>`;
      }).join("")}</ul>`
      : "";

  const measuringSince = snap.measurement.measuringSince ? snap.measurement.measuringSince.slice(0, 10) : null;
  const onchain = stats?.onchainRevenueProof;

  const body = `
<div class="st-wrap">

<section>
<h1 class="st-h1">Service status</h1>
<p class="st-sub">Availability is measured from outside this server, so an outage is witnessed by something that stays up when we do not. <a href="${esc(HEARTBEAT_RUNS)}" rel="noopener">Every probe run is public</a>.</p>

<div class="hero">
  <span class="dot ${DOT[snap.overall]}"></span>
  <span class="hw">${esc(headline)}</span>
  <p class="hm">${measuringSince
    ? `Probed every few minutes by two independent observers since ${esc(measuringSince)}, across ${snap.measurement.totalObservations.toLocaleString()} recorded observation${plural(snap.measurement.totalObservations)}.`
    : "No observations recorded yet, so no availability is claimed."}</p>
  ${heroExtra}
</div>

${windowList}
</section>

<section>
<h2 id="components">Components</h2>
<p class="lead">Each bar is one UTC day; hover for that day's probe count. Grey means no observation was made that day, shown as absence rather than counted as uptime.</p>
<p class="bar-legend"><i class="b up"></i> every probe passed <i class="b partial"></i> some probes failed <i class="b down"></i> every probe failed <i class="b nodata"></i> no observation</p>
${snap.components.map(componentRow).join("\n")}

<h2 id="rails">Payment rails</h2>
<p class="lead">Each chain settled by the daily paid canary, graded independently - a single rail failing here never counts as a service outage above; it means that specific chain isn't settling right now.</p>
${snap.railComponents.map(componentRow).join("\n")}
</section>

<section>
${incidentsSection(snap.incidents)}

${liveSection(snap.live, stats)}
</section>

<section>
<h2 id="method">How this is measured</h2>
<div class="method">
<ul>
<li><b>The observer sits outside the service.</b> A GitHub Actions workflow probes production every 15 minutes and records what it saw; this page only stores and renders those observations.</li>
<li><b>An outage appears as a gap.</b> When production is down the probe cannot report in either, so the record shows missing observations rather than a tidy row of failures. Gaps are never counted as uptime.</li>
<li><b>Percentages carry their denominator.</b> 100% of three probes is a weaker claim than 100% of three thousand, and the page shows which one you are reading.</li>
<li><b>Stale means unknown, not healthy.</b> A component whose most recent observation has aged out is reported as not measured.</li>
<li><b>Payment is proven with real money.</b> A daily canary buys tools across every supported chain and settles genuine USDC. <a href="${esc(CANARY_RUNS)}" rel="noopener">Runs are public</a>.</li>
<li><b>Incidents are derived, not authored.</b> The table above is computed from failed probes, so a bad day cannot be edited out.</li>
</ul>
</div>

<div class="st-links">
  <a href="/api/status">/api/status</a> ·
  <a href="/api/stats">/api/stats</a> ·
  <a href="/api/reliability">/api/reliability</a> ·
  <a href="/health">/health</a>
  ${onchain ? ` · <a href="${esc(onchain)}" rel="noopener">wallet on-chain</a>` : ""}
</div>
</section>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Status - Agent402 x402 + MCP server uptime",
    description:
      "Availability for Agent402.Tools, measured every few minutes by two independent observers outside production: per-component uptime history, incidents derived from real probes, and daily real-money payment checks.",
    canonical: `${baseUrl}/status`,
    baseUrl,
    activePath: "__none__",
    extraCss: CSS,
    body,
  });
}
