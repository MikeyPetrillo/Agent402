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
    network: null, networkLabel: null,
    external30d: { settlements: n(d30?.totals?.external?.sales), buyers: n(d30?.distinctExternalBuyers), tools: n(d30?.distinctToolsSoldExternal) },
    externalAllTime: { settlements: n(all?.totals?.external?.sales), buyers: n(all?.distinctExternalBuyers), tools: n(all?.distinctToolsSoldExternal) },
  };
  // Per-rail figures for a chain page: only settlements on THAT network
  // (the ledger's own external classification, collapsed to the rail key).
  if (network && typeof byNetworkFn === "function") {
    const pick = (m) => { const k = Object.keys(m || {}).find((x) => x === network || x.startsWith(`${network} `) || x.startsWith(`${network}:`)); return k ? m[k] : { settlements: 0, buyers: 0 }; };
    let m30, mall;
    try { m30 = pick(byNetworkFn({ days: 30 })); mall = pick(byNetworkFn({ days: ALL_TIME_DAYS })); } catch { return base; }
    return { ...base, network, networkLabel: networkLabel || network,
      external30d: { settlements: n(m30.settlements), buyers: n(m30.buyers), tools: null },
      externalAllTime: { settlements: n(mall.settlements), buyers: n(mall.buyers), tools: null } };
  }
  return base;
}

const fmt = (v) => Number(v || 0).toLocaleString("en-US");

export const HOST_EXCLUSION_NOTE = "Our own canary and volume runs are excluded from these figures; the ranked rows measure other sellers on chain and never include the host.";

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
      <span><strong>${fmt(f.externalAllTime.settlements)}</strong> <span style="color:var(--faint);">settlements, all time</span></span>
      <span><strong>${fmt(f.externalAllTime.buyers)}</strong> <span style="color:var(--faint);">distinct buyers, all time</span></span>
    </div>
    <p style="font-size:13px;line-height:1.55;color:var(--muted);margin:0 0 10px;">Agent402 runs this index and sells 500+ tools, metered models and reports on the same rails. ${esc(HOST_EXCLUSION_NOTE)}</p>
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
    <span style="font-family:var(--font-mono);font-size:12.5px;color:${ink};font-variant-numeric:tabular-nums;">${fmt(f.external30d.settlements)} settlements &middot; ${fmt(f.external30d.buyers)} buyers <span style="color:${faint};">(30 days, outside buyers only)</span> &middot; ${fmt(f.externalAllTime.settlements)} all time</span>
    <span style="flex-basis:100%;font-family:var(--font-mono);font-size:11.5px;line-height:1.5;color:${faint};">${esc(HOST_EXCLUSION_NOTE)}</span>
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
    external: { days30: f.external30d, allTime: f.externalAllTime, recordingSince: f.recordingSince },
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
