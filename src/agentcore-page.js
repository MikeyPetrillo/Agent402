// /integrations/agentcore - AWS Bedrock AgentCore: tools through an AgentCore
// Gateway target, payment through AgentCore Payments.
//
// Every sentence about what this server answers is read from the switch that
// decides it:
//   - the x402-alone answer to the Payments plugin's client comes from the MPP
//     offer gate (src/mpp-offer-gate.js): it is stated only while the gate
//     lists a prefix that client's User-Agent starts with;
//   - the MPP on Tempo paragraph is shown only while this server offers Tempo
//     (tempoEnabled), and names the X-Payment-Offers header only while the
//     gate withholds the challenges from that client. With the gate off the
//     challenges ride every 402, so the paragraph names no header.
// Tool cards resolve against the live catalog, so a price is the catalog's
// and a retired slug drops off the page.
//
// AgentCore is AWS's product, not ours. A sentence here says what THIS server
// answers, what this repository's samples do, or what AWS's documentation
// says (attributed, with the link): never what AWS's product will do.
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc, codeBlock } from "./ledger-chrome.js";
import { repoUrl } from "./repo-link.js";
import { failedCallFootnote } from "./settlement-footnote.js";
import { displayPrice } from "./integration-pages.js";
import { withheldUserAgentPrefixes, OFFER_REQUEST_HEADER } from "./mpp-offer-gate.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { PLATFORM_INTEGRATIONS } from "./platform-integrations.js";

const PLATFORM = PLATFORM_INTEGRATIONS.find((p) => p.slug === "agentcore");
export const AGENTCORE_SLUG = PLATFORM.slug;
export const AGENTCORE_NAME = PLATFORM.name;
// The User-Agent the Payments plugin's HTTP client sends (a version follows the slash).
export const AGENTCORE_PLUGIN_USER_AGENT = "python-httpx/";
const SAMPLE_DIR = "examples/agentcore-x402-buyer";
const GATEWAY_DIR = "examples/agentcore-gateway";
// The AgentCore CLI package version the Gateway example's MCP target ran with (its README).
const GATEWAY_CLI_VERSION = "@aws/agentcore 0.27.1";
const TOOL_SLUGS = ["search", "answer", "hash"];
const AWS_PAYMENTS_DOC = "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html";

/** Does the gate answer the Payments plugin's client with the x402 offer alone? */
export function pluginGetsX402Alone(env = process.env) {
  const ua = `${AGENTCORE_PLUGIN_USER_AGENT}0`.toLowerCase();
  return withheldUserAgentPrefixes(env).some((p) => ua.startsWith(p));
}

const H2 = 'style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;"';
const H3 = 'style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-lg);margin:22px 0 10px;"';
const P = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.65;margin:0 0 14px;max-width:760px;"';
const LI = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.65;margin:0 0 8px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';
const code = (s) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(s)}</code>`;
const pre = (text) => codeBlock(`<code>${esc(text)}</code>`, { html: true, style: "margin:0 0 14px" });

/**
 * The page. `catalog` resolves the tool cards. `tempo` and `env` default to
 * this boot's own switches; a test passes them to render each variant.
 */
export function agentcorePage(baseUrl, catalog = {}, { tempo = tempoEnabled(), env = process.env } = {}) {
  const canonical = `${baseUrl}/integrations/${AGENTCORE_SLUG}`;
  const title = `${AGENTCORE_NAME} integration`;
  const description = "Use Agent402 tools from an AWS Bedrock AgentCore agent: add an AgentCore Gateway target from openapi.json or the hosted MCP connector, and pay per call through AgentCore Payments over x402.";
  const sample = repoUrl(`tree/main/${SAMPLE_DIR}`);
  const gatewaySample = repoUrl(`tree/main/${GATEWAY_DIR}`);
  const x402Alone = pluginGetsX402Alone(env);
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && d.slug).map((d) => [d.slug, d]));
  const tools = TOOL_SLUGS.map((s) => bySlug.get(s)).filter(Boolean);
  const answerTool = bySlug.get("answer");

  const x402Para = x402Alone
    ? `x402 is this server's default for the Payments plugin's HTTP client. A request whose User-Agent starts with ${code(AGENTCORE_PLUGIN_USER_AGENT)} (what the plugin sent when the sample ran) is answered with the x402 offer alone: the ${code("PAYMENT-REQUIRED")} header and the full offer in the body, with no ${code("WWW-Authenticate: Payment")} challenge. The offer is payable in USDC with no extra configuration on this server's side.`
    : `Every 402 here carries the ${code("PAYMENT-REQUIRED")} header and the full x402 offer in the body, payable in USDC.`;
  const tempoConfig = pre('network_preferences_config=["tempo:4217", "eip155:4217"]\nbuyer_pays_gas_fees=True');
  const tempoFunds = "Paying over MPP on Tempo takes USDC.e or PathUSD on Tempo; the sample's Tempo probe sets the plugin's network preferences to Tempo first:";
  const mppPara = !tempo ? ""
    : x402Alone
      ? `<p ${P}>To get the MPP challenges instead, send ${code(`${OFFER_REQUEST_HEADER}: mpp`)} with the request: the 402 then carries them as every other client gets them. ${tempoFunds}</p>${tempoConfig}`
      : `<p ${P}>The same 402 carries the MPP challenges. ${tempoFunds}</p>${tempoConfig}`;

  const toolCards = tools.map((t) => `<a href="/tools/${esc(t.slug)}" style="display:block;border:1px solid var(--hairline);background:var(--card);padding:14px 16px;text-decoration:none;color:var(--ink);">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;"><span style="font-weight:700;font-size:var(--fs-base);">${esc(t.name || t.slug)}</span><span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);">${esc(displayPrice(t.price))}</span></div>
      <div class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-top:4px;"><span>${esc(t.slug)}</span>${t.modelBacked ? "<span>model-backed</span>" : ""}</div>
    </a>`).join("\n");

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Integrations", item: `${baseUrl}/integrations` },
      { "@type": "ListItem", position: 3, name: AGENTCORE_NAME, item: canonical },
    ],
  };
  const pageLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: canonical,
    author: siteOrgRef(baseUrl),
  };

  const body = `
  <div style="max-width:980px;margin:0 auto;padding:50px 30px 64px;">
    <nav class="ml-crumb" aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a><span class="ml-crumb-cur">&#160;/ <span style="color:var(--ink);">${esc(AGENTCORE_NAME)}</span></span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 18px;">${esc(AGENTCORE_NAME)}</h1>
    <p style="color:var(--muted);font-size:var(--fs-lg);line-height:1.7;margin:0 0 34px;max-width:760px;">Agent402 serves an AgentCore agent two things: a tool catalog to add as an AgentCore Gateway target, and an x402 offer on every paid call. The sample on this page pays that offer through AgentCore Payments.</p>

    <section id="setup" style="margin-bottom:34px;">
      <h2 ${H2}>Set up the tools</h2>
      <p ${P}>Add one Gateway target; this server offers two sources for it. The commands are from <a href="${esc(gatewaySample)}" rel="noopener" ${A}>${esc(GATEWAY_DIR)}</a>, whose MCP server target ran as written with ${code(GATEWAY_CLI_VERSION)}. Both start from a project and a gateway:</p>
      ${pre("agentcore create --project-name agent402gw --no-agent && cd agent402gw\nagentcore add gateway --name Agent402Gateway --protocol-type MCP --authorizer-type AWS_IAM")}
      <h3 ${H3}>OpenAPI target</h3>
      ${pre(`curl -s ${baseUrl}/openapi.json -o openapi.json\nagentcore add gateway-target \\\n  --name Agent402API \\\n  --type open-api-schema \\\n  --schema ./openapi.json \\\n  --outbound-auth NONE \\\n  --gateway Agent402Gateway\nagentcore deploy --yes`)}
      <p ${P}>Each catalog route is one operation in the document, with its ${code("operationId")} and input schema.</p>
      <h3 ${H3}>MCP server target</h3>
      ${pre(`agentcore add gateway-target \\\n  --name Agent402MCP \\\n  --type mcp-server \\\n  --endpoint ${baseUrl}/mcp \\\n  --gateway Agent402Gateway \\\n  --outbound-auth NONE\nagentcore deploy --yes`)}
      <p ${P}>The connector takes no authentication. Its tools include ${code("web.search")}, ${code("web.answer")}, ${code("catalog.search")}, ${code("catalog.find")} and ${code("catalog.call")}, and ${code("catalog.call")} runs a catalog tool by slug. The pure-CPU tools run free on the connector, rate-limited per client.</p>
    </section>

    <section id="pay" style="margin-bottom:34px;">
      <h2 ${H2}>Pay for calls</h2>
      <p ${P}>This server answers an unpaid call to a paid route with 402, whether it arrives directly or through a Gateway target. In the sample on this page the agent pays. <a href="${esc(AWS_PAYMENTS_DOC)}" rel="noopener" ${A}>AWS's documentation</a> says AgentCore Payments handles the agent's side of a payment, from receiving the seller's payment request, through signing with the configured wallet provider, to returning the payment proof the agent sends back, and that each Payment Session has a budget limit and an expiry and denies further payment requests once either is reached.</p>
      <p ${P}>${x402Para}</p>
      ${mppPara}
      <p ${P}>${esc(failedCallFootnote())}</p>
    </section>

    <section id="sample" style="margin-bottom:34px;">
      <h2 ${H2}>Run the sample</h2>
      <p ${P}><a href="${esc(sample)}" rel="noopener" ${A}>${esc(SAMPLE_DIR)}</a> is a runnable buyer with two entry points.</p>
      <ul style="padding-left:20px;margin:0;">
        <li ${LI}>${code("direct_buy.py")}: fetch, 402, sign, retry, then check the paid sha256 answer against its own hash.</li>
        <li ${LI}>${code("agent_buy.py")}: a Strands agent with the Payments plugin runs a web search, then a cited answer${answerTool?.modelBacked ? " from a model-backed tool" : ""}, each paid through the plugin.</li>
      </ul>
    </section>

    ${tools.length ? `<section style="margin-bottom:34px;">
      <h2 ${H2}>Tools to try first</h2>
      <div class="ip-tools" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;">
${toolCards}
      </div>
      <p style="color:var(--muted);font-size:var(--fs-md);margin:12px 0 0;">Every tool, price and input schema: <a href="/tools" ${A}>our tools</a>.</p>
    </section>` : ""}

    <section style="margin-bottom:10px;">
      <h2 ${H2}>Links</h2>
      <ul style="list-style:none;padding:0;margin:0;">
        <li ${LI}><a href="${esc(AWS_PAYMENTS_DOC)}" rel="noopener" ${A}>AgentCore Payments in the AWS documentation</a></li>
        <li ${LI}><a href="/integrations/strands" ${A}>Strands Agents adapter</a></li>
        <li ${LI}>Guide: <a href="/guides/agent-hosts" ${A}>agent hosts</a></li>
        <li ${LI}><a href="/how-to-pay" ${A}>How to pay</a></li>
        <li ${LI}><a href="/integrations" ${A}>All integrations</a></li>
      </ul>
    </section>
  </div>
  ${ledgerFooterCompact()}`;

  const extraCss = `@media (max-width:720px){.ip-tools{grid-template-columns:minmax(0,1fr)!important}}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd: [breadcrumbLd, pageLd], extraCss, body });
}
