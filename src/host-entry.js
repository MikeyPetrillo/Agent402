// The host's own entry on the discovery surfaces, with EXTERNAL-ONLY figures.
//
// The marketplace, the leaderboards and /api/index rank OTHER sellers and keep
// the operator out of the ranked lists and the seller counts on purpose: an
// index that ranks itself first is not evidence of anything, and our own
// on-chain volume is mostly our own canary and volume runs. That exclusion
// used to leave the host with no honest entry at all (/api/index?seller=
// agent402.tools answered "not found"). This module renders one: a clearly
// labelled card / row / JSON summary carrying only settlements the sales
// ledger classified as external (never internal or synthetic, reusing the
// ledger's own classification), placed OUTSIDE every ranking and never
// counted in a seller total. Renderers take a figures object so the page
// modules stay offline-testable; a null figures object renders nothing.
import { esc } from "./ledger-chrome.js";

const ALL_TIME_DAYS = 36_500;

// "ALL TIME" IS A CLAIM ABOUT A WINDOW, AND THIS ONE STARTS LATE.
//
// The window here is the whole sales ledger, but the sales ledger is younger
// than the service: measured on prod 2026-09-22, it began recording
// 2026-07-03 while /api/stats servingSince reads 2026-06-12 and the lifetime
// viaUSDC counter stood at 35,947 against 11,825 settlements in the ledger.
// The card said "11,825 settlements, all time" and "443 distinct buyers, all
// time" with nothing naming that start, so a reader takes a figure that
// begins three weeks in as the whole history.
//
// The number is right and only its contract was quiet, which is the failure
// shape this file has already been burned by twice (a LIMIT-20 list's length
// published as a tool count; a 250-of-4,473 index page published as "every
// seller indexed"). So the start date travels WITH the figure - on the card,
// on the row, and as `since` inside the JSON object rather than only beside
// it - and the label reads "recorded" rather than "all time" when we know it.
// A ledger that cannot report its own start says nothing instead of guessing.
const isoDay = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null;
};

/** External-only figures from the sales ledger. `summaryFn` is injectable. */
export function hostFigures({ summaryFn, byNetworkFn, network = null, networkLabel = null, toolCount = 0, baseUrl = "" } = {}) {
  if (typeof summaryFn !== "function") return null;
  let d30, all;
  try { d30 = summaryFn({ days: 30 }); all = summaryFn({ days: ALL_TIME_DAYS }); } catch { return null; }
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const base = {
    baseUrl,
    toolCount: n(toolCount),
    recordingSince: all?.recordingSince ? new Date(all.recordingSince).toISOString() : null,
    // The day the ledger's own record starts, carried into every figure below
    // that covers "everything" - null when the ledger cannot say.
    recordedSince: isoDay(all?.recordingSince),
    network: null, networkLabel: null,
    external30d: { settlements: n(d30?.totals?.external?.sales), buyers: n(d30?.distinctExternalBuyers), tools: n(d30?.distinctToolsSoldExternal), windowDays: 30 },
    externalAllTime: { settlements: n(all?.totals?.external?.sales), buyers: n(all?.distinctExternalBuyers), tools: n(all?.distinctToolsSoldExternal), since: isoDay(all?.recordingSince) },
  };
  // Per-rail figures for a chain page: only settlements on THAT network
  // (the ledger's own external classification, collapsed to the rail key).
  if (network && typeof byNetworkFn === "function") {
    const pick = (m) => { const k = Object.keys(m || {}).find((x) => x === network || x.startsWith(`${network} `) || x.startsWith(`${network}:`)); return k ? m[k] : { settlements: 0, buyers: 0 }; };
    let m30, mall;
    try { m30 = pick(byNetworkFn({ days: 30 })); mall = pick(byNetworkFn({ days: ALL_TIME_DAYS })); } catch { return base; }
    return { ...base, network, networkLabel: networkLabel || network,
      external30d: { settlements: n(m30.settlements), buyers: n(m30.buyers), tools: null, windowDays: 30 },
      externalAllTime: { settlements: n(mall.settlements), buyers: n(mall.buyers), tools: null, since: base.recordedSince } };
  }
  return base;
}

const fmt = (v) => Number(v || 0).toLocaleString("en-US");

/**
 * Which settlement rails carried at least one OUTSIDE settlement, from the
 * sales ledger's own external classification (externalByNetwork). `rails` is
 * the offered rail list (src/rails.js RAILS), `extra` any rail offered beside
 * it (Tempo). A rail matches by its friendly key or its CAIP-2 id, the two
 * spellings the ledger records. Pure.
 */
export function railsWithOutsideSettlements(byNetwork, rails, extra = []) {
  const m = byNetwork && typeof byNetwork === "object" ? byNetwork : {};
  const keyOf = (name) => String(name).replace(/ Chain$/, "").toLowerCase().replace(/\s+/g, "");
  const offered = [
    ...(Array.isArray(rails) ? rails : []).map((r) => ({ name: r.name, keys: [keyOf(r.name), String(r.caip2 || "").toLowerCase()].filter(Boolean) })),
    ...(Array.isArray(extra) ? extra : []).map((r) => ({ name: r.name, keys: (r.keys || [keyOf(r.name)]).map((k) => String(k).toLowerCase()) })),
  ];
  const settled = (k) => Object.entries(m).some(([key, v]) => String(key).toLowerCase() === k && Number(v?.settlements) > 0);
  const withOutside = offered.filter((r) => r.keys.some(settled)).map((r) => r.name);
  return { withOutside, offered: offered.length };
}

export const HOST_EXCLUSION_NOTE = "Our own canary and volume runs are excluded from these figures; the ranked rows measure other sellers on chain and never include the host.";

/** How to label the widest figure: its real start when the ledger knows one,
 *  and only then the unqualified "all time". */
export const wideLabel = (f) => (f?.externalAllTime?.since ? `since ${f.externalAllTime.since}` : "all time");
/** The one sentence that keeps "since" from reading as an arbitrary cutoff. */
export const HOST_LEDGER_START_NOTE = (since) =>
  `Settlements are counted from the sales ledger, which starts ${since}; earlier calls were served and settled but are not itemised in it, so these are not lifetime totals.`;

/** Marketplace card, rendered above the roster and outside every count. */
export function hostCardHtml(f) {
  if (!f) return "";
  return `
  <div data-host-card style="border:1px solid var(--hairline);background:var(--card);padding:18px 20px;margin:0 0 22px;">
    <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:baseline;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--accent);">THIS SITE &middot; HOST &middot; NOT RANKED, NOT COUNTED</div>
      <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">${f.networkLabel ? `outside buyers on ${esc(f.networkLabel)} only` : "outside buyers only"}</div>
    </div>
    <div style="display:flex;gap:26px;flex-wrap:wrap;margin:12px 0 10px;font-family:var(--font-mono);font-size:13px;color:var(--ink);">
      <span><strong>${fmt(f.external30d.settlements)}</strong> <span style="color:var(--faint);">settlements, 30 days</span></span>
      <span><strong>${fmt(f.external30d.buyers)}</strong> <span style="color:var(--faint);">distinct buyers, 30 days</span></span>
      <span><strong>${fmt(f.externalAllTime.settlements)}</strong> <span style="color:var(--faint);">settlements, ${esc(wideLabel(f))}</span></span>
      <span><strong>${fmt(f.externalAllTime.buyers)}</strong> <span style="color:var(--faint);">distinct buyers, ${esc(wideLabel(f))}</span></span>
    </div>
    <p style="font-size:13px;line-height:1.55;color:var(--muted);margin:0 0 10px;">Agent402 runs this index and sells 500+ tools, metered models and reports on the same rails. ${esc(HOST_EXCLUSION_NOTE)}${f.externalAllTime.since ? ` ${esc(HOST_LEDGER_START_NOTE(f.externalAllTime.since))}` : ""}</p>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12.5px;">
      <a href="/tools" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);">tools &rarr;</a>
      <a href="/why" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);">why pay here &rarr;</a>
      <a href="/revenue" style="color:var(--muted);text-decoration:none;">every settlement &rarr;</a>
    </div>
  </div>`;
}

/** Leaderboard row: pinned, labelled, never numbered. `dark` picks the on-dark tokens. */
export function hostRowHtml(f, { dark = false } = {}) {
  if (!f) return "";
  const ink = dark ? "var(--on-dark)" : "var(--ink)";
  const faint = dark ? "var(--dk-muted3)" : "var(--faint)";
  return `
  <div data-host-row style="border:1px solid var(--hairline);${dark ? "background:var(--surface);" : "background:var(--card);"}padding:14px 18px;margin-top:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:baseline;">
    <span style="font-family:var(--font-mono);font-size:12.5px;color:${ink};"><span style="font-size:10.5px;letter-spacing:.1em;color:var(--accent);margin-right:10px;">HOST &middot; NOT RANKED</span><strong>Agent402</strong> <span style="color:${faint};">(this site)</span></span>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:${ink};font-variant-numeric:tabular-nums;">${fmt(f.external30d.settlements)} settlements &middot; ${fmt(f.external30d.buyers)} buyers <span style="color:${faint};">(30 days, outside buyers only)</span> &middot; ${fmt(f.externalAllTime.settlements)} ${esc(wideLabel(f))}</span>
    <span style="flex-basis:100%;font-family:var(--font-mono);font-size:11.5px;line-height:1.5;color:${faint};">${esc(HOST_EXCLUSION_NOTE)}${f.externalAllTime.since ? ` ${esc(HOST_LEDGER_START_NOTE(f.externalAllTime.since))}` : ""}</span>
  </div>`;
}

/** The /api/index?seller=<self> answer. */
export function hostIndexEntry(f) {
  if (!f) return null;
  const b = String(f.baseUrl || "").replace(/\/+$/, "");
  return {
    self: true,
    listed: true,
    origin: b,
    displayName: "Agent402",
    homepage: b,
    toolCount: f.toolCount,
    note: "The host. Excluded from the ranked index, the router's external pool and every seller count by design; these figures count only settlements the sales ledger classified as external (never the host's own canary or volume runs).",
    // `allTime` carries its own `since`: the ledger starts later than the
    // service does, so this is the recorded history and not a lifetime total.
    external: {
      days30: f.external30d,
      allTime: f.externalAllTime,
      recordingSince: f.recordingSince,
      scopeNote: f.externalAllTime.since
        ? HOST_LEDGER_START_NOTE(f.externalAllTime.since)
        : "The ledger could not report when its record starts, so allTime.since is null and the figure is not a lifetime total.",
    },
    links: { pricing: `${b}/api/pricing`, openapi: `${b}/openapi.json`, manifest: `${b}/.well-known/x402`, tools: `${b}/tools`, why: `${b}/why` },
  };
}

// Trailing-slash trim WITHOUT a regex. `/\/+$/` against a caller-supplied
// value is polynomial-time on a string of many slashes (CodeQL
// js/polynomial-redos, high, on this exact line): "////...x" backtracks. A
// slice loop is linear and cannot backtrack at all.
const trimTrailingSlashes = (v) => { let i = v.length; while (i > 0 && v.charCodeAt(i - 1) === 47) i--; return v.slice(0, i); };

/** Does a seller query name the host? Accepts an origin, a host, or the canonical origin. */
export function isSelfSellerQuery(q, baseUrl) {
  // Bounded before anything else: a seller name is never long, and an
  // unbounded caller string has no business reaching a URL parse.
  const s = trimTrailingSlashes(String(q || "").trim().toLowerCase().slice(0, 256));
  if (!s) return false;
  const host = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return String(u).toLowerCase(); } };
  const candidates = new Set(["agent402.tools", "https://agent402.tools", "www.agent402.tools"]);
  if (baseUrl) { const b = trimTrailingSlashes(String(baseUrl)).toLowerCase(); candidates.add(b); candidates.add(host(b)); }
  return candidates.has(s) || candidates.has(host(s.startsWith("http") ? s : `https://${s}`));
}
