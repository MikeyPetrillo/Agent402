// Who a payTo belongs to. Built from public discovery data only, refreshed on
// a timer, served from memory. A failed refresh keeps the last directory.
//   - Coinbase Bazaar discovery feed: Base payTo -> service name, icon, origin
//   - agent402 public leaderboards: names for wallets the crawl knows, and the
//     MPP recipients with their sellers
//   - MPPScan's public server list: MPP seller names and logos
// agent402's own surfaces are read at most every LIVE_DIRECTORY_REFRESH_MS
// (default 30 min) and served from their own caches there.

const BAZAAR_URL = process.env.LIVE_BAZAAR_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const AGENT402 = (process.env.LIVE_AGENT402_URL || "https://agent402.tools").replace(/\/+$/, "");
const MPPSCAN_URL = process.env.LIVE_MPPSCAN_URL || "https://www.mppscan.com/api/trpc/servers.list?input=%7B%22json%22%3A%7B%22timeframeDays%22%3A0%7D%7D";
// agent402's own payTo on both chains (public in every 402 it serves).
export const AGENT402_PAYTOS = new Set((process.env.LIVE_AGENT402_PAYTOS || "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
// Wallets whose payments are agent402's own test and volume traffic; shown
// as such, never as outside demand. Set on the service, not in the repo.
export const INTERNAL_PAYERS = new Set((process.env.LIVE_INTERNAL_PAYERS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a);
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };
const originOf = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.origin : null; } catch { return null; } };
const cleanText = (s, n = 60) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

async function getJson(url, fetchImpl, timeoutMs = 20_000) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "agent402-live/1 (+https://agent402.tools)" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${hostOf(url)} HTTP ${res.status}`);
  return res.json();
}

/** Bazaar items -> Map(payTo -> {name, icon, origin, endpoints}). Pure. */
export function bazaarDirectory(items) {
  const byPayTo = new Map();
  for (const it of items || []) {
    const acc = (Array.isArray(it?.accepts) ? it.accepts : []).find((a) => {
      const n = String(a?.network || "").toLowerCase();
      return (n === "eip155:8453" || n === "base") && String(a?.asset || "").toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    });
    const payTo = String(acc?.payTo || "").toLowerCase();
    if (!isAddr(payTo)) continue;
    const origin = originOf(it.resource);
    const row = byPayTo.get(payTo) || { names: new Map(), icon: null, origin: null, endpoints: new Set() };
    const name = cleanText(it?.serviceName || it?.extensions?.bazaar?.info?.serviceName || it?.extensions?.bazaar?.serviceName || "");
    if (name) row.names.set(name, (row.names.get(name) || 0) + 1);
    const icon = it?.iconUrl || it?.extensions?.["x402-merchant"]?.info?.logo || it?.extensions?.bazaar?.info?.icon_url;
    if (!row.icon && originOf(icon)) row.icon = String(icon);
    if (!row.origin && origin) row.origin = origin;
    if (originOf(it.resource) && row.endpoints.size < 20) row.endpoints.add(String(it.resource).slice(0, 200));
    byPayTo.set(payTo, row);
  }
  const out = new Map();
  for (const [payTo, r] of byPayTo) {
    const top = [...r.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    out.set(payTo, { name: top || hostOf(r.origin) || null, icon: r.icon, origin: r.origin, endpoints: [...r.endpoints] });
  }
  return out;
}

export function makeDirectory({ fetchImpl = fetch, log = console } = {}) {
  let base = new Map();          // payTo -> seller
  let mpp = new Map();           // recipient -> seller
  let mppLogos = new Map();      // origin -> logo url
  let refreshedAt = null, lastError = null;

  async function refreshBazaar() {
    const items = [];
    for (let offset = 0, page = 0; page < 40; page++, offset += 1000) {
      const j = await getJson(`${BAZAAR_URL}?limit=1000&offset=${offset}`, fetchImpl);
      const got = j.items || j.resources || [];
      items.push(...got);
      const total = Number(j.pagination?.total ?? 0);
      if (!got.length || (total && items.length >= total)) break;
    }
    return bazaarDirectory(items);
  }

  async function refreshAgent402(next) {
    const lb = await getJson(`${AGENT402}/api/leaderboard?top=50`, fetchImpl);
    for (const r of lb.leaderboard || []) {
      for (const w of r.wallets || [r.wallet]) {
        const k = String(w || "").toLowerCase();
        if (!isAddr(k) || next.has(k)) continue;
        next.set(k, { name: cleanText(r.name) || hostOf(r.homepage), icon: null, origin: originOf(r.homepage) || originOf(r.origins?.[0]), endpoints: [] });
      }
    }
  }

  async function refreshMpp() {
    const next = new Map();
    const j = await getJson(`${AGENT402}/api/mpp-leaderboard`, fetchImpl);
    for (const r of j.rows || []) {
      const k = String(r.recipient || "").toLowerCase();
      if (!isAddr(k)) continue;
      const first = (r.sellers || [])[0] || {};
      const more = Math.max(0, (r.sellers || []).length - 1);
      // One recipient can be shared by many sellers (a payment gateway): the
      // payment is to the recipient, so it is labelled as shared rather than
      // credited to whichever seller happens to be listed first.
      const name = more ? `Shared recipient · ${more + 1} sellers` : (cleanText(first.name) || hostOf(first.origin));
      next.set(k, { name, icon: null, origin: more ? null : originOf(first.origin), endpoints: (r.sellers || []).slice(0, 8).map((s) => originOf(s.origin)).filter(Boolean), self: r.self === true, shared: more > 0 });
    }
    return next;
  }

  async function refreshMppLogos() {
    const j = await getJson(MPPSCAN_URL, fetchImpl);
    const rows = j?.result?.data?.json?.origins || j?.result?.data?.json?.items || [];
    const out = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const o = originOf(r?.url), logo = r?.logoUrl || r?.logo;
      if (o && originOf(logo)) out.set(o, String(logo));
    }
    return out;
  }

  async function refresh() {
    const errors = [];
    try { const b = await refreshBazaar(); try { await refreshAgent402(b); } catch (e) { errors.push(`agent402 leaderboard: ${e.message}`); } base = b; } catch (e) { errors.push(`bazaar: ${e.message}`); }
    try { mpp = await refreshMpp(); } catch (e) { errors.push(`mpp leaderboard: ${e.message}`); }
    try { mppLogos = await refreshMppLogos(); } catch (e) { errors.push(`mppscan: ${e.message}`); }
    for (const s of mpp.values()) if (!s.icon && s.origin && mppLogos.has(s.origin)) s.icon = mppLogos.get(s.origin);
    refreshedAt = Date.now();
    lastError = errors.length ? errors.join("; ").slice(0, 300) : null;
    if (lastError) log.warn?.(`[live:directory] ${lastError}`);
    log.log?.(`[live:directory] base ${base.size} payTos, mpp ${mpp.size} recipients`);
  }

  /** The seller a payment went to, or an "unlisted" placeholder. */
  function lookup(chain, payTo) {
    const s = (chain === "mpp" ? mpp : base).get(payTo);
    const agent402 = AGENT402_PAYTOS.has(payTo) || s?.self === true;
    if (agent402) return { key: `${chain}:${payTo}`, name: "Agent402", origin: "https://agent402.tools", icon: null, agent402: true, listed: true, endpoints: [] };
    if (!s) return { key: `${chain}:${payTo}`, name: `${payTo.slice(0, 6)}…${payTo.slice(-4)}`, origin: null, icon: null, agent402: false, listed: false, endpoints: [] };
    return { key: `${chain}:${payTo}`, name: s.name || `${payTo.slice(0, 6)}…${payTo.slice(-4)}`, origin: s.origin, icon: s.icon, agent402: false, listed: true, endpoints: s.endpoints || [] };
  }

  return {
    refresh,
    lookup,
    mppRecipients: () => new Set([...mpp.keys(), ...AGENT402_PAYTOS]),
    status: () => ({ basePayTos: base.size, mppRecipients: mpp.size, mppLogos: mppLogos.size, refreshedAt, lastError }),
  };
}
