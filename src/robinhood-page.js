// /robinhood — dedicated landing for the USDG / Robinhood Chain payment rail.
// The head-term SEO page while the space is empty (the chain is days old);
// the /guides/usdg-payments-robinhood-chain guide stays the deep-dive. All
// rail facts derive from src/rails.js so the page can never disagree with
// what the paywall actually offers.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS, RAILS_SHORT } from "./rails.js";

const RH = RAILS.find((r) => r.caip2 === "eip155:4663") || { name: "Robinhood Chain", asset: "USDG", chainId: 4663, caip2: "eip155:4663" };
const USDG_CONTRACT = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const PROOF_TX = "0xae8e3e4048a28a1db30ad17ac83d998885623c764d0e3d27abf8e817f578f826";

export function robinhoodPage(baseUrl) {
  const canonical = baseUrl + "/robinhood";
  const title = "USDG payments on Robinhood Chain — Agent402";
  const description =
    `Agent402 settles x402 payments in ${RH.asset} (Global Dollar) on ${RH.name} (chain id ${RH.chainId}) — live since day 2 of mainnet, verifiable on-chain. ` +
    `1,407 pay-per-call tools for AI agents: ${RAILS_SHORT}.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: "USDG payments on Robinhood Chain over x402",
    url: canonical,
    description,
    publisher: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
  };

  const body = `
  <main style="max-width:900px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ eip155:${RH.chainId} · ${RH.asset}</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em;margin:0 0 14px;color:var(--ink);">${RH.asset} payments on ${RH.name}.</h1>
    <p style="font-size:17px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 10px;">
      Every paid tool on Agent402 accepts <strong style="color:var(--ink);">${RH.asset} (Global Dollar)</strong> on
      ${RH.name} — the same x402 flow as USDC, gasless for the buyer, settled on-chain in seconds. Live since
      the chain's second day of mainnet, and re-proven daily by an automated on-chain canary purchase.
    </p>
    <p style="font-size:15px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 34px;">
      Verify it yourself: <a href="https://robinhoodchain.blockscout.com/tx/${PROOF_TX}" rel="noopener">a real settlement on Blockscout</a> ·
      <a href="${baseUrl}/.well-known/x402">the machine-readable manifest</a> ·
      <a href="${baseUrl}/guides/usdg-payments-robinhood-chain">the full integration guide</a>.
    </p>

    <div style="border:1.5px solid var(--ink);background:var(--card);padding:20px 22px;margin:0 0 34px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed #b3a98f;padding-bottom:10px;margin-bottom:12px;">·· CHAIN PARAMETERS ··</div>
      <div style="display:grid;grid-template-columns:180px 1fr;gap:8px 18px;font-family:var(--font-mono);font-size:13.5px;">
        <span style="color:var(--muted);">chain id</span><span>${RH.chainId} (CAIP-2 <code>${RH.caip2}</code>)</span>
        <span style="color:var(--muted);">rpc</span><span><code>https://rpc.mainnet.chain.robinhood.com</code></span>
        <span style="color:var(--muted);">explorer</span><span><code>robinhoodchain.blockscout.com</code></span>
        <span style="color:var(--muted);">stablecoin</span><span>${RH.asset} (Global Dollar) — <code>${USDG_CONTRACT}</code>, 6 decimals</span>
        <span style="color:var(--muted);">EIP-712 domain</span><span>name <code>"Global Dollar"</code>, version <code>"1"</code></span>
      </div>
    </div>

    <h2 style="font-size:26px;font-weight:800;margin:0 0 10px;">Pay a tool in ${RH.asset}</h2>
    <p style="font-size:15px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 14px;">
      Multi-chain sellers list Base first, so pin the chain. With
      <a href="https://www.npmjs.com/package/agent402-client" rel="noopener">agent402-client</a> it's one call —
      or set <code>AGENT402_NETWORKS=robinhood</code> on
      <a href="https://www.npmjs.com/package/agent402-mcp" rel="noopener">agent402-mcp</a> and every MCP tool call settles in ${RH.asset}:
    </p>
    <pre style="border:1.5px solid var(--ink);background:#151310;color:#e8e2d2;padding:18px 20px;overflow-x:auto;font-family:var(--font-mono);font-size:13px;line-height:1.55;margin:0 0 34px;"><code>import { withNetworkPreference } from "agent402-client";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
registerExactEvmScheme(client, { signer });      // a wallet holding ${RH.asset} on chain ${RH.chainId}
withNetworkPreference(client, ["robinhood"]);    // pin the rail
const payFetch = wrapFetchWithPayment(fetch, client);
await payFetch("${baseUrl}/api/hash", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) });</code></pre>

    <h2 style="font-size:26px;font-weight:800;margin:0 0 10px;">Accept ${RH.asset} as a seller</h2>
    <p style="font-size:15px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 14px;">
      The <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open-source server</a> ships the rail — enabling it is config
      (<code>PAYMENT_NETWORKS=…,robinhood</code> + <code>ROBINHOOD_FACILITATOR_URL</code>), and
      <a href="https://www.npmjs.com/package/agent402-tollbooth" rel="noopener">agent402-tollbooth</a> can charge crawlers in ${RH.asset}
      (<code>TOLLBOOTH_NETWORK=${RH.caip2} TOLLBOOTH_ASSET=${RH.asset}</code>). The
      <a href="${baseUrl}/guides/usdg-payments-robinhood-chain">guide</a> covers the whole path, including how to
      recognize an x402 settlement on Blockscout.
    </p>
    <p style="font-size:15px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 34px;">
      Looking for other sellers on this chain? The neutral router takes a network filter:
      <code><a href="${baseUrl}/api/route?q=search&network=robinhood">/api/route?q=…&amp;network=robinhood</a></code>.
    </p>
  </main>
  ${ledgerFooterCompact(baseUrl)}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/robinhood", jsonLd, body });
}
