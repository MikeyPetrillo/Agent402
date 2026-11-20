// /wholesale - the reseller docs for the versioned wholesale JSON
// (src/wholesale.js). Every fact on the page is read from the same module the
// JSON is built from (families, the reliability definition, the error codes),
// so the page and the API cannot disagree. No price is typed here: prices are
// on the JSON, read from the catalog.
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { WHOLESALE_FAMILIES, WHOLESALE_VERSION, RELIABILITY_DEFINITION, familyTools, wholesaleChargingSentence } from "./wholesale.js";
import { REFUND_TERMS_PATH } from "./refund-terms-path.js";
import { ERROR_CODES, ERROR_CODE_SCOPE, ERROR_CODE_NOT_CARRIED } from "./stable-error-code.js";
import { toolReliabilityEnabled, TOOL_RELIABILITY_PATH } from "./tool-reliability.js";

const P = (html) => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${html}</p>`;
const CODE = (t) => `<code style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);">${esc(t)}</code>`;

function section(h, inner) {
  return `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:260px minmax(0,1fr);gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="ws-2col">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(h)}</h2>
    <div style="min-width:0;">${inner}</div>
  </div>
</section>`;
}

function table(head, rows) {
  const th = head.map((h) => `<th style="text-align:left;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);font-weight:400;padding:8px 12px 8px 0;border-bottom:1px solid var(--hairline);">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td style="font-size:var(--fs-sm);color:var(--muted);padding:8px 12px 8px 0;border-bottom:1px solid var(--hairline);vertical-align:top;">${c}</td>`).join("")}</tr>`).join("");
  return `<div style="overflow-x:auto;margin:0 0 14px;"><table style="border-collapse:collapse;width:100%;min-width:520px;"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** `tempoPush`: whether a Tempo push credential is offered (src/server.js
 *  reads the live switch), which adds its exception to the failure sentence. */
export function wholesalePage(baseUrl, catalog = {}, powSlugs = new Set(), { tempoPush = true } = {}) {
  const canonical = `${baseUrl}/wholesale`;
  const title = "Wholesale tool data";
  const description = "A stable, versioned JSON read per tool family for resellers: each tool's price (the public price, no hidden discount), the credit to keep with its answers, its seven-day success rate and latency, and stable error codes.";
  const index = `${baseUrl}/api/wholesale/${WHOLESALE_VERSION}`;
  const toolCount = (f) => familyTools(f, { catalog, powSlugs }).length;
  const families = table(["Family", "Source", "Basis", "Tools", "JSON"], WHOLESALE_FAMILIES.map((f) => [
    `<strong style="color:var(--ink);font-weight:600;">${esc(f.title)}</strong>`,
    esc(f.source),
    esc(f.redistribution),
    String(toolCount(f)),
    `<a href="/api/wholesale/${WHOLESALE_VERSION}/${esc(f.id)}" style="color:var(--ink);">${esc(f.id)}</a>`,
  ]));
  const codes = table(["Status", "errorCode", "Meaning", "What helps"], ERROR_CODES.map((e) => [String(e.status), CODE(e.code), esc(e.meaning), CODE(e.retry)]));
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">wholesale</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;">Wholesale tool data.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Build a product on these tools: one versioned JSON read per tool family gives each tool's price, the credit to keep with its answers, its measured success rate and latency, and the error codes your integration can branch on. Start at <a href="${esc(index)}" style="color:var(--ink);">${esc(index)}</a>.</p>
  </div>
</header>
${section("Families", `${P(`Each family lists only sources whose answers may be passed on: public-domain government data, CC BY 4.0 weather data with its credit, and our own computation. Every tool row carries ${CODE("credit")}, each tool's credit line: keep it with every answer you pass on, beside any credit the answer itself carries (an answer that resolved a place name carries the GeoNames credit).`)}${families}`)}
${section("Price", P(`Every price is the public route's own price, the same for every buyer; there is no wholesale discount. A route priced per request (the bundle products, priced per site, company or coin) lists its range and quotes the exact amount in each 402 from the body you send. Pay per call over x402 or MPP as on the public route; <a href="/how-to-pay" style="color:var(--ink);">how to pay</a>.`))}
${section("Reliability", `${P(`Each tool reads ${CODE("measured")} or ${CODE("not enough data")}: ${esc(RELIABILITY_DEFINITION.status)}.`)}${P(`Success rate: ${esc(RELIABILITY_DEFINITION.successRate)}.`)}${P(`Latency: ${esc(RELIABILITY_DEFINITION.latency)}.`)}${toolReliabilityEnabled() ? P(`The same figures, window and threshold as <a href="${TOOL_RELIABILITY_PATH}" style="color:var(--ink);">${TOOL_RELIABILITY_PATH}</a>.`) : ""}${P(`Service-wide uptime, measured from outside production, is on <a href="/status" style="color:var(--ink);">/status</a> and <a href="/api/reliability" style="color:var(--ink);">/api/reliability</a>.`)}`)}
${section("Error codes", `${P(`${esc(ERROR_CODE_SCOPE)} Branch on the code; the message text may change. ${esc(ERROR_CODE_NOT_CARRIED)} ${esc(wholesaleChargingSentence(tempoPush))} The refund terms, rail by rail, are at <a href="${REFUND_TERMS_PATH}" style="color:var(--ink);">${REFUND_TERMS_PATH}</a>.`)}${codes}`)}
${section("Stability", P(`This is ${CODE(WHOLESALE_VERSION)}. Within it, fields are only added, never renamed, retyped or removed; a breaking change ships as a new version beside this one. Each tool's input and output schema is in <a href="/openapi.json" style="color:var(--ink);">/openapi.json</a>.`))}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.ws-2col{grid-template-columns:minmax(0,1fr)!important}}`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Wholesale", item: canonical }] },
    { "@type": "WebPage", "@id": canonical, name: title, description, publisher: siteOrgRef(baseUrl) },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/wholesale", extraCss, jsonLd, body });
}
