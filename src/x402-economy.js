// x402 Economy Observatory — live, chain-wide analytics on gasless USDC
// settlements on Base: the on-chain footprint of the x402 economy.
//
// Method (stated on the page too): an x402 "exact" payment settles as an
// EIP-3009 transferWithAuthorization on USDC — one transaction on the USDC
// contract that emits BOTH `Transfer(from,to,value)` and
// `AuthorizationUsed(authorizer,nonce)`. We count Transfer events whose
// transaction also emitted AuthorizationUsed, chain-wide (every seller, not
// just us), via the CDP SQL API over decoded base.events. This includes any
// gasless authorized USDC transfer (x402 facilitators dominate this
// pattern), and the page says so honestly.
//
// Data flows through the SAME paid `onchain-sql` tool users can buy — the
// observatory is a public demo of it. Results cache 30 min server-side (and
// lean on CDP's own 15-min query cache), so the page costs at most a few
// queries per half hour regardless of traffic. Env-gated: without CDP keys
// the page renders a "warming up" state instead of erroring.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { CDP_TOOLS } from "./tools/cdp-kit.js";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sequential + 429-retry: CDP rate-limits concurrent SQL calls, and under the
// 30-minute snapshot cache a few extra seconds per refresh cost nothing.
async function runSql(sql) {
  const tool = CDP_TOOLS.find((t) => t.slug === "onchain-sql");
  for (let attempt = 1; ; attempt++) {
    try {
      return await tool.handler({ sql, cacheSeconds: 900 });
    } catch (e) {
      if (e?.statusCode === 429 && attempt < 4) { await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
}

const utcStamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
const DAY_MS = 24 * 60 * 60 * 1000;

// Daily settlements over the last 30 days — from AuthorizationUsed ALONE.
// Every EIP-3009 settle emits exactly one AuthorizationUsed, and its
// `authorizer` parameter IS the payer, so counts + unique payers need no
// join with the (enormous) Transfer stream. The joined 30-day variant blew
// CDP's per-query budget (HTTP 502); this one is cheap at any window.
const dailyQuery = (since) => `
SELECT
  toDate(block_timestamp) AS day,
  count() AS settlements,
  uniqExact(toString(parameters['authorizer'])) AS payers
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'AuthorizationUsed'
  AND block_timestamp >= '${since}'
GROUP BY day
ORDER BY day DESC
LIMIT 31`;

// Dollar volume needs the Transfer values, so it joins — bounded to 7 days,
// the window the engine handles comfortably (validated live in CI).
const volumeQuery = (since) => `
WITH auth_txs AS (
  SELECT DISTINCT transaction_hash
  FROM base.events
  WHERE address = '${USDC_BASE}'
    AND event_name = 'AuthorizationUsed'
    AND block_timestamp >= '${since}'
)
SELECT
  count() AS settlements,
  uniqExact(toString(parameters['from'])) AS payers,
  uniqExact(toString(parameters['to'])) AS merchants,
  sum(toUInt256OrZero(toString(parameters['value']))) AS volume_units
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'Transfer'
  AND block_timestamp >= '${since}'
  AND transaction_hash IN (SELECT transaction_hash FROM auth_txs)
LIMIT 1`;

// Top receiving wallets (merchants) over the last 7 days.
const merchantsQuery = (since) => `
WITH auth_txs AS (
  SELECT DISTINCT transaction_hash
  FROM base.events
  WHERE address = '${USDC_BASE}'
    AND event_name = 'AuthorizationUsed'
    AND block_timestamp >= '${since}'
)
SELECT
  toString(parameters['to']) AS merchant,
  count() AS payments,
  uniqExact(parameters['from']) AS payers,
  sum(toUInt256OrZero(toString(parameters['value']))) AS volume_units
FROM base.events
WHERE address = '${USDC_BASE}'
  AND event_name = 'Transfer'
  AND block_timestamp >= '${since}'
  AND transaction_hash IN (SELECT transaction_hash FROM auth_txs)
GROUP BY merchant
ORDER BY payments DESC
LIMIT 12`;

const usd = (units) => Number(units || 0) / 1e6;

let cached = null;
let cachedAt = 0;
export async function x402EconomySnapshot() {
  if (cached && Date.now() - cachedAt < 30 * 60 * 1000) return cached;
  const out = {
    spec: "agent402-x402-economy/1",
    asOf: new Date().toISOString(),
    method: "EIP-3009 gasless USDC settlements on Base: Transfer events whose transaction also emitted AuthorizationUsed on the USDC contract — the settlement primitive x402 uses, measured chain-wide across every seller.",
    chain: "base (eip155:8453)",
    daily: [], topMerchants: [], totals: {}, errors: [],
  };
  const settle = (p) => p.then((value) => ({ status: "fulfilled", value })).catch((reason) => ({ status: "rejected", reason }));
  // Sequential on purpose — see runSql. allSettled semantics preserved so one
  // failed query still leaves the others rendering.
  const dailyRes = await settle(runSql(dailyQuery(utcStamp(30 * DAY_MS))));
  const volRes = await settle(runSql(volumeQuery(utcStamp(7 * DAY_MS))));
  const merchRes = await settle(runSql(merchantsQuery(utcStamp(7 * DAY_MS))));
  if (dailyRes.status === "fulfilled") {
    out.daily = (dailyRes.value.rows || []).map((r) => ({
      day: r.day,
      settlements: Number(r.settlements),
      payers: Number(r.payers),
    }));
    out.totals.last30d = { settlements: out.daily.reduce((s, d) => s + d.settlements, 0) };
  } else {
    out.errors.push(`daily: ${String(dailyRes.reason?.message || dailyRes.reason).slice(0, 200)}`);
  }
  if (volRes.status === "fulfilled") {
    const r = volRes.value.rows?.[0] || {};
    out.totals.last7d = {
      settlements: Number(r.settlements || 0),
      payers: Number(r.payers || 0),
      merchants: Number(r.merchants || 0),
      volumeUsd: Number(usd(r.volume_units).toFixed(2)),
    };
  } else {
    out.errors.push(`volume: ${String(volRes.reason?.message || volRes.reason).slice(0, 200)}`);
  }
  if (merchRes.status === "fulfilled") {
    out.topMerchants = (merchRes.value.rows || []).map((r) => ({
      merchant: r.merchant,
      payments: Number(r.payments),
      payers: Number(r.payers),
      volumeUsd: Number(usd(r.volume_units).toFixed(2)),
    }));
  } else {
    out.errors.push(`merchants: ${String(merchRes.reason?.message || merchRes.reason).slice(0, 200)}`);
  }
  // Only cache successful reads for the full window; retry errors sooner.
  cached = out;
  cachedAt = out.errors.length ? Date.now() - 25 * 60 * 1000 : Date.now();
  return out;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

export function x402EconomyPage(baseUrl, snap) {
  const canonical = baseUrl + "/x402-economy";
  const title = "x402 Economy Observatory — live on-chain settlement analytics";
  const description =
    "Live, chain-wide analytics on the x402 economy: gasless EIP-3009 USDC settlements on Base — daily volume, unique payers, and the top-earning seller wallets — measured at the raw settlement primitive across every seller (registered anywhere or not), with the one-sentence methodology stated and the underlying query buyable as an x402 tool.";
  const t7 = snap.totals?.last7d || { settlements: 0, volumeUsd: 0, payers: 0 };
  const t30 = snap.totals?.last30d || { settlements: 0 };
  const stat = (label, value) => `
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:16px 20px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);">${esc(label)}</div>
      <div style="font-family:var(--font-mono);font-size:26px;font-weight:800;margin-top:6px;">${value}</div>
    </div>`;
  const maxSett = Math.max(1, ...snap.daily.map((d) => d.settlements));
  const body = `
  <main style="max-width:1100px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/x402-economy</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);">The x402 economy, measured.</h1>
    <p style="font-size:16px;line-height:1.6;color:var(--muted);max-width:680px;margin:0 0 26px;">
      Every gasless <strong style="color:var(--ink);">EIP-3009 USDC settlement on Base</strong> — the primitive x402 payments use —
      counted chain-wide across every seller, straight from decoded on-chain events. Machine-readable at
      <a href="/api/x402-economy">/api/x402-economy</a>; the data flows through the same
      <a href="/tools/onchain-sql">onchain-sql</a> tool any agent can buy for $0.02.
    </p>
    ${snap.errors?.length && !snap.daily.length
      ? `<div style="border:1.5px dashed var(--ink);padding:18px 20px;font-family:var(--font-mono);font-size:13px;color:var(--muted);">observatory warming up — data source unavailable right now (detail in <a href="/api/x402-economy">/api/x402-economy</a>)</div>`
      : `
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:0 0 30px;">
      ${stat("SETTLEMENTS · 7D", fmt(t7.settlements))}
      ${stat("VOLUME · 7D", "$" + fmt(t7.volumeUsd))}
      ${stat("UNIQUE PAYERS · 7D", fmt(t7.payers))}
      ${stat("SETTLEMENTS · 30D", fmt(t30.settlements))}
    </div>
    <h2 style="font-size:24px;font-weight:800;margin:0 0 12px;">Daily settlements (30 days)</h2>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;margin:0 0 30px;font-family:var(--font-mono);font-size:12.5px;">
      ${snap.daily.map((d) => `
        <div style="display:grid;grid-template-columns:90px 1fr 220px;gap:12px;align-items:center;padding:3px 0;">
          <span style="color:var(--muted);">${esc(d.day)}</span>
          <span style="display:block;height:12px;background:var(--accent);opacity:.85;width:${Math.max(1, Math.round((d.settlements / maxSett) * 100))}%;"></span>
          <span>${fmt(d.settlements)} settlements · ${fmt(d.payers)} payers</span>
        </div>`).join("")}
    </div>
    <h2 style="font-size:24px;font-weight:800;margin:0 0 12px;">Top seller wallets (7 days)</h2>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;margin:0 0 26px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:13px;">
        <tr style="text-align:left;color:var(--muted);font-size:11px;letter-spacing:.06em;"><th style="padding:4px 8px;">WALLET</th><th style="padding:4px 8px;">PAYMENTS</th><th style="padding:4px 8px;">PAYERS</th><th style="padding:4px 8px;">VOLUME</th></tr>
        ${snap.topMerchants.map((m) => `
          <tr style="border-top:1px dashed #b3a98f;">
            <td style="padding:6px 8px;"><a href="https://basescan.org/address/${esc(m.merchant)}" rel="noopener">${esc(short(m.merchant))}</a></td>
            <td style="padding:6px 8px;">${fmt(m.payments)}</td>
            <td style="padding:6px 8px;">${fmt(m.payers)}</td>
            <td style="padding:6px 8px;">$${fmt(m.volumeUsd)}</td>
          </tr>`).join("")}
      </table>
    </div>`}
    <p style="font-size:13.5px;color:var(--muted);max-width:720px;">
      Method: Transfer events on Base USDC whose transaction also emitted AuthorizationUsed — i.e. gasless
      <code>transferWithAuthorization</code> (EIP-3009), the exact settlement x402 facilitators relay. This measures the
      whole ecosystem, not just Agent402; any non-x402 gasless USDC transfer using the same primitive is included.
      Data refreshes every 30 minutes via Coinbase's decoded onchain dataset. As of ${esc(snap.asOf)}.
    </p>
  </main>
  ${ledgerFooterCompact(baseUrl)}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/x402-economy",
    jsonLd: { "@context": "https://schema.org", "@type": "Dataset", name: "x402 Economy — gasless USDC settlements on Base", url: canonical, description, creator: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl } },
    body,
  });
}
