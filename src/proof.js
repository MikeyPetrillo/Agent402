// /proof - receipts for the metered tier: the settled amount next to the
// quoted ceiling, with the settle transaction, so "you pay for what the model
// used, under a price you saw first" is a fact anyone can check on-chain
// rather than a sentence on /why.
//
// Privacy posture, same as /api/revenue/mpp: aggregates plus ONE latest
// external row and ONE latest internal (daily canary) row. No payer, no
// per-call feed. The internal row is labelled as ours in the copy.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const EXPLORER = {
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  optimism: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  avalanche: (h) => `https://snowtrace.io/tx/${h}`,
  celo: (h) => `https://celoscan.io/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
  tempo: (h) => `https://explore.tempo.xyz/tx/${h}`,
};
export function txLink(network, tx) {
  if (!tx) return null;
  const f = EXPLORER[String(network || "").toLowerCase()];
  return f ? f(tx) : null;
}

const usd = (n) => (n == null ? "n/a" : `$${Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);
const pct = (settled, quoted) => (quoted ? `${Math.round((settled / quoted) * 100)}%` : "n/a");

function rowHtml(label, side, note) {
  const l = side.latest;
  if (!l) {
    return `<div style="background:var(--card);border:1px solid var(--hairline);padding:22px 24px;">
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:10px;">${esc(label)}</div>
  <p style="margin:0;color:var(--muted);font-size:15px;line-height:1.55;">No settlement recorded yet.${note ? ` ${esc(note)}` : ""}</p>
</div>`;
  }
  const link = txLink(l.network, l.tx);
  const txCell = l.tx ? (link ? `<a href="${esc(link)}" rel="noopener" style="color:var(--ink);word-break:break-all;">${esc(l.tx)}</a>` : `<span style="word-break:break-all;">${esc(l.tx)}</span>`) : "n/a";
  return `<div style="background:var(--card);border:1px solid var(--hairline);padding:22px 24px;">
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:12px;">${esc(label)}</div>
  <dl style="display:grid;grid-template-columns:150px 1fr;gap:8px 16px;margin:0;font-size:15px;line-height:1.5;">
    <dt style="color:var(--muted);">quoted ceiling</dt><dd style="margin:0;color:var(--ink);font-family:var(--font-mono);">${esc(usd(l.quoteUsd))}</dd>
    <dt style="color:var(--muted);">settled</dt><dd style="margin:0;color:var(--ink);font-family:var(--font-mono);">${esc(usd(l.settledUsd))}${l.quoteUsd != null ? ` <span style="color:var(--muted);">(${esc(pct(l.settledUsd, l.quoteUsd))} of the ceiling)</span>` : ""}</dd>
    <dt style="color:var(--muted);">network / wire</dt><dd style="margin:0;color:var(--ink);font-family:var(--font-mono);">${esc(l.network || "n/a")} / ${esc(l.wire || l.rail || "n/a")}</dd>
    <dt style="color:var(--muted);">settle tx</dt><dd style="margin:0;font-family:var(--font-mono);font-size:13px;">${txCell}</dd>
    <dt style="color:var(--muted);">when</dt><dd style="margin:0;color:var(--ink);font-family:var(--font-mono);">${esc(l.atPrecision === "hour" ? `${l.at.slice(0, 13).replace("T", " ")}:00` : l.at.slice(0, 16).replace("T", " "))} UTC${l.atPrecision === "hour" ? " (to the hour)" : ""}</dd>
  </dl>
  ${note ? `<p style="margin:14px 0 0;color:var(--muted);font-size:13px;line-height:1.5;">${esc(note)}</p>` : ""}
  <p style="margin:10px 0 0;color:var(--muted);font-size:13px;line-height:1.5;">Aggregate on this side of the ledger: ${side.count} settlement${side.count === 1 ? "" : "s"}, ${esc(usd(side.settledUsd))} settled${side.quotedUsd != null ? ` against ${esc(usd(side.quotedUsd))} quoted (${side.quotedCount} rows carry a quote)` : ""}.</p>
</div>`;
}

export function proofPage(baseUrl, feed) {
  const canonical = `${baseUrl}/proof`;
  const title = "Receipts: settled under the quoted ceiling";
  const description = "The metered model route quotes a ceiling before payment and settles what the call actually used. This page shows the latest settlement next to its quote, with the on-chain transaction, plus the aggregate.";
  const ext = feed?.external || { count: 0, latest: null };
  const int = feed?.internal || { count: 0, latest: null };
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/why" style="color:var(--muted);text-decoration:none;">why pay here</a> / <span style="color:var(--ink);">receipts</span>
    </nav>
    <h1 style="font-weight:800;font-size:48px;line-height:.98;letter-spacing:-.035em;margin:0 0 20px;color:var(--ink);max-width:900px;">Settled under the ceiling you saw first.</h1>
    <p style="font-size:17px;line-height:1.6;color:var(--muted);max-width:820px;margin:0;">Every call to the metered route (<code>POST /v1/metered/chat/completions</code>) is quoted from its own body before payment. A buyer whose client speaks the <code>upto</code> scheme, or who pays by card or credits, settles what the call actually used, times 1.15, never more than the quote. The ledger records both numbers per settlement; the settle transaction is on-chain. Machine-readable: <a href="/api/proof" style="color:var(--ink);">/api/proof</a>.</p>
  </div>
</header>
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 56px;display:grid;gap:18px;">
  ${rowHtml("LATEST EXTERNAL SETTLEMENT (a buyer that is not us)", ext, ext.latest ? "" : "The metered route is new; this row fills in with the first outside buyer's settlement.")}
  ${rowHtml("LATEST INTERNAL SETTLEMENT (our own daily canary, paying with our own wallet)", int, "Internal by construction: the CI canary buys this route every day from our burner wallet to prove the settle-actual path, and the ledger files it as ours, never as revenue.")}
  <p style="font-size:14px;line-height:1.6;color:var(--muted);margin:6px 0 0;">Nothing here identifies a buyer. The rest of the proof lives on <a href="/status" style="color:var(--ink);">/status</a> (uptime observed from outside production), <a href="/revenue" style="color:var(--ink);">/revenue</a> (transactions by rail and wire) and the <a href="https://github.com/MikeyPetrillo/Agent402" style="color:var(--ink);">source</a>.</p>
</section>
${ledgerFooterCompact()}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/proof", body, robots: undefined, jsonLd: [{ "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Why pay here", item: `${baseUrl}/why` },
    { "@type": "ListItem", position: 3, name: "Receipts", item: canonical },
  ] }] });
}
