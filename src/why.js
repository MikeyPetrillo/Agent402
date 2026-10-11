// "Why pay here" - what is actually different about paying here, every claim
// linked to the surface that proves it. Rendered as the #why section of the
// home page (src/ledger-home.js): `t` is the row heading (one line at desktop
// width), `s` the one-sentence row text, `h` + `p` the full claim behind "how it
// works". `links` (at most two) sit on the row; `more` sit inside the expander.
// scripts/test-wrap-quality.js measures the rows in Chromium. /why answers a 301 to /#why, and /docs keeps an
// id="why" stub pointing there for old deep links. The agent-facing
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
    t: "Pay for usage, under a quoted ceiling.",
    h: "Pay for what the model used, with the ceiling quoted first.",
    s: "Metered calls quote a ceiling in the 402 and settle the actual usage under it, with a receipt on each settled call.",
    p: "On the metered gateway every 402 quotes this exact request from its own body. A wallet that can pay with the upto scheme settles the actual usage under that ceiling; provider discounts such as prompt-cache reads pass through. Every settled x402 or MPP response carries a receipt. A JSON answer bought with an EVM wallet can then be attested on Base by that same wallet: POST /api/attest with the settlement transaction writes an Ethereum Attestation Service record of the tool, the response digest and the payment, from our wallet, so an agent can prove afterwards what it acted on. Streamed and binary answers carry no digest, and wallet-scoped routes such as memory are never attested.",
    links: [["/tools/v1-chat-metered", "the metered tier"], ["/guides/openclaw-model-provider", "OpenClaw setup"]],
    more: [],
  },
  {
    id: "never-charged",
    kicker: "02 / FAILURE",
    t: "A failed call is not charged.",
    h: "A failed call is not charged, and the response proves it.",
    s: "Settlement runs after the answer and an error cancels it; a keyed retry replays the paid answer instead of paying twice.",
    p: "Settlement runs after the handler answers and an error status cancels it, so a response with no payment receipt, or a receipt marked success:false, moved no money. A retry that carries the same idempotency key and the same payment credential replays the paid answer instead of paying again. The one residual case, a settled receipt on an error response, is detected by our own alarm and recorded as a debt in a refund ledger, never written off silently. A Tempo push payment is sent before the call runs, so a call that then fails is recorded as a refund owed the same way. Anyone holding the settlement transaction can check it for free at /api/refunds/lookup and see our refund transaction once it is sent.",
    links: [["/status", "outside uptime"], ["/guides/x402-and-mpp", "how it settles"]],
    more: [],
  },
  {
    id: "one-key",
    kicker: "03 / ONE KEY",
    t: "One key buys everything.",
    h: "One key buys everything.",
    s: "One wallet pays for LLM tiers on four wires, embeddings, images, speech, 500+ tools and finished reports.",
    p: "The same wallet pays for flat LLM tiers and a metered tier on four wires (OpenAI chat, OpenAI Responses, Anthropic Messages, Gemini generateContent), embeddings, rerank, images, video, speech, transcription, grounded answers with citations, 500+ tools and finished reports, and an EVM wallet also keys its own memory. One paywall, one key.",
    links: [["/tools", "tools"], ["/v1/models", "gateway models"]],
    more: [["/reports", "reports"]],
  },
  {
    id: "no-wallet",
    kicker: "04 / NO WALLET",
    t: "No wallet required.",
    h: "No wallet required.",
    s: "Proof-of-work pays for the pure-CPU tools, and cards pay over MPP and at report checkout.",
    p: `Proof-of-work pays for the pure-CPU tools, cards over MPP pay any route priced at $${STRIPE_MIN_USD.toFixed(2)} or more, and card checkout sells the finished reports, beside USDC or USDG on ${RAILS.length} chains and native MPP on Tempo. An agent with a wallet never needs an account.`,
    links: [["/pricing", "ways to pay"], ["/reports", "card checkout"]],
    more: [],
  },
  {
    id: "deliverables",
    kicker: "05 / DELIVERABLES",
    t: "Finished work, ready to use.",
    h: "Finished work, ready to use.",
    s: "Dossiers, 13F holdings, filing reports, domain audits and deep research from live sources; monitors re-run them on change.",
    p: `Company dossiers, insider flow, 13F holdings, filing reports, IPO digests, domain audits, token risk, deep research, market briefs, recall watch and a LinkedIn article package, grounded in live sources, most with a downloadable data appendix. Monitors check for free on a schedule and re-run the paid report when the facts change, up to ${MAX_FULL_PER_SUB_30D} full reports in any 30 days; past that a change arrives as an alert.`,
    links: [["/reports", "report products"], ["/monitors", "monitors"]],
    more: [],
  },
  {
    id: "route",
    kicker: "06 / ROUTING",
    t: "We source from other sellers.",
    h: "We source from other sellers.",
    s: "Route-and-execute buys the result from the best seller, ours or anyone else's, under one receipt.",
    p: `Route-and-execute resolves a task to the best seller across the whole ecosystem, ours or anyone else's, buys the result from that seller with our own wallet and sells it to the agent under one receipt. ${routingProofSentence()}`,
    links: [["/tools/route-execute", "route-and-execute"], ["/marketplace", "the seller index"]],
    more: [],
  },
  {
    id: "proof",
    kicker: "07 / PROOF",
    t: "Everything is checkable.",
    h: "Everything is checkable.",
    s: "Outside uptime probes, a daily real-money canary, published transactions, open source and an on-chain operator identity.",
    p: "Uptime is observed by two probes outside production, a real-money canary buys through every on-chain rail daily, transactions are published by rail and by wire, and the whole server is open source and self-hostable. The deterministic tools are pure code with no model in their path - parsers, hashes, math, a real browser - and the ones that DO run a model are named rather than blended in: the /v1 gateway tiers, the report products, the image, speech, transcription, embedding and AI-answer tools, the Decide planner, and the judgment model that can pick among the router's shortlisted candidates. Every 402 also carries the SHAPE of the answer before you pay: its first x402 accept declares an outputSchema, so an agent can check what came back against what was promised instead of taking a status code on trust. The operator is identified on-chain too: Agent402 is agent 94639 in the ERC-8004 Identity Registry on Base, and /.well-known/agent-registration.json is the record that registration points at, beside an A2A agent card at /.well-known/agent-card.json. So an agent can resolve who serves this catalog from the chain rather than from this page.",
    links: [["/proof", "receipts"], ["/status", "status"]],
    more: [["/revenue", "transactions"], ["/.well-known/agent-registration.json", "on-chain identity"], [REPO_URL, "source"]],
  },
];

/** The other ways to give an agent tools, side by side (the old /compare
 * page, folded in here; /compare answers a 301 to /#why-compare). Category labels
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

/** Where the seven points are published: the #why section of the home page. */
export const WHY_PATH = "/#why";

/** JSON-LD for the #why section: the seven points as an ItemList anchored
 * on the home page. */
export function whyJsonLd(baseUrl) {
  const at = `${baseUrl}/`;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${at}#why`,
    name: "Why pay here: seven things that are different about Agent402",
    itemListElement: WHY_POINTS.map((w, i) => ({ "@type": "ListItem", position: i + 1, name: w.h, description: w.p, url: `${at}#why-${w.id}` })),
  };
}

/** CSS for the home #why section (appended to the home page's extraCss). */
export const WHY_SECTION_CSS = `
  #why, #why-compare, .why-pt { scroll-margin-top: 90px; }
  .why-list { border-top:1px solid var(--hairline); }
  .why-pt { display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:10px 48px;padding:20px 0;border-bottom:1px solid var(--hairline); }
  .why-pt .why-k { font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);white-space:nowrap;margin:0 0 6px; }
  .why-pt h3 { font-weight:600;font-size:var(--fs-lg);line-height:1.3;letter-spacing:-.01em;margin:0;color:var(--ink); }
  .why-pt .why-body { display:flex;flex-direction:column;gap:10px;min-width:0; }
  .why-pt .why-body > p { font-size:var(--fs-md);line-height:1.55;color:var(--muted);margin:0;max-width:76ch; }
  .why-pt .why-row { display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 22px; }
  .why-pt .why-row > * { white-space:nowrap; }
  .why-pt .why-row > details { white-space:normal; }
  .why-pt .why-row > details[open] { flex-basis:100%; }
  .why-pt a.why-proof { font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash); }
  .why-pt details summary { cursor:pointer;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);list-style:none; }
  .why-pt details summary::-webkit-details-marker { display:none; }
  .why-pt details[open] summary { margin-bottom:8px; }
  .why-pt details p { font-size:var(--fs-sm);line-height:1.6;color:var(--muted);margin:0 0 8px;max-width:76ch; }
  .why-pt details p strong { color:var(--ink);font-weight:500; }
  @media (max-width:900px){ .why-pt { grid-template-columns:minmax(0,1fr);gap:8px; } }
  .why-cmp-wrap { overflow-x:auto;border:1px solid var(--hairline);background:var(--card); }
  .why-cmp { width:100%;min-width:640px;border-collapse:collapse;margin:0;font-size:var(--fs-md); }
  .why-cmp th, .why-cmp td { text-align:left;vertical-align:top;padding:11px 16px;border-bottom:1px solid var(--hairline); }
  .why-cmp thead th { font-family:var(--font-mono);font-size:var(--fs-2xs);font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);white-space:nowrap; }
  .why-cmp tbody tr:nth-child(even) th, .why-cmp tbody tr:nth-child(even) td { background:var(--card-zebra); }
  .why-cmp tbody tr:last-child th, .why-cmp tbody tr:last-child td { border-bottom:none; }
  .why-cmp tbody th { font-weight:600;color:var(--ink);white-space:nowrap; }
  .why-cmp td { color:var(--muted); }
  .why-cmp td.why-cmp-here { color:var(--ink); }`;

/** The comparison table under the seven points, in its own scroll wrapper. */
function whyCompareHtml() {
  const head = `<tr><th scope="col">Task</th>${WHY_COMPARE.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
  const rows = WHY_COMPARE.rows.map(([label, ...cells]) => `<tr><th scope="row">${esc(label)}</th>${cells.map((c, i) => `<td${i === 0 ? ' class="why-cmp-here"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="why-cmp-wrap" tabindex="0" aria-label="Comparison table, scrolls sideways on narrow screens"><table class="why-cmp"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/** The "Why pay here" section of the home page: seven rows, each a kicker and
 * a one-line heading on the left; on the right one sentence, at most two proof
 * links, and the full claim (with any further proof links) behind "how it
 * works". Then the side-by-side table. */
export function whySectionHtml() {
  const linkHtml = ([href, label]) => `<a class="why-proof" href="${esc(href)}">${esc(label)} &rarr;</a>`;
  const points = WHY_POINTS.map((w) => `
    <div class="why-pt" id="why-${esc(w.id)}">
      <div><div class="why-k">${esc(w.kicker)}</div><h3>${esc(w.t)}</h3></div>
      <div class="why-body">
        <p>${esc(w.s)}</p>
        <div class="why-row">${w.links.map(linkHtml).join("")}<details><summary>how it works +</summary><p><strong>${esc(w.h)}</strong> ${esc(w.p)}</p>${w.more.length ? `<div class="why-row">${w.more.map(linkHtml).join("")}</div>` : ""}</details></div>
      </div>
    </div>`).join("");
  return `<section id="why" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div class="hm-kicker">$ GET /proof</div>
  <h2 class="hm-h2" style="margin:0 0 12px;">Why pay here.</h2>
  <p class="hm-lede" style="margin:0 0 26px;">Seven claims, each linked to the surface that proves it.</p>
  <div class="why-list">${points}
  </div>
  <h3 id="why-compare" style="font-weight:600;font-size:var(--fs-xl);letter-spacing:-.02em;margin:34px 0 12px;color:var(--ink);">Side by side with the other ways in.</h3>
  ${whyCompareHtml()}
</section>`;
}

/** What /docs keeps at #why: a pointer for old deep links, not a copy. */
export function whyDocsStubHtml() {
  return `<p id="why" style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);margin:0 0 30px;">Why pay here: what is different, each point with its proof, is on the <a href="/#why" style="color:var(--ink);">home page</a>.</p>
`;
}
