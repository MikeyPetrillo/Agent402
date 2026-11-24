// /integrations/claude-managed-agents - Claude Managed Agents: the hosted MCP
// connector attached to an agent definition, the free tools it runs, and a
// host-side custom tool that pays for the rest.
//
// Claude Managed Agents is Anthropic's product (beta), not ours. A sentence
// here says what THIS server answers, what the samples on the page send, or
// what Anthropic's documentation says (attributed, with the link): never what
// Anthropic's product will do. The requests follow the documentation pages
// linked in DOCS, read 2026-11-24 (beta header managed-agents-2026-04-01).
// One live session that day (agent, environment and session created with
// these bodies, each 200) connected to /mcp and skipped every dotted tool
// name ("Tool names must match [a-zA-Z0-9_-]"), so the agent names the
// connector's plain-names URL (?tool_names=underscore, src/mcp-flagship.js
// plainToolName). A live run through that URL waits for it to be deployed.
//
// Every figure is read from the code that decides it: the free tools' count
// and test (isComputePayable over the live catalog), the connector's per-client
// limits (src/rate-limit.js), the wires the connector takes in the call
// (connectorWires, src/connector-pay.js) and the tool card prices (the catalog).
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc, codeBlock } from "./ledger-chrome.js";
import { failedCallFootnote } from "./settlement-footnote.js";
import { displayPrice } from "./integration-pages.js";
import { isComputePayable } from "./pow.js";
import { MAX_CALLS_PER_BURST, MAX_CALLS_PER_WINDOW } from "./rate-limit.js";
import { connectorWires, X402_MCP_PAYMENT_KEY, MPP_MCP_CREDENTIAL_KEY } from "./connector-pay.js";
import { plainToolName, PLAIN_TOOL_NAMES_VALUE } from "./mcp-flagship.js";
import { PLATFORM_INTEGRATIONS, platformListed } from "./platform-integrations.js";
import { articleDates } from "./page-dates.js";

const PLATFORM = PLATFORM_INTEGRATIONS.find((p) => p.slug === "claude-managed-agents");
export const MANAGED_AGENTS_SLUG = PLATFORM.slug;
export const MANAGED_AGENTS_NAME = PLATFORM.name;
/** True once MANAGED_AGENTS_PAGE=on lists the page; until then it is served
 *  with noindex and no listing surface links it (src/platform-integrations.js). */
export const managedAgentsListed = (env = process.env) => platformListed(PLATFORM, env);
// Anthropic's documentation, as the page links it.
export const DOCS = Object.freeze({
  overview: "https://platform.claude.com/docs/en/managed-agents/overview",
  quickstart: "https://platform.claude.com/docs/en/managed-agents/quickstart",
  mcp: "https://platform.claude.com/docs/en/managed-agents/mcp-connector",
  vaults: "https://platform.claude.com/docs/en/managed-agents/vaults",
  permissions: "https://platform.claude.com/docs/en/managed-agents/permission-policies",
  tools: "https://platform.claude.com/docs/en/managed-agents/tools",
  environments: "https://platform.claude.com/docs/en/managed-agents/environments",
});
export const BETA_HEADER = "managed-agents-2026-04-01";
export const API_VERSION = "2026-10-21";
// The connector's discovery tools: they never charge and never write.
export const DISCOVERY_TOOLS = Object.freeze(["catalog.search", "catalog.find", "payment.info", "server.describe"]);
export const SERVER_NAME = "agent402";
export const PAID_TOOL_NAME = "agent402_paid_call";
const TOOL_SLUGS = ["hash", "search", "answer"];
/** The connector URL the agent names: every tool listed under a plain name. */
export const connectorUrl = (baseUrl) => `${baseUrl}/mcp?tool_names=${PLAIN_TOOL_NAMES_VALUE}`;

const H2 = 'style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;"';
const H3 = 'style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-lg);margin:22px 0 10px;"';
const P = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.65;margin:0 0 14px;max-width:760px;"';
const LI = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.65;margin:0 0 8px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';
const code = (s) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(s)}</code>`;
const pre = (text) => codeBlock(`<code>${esc(text)}</code>`, { html: true, style: "margin:0 0 14px" });
const docLink = (href, text) => `<a href="${esc(href)}" rel="noopener" ${A}>${esc(text)}</a>`;

/** The agent definition the page sends: the connector, its discovery tools
 *  allowed, catalog_call at the documented always_ask default, and the host's
 *  paid-call tool. */
export function agentDefinition(baseUrl) {
  return {
    name: "Agent402 tools",
    model: "claude-opus-5-5",
    system: "Find Agent402 tools with catalog_find, run free ones with catalog_call, and run a paid one with agent402_paid_call.",
    mcp_servers: [{ type: "url", name: SERVER_NAME, url: connectorUrl(baseUrl) }],
    tools: [
      { type: "agent_toolset_20260401", configs: [{ name: "web_search", enabled: false }, { name: "web_fetch", enabled: false }] },
      {
        type: "mcp_toolset",
        mcp_server_name: SERVER_NAME,
        default_config: { enabled: false },
        configs: [
          ...DISCOVERY_TOOLS.map((name) => ({ name: plainToolName(name), enabled: true, permission_policy: { type: "always_allow" } })),
          { name: "catalog_call", enabled: true },
        ],
      },
      {
        type: "custom",
        name: PAID_TOOL_NAME,
        description: "Run a paid Agent402 tool by slug. The host pays for the call and returns the answer.",
        input_schema: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Tool slug from catalog_find" },
            params: { type: "object", description: "Tool input, matching the tool's inputSchema" },
          },
          required: ["slug"],
        },
      },
    ],
  };
}

export const ENVIRONMENT = Object.freeze({ name: "agent402-env", config: { type: "cloud", networking: { type: "limited", allow_mcp_servers: true } } });

const HEADERS = `H=(-H "x-api-key: $ANTHROPIC_API_KEY" \\
   -H "anthropic-version: ${API_VERSION}" \\
   -H "anthropic-beta: ${BETA_HEADER}" \\
   -H "content-type: application/json")`;

export function setupCommands(baseUrl) {
  const json = (o) => JSON.stringify(o, null, 2);
  return [
    HEADERS,
    `# 1. The agent (save its id as AGENT_ID)\ncurl -sS https://api.anthropic.com/v1/agents "\${H[@]}" -d '${json(agentDefinition(baseUrl))}'`,
    `# 2. The environment (save its id as ENVIRONMENT_ID)\ncurl -sS https://api.anthropic.com/v1/environments "\${H[@]}" -d '${json(ENVIRONMENT)}'`,
    `# 3. A session (save its id as SESSION_ID); no vault: the connector takes no credential\ncurl -sS https://api.anthropic.com/v1/sessions "\${H[@]}" -d '{\n  "agent": "'"$AGENT_ID"'",\n  "environment_id": "'"$ENVIRONMENT_ID"'",\n  "title": "Agent402 free tools"\n}'`,
  ];
}

export function runCommands() {
  return [
    `# Watch the session in one terminal\ncurl -sSN https://api.anthropic.com/v1/sessions/$SESSION_ID/events/stream "\${H[@]}"`,
    `# Send the task from another\ncurl -sS https://api.anthropic.com/v1/sessions/$SESSION_ID/events "\${H[@]}" -d '{\n  "events": [{\n    "type": "user.message",\n    "content": [{ "type": "text", "text": "Use catalog_find to pick a tool that hashes text, then run it with catalog_call on hello world with sha256." }]\n  }]\n}'`,
    `# catalog_call waits for approval: answer with the id of its agent.mcp_tool_use event\ncurl -sS https://api.anthropic.com/v1/sessions/$SESSION_ID/events "\${H[@]}" -d '{\n  "events": [{ "type": "user.tool_confirmation", "tool_use_id": "sevt_...", "result": "allow" }]\n}'`,
  ];
}

export const HOST_LOOP = `import Anthropic from "@anthropic-ai/sdk";
import { Agent402 } from "agent402-client";

// payFetch: a payment-aware fetch built from your wallet
// (the agent402-client README shows both); the key stays on your host.
const agent402 = new Agent402({ fetch: payFetch, maxPerCallUsd: 0.05 });
const client = new Anthropic();
const sessionId = process.env.SESSION_ID;

const stream = await client.beta.sessions.events.stream(sessionId);
await client.beta.sessions.events.send(sessionId, {
  events: [{ type: "user.message", content: [{ type: "text", text: "Search the web for x402 adoption and summarize it." }] }],
});
loop: for await (const event of stream) {
  if (event.type === "agent.custom_tool_use" && event.name === "${PAID_TOOL_NAME}") {
    const { slug, params } = event.input;
    let text;
    try { text = JSON.stringify(await agent402.call(slug, params ?? {})); }
    catch (err) { text = \`error: \${err.message}\`; }
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text }] }],
    });
  } else if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") {
    break loop;
  }
}`;

/**
 * The page. `catalog` resolves the free-tool count and the tool cards. `env`
 * defaults to this boot's own; a test passes one to render each variant.
 */
export function managedAgentsPage(baseUrl, catalog = {}, { env = process.env } = {}) {
  const canonical = `${baseUrl}/integrations/${MANAGED_AGENTS_SLUG}`;
  const title = `Agent402 with ${MANAGED_AGENTS_NAME}`;
  const description = "Attach the Agent402 MCP connector to a Claude Managed Agents agent: discovery and pure-CPU tools free, paid tools through a host-side custom tool.";
  const defs = Object.values(catalog || {}).filter((d) => d && d.slug);
  const freeCount = defs.filter((d) => isComputePayable(d)).length;
  const bySlug = new Map(defs.map((d) => [d.slug, d]));
  const tools = TOOL_SLUGS.map((s) => bySlug.get(s)).filter(Boolean);
  const wires = connectorWires(env === process.env ? undefined : { x402: env.FREE_MODE !== "true", mpp: env.FREE_MODE !== "true" && Boolean(env.MPP_SECRET_KEY) });

  const inCallPara = wires.names.length
    ? `A paid tool is payable in the call on this connector over ${esc(wires.phrase)}: the MCP client sends the payment in the tool call's metadata (${[wires.x402 && code(X402_MCP_PAYMENT_KEY), wires.mpp && code(MPP_MCP_CREDENTIAL_KEY)].filter(Boolean).join(" or ")}). A paid tool called with no payment answers with its price and payment setup, and nothing is charged. ${docLink(DOCS.vaults, "Anthropic's documentation")} describes the credentials an agent's MCP connection carries as vault credentials (a static bearer token or OAuth), and does not describe a payment in that metadata, so the pattern below pays from your own host.`
    : "This instance runs in free mode, with no paywall: its connector serves the proof-of-work tools and answers a paid tool with setup text.";

  const toolCards = tools.map((t) => {
    const free = isComputePayable(t);
    return `<a href="/tools/${esc(t.slug)}" style="display:block;border:1px solid var(--hairline);background:var(--card);padding:14px 16px;text-decoration:none;color:var(--ink);">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;"><span style="font-weight:700;font-size:var(--fs-base);">${esc(t.name || t.slug)}</span><span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);">${free ? "free on /mcp" : esc(displayPrice(t.price))}</span></div>
      <div class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-top:4px;"><span>${esc(t.slug)}</span>${t.modelBacked ? "<span>model-backed</span>" : ""}</div>
    </a>`;
  }).join("\n");

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Integrations", item: `${baseUrl}/integrations` },
      { "@type": "ListItem", position: 3, name: MANAGED_AGENTS_NAME, item: canonical },
    ],
  };
  const pageLd = { "@context": "https://schema.org", "@type": "TechArticle", headline: title, description, url: canonical, author: siteOrgRef(baseUrl) };

  const body = `
  <div style="max-width:980px;margin:0 auto;padding:50px 30px 64px;">
    <nav class="ml-crumb" aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a><span class="ml-crumb-cur">&#160;/ <span style="color:var(--ink);">${esc(MANAGED_AGENTS_NAME)}</span></span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 18px;">Agent402 with ${esc(MANAGED_AGENTS_NAME)}</h1>
    <p style="color:var(--muted);font-size:var(--fs-lg);line-height:1.7;margin:0 0 34px;max-width:760px;">Agent402's hosted MCP connector at ${code(connectorUrl(baseUrl))} attaches to a Claude Managed Agents agent as a remote MCP server. The agent finds tools and runs the free ones through it; a custom tool on your host pays for the rest.</p>

    <section id="setup" style="margin-bottom:34px;">
      <h2 ${H2}>Attach the connector</h2>
      <p ${P}>Three requests: an agent that names the connector, an environment, and a session. The field names and the ${code(`anthropic-beta: ${BETA_HEADER}`)} header are from ${docLink(DOCS.quickstart, "Anthropic's quickstart")} and ${docLink(DOCS.mcp, "MCP connector")} pages; the beta can change them, so check those pages before you ship.</p>
      ${setupCommands(baseUrl).map(pre).join("\n      ")}
      <p ${P}>With ${code(`?tool_names=${PLAIN_TOOL_NAMES_VALUE}`)} the connector lists every tool under a name of letters, digits, ${code("_")} and ${code("-")} (${code("catalog_search")} for ${code("catalog.search")}), the form a managed agent session accepted when this page was checked; it skipped the dotted names. Either spelling runs the same tool.</p>
      <p ${P}>The connector takes no credential, so the session names no vault. ${docLink(DOCS.mcp, "Anthropic's documentation")} says a server with no matching vault credential is connected unauthenticated, that an ${code("mcp_toolset")} defaults to the ${code("always_ask")} permission policy, and that with ${code("limited")} networking, ${code("allow_mcp_servers")} lets a session start whose agent declares an MCP server outside the environment's ${code("allowed_hosts")}.</p>
      <p ${P}>The agent above allows the four discovery tools (${DISCOVERY_TOOLS.map((n) => code(plainToolName(n))).join(", ")}), which take no payment and write nothing on this connector, and leaves ${code("catalog_call")} at ${code("always_ask")}. ${docLink(DOCS.permissions, "Permission policies")} covers the other choices.</p>
    </section>

    <section id="run" style="margin-bottom:34px;">
      <h2 ${H2}>Run a free tool</h2>
      ${runCommands().map(pre).join("\n      ")}
      <p ${P}>${freeCount ? `${freeCount} pure-CPU tools run free on the connector through ${code("catalog_call")}, with no wallet` : `The pure-CPU tools run free on the connector through ${code("catalog_call")}, with no wallet`}. The free calls are limited per client address: ${MAX_CALLS_PER_BURST} a minute and ${MAX_CALLS_PER_WINDOW} an hour on this server, shared by every call that arrives from that address. The discovery tools are free too.</p>
    </section>

    <section id="pay" style="margin-bottom:34px;">
      <h2 ${H2}>Pay for calls</h2>
      <p ${P}>${inCallPara}</p>
      <h3 ${H3}>A host-side paid-call tool</h3>
      <p ${P}>The agent above declares ${code(PAID_TOOL_NAME)} as a custom tool. ${docLink(DOCS.tools, "Anthropic's documentation")} says a custom tool call reaches your application as an ${code("agent.custom_tool_use")} event and your application answers with ${code("user.custom_tool_result")}. Here your host runs the call with <a href="/integrations/client" ${A}>agent402-client</a>, which pays the 402 from your wallet and caps each call, then hands the answer back:</p>
      ${pre(HOST_LOOP)}
      <p ${P}>${esc(failedCallFootnote())}</p>
    </section>

    <section id="limits" style="margin-bottom:34px;">
      <h2 ${H2}>Limits</h2>
      <ul style="padding-left:20px;margin:0;">
        <li ${LI}>Free calls: ${MAX_CALLS_PER_BURST} a minute and ${MAX_CALLS_PER_WINDOW} an hour per client address on the connector.</li>
        <li ${LI}>A paid call through ${code(PAID_TOOL_NAME)} is capped by your own ${code("maxPerCallUsd")}, and spends only what your wallet holds.</li>
        <li ${LI}>${docLink(DOCS.mcp, "Anthropic's documentation")} says an MCP tool output over 100,000 characters is written to a file in the sandbox and the model gets a preview with its path.</li>
        <li ${LI}>Claude Managed Agents is a beta: ${docLink(DOCS.overview, "its overview")} lists the models and platforms it runs on.</li>
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
        <li ${LI}>${docLink(DOCS.mcp, "MCP connector in the Claude Managed Agents documentation")}</li>
        <li ${LI}>${docLink(DOCS.vaults, "Vaults in the Claude Managed Agents documentation")}</li>
        <li ${LI}><a href="/integrations/mcp" ${A}>Agent402 MCP connector</a></li>
        <li ${LI}><a href="/integrations/anthropic" ${A}>Anthropic SDK adapter</a></li>
        <li ${LI}><a href="/how-to-pay" ${A}>How to pay</a></li>
        <li ${LI}><a href="/integrations" ${A}>All integrations</a></li>
      </ul>
    </section>
  </div>
  ${ledgerFooterCompact()}`;

  const extraCss = `@media (max-width:720px){.ip-tools{grid-template-columns:minmax(0,1fr)!important}}`;
  const robots = managedAgentsListed(env) ? undefined : "noindex, follow";
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd: [breadcrumbLd, pageLd], extraCss, body, robots, article: articleDates(`/integrations/${MANAGED_AGENTS_SLUG}`) });
}
