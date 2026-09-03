// The MPP marketplace (/mpp-marketplace) - a live, independently-verified
// directory of sellers on the MPP payment protocol, parallel to the x402
// marketplace (src/market-page.js) but a different seller population and a
// much simpler data model: no on-chain settlement join (MPP sellers aren't
// necessarily on our own leaderboard - we don't have call/volume data for
// them), just what the mpp.dev registry advertises plus our own live
// verification of it (src/mpp-index.js).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { mppChallengeRails } from "./mpp-shim.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { mppCrawlIntervalLabel } from "./mpp-index.js";
import { hostRowHtml } from "./host-entry.js";

// Crawled seller data is third-party input: only http(s) may become an href,
// same rule market-page.js uses for the exact same reason.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");

const CSS = `
.mpr-row{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start;padding:14px 16px;border:1px solid var(--hairline);background:var(--card)}
.mpr-name{font-weight:700;font-size:14.5px;color:var(--ink);text-decoration:none}
.mpr-host{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:2px}
.mpr-desc{font-size:13.5px;line-height:1.5;color:var(--muted);margin:8px 0}
.mpr-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.mpr-tag{font-family:var(--font-mono);font-size:10.5px;color:var(--faint);border:1px solid var(--hairline);padding:2px 6px}
.mpr-endpoint{font-family:var(--font-mono);font-size:11.5px;color:var(--on-dark2);background:var(--surface);padding:6px 9px;margin-top:8px;display:inline-block}
.mpr-verified{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11.5px;color:var(--green);white-space:nowrap}
.mpr-dot{width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block}
.mkt-search-wrap{border:1px solid var(--hairline)}
.mkt-search-wrap:focus-within{border-color:var(--accent)}
.mpr-proven{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;color:var(--ink);border:1px solid var(--ink);padding:2px 7px;margin-left:8px;white-space:nowrap}
.mlb-scroll{overflow-x:auto}
.mlb-scroll table{border-collapse:collapse;width:100%;min-width:860px;font-size:13.5px}
.mlb-scroll th{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;text-align:left;padding:10px 12px;border-bottom:1px solid var(--hairline)}
.mlb-scroll td{padding:10px 12px;border-bottom:1px solid var(--hairline);vertical-align:top}
.mlb-scroll td.num{font-family:var(--font-mono);text-align:right;white-space:nowrap}
.mlb-scroll th.num{text-align:right}
.mlb-addr{font-family:var(--font-mono);font-size:11.5px;color:var(--faint);text-decoration:none}
@media (max-width: 900px){.mpr-row{grid-template-columns:1fr}}
`;

function agoLabel(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
}

const shortAddr = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "");
const fmtUsd = (n) => (Number(n) >= 100 ? `$${Math.round(Number(n)).toLocaleString("en-US")}` : `$${Number(n || 0).toFixed(2)}`);

/** Leaderboard section: verified MPP sellers ranked by inbound USDC.e transfers
 *  on Tempo to the recipient their LIVE challenge names (src/mpp-leaderboard.js).
 *  A window, not lifetime, and a proxy (any inbound transfer), both said in the
 *  copy. Rows with zero transfers are counted, never listed. */
function leaderboardHtml(lb, host = null) {
  const rows = Array.isArray(lb?.rows) ? lb.rows : [];
  const active = rows.filter((r) => r.transfers > 0 || (r.d30?.transfers || 0) > 0);
  const hours = lb?.window?.approxHours;
  const hist = lb?.history;
  const histNote = hist?.since ? ` Rolling 7d/30d columns sum what we observed since ${esc(hist.since)} (${hist.daysCovered || Object.keys(hist.days || {}).length} UTC day${(hist.daysCovered || 1) === 1 ? "" : "s"}${hist.gaps ? `, ${hist.gaps} refresh gap${hist.gaps === 1 ? "" : "s"} lost blocks` : ""}) - a running total from that date, not lifetime.` : "";
  const viaFeed = lb?.window?.source === "tempo-api";
  const windowLabel = viaFeed ? `last ${hours}h` : (hours ? `last ~${hours}h` : "recent window");
  const windowSource = viaFeed
    ? "read from Tempo's transfer index (a 24-hour time window)"
    : `read from the chain by us over the ${esc(windowLabel)} (${lb?.window?.blocks ? `${lb.window.blocks.toLocaleString("en-US")} blocks` : "rpc window"})`;
  const staleNote = lb?.stale
    ? `<span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);margin-left:10px;">stale &middot; last good read ${lb.generatedAt ? esc(agoLabel(lb.generatedAt)) : "never"}${lb.lastError ? ` &middot; ${esc(lb.lastError)}` : ""}</span>`
    : (lb?.generatedAt ? `<span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);margin-left:10px;">read on chain ${esc(agoLabel(lb.generatedAt))}</span>` : "");
  const explorer = "https://explore.tempo.xyz/address/";
  const MAX_NAMES = 4;
  const trs = active.map((r) => {
    const all = r.sellers || [];
    const shown = all.slice(0, MAX_NAMES).map((x) => `<a href="${safeHref(x.url || x.origin)}" rel="noopener" style="color:var(--ink);text-decoration:none;font-weight:700;">${esc(x.name)}</a>`).join(", ");
    const more = all.length > MAX_NAMES ? ` <span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);" title="${esc(all.slice(MAX_NAMES).map((x) => x.name).join(", "))}">+${all.length - MAX_NAMES} more on this recipient</span>` : "";
    const names = shown + more;
    const who = r.self ? `<span style="font-weight:700;">Agent402</span> <span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);">(this server)</span>${names ? `, ${names}` : ""}` : (names || `<span style="color:var(--faint);">unnamed recipient</span>`);
    return `<tr>
      <td class="num">${r.rank}</td>
      <td>${who}<div><a class="mlb-addr" href="${explorer}${esc(r.recipient)}" rel="noopener">${esc(shortAddr(r.recipient))}</a></div></td>
      <td class="num">${r.transfers.toLocaleString("en-US")}</td>
      <td class="num">${(r.d7?.transfers ?? 0).toLocaleString("en-US")}</td>
      <td class="num">${(r.d30?.transfers ?? 0).toLocaleString("en-US")}</td>
      <td class="num">${r.payers.toLocaleString("en-US")}</td>
      <td class="num">${esc(fmtUsd(r.d7?.volumeUsdc ?? r.volumeUsdc))}</td>
      <td>${r.routable ? `<span class="mpr-proven">routable</span>` : r.proven ? `<span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);" title="On-chain floor met, but the live challenge offers no tempo/charge - the router pays charge only">session only</span>` : `<span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);">below floor (${lb.provenFloor})</span>`}</td>
    </tr>`;
  }).join("");
  const table = active.length
    ? `<div class="mlb-scroll"><table>
      <thead><tr><th class="num">#</th><th>Seller &middot; Tempo recipient</th><th class="num" title="inbound USDC.e transfers in the read window">${esc(windowLabel)}</th><th class="num" title="rolling 7 days of observed transfers">7d</th><th class="num" title="rolling 30 days of observed transfers">30d</th><th class="num" title="distinct payer addresses in the read window">Payers</th><th class="num" title="7-day observed volume">Volume 7d</th><th>Router</th></tr></thead>
      <tbody>${trs}</tbody></table></div>`
    : `<p style="color:var(--muted);font-size:13.5px;margin:0;">${lb?.generatedAt ? "No verified seller's recipient received a USDC.e transfer on Tempo in the window." : "First on-chain read pending - the leaderboard rebuilds every 30 minutes from the verified index above."}</p>`;
  const zero = rows.length - active.length;
  // (rows here are lb.rows; a row is active with a window OR a 30d count)
  return `
  <h2 id="leaderboard" style="font-size:21px;font-weight:800;margin:40px 0 6px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">MPP leaderboard &middot; settled on Tempo${staleNote}</h2>
  <p style="font-size:13px;color:var(--faint);margin:0 0 12px;max-width:820px;">Verified sellers ranked by inbound USDC.e transfers on Tempo (chain 4217) to the recipient address their <em>live</em> MPP challenge names, ${windowSource}. A window, not lifetime; an inbound transfer is the same proxy the <a href="/guides/smart-order-router" style="color:var(--muted);">router</a> requires before it spends (floor ${lb?.provenFloor ?? "-"} in the window = <span class="mpr-proven" style="margin:0;">routable</span>).${histNote} Ranked by 7d, then window. Machine-readable: <a href="/api/mpp-leaderboard" style="color:var(--muted);">/api/mpp-leaderboard</a>.</p>
  ${table}
  ${hostRowHtml(host)}
  ${zero > 0 ? `<p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:10px;">${zero.toLocaleString("en-US")} more verified recipient${zero === 1 ? "" : "s"} with no inbound transfer observed (listed below, not ranked).</p>` : ""}`;
}

function sellerRowHtml(s, lbByRecipient) {
  const endpoint = Array.isArray(s.endpoints) ? s.endpoints[0] : null;
  const rec = (s.offers || []).find((o) => o?.method === "tempo" && o.recipient && lbByRecipient?.has(o.recipient));
  const lbRow = rec ? lbByRecipient.get(rec.recipient) : null;
  const provenHtml = lbRow?.routable ? `<span class="mpr-proven" title="${esc(String(lbRow.transfers))} inbound USDC.e transfers on Tempo in the window">routable &middot; #${lbRow.rank}</span>` : "";
  const endpointHtml = endpoint
    ? `<span class="mpr-endpoint">${esc(String(endpoint.method || "GET").toUpperCase())} ${esc(endpoint.path || "")}${endpoint.payment?.amount ? ` &middot; $${(Number(endpoint.payment.amount) / Math.pow(10, Number(endpoint.payment.decimals ?? 6))).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}` : ""}</span>`
    : "";
  // Categories and tags overlap in real registry data (e.g. a service tagged
  // BOTH category "blockchain" and tag "blockchain" - live-verified against
  // agents.allium.so during development) - dedup or the row shows the same
  // word twice.
  const tags = [...new Set([...(s.categories || []), ...(s.tags || [])])].slice(0, 6);
  const tagsHtml = tags.length ? `<div class="mpr-tags">${tags.map((t) => `<span class="mpr-tag">${esc(t)}</span>`).join("")}</div>` : "";
  const docsLinks = [
    s.docs?.homepage ? `<a href="${safeHref(s.docs.homepage)}" rel="noopener" style="color:var(--muted);">homepage</a>` : "",
    s.docs?.llmsTxt ? `<a href="${safeHref(s.docs.llmsTxt)}" rel="noopener" style="color:var(--muted);">llms.txt</a>` : "",
    s.docs?.apiReference ? `<a href="${safeHref(s.docs.apiReference)}" rel="noopener" style="color:var(--muted);">openapi.json</a>` : "",
  ].filter(Boolean).join(" &middot; ");
  return `<div class="mpr-row">
    <div>
      <a href="${safeHref(s.url || s.origin)}" rel="noopener" class="mpr-name">${esc(s.name)}</a>
      <div class="mpr-host">${esc(String(s.origin || "").replace(/^https?:\/\//, ""))}</div>
      ${s.description ? `<p class="mpr-desc">${esc(s.description)}</p>` : ""}
      ${endpointHtml}
      ${tagsHtml}
      ${docsLinks ? `<div style="font-family:var(--font-mono);font-size:11px;margin-top:8px;">${docsLinks}</div>` : ""}
    </div>
    <span class="mpr-verified"><span class="mpr-dot"></span>verified &middot; probed ${esc(agoLabel(s.lastProbeAt))}${provenHtml}</span>
  </div>`;
}

/** @param baseUrl canonical origin
 *  @param snapshot mppIndexSnapshot() result */
export function mppMarketPage(baseUrl, snapshot, leaderboard = null, { host = null } = {}) {
  const sellers = Array.isArray(snapshot?.sellers) ? snapshot.sellers : [];
  const lbByRecipient = new Map((leaderboard?.rows || []).map((r) => [r.recipient, r]));
  const verifiedCount = snapshot?.verifiedSellers || 0;
  const discoveredTotal = snapshot?.discoveredTotal || 0;
  const totalEndpoints = sellers.reduce((sum, s) => sum + (Array.isArray(s.endpoints) ? s.endpoints.length : 0), 0);
  // Which chains WE accept MPP payment on — not a seller directory row, this
  // is Agent402's own settlement support. Derived live from mpp-shim.js so it
  // can never drift from the actual gate (empty when the shim isn't mounted).
  const challengeRails = mppChallengeRails();
  const chainsNote = challengeRails.length
    ? (() => {
        const names = challengeRails.map((r) => esc(r.name));
        const namesJoined = names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : names[0];
        const assetsJoined = [...new Set(challengeRails.map((r) => r.asset))].join(" / ");
        return `<p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:10px 0 0;max-width:640px;">Agent402 itself accepts MPP payment on ${namesJoined} (${esc(assetsJoined)}) - <a href="/what-is-mpp" style="color:inherit;">how MPP works here</a>.</p>`;
      })()
    : "";
  // Tempo is a SEPARATE MPP payment method, not an x402-settled chain (it
  // rides Tempo's own TIP-1034 relay, never @x402/express) — deliberately
  // never folded into chainsNote above, which describes x402-derived rails.
  const tempoNote = tempoEnabled()
    ? `<p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:6px 0 0;max-width:640px;">...and natively via Tempo (its own MPP payment method, not an x402-settled chain).</p>`
    : "";
  const categories = [...new Set(sellers.flatMap((s) => s.categories || []))];

  const rows = sellers
    .slice()
    .sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0))
    .map((s) => sellerRowHtml(s, lbByRecipient))
    .join("");

  const honesty = sellers.length === 0
    ? `<p style="color:var(--muted);font-size:13.5px;">No sellers verified yet - the crawler runs ${mppCrawlIntervalLabel()} and this page updates as soon as one clears live verification. Discovery has found ${discoveredTotal.toLocaleString("en-US")} candidate origin${discoveredTotal === 1 ? "" : "s"} so far.</p>`
    : "";

  const gapNote = discoveredTotal > verifiedCount
    ? `<p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:10px;">${discoveredTotal.toLocaleString("en-US")} candidate origins discovered, ${verifiedCount.toLocaleString("en-US")} independently verified so far - a gap is normal (re-probe pending, or a listing that no longer answers), never hidden.</p>`
    : "";

  const rosterHtml = `
  <h2 id="sellers" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Verified MPP sellers</h2>
  <p style="font-size:13px;color:var(--faint);margin:-6px 0 12px;">Every row here made a real, unpaid request that came back with a genuine WWW-Authenticate: Payment challenge - a registry listing alone is never enough to appear here.</p>
  <div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
  ${honesty}
  ${gapNote}`;

  const statsHtml = `
  <div class="ml-2col ml-4col" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 0;">
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">VERIFIED SELLERS</div><div style="font-size:26px;font-weight:800;">${verifiedCount.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">live-probed, not just registry-listed</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">ENDPOINTS LISTED</div><div style="font-size:26px;font-weight:800;">${totalEndpoints.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">advertised across verified sellers</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">CATEGORIES</div><div style="font-size:26px;font-weight:800;">${categories.length}</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">DISCOVERED TOTAL</div><div style="font-size:26px;font-weight:800;">${discoveredTotal.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">candidates found, verification pending or failed</div></div>
  </div>`;

  const headerHtml = `
  <div>
    <h1 style="font-size:34px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;">The MPP marketplace.</h1>
    <p style="font-size:16.5px;color:var(--muted);margin:0;max-width:640px;">A live-verified index of sellers on the MPP payment protocol - ${verifiedCount.toLocaleString("en-US")} confirmed by a real, unpaid probe of their actual endpoint, not just claimed by a registry.</p>
    ${chainsNote}
    ${tempoNote}
    <div style="margin:18px 0 0;padding:16px 18px;border:1px solid var(--hairline);background:var(--paper);max-width:640px;">
      <div id="list-api">
        <div style="font-weight:800;font-size:15px;margin-bottom:8px;color:var(--ink);">Register in one call</div>
        <label for="reg-origin" style="display:block;font-family:var(--font-mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Your API's origin</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:2 1 220px;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);">
          <input id="reg-path" type="text" placeholder="/v1/priced-endpoint (optional)" aria-label="Priced path to probe (optional)" style="flex:1 1 160px;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);">
          <button id="reg-go" data-endpoint="/api/mpp-index/register" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
        </div>
        <div id="reg-out" role="status" aria-live="polite" data-listed-note="Appears on /mpp-marketplace." style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin for a genuine MPP challenge and list you if it answers. A seller not yet in the mpp.dev registry needs its paywall reachable at the bare origin root to verify today.</div>
      </div>
      <script src="/js/reg-form.js"></script>
    </div>
    ${statsHtml}
  </div>`;

  const methodSection = `
  <div style="padding:26px;border:1px solid var(--hairline);background:var(--card);margin-top:48px;">
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">HOW THIS INDEX IS BUILT</div>
    <h2 style="font-weight:800;font-size:22px;margin:0 0 14px;color:var(--ink);">Crawled and verified, not curated</h2>
    <div style="display:flex;flex-direction:column;">${[
      "Discovery: the public mpp.dev services registry, MPPScan's origin list, and anyone who self-registers at POST /api/mpp-index/register.",
      "Every listed origin gets a real, unpaid request to one of its actual advertised endpoints (from the registry, the seller's own /openapi.json discovery document, or the submitter's hint) - a registry claim alone never counts.",
      "A listing counts as verified only when that request genuinely comes back with a WWW-Authenticate: Payment challenge.",
      `A crawl cycle re-probes every known origin ${mppCrawlIntervalLabel()}; a seller that stops answering drops out of the verified count on its own.`,
    ].map((body_, i) => `<div style="display:grid;grid-template-columns:26px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${String(i + 1).padStart(2, "0")}</span><span style="font-size:13.5px;line-height:1.55;color:var(--muted);">${esc(body_)}</span></div>`).join("")}</div>
    <p style="font-size:13px;line-height:1.6;color:var(--faint);margin:14px 0 0;">Two known scope limits, disclosed rather than hidden: sellers hosted as per-tenant paths on one shared gateway domain aren't discoverable yet, and self-serve registration for a seller not already in the mpp.dev registry probes the bare origin root unless the submitter names the priced path (the optional path field, or a path property in the POST body) - MPP has no standard discovery path the way x402's /.well-known/x402 is.</p>
  </div>`;

  const MPP_FAQS = [
    { q: "What is the MPP marketplace?", a: "A directory of services that accept payments over MPP (the IETF-track \"Payment\" HTTP auth scheme). Every listing here has been independently, live-verified - a real unpaid request confirming the seller's endpoint genuinely answers with a WWW-Authenticate: Payment challenge - not just copied from a registry's claim." },
    { q: "How is this different from Agent402's x402 marketplace?", a: "Different protocol, different seller population, and a separate crawler entirely. An MPP seller isn't necessarily an x402 seller and vice versa; Agent402 itself supports both, as a buyer-facing wire translation on its own tools and as a neutral index for each ecosystem." },
    { q: "How does a seller get listed?", a: "Three ways, all free and automatic: appear in the public mpp.dev registry or on MPPScan (both crawled), answer an MPP challenge on a 402 our x402 crawler already probes (dual-stack sellers are detected without any listing), or register directly - the form above, or POST /api/mpp-index/register with your origin and, optionally, the priced path your 402 lives on. There is no review queue: verification is a real unpaid probe, and a listing appears as soon as it comes back with WWW-Authenticate: Payment." },
    { q: "How is the MPP leaderboard ranked?", a: "By what the chain shows, not by what anyone claims: for every verified seller we take the recipient address its live MPP challenge names, then count inbound USDC.e transfers to that address on Tempo over the most recent read window (24 hours from Tempo's own transfer index when it is available, otherwise about fifteen hours of blocks read from the RPC, its per-query cap), plus distinct payers and volume. It is a window, not lifetime, and an inbound transfer is a proxy for a settlement rather than proof of one - the same proxy Agent402's own router requires before it spends money with a seller, which is why rows at or above the floor are marked routable." },
    { q: "Why do discovered and verified counts differ?", a: "Discovery finds candidate origins from the mpp.dev registry and MPPScan; verification is our own real probe of each one. A gap between the two is normal - a fresh discovery awaiting its first probe, or a listing that no longer answers - and is always shown, never hidden." },
  ];
  const faqHtml = MPP_FAQS.map((f) => `<article style="padding:22px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:17.5px;margin:0 0 10px;color:var(--ink);">${esc(f.q)}</h3><p style="font-size:15px;line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`).join("");
  const faqSection = `
  <div style="max-width:760px;margin:56px 0 0;">
    <h2 style="font-weight:800;font-size:26px;letter-spacing:-.02em;margin:0 0 20px;color:var(--ink);">About this index.</h2>
    <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
  </div>`;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "The MPP marketplace",
      url: `${baseUrl}/mpp-marketplace`,
      description: `Independently-verified sellers on the MPP payment protocol. ${verifiedCount} verified.`,
      mainEntity: { "@type": "OfferCatalog", name: "MPP-payable agent services", numberOfItems: verifiedCount },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402.Tools", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "MPP marketplace", item: `${baseUrl}/mpp-marketplace` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": `${baseUrl}/mpp-marketplace#dataset`,
      name: "MPP seller index",
      description: "Live-verified directory of MPP payment protocol sellers: origin, description, categories, advertised endpoints, and independent probe verification.",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      isAccessibleForFree: true,
      variableMeasured: [
        { "@type": "PropertyValue", name: "verified", description: "Whether a real probe confirmed a genuine WWW-Authenticate: Payment challenge" },
        { "@type": "PropertyValue", name: "categories", description: "Registry-declared service categories" },
        { "@type": "PropertyValue", name: "offers", description: "Payment methods the seller's live challenge offers (method, recipient, currency, chain)" },
        { "@type": "PropertyValue", name: "leaderboard.transfers", description: "Inbound USDC.e transfers on Tempo to the seller's live recipient over the read window" },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "@id": `${baseUrl}/mpp-marketplace#faq`,
      mainEntity: MPP_FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];

  const body = `
<div style="max-width:1080px;margin:0 auto;padding:36px 24px;">
  <section>${headerHtml}</section>
  <section>${leaderboardHtml(leaderboard, host)}</section>
  <section>${rosterHtml}</section>
  <section>${methodSection}</section>
  <section>${faqSection}</section>
  <section>
    <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/mpp-index">/api/mpp-index</a> &middot; <a href="/api/mpp-leaderboard">/api/mpp-leaderboard</a> &middot; upstream registry <a href="https://mpp.dev/api/services">mpp.dev/api/services</a></p>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "MPP marketplace - independently-verified sellers on the MPP protocol",
    description: "A live directory of MPP payment protocol sellers, each independently verified with a real unpaid probe before being listed. Free to browse, free to register.",
    canonical: `${baseUrl}/mpp-marketplace`,
    baseUrl,
    activePath: "/mpp-marketplace",
    jsonLd,
    extraCss: `${CSS}\n@media (max-width: 900px) { .ml-4col { grid-template-columns: repeat(2,1fr) !important; } }`,
    body,
  });
}
