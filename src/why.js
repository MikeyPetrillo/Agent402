// "Why pay here" - what is actually different about paying here, every claim
// linked to the surface that proves it. Rendered as the #why section of /docs
// (src/ledger-docs.js); /why answers a 301 to /docs#why. The agent-facing
// surfaces (llms.txt, MCP instructions, package READMEs) point at it, so the
// seven points live in ONE place and read the same everywhere. First-party
// claims only: no comparisons, no third-party names, evergreen "500+" counts.
import { esc } from "./ledger-chrome.js";
import { routingProofSentence } from "./routing-proof.js";
import { RAILS } from "./rails.js";
import { STRIPE_MIN_USD } from "./mpp-stripe.js";
import { MAX_FULL_PER_SUB_30D } from "./monitor-scheduler.js";

import { REPO_URL } from "./repo-link.js";
export const WHY_POINTS = [
  {
    id: "actual",
    kicker: "01 / PRICE",
    h: "Pay for what the model used, with the ceiling quoted first.",
    p: "On the metered gateway every 402 quotes this exact request from its own body. A wallet that can pay with the upto scheme settles the actual usage under that ceiling; provider discounts such as prompt-cache reads pass through. Every settled x402 or MPP response carries a receipt. A JSON answer bought with an EVM wallet can then be attested on Base by that same wallet: POST /api/attest with the settlement transaction writes an Ethereum Attestation Service record of the tool, the response digest and the payment, from our wallet, so an agent can prove afterwards what it acted on. Streamed and binary answers carry no digest, and wallet-scoped routes such as memory are never attested.",
    links: [["/tools/v1-chat-metered", "the metered tier"], ["/guides/openclaw-model-provider", "OpenClaw setup"]],
  },
  {
    id: "never-charged",
    kicker: "02 / FAILURE",
    h: "A failed call is not charged, and the response proves it.",
    p: "Settlement runs after the handler answers and an error status cancels it, so a response with no payment receipt, or a receipt marked success:false, moved no money. A retry that carries the same idempotency key and the same payment credential replays the paid answer instead of paying again. The one residual case, a settled receipt on an error response, is detected by our own alarm and recorded as a debt in a refund ledger, never written off silently. A Tempo push payment is sent before the call runs, so a call that then fails is recorded as a refund owed the same way. Anyone holding the settlement transaction can check it for free at /api/refunds/lookup and see our refund transaction once it is sent.",
    links: [["/status", "uptime measured from outside"], ["/guides/x402-and-mpp", "how the paywall settles"]],
  },
  {
    id: "one-key",
    kicker: "03 / ONE KEY",
    h: "One key buys everything.",
    p: "The same wallet pays for flat LLM tiers and a metered tier on four wires (OpenAI chat, OpenAI Responses, Anthropic Messages, Gemini generateContent), embeddings, rerank, images, video, speech, transcription, grounded answers with citations, 500+ tools and finished reports, and an EVM wallet also keys its own memory. One paywall, one key.",
    links: [["/tools", "the catalog"], ["/v1/models", "gateway models"], ["/reports", "reports"]],
  },
  {
    id: "no-wallet",
    kicker: "04 / NO WALLET",
    h: "No wallet required.",
    p: `Proof-of-work pays for the pure-CPU tools, cards over MPP pay any route priced at $${STRIPE_MIN_USD.toFixed(2)} or more, and card checkout sells the finished reports, beside USDC or USDG on ${RAILS.length} chains and native MPP on Tempo. An agent with a wallet never needs an account.`,
    links: [["/pricing", "ways to pay"], ["/reports", "buy a report by card"]],
  },
  {
    id: "deliverables",
    kicker: "05 / DELIVERABLES",
    h: "Finished work, ready to use.",
    p: `Company dossiers, insider flow, 13F holdings, filing reports, IPO digests, domain audits, token risk, deep research, market briefs, recall watch and a LinkedIn article package, grounded in live sources, most with a downloadable data appendix. Monitors check for free on a schedule and re-run the paid report when the facts change, up to ${MAX_FULL_PER_SUB_30D} full reports in any 30 days; past that a change arrives as an alert.`,
    links: [["/reports", "report products"], ["/monitors", "monitors"]],
  },
  {
    id: "route",
    kicker: "06 / ROUTING",
    h: "We source from other sellers.",
    p: `Route-and-execute resolves a task to the best seller across the whole ecosystem, ours or anyone else's, buys the result from that seller with our own wallet and sells it to the agent under one receipt. ${routingProofSentence()}`,
    links: [["/tools/route-execute", "route-and-execute"], ["/marketplace", "the seller index"]],
  },
  {
    id: "proof",
    kicker: "07 / PROOF",
    h: "Everything is checkable.",
    p: "Uptime is observed by two probes outside production, a real-money canary buys through every on-chain rail daily, transactions are published by rail and by wire, and the whole server is open source and self-hostable. The deterministic tools are pure code with no model in their path - parsers, hashes, math, a real browser - and the ones that DO run a model are named rather than blended in: the /v1 gateway tiers, the report products, the image, speech, transcription, embedding and AI-answer tools, the Decide planner, and the judgment model that can pick among the router's shortlisted candidates. Every 402 also carries the SHAPE of the answer before you pay: the accept declares an outputSchema, so an agent can check what came back against what was promised instead of taking a status code on trust. The operator is identified on-chain too: Agent402 is agent 94639 in the ERC-8004 Identity Registry on Base, and /.well-known/agent-registration.json is the record that registration points at, beside an A2A agent card at /.well-known/agent-card.json. So an agent can resolve who serves this catalog from the chain rather than from this page.",
    links: [["/proof", "receipts"], ["/status", "status"], ["/revenue", "transactions"], ["/.well-known/agent-registration.json", "on-chain identity"], [REPO_URL, "source"]],
  },
];

/** The other ways to give an agent tools, side by side (the old /compare
 * page, folded in here; /compare answers a 301 to /docs#why). Category labels
 * only: no product or vendor is named. */
export const WHY_COMPARE = {
  cols: ["Here", "Building it yourself", "Calling each provider directly"],
  rows: [
    ["Getting started", "One MCP add or one HTTP call", "Write, host and monitor each handler", "An account and an API key per provider"],
    ["Paying", "Per call over x402 or MPP; proof-of-work for the pure-CPU tools", "Billing is yours to build", "A plan or a prepaid balance per provider"],
    ["Finding a tool", "A searchable catalog and /api/find", "Only what you have built", "Each provider's own docs"],
    ["Errors and retries", "One JSON error shape; a keyed retry replays the paid answer", "Yours to design", "A format per provider"],
    ["Running it", "Hosted, or self-host the open-source server", "Yours to run", "Each provider's own uptime"],
  ],
};

/** One-line-per-point plain text for agent surfaces (llms.txt, MCP instructions). */
export function whyPointsPlain() {
  return WHY_POINTS.map((w) => `${w.h} ${w.p}`);
}

/** Where the seven points are published: the #why section of /docs. */
export const WHY_PATH = "/docs#why";

/** JSON-LD for the #why section: the seven points as an ItemList anchored
 * on the docs page. */
export function whyJsonLd(baseUrl) {
  const at = `${baseUrl}/docs`;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${at}#why`,
    name: "Why pay here: seven things that are different about Agent402",
    itemListElement: WHY_POINTS.map((w, i) => ({ "@type": "ListItem", position: i + 1, name: w.h, description: w.p, url: `${at}#why-${w.id}` })),
  };
}

/** CSS for the #why section (appended to the docs page's extraCss). */
export const WHY_SECTION_CSS = `
  #why, .why-pt { scroll-margin-top: 110px; }
  .why-pt { display:grid;grid-template-columns:150px minmax(0,1fr);gap:22px;padding:22px 0;border-top:1px solid var(--hairline); }
  .ml-docs-main .why-pt h3 { font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);line-height:1.2;letter-spacing:-.01em;margin:0 0 8px;color:var(--ink); }
  .ml-docs-main .why-pt p { font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 12px; }
  .ml-docs-main .why-pt a.why-proof { font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px; }
  @media (max-width:900px){ .why-pt { grid-template-columns:minmax(0,1fr);gap:6px; } }
  #why-compare { scroll-margin-top: 110px; }
  .why-cmp-wrap { overflow-x:auto;border:1px solid var(--hairline);background:var(--card);margin:0 0 44px; }
  .ml-docs-main .why-cmp { width:100%;min-width:640px;border-collapse:collapse;margin:0;font-size:var(--fs-md); }
  .ml-docs-main .why-cmp th, .ml-docs-main .why-cmp td { text-align:left;vertical-align:top;padding:12px 16px;border:0;border-bottom:1px solid var(--hairline);background:transparent; }
  .ml-docs-main .why-cmp thead th { font-family:var(--font-mono);font-size:var(--fs-2xs);font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--faint); }
  .ml-docs-main .why-cmp tbody tr:nth-child(even) th, .ml-docs-main .why-cmp tbody tr:nth-child(even) td { background:var(--card-zebra); }
  .ml-docs-main .why-cmp tbody tr:last-child th, .ml-docs-main .why-cmp tbody tr:last-child td { border-bottom:none; }
  .ml-docs-main .why-cmp tbody th { font-weight:600;color:var(--ink); }
  .ml-docs-main .why-cmp td { color:var(--muted); }
  .ml-docs-main .why-cmp td.why-cmp-here { color:var(--ink); }`;

/** The comparison table under the seven points, in its own scroll wrapper. */
function whyCompareHtml() {
  const head = `<tr><th scope="col">Task</th>${WHY_COMPARE.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
  const rows = WHY_COMPARE.rows.map(([label, ...cells]) => `<tr><th scope="row">${esc(label)}</th>${cells.map((c, i) => `<td${i === 0 ? ' class="why-cmp-here"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="why-cmp-wrap"><table class="why-cmp"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/** The "Why pay here" section of /docs: all seven points with their proof
 * links, under the anchor #why. */
export function whySectionHtml() {
  const linkHtml = ([href, label]) => `<a class="why-proof" href="${esc(href)}">${esc(label)} &rarr;</a>`;
  const points = WHY_POINTS.map((w) => `
        <div class="why-pt" id="why-${esc(w.id)}">
          <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);">${esc(w.kicker)}</div>
          <div>
            <h3>${esc(w.h)}</h3>
            <p>${esc(w.p)}</p>
            <div style="display:flex;gap:18px;flex-wrap:wrap;">${w.links.map(linkHtml).join("")}</div>
          </div>
        </div>`).join("");
  return `<!-- WHY -->
      <section>
      <h2 id="why" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 10px;">Why pay here.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">Seven things that are different about paying here. Every claim links to the surface that proves it: what the server does, measured on the server, on the open protocols anyone can build on, x402 and MPP.</p>
      <div style="border-bottom:1px solid var(--hairline);margin-bottom:30px;">${points}
      </div>
      <h3 id="why-compare" style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);line-height:1.2;letter-spacing:-.01em;margin:0 0 12px;color:var(--ink);">Side by side with the other ways in.</h3>
      ${whyCompareHtml()}
      </section>
`;
}
