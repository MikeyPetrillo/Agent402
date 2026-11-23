// /aws/start: the setup page for a buyer who arrives from the AWS Marketplace
// listing (its fulfillment URL).
//
// Everything on it is read from the gate this boot built
// (src/aws-marketplace-gate.js): the endpoint, the JWKS and OpenAPI addresses,
// the served tools with their catalog name, purpose and list price, grouped
// with the notice each group is sold under (src/aws-listing.js), and the
// attempt and rate limits the gate enforces. A tool the gate refused at boot
// is not on it.
//
// AWS Marketplace asks that a listing never sends its buyers elsewhere, so the
// page is self-contained: no site navigation or footer, and no link to any
// other surface of this server. Its only links are the /aws addresses, AWS's
// own documentation and the support mailbox (scripts/test-aws-start-page.js
// reads every href). Not indexed.
import { LEDGER_HEAD, LEDGER_CSS, esc, jsSrc, codeBlock } from "./ledger-chrome.js";
import { awsServedGroups, sentencesOf } from "./aws-listing.js";
import { AWS_JWKS_PATH, AWS_NETWORK, AWS_PREFIX } from "./aws-marketplace-gate.js";

export const AWS_START_PATH = `${AWS_PREFIX}/start`;
export const AWS_OPENAPI_PATH = `${AWS_PREFIX}/openapi.json`;
export const AWS_SUPPORT_EMAIL = "help@agent402.tools";
export const AWS_SECURITY_EMAIL = "security@agent402.tools";
const AWS_PAYMENTS_DOC = "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html";

/** A list price as "$0.001". */
export function awsPriceLabel(def) {
  const p = String(def?.price ?? "").trim();
  return p.startsWith("$") ? p : `$${p}`;
}

/**
 * One line on what a tool does: the first sentence of its AWS-facing
 * description (src/aws-listing.js awsDescriptionOf, which already leaves out
 * every sentence that points past the listing), at most `max` characters.
 */
export function awsPurposeOf(def, { describe = (d) => d?.description, max = 180 } = {}) {
  let first = sentencesOf(describe(def))[0] || String(def?.name || def?.slug || "");
  if (first.length > max) {
    const cut = first.slice(0, max - 1);
    first = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:(-]+$/, "")}…`;
  }
  return first;
}

const CSS = `
.aw-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.aw-eyebrow{font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 14px}
.aw-wrap h1{font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.02em;margin:0 0 16px;text-wrap:balance}
.aw-wrap h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:56px 0 14px}
.aw-wrap h3{font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);margin:30px 0 8px}
.aw-lede{font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:76ch;margin:0}
.aw-wrap p,.aw-wrap li{font-size:var(--fs-prose);line-height:1.6;color:var(--muted);max-width:76ch}
.aw-wrap p{margin:0 0 14px}
.aw-wrap ol,.aw-wrap ul{margin:0 0 14px;padding-left:22px}
.aw-wrap li{margin:0 0 8px}
.aw-wrap b{color:var(--ink);font-weight:600}
.aw-wrap a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent)}
.aw-wrap code{font-family:var(--font-mono);font-size:var(--fs-code-inline);overflow-wrap:break-word}
.aw-notice{font-size:var(--fs-base);color:var(--muted);border-left:2px solid var(--hairline);padding:2px 0 2px 12px;margin:0 0 14px;max-width:76ch}
.aw-tablewrap{overflow-x:auto;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--card)}
.aw-table{width:100%;border-collapse:collapse;min-width:640px}
.aw-table caption{text-align:left;padding:0;font-size:0}
.aw-table th,.aw-table td{text-align:left;vertical-align:top;padding:10px 16px;border-top:1px solid var(--hairline);font-size:var(--fs-md);line-height:1.4}
.aw-table thead th{border-top:0;font-family:var(--font-mono);font-size:var(--fs-2xs);font-weight:400;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.aw-table tbody tr:nth-child(even){background:var(--card-zebra)}
.aw-table tbody th{font-family:var(--font-mono);font-size:var(--fs-sm);font-weight:400;color:var(--ink);white-space:nowrap}
.aw-table td{color:var(--muted)}
.aw-table td.aw-price{font-family:var(--font-mono);font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap}
.aw-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 18px;margin:0 0 14px;max-width:900px}
.aw-kv dt{font-size:var(--fs-md);color:var(--ink);font-weight:600}
.aw-kv dd{margin:0;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);overflow-wrap:anywhere}
@media (max-width: 600px){
  .aw-wrap{padding:30px 16px}
  .aw-wrap h1{font-size:var(--fs-2xl)}
  .aw-kv{grid-template-columns:minmax(0,1fr)}
  .aw-kv dd{margin-bottom:8px}
}
`;

/**
 * The page. `defs` is the gate's served set (a Map of slug to catalog
 * definition, in listed order); `config` the gate's settings; `describe` the
 * AWS-facing description of a definition.
 */
export function awsStartPage({ baseUrl, defs, config, describe = (d) => d?.description }) {
  const origin = (() => { try { return new URL(String(baseUrl)).origin; } catch { return String(baseUrl || "").replace(/\/+$/, ""); } })();
  const endpoint = `${origin}${AWS_PREFIX}`;
  const jwks = `${origin}${AWS_JWKS_PATH}`;
  const openapi = `${origin}${AWS_OPENAPI_PATH}`;
  const served = [...(defs?.keys?.() || [])];
  const groups = awsServedGroups(served);
  const prices = served.map((s) => Number(String(defs.get(s).price).replace(/[^0-9.]/g, ""))).filter((n) => n > 0);
  const lo = prices.length ? Math.min(...prices) : 0;
  const hi = prices.length ? Math.max(...prices) : 0;
  // Dollars as the catalog writes them: at least two decimals ($0.10, $0.001).
  const usd = (n) => { const [i, d = ""] = String(Number(n.toFixed(8))).split("."); return `$${i}.${d.padEnd(2, "0")}`; };
  const retryMax = Number(config?.retryMax ?? 0);
  const attempts = retryMax + 1;

  const firstSlug = served[0];
  const firstDef = firstSlug ? defs.get(firstSlug) : null;
  const method = firstDef ? String(firstDef.route).split(" ")[0] : "POST";
  const example = firstDef?.discovery?.input && typeof firstDef.discovery.input === "object" ? firstDef.discovery.input : {};
  const query = method === "GET" && Object.keys(example).length ? `?${new URLSearchParams(Object.entries(example).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString()}` : "";
  const request = firstDef
    ? `${method} ${endpoint}/${firstSlug}${query}${method === "POST" ? `\nContent-Type: application/json\n\n${JSON.stringify(example, null, 2)}` : ""}`
    : "";

  const table = (g) => `
<h3 id="${esc(g.id)}">${esc(g.title)}</h3>
<p class="aw-notice">${esc(g.notice)}</p>
<div class="aw-tablewrap ml-rowlist" role="region" aria-labelledby="${esc(g.id)}" tabindex="0">
<table class="aw-table">
<caption>${esc(g.title)}</caption>
<thead><tr><th scope="col">Tool</th><th scope="col">What it does</th><th scope="col">Price per call</th></tr></thead>
<tbody>
${g.slugs.map((s) => { const d = defs.get(s); return `<tr><th scope="row"><code>${esc(s)}</code></th><td>${esc(awsPurposeOf(d, { describe }))}</td><td class="aw-price">${esc(awsPriceLabel(d))}</td></tr>`; }).join("\n")}
</tbody>
</table>
</div>`;

  const body = `<div class="aw-wrap">
<p class="aw-eyebrow">AWS Marketplace</p>
<h1>Agent402 tools on AWS Marketplace</h1>
<p class="aw-lede">Your agent calls each tool over HTTPS and pays per call in US dollars on your AWS bill, through Amazon Bedrock AgentCore payments with the AWS Billing connector. ${served.length} tools, from ${esc(usd(lo))} to ${esc(usd(hi))} per call.</p>

<h2 id="setup">Set up</h2>
<ol>
  <li>Subscribe to the Agent402 listing in AWS Marketplace.</li>
  <li>Give your agent a payment connection in Amazon Bedrock AgentCore payments using the AWS Billing connector (<a href="${AWS_PAYMENTS_DOC}" rel="noopener">AgentCore payments documentation</a>).</li>
  <li>Your agent sends its request to <code>${esc(endpoint)}/&lt;tool&gt;</code>. The first answer is <code>402 Payment Required</code> with one x402 offer: scheme <code>exact</code> on network <code>${esc(AWS_NETWORK)}</code>, priced in US dollars, with a quote we sign.</li>
  <li>AgentCore payments pays the offer and your agent sends the same request again with the payment. The answer is the tool's JSON.</li>
</ol>
${request ? `<p>For example, the first tool in the list:</p>\n${codeBlock(`<code>${esc(request)}</code>`, { html: true, label: "The request", style: "margin:0 0 14px" })}` : ""}

<h2 id="endpoints">Endpoints</h2>
<dl class="aw-kv">
  <dt>Endpoint</dt><dd>${esc(endpoint)}</dd>
  <dt>Each tool</dt><dd>${esc(endpoint)}/&lt;tool&gt;</dd>
  <dt>Quote keys (JWKS)</dt><dd><a href="${esc(jwks)}">${esc(jwks)}</a></dd>
  <dt>OpenAPI</dt><dd><a href="${esc(openapi)}">${esc(openapi)}</a></dd>
</dl>
<p>Each tool takes the method shown in the OpenAPI document: a <code>GET</code> tool reads its input from the query string, a <code>POST</code> tool from a JSON body. The bare endpoint answers as the first tool in the list.</p>

<h2 id="tools">Tools</h2>
${groups.map(table).join("\n")}

<h2 id="data">Data handling</h2>
<ul>
  <li><b>Inputs and answers.</b> What your agent sends is processed in memory to compute the answer and is not stored. Some tools that read public data keep their answer for between one minute and one day, keyed by the input that produced it, so a repeat call is faster.</li>
  <li><b>Payments.</b> For each paid call we keep the payment id, the tool, its price and the time, to account for the sale. We do not store your AWS account or buyer identity.</li>
  <li><b>Operational logs.</b> The request path, status code and client address are written to standard operational logs for abuse prevention and debugging, kept for our hosting platform's default log retention. An error message in those logs can name an input value that was refused.</li>
  <li><b>Rate limits.</b> Counted per minute in process memory under one-way digests of the client address and the AWS buyer id, never the values themselves.</li>
  <li><b>Sharing.</b> Inputs are not sold or shared. A tool that reads a public source sends that source the query it needs (a ticker, a place, a host name), never who asked.</li>
  <li><b>Encryption.</b> Every call is served over HTTPS (TLS).</li>
</ul>

<h2 id="refunds">Failed calls and refunds</h2>
<ul>
  <li>AWS Marketplace takes the payment when it issues the payment token, before the request reaches us. One payment buys one answer; a payment sent a second time after its answer is refused with <code>409</code>.</li>
  <li>An input we refuse before running the tool does not use the payment: correct it and send the request again with the same payment while it is valid.</li>
  <li>A call that does not end in an answer gives the payment back for another try: one payment covers up to ${attempts} attempt${attempts === 1 ? "" : "s"} while it is valid, and each failed answer says how many are left.</li>
  <li>A paid call that ends without an answer after its last attempt is recorded with its payment id, the tool, the time and why it ended, is reviewed, and an approved correction is made as a billing adjustment on your AWS invoice through AWS Marketplace. Adjustments apply to your AWS invoice, not to individual payments. Write to <a href="mailto:${AWS_SUPPORT_EMAIL}">${AWS_SUPPORT_EMAIL}</a> with the payment id to ask about one.</li>
  <li>Your purchase is governed by AWS Marketplace's standard contract together with this refund rule.</li>
</ul>

<h2 id="limits">Limits</h2>
<p>Up to ${esc(String(config?.quotesPerMin ?? ""))} unpaid requests a minute per client address, and up to ${esc(String(config?.paidPerMin ?? ""))} new paid requests a minute per AWS buyer and per client address. Past either, the answer is <code>429</code> with <code>Retry-After</code>; a paid request refused this way does not use its payment. A quote is valid for ${esc(String(Math.round(Number(config?.quoteSeconds || 0) / 60)))} minutes.</p>

<h2 id="support">Support</h2>
<p>Questions, billing and failed calls: <a href="mailto:${AWS_SUPPORT_EMAIL}">${AWS_SUPPORT_EMAIL}</a>. Security reports: <a href="mailto:${AWS_SECURITY_EMAIL}">${AWS_SECURITY_EMAIL}</a>.</p>
</div>`;

  const title = "Agent402 on AWS Marketplace";
  const description = "Set up Agent402 tools bought through AWS Marketplace: endpoints, tools, prices, data handling and refunds.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<script src="${jsSrc("theme-init.js")}"></script>
<script src="${jsSrc("site-chrome.js")}" defer></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, nofollow">
${LEDGER_HEAD}
<style>${LEDGER_CSS}${CSS}</style>
</head>
<body style="overflow-x:clip;">
<a class="ml-skip" href="#main">Skip to content</a>
<main id="main" tabindex="-1">${body}</main>
</body>
</html>`;
}
