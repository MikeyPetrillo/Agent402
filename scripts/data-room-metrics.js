// Data-room metrics: one JSON summary of the service read from its PUBLIC
// surfaces only (/health, /api/pricing, /api/stats, /api/status,
// /api/reliability). It sends no credential, reads no operator surface, no
// database and no private file, so everything it prints is already public.
//
//   node scripts/data-room-metrics.js                      the hosted service
//   BASE_URL=http://127.0.0.1:3000 node scripts/data-room-metrics.js
//   node scripts/data-room-metrics.js --out metrics.json
//
// Exit 0 with the summary; exit 1 when a surface cannot be read (the summary
// is still printed, with that surface named under `unreadable`).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SURFACES = ["/health", "/api/pricing", "/api/stats", "/api/status", "/api/reliability"];

const priceUsd = (p) => { const n = Number(String(p ?? "").replace(/^\$/, "")); return Number.isFinite(n) ? n : null; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Read every surface. `fetchImpl` is injectable for tests. */
export async function readSurfaces(base, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const out = {}, unreadable = [];
  for (const p of SURFACES) {
    try {
      const r = await fetchImpl(new URL(p, base).href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      out[p] = await r.json();
    } catch (e) { unreadable.push({ surface: p, reason: String(e?.message || e).slice(0, 120) }); }
  }
  return { bodies: out, unreadable };
}

/** The summary, from surface bodies keyed by path. Pure. */
export function summarize(base, bodies, unreadable = []) {
  const health = bodies["/health"] || {};
  const pricing = bodies["/api/pricing"] || {};
  const stats = bodies["/api/stats"] || {};
  const status = bodies["/api/status"] || {};
  const rel = bodies["/api/reliability"] || {};
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  const prices = endpoints.map((e) => priceUsd(e.price)).filter((n) => n !== null);
  const byCategory = {};
  for (const e of endpoints) byCategory[e.category || "uncategorized"] = (byCategory[e.category || "uncategorized"] || 0) + 1;
  const served = stats.toolCallsServed || rel.toolCallsServed || {};
  const components = Array.isArray(status.components) ? status.components : [];
  const statusOf = (c) => String(c?.status ?? c?.state ?? "unknown");
  const componentStatus = {};
  for (const c of components) componentStatus[statusOf(c)] = (componentStatus[statusOf(c)] || 0) + 1;
  return {
    source: String(base),
    build: health.meta?.build ?? null,
    catalog: {
      toolCount: num(health.meta?.toolCount) ?? num(stats.tools),
      pricedEndpoints: endpoints.length,
      modelBacked: endpoints.filter((e) => e.modelBacked === true).length,
      proofOfWorkEligible: endpoints.filter((e) => e.computePayable === true).length,
      quoted: endpoints.filter((e) => e.quoted === true).length,
      categories: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
      priceUsd: prices.length ? { min: Math.min(...prices), median: median(prices), max: Math.max(...prices) } : null,
    },
    payment: {
      protocol: pricing.payment?.protocol ?? null,
      networks: Array.isArray(pricing.payment?.networks) ? pricing.payment.networks.length : null,
      llmGatewayTiers: Array.isArray(pricing.llmGateway?.tiers) ? pricing.llmGateway.tiers.length : null,
    },
    usage: {
      toolCallsServed: num(served.total),
      viaUSDC: num(served.viaUSDC),
      viaMPPWire: num(served.viaMPPWire),
      viaProofOfWork: num(served.viaProofOfWork),
      chargedButFailedGenuine: num(stats.chargedButFailedGenuine),
    },
    reliability: {
      overall: status.overall ?? rel.status ?? null,
      components: components.length,
      componentStatus,
      openIncidents: Array.isArray(status.incidents) ? status.incidents.length : null,
      guarantees: Array.isArray(rel.guarantees) ? rel.guarantees.length : null,
      servingSince: rel.servingSince ?? null,
      measuringSince: status.measurement?.measuringSince ?? null,
    },
    unreadable,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.BASE_URL || "https://agent402.tools";
  const { bodies, unreadable } = await readSurfaces(base);
  const text = JSON.stringify(summarize(base, bodies, unreadable), null, 2) + "\n";
  const i = process.argv.indexOf("--out");
  if (i > 0 && process.argv[i + 1]) { writeFileSync(process.argv[i + 1], text); console.error(`wrote ${process.argv[i + 1]}`); } else process.stdout.write(text);
  process.exit(unreadable.length ? 1 : 0);
}
