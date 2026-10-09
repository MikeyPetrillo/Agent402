// /decide - the page for Agent402 Decide: describe a job, get a call-ready
// plan over this catalog and indexed x402/MPP sellers, optionally run it.
//
// Every price, the credit window, the routing fee and the live-402 window are
// read from the decide config (src/decide/config.js), never typed here, so
// the page cannot drift from what the 402 charges. Rendered only when the
// decide tools are in the catalog (the route 404s otherwise).
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { decideConfig } from "./decide/config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => `$${Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;

export const DECIDE_EXAMPLE_TASK = "Check whether a wallet is on a sanctions list, then list its recent token transfers on Base";

// The example's endpoints and prices come from the live catalog (a typed
// price drifted to $0.005 against $0.002/$0.003, and a typed path pointed at
// a route that does not exist); a tool missing from the catalog drops out.
function exampleResponse(catalog = {}) {
  const def = (slug) => Object.entries(catalog).find(([, d]) => d?.slug === slug);
  const priceOf = (d) => { const n = Number(String(d?.price ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
  const steps = [
    ["sanctions-wallet", "check the wallet against sanctions lists", { address: "0x…" }],
    ["asset-transfers", "fetch recent token transfers on Base", { address: "0x…", network: "base" }],
  ].map(([slug, purpose, exampleParams]) => {
    const hit = def(slug); if (!hit) return null;
    const [route, d] = hit;
    return { purpose, tool: { slug, seller: "agent402", firstParty: true, endpoint: route.split(" ")[1] || route, priceUsd: priceOf(d), exampleParams } };
  }).filter(Boolean);
  const plan = steps.map((s, i) => ({ step: i + 1, ...s, fallbacks: ["…"], dependsOn: [] }));
  const cost = Math.round(plan.reduce((a, s) => a + (s.tool.priceUsd || 0), 0) * 1e6) / 1e6;
  return {
    decisionId: "dec_…",
    plan,
    estimatedCostUsd: cost, estimatedLatencyMs: 3000, confidence: 0.95, gaps: [],
    executionCredit: { amountUsd: decideConfig().prices.plan, token: "dc_…" },
  };
}

export function decidePage(baseUrl, catalog) {
  const c = decideConfig();
  const p = c.prices;
  const canonical = `${baseUrl}/decide`;
  const title = "Agent402 Decide: a plan for any job";
  const description = `Describe a job and get a call-ready plan over this catalog and outside x402 sellers with a recently verified 402: which tools, in what order, with fallbacks and params that validate. ${usd(p.quick)} to ${usd(p.full)} per decision; the fee comes back as credit when Agent402 runs the plan.`;
  const curl = `curl -X POST ${baseUrl}/api/decide \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ task: DECIDE_EXAMPLE_TASK, depth: "plan" })}'`;
  const example = JSON.stringify(exampleResponse(catalog), null, 2);
  const liveDays = Math.round(c.liveWithinHours / 24);

  const faqs = [
    { q: "What does a decision return?", a: `A plan: each step names its tool, endpoint, price, input params that validate against that tool's schema, and fallbacks. Plus a cost and latency estimate, a confidence score, and any needs no indexed tool covers (gaps). Depth "full" adds a compiled prompt an agent can run as is.` },
    { q: "How are Agent402's own tools ranked?", a: `By the same formula as every other seller's, with the same weights: fit to the step, observed reliability, price, schema quality and a freshness pass mark. The formula has no term for who sells a tool, the model that judges fit sees the same bounded description for every tool, and every tool in a plan carries firstParty, so you always see whose it is.` },
    { q: "Which outside sellers can appear?", a: `Outside x402 sellers (including sellers that also accept MPP) whose route answered a live 402 within the last ${liveDays} days and whose input schema is known. Anything the index cannot cover is listed in gaps.` },
    { q: "Can a step use what an earlier step returned?", a: "Yes. When a later step needs a value an earlier step produces (the address an ENS lookup resolved, say), the plan writes {{step N}} for it and lists that step in dependsOn. Run through POST /api/decide/execute, Agent402 fills it in from the earlier step's answer: a field with the parameter's name, or the one address or IP it returned. A value it cannot name without guessing skips that step, and nothing is paid for it." },
    { q: "Can execute run a free plan sketch?", a: "Yes. /api/find and /api/route answer a multi-step task with a free sketch: one tool per step, chosen by keyword, no model. Send its execute body (the step slugs and your inputs for step 1) to POST /api/decide/execute and Agent402 runs the steps in order at list price; each later step takes its one required input from the step before. A paid decision adds judged fit, fallbacks, filled params and the credit." },
    { q: "How does the credit work?", a: `The decision fee comes back as a credit worth ${c.credit.percentOfFee}% of it, valid ${c.credit.ttlHours} hours, toward running that plan with POST /api/decide/execute. Unspent budget from a run returns as credit until the same window closes.` },
    { q: "What does running a plan cost?", a: `Our tools at list price. Outside tools at the seller's price plus a ${c.routingFeePct}% markup: we buy the result from the seller and sell it to you. Spend stops at your budget, fallbacks run in order, and a run where no step succeeds is not charged.` },
  ];
  const faqLd = { "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Decide", item: canonical },
  ] };
  const productLd = { "@type": "Product", name: "Agent402 Decide", description, url: canonical,
    offers: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: String(p.quick), highPrice: String(p.full), offerCount: 3 } };

  const extraCss = `
.dc-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px;align-items:start}
.dc-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.dc-depths{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.dc-card{background:var(--card);border:1px solid var(--hairline);padding:20px 22px}
.dc-card h3{font-size:17px;font-weight:700;margin:0 0 8px;color:var(--ink)}
.dc-card p{font-size:14px;line-height:1.55;color:var(--muted);margin:0}
.dc-num{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:10px}
.dc-price{font-family:var(--font-mono);font-size:24px;letter-spacing:-.02em;color:var(--ink);margin:6px 0 10px}
.dc-pre{background:var(--surface);color:var(--on-dark);border:1px solid var(--hairline);padding:18px 20px;font-family:var(--font-mono);font-size:12.5px;line-height:1.6;overflow-x:auto;margin:0;white-space:pre}
.dc-h2{font-weight:800;font-size:30px;line-height:1.05;letter-spacing:-.025em;margin:0 0 12px;color:var(--ink)}
.dc-lede{font-size:16px;line-height:1.6;color:var(--muted);margin:0 0 22px;max-width:720px}
@media (max-width:900px){.dc-hero,.dc-steps,.dc-depths{grid-template-columns:minmax(0,1fr)}}
`;
  const sec = (inner, pad = "56px 30px 0") => `<section style="max-width:1180px;margin:0 auto;padding:${pad};">${inner}</section>`;

  const steps = [
    ["01 · Index", "This catalog and outside sellers", `This catalog plus outside x402 sellers, each with its price, rails, chains and input schema. Outside tools need a live 402 in the last ${liveDays} days.`],
    ["02 · Rank", "One formula for every seller", "Fit to the job, observed reliability, price, schema quality and a freshness pass mark, with the same weights for every tool and no term for who sells it."],
    ["03 · Plan", "Steps you can call", "The job split into steps, each with a primary tool and fallbacks, params that validate against the tool's schema, and a cost and latency estimate. Gaps are named."],
    ["04 · Run", "Yourself, or through us", `Call the plan directly, or send it to /api/decide/execute. Outside steps are bought from the seller and resold at the seller's price plus a ${c.routingFeePct}% markup, and the decision fee comes back as credit.`],
  ];
  const depths = [
    ["quick", p.quick, "The single best tool for the whole job, with fallbacks."],
    ["plan", p.plan, "The job split into steps, each with a primary tool, fallbacks and dependencies."],
    ["full", p.full, "The plan plus params filled from your task, a compiled prompt to run it, and cost and latency estimates."],
  ];

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">decide</span>
    </nav>
    <div class="dc-hero">
      <div>
        <div class="dc-num">Agent402 Decide</div>
        <h1 style="font-weight:800;font-size:48px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);">Describe the job. Get the plan.</h1>
        <p style="font-size:18px;line-height:1.55;color:var(--muted);margin:0 0 18px;">One paid call returns a call-ready plan over this catalog and outside x402 sellers with a recently verified 402: which tools, in what order, with fallbacks and params that validate. Run it yourself, or have Agent402 run it and the fee comes back as credit.</p>
        <p style="font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 22px;">${usd(p.quick)} to ${usd(p.full)} per decision, paid per request in USDC over <a href="/what-is-x402" style="color:var(--ink);">x402</a> or <a href="/what-is-mpp" style="color:var(--ink);">MPP</a>. No account.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a href="#connect" style="background:var(--btn-bg);color:var(--btn-fg);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">ADD TO YOUR AGENT →</a>
          <a href="/docs#decide" style="border:1.5px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">DOCS</a>
        </div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;">the call</div>
        <pre class="dc-pre">${esc(curl)}</pre>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:16px 0 8px;">the plan (abridged)</div>
        <pre class="dc-pre">${esc(example)}</pre>
      </div>
    </div>
  </div>
</header>
${sec(`<h2 class="dc-h2">How it decides.</h2><p class="dc-lede">A plan is only useful if you can trust why each tool is in it, so every step says why, every tool says whose it is, and the scoring is the same for everyone.</p>
  <div class="dc-steps">${steps.map(([n, h, t]) => `<div class="dc-card"><div class="dc-num">${esc(n)}</div><h3>${esc(h)}</h3><p>${esc(t)}</p></div>`).join("")}</div>`)}
${sec(`<h2 class="dc-h2">Three depths.</h2><p class="dc-lede">Priced by how much of the plan you want. Each decision's fee returns as a ${c.credit.percentOfFee}% credit, valid ${c.credit.ttlHours} hours, toward running it.</p>
  <div class="dc-depths">${depths.map(([d, pr, t]) => `<div class="dc-card"><div class="dc-num">depth "${esc(d)}"</div><div class="dc-price">${usd(pr)}</div><p>${esc(t)}</p></div>`).join("")}</div>`)}
${sec(`<div style="background:var(--surface);border:1px solid var(--hairline);padding:40px;">
  <h2 class="dc-h2" style="color:var(--on-dark);">One formula, disclosed.</h2>
  <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 14px;max-width:760px;">Our tools and every outside seller's are scored on the same five signals with the same weights, and the formula has no term for who sells a tool. The model that judges fit sees the same bounded description for every tool, and every tool in a plan carries <code>firstParty</code>, so the source is disclosed.</p>
  <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0;max-width:760px;">What we charge is on the page: the decision fee by depth, our tools at list price when a plan runs through us, and outside tools at the seller's price plus a disclosed ${c.routingFeePct}% markup. Reliability counts what we observe, one observation per payer per day, and reports through <code>/api/decide/feedback</code> can move a tool only within a bounded range.</p>
</div>`)}
${sec(`<div id="connect"><h2 class="dc-h2">Connect.</h2><p class="dc-lede">Three routes, the same on every surface.</p>
  <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:13px;">
    <div style="display:grid;grid-template-columns:70px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide</span><span style="color:var(--faint);">MCP: decide.plan · ${usd(p.quick)}-${usd(p.full)}</span></div>
    <div style="display:grid;grid-template-columns:70px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/execute</span><span style="color:var(--faint);">MCP: decide.execute · plan budget less credit</span></div>
    <div style="display:grid;grid-template-columns:70px 1fr auto;gap:14px;padding:12px 18px;"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/feedback</span><span style="color:var(--faint);">MCP: decide.feedback · free</span></div>
  </div>
  <pre class="dc-pre" style="margin-top:14px;">claude mcp add --transport http agent402 ${esc(baseUrl)}/mcp</pre></div>`)}
${sec(`<h2 class="dc-h2">Questions.</h2>${faqs.map((f) => `<details style="border-top:1px solid var(--hairline);padding:16px 0;"><summary style="font-weight:600;font-size:16px;cursor:pointer;color:var(--ink);">${esc(f.q)}</summary><p style="font-size:15px;line-height:1.6;color:var(--muted);margin:10px 0 0;max-width:760px;">${esc(f.a)}</p></details>`).join("")}`, "56px 30px 64px")}
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/decide", extraCss, jsonLd: [breadcrumbLd, productLd, faqLd], body });
}
