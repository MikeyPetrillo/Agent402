// /how-to-pay: a buyer's path from nothing to a paid call on every rail this
// server takes: x402 (a stablecoin on each chain in src/rails.js), MPP (the
// tempo, evm and stripe methods the 402 offers), prepaid credits (while they
// are on sale, or a key already issued), and the free proof-of-work tier.
//
// Nothing here is typed that the code decides: the rail list and its count
// come from RAILS (the same table /.well-known/x402 reads), the MPP methods
// from mppMethodsSummary() at render time (so a self-host with no MPP key
// shows none), the credits state from creditsSalesEnabled(), the card floor
// from STRIPE_MIN_USD, the proof-of-work cost from the live difficulty, the
// idempotency window from its store, and every price from the catalog passed
// in. The settlement rule is stated per rail, because it differs: x402, the
// MPP evm method, a Tempo charge, a card and credits all settle only after a
// final 200; a Tempo push transfer is on chain before the call, so an answer
// that never arrives is booked as owed.
import { ledgerShell, ledgerFooterCompact, esc, breadcrumbLd } from "./ledger-chrome.js";
import { RAILS, railKey, x402EvmOnly, liveRails } from "./rails.js";
import { mppMethodsSummary } from "./mpp-offers.js";
import { mppShimEnabled } from "./mpp-shim.js";
import { mppFlagshipRows, mppFlagshipSnippet, MPP_FLAGSHIP_SNIPPET_SLUG } from "./mpp-flagship.js";
import { STRIPE_MIN_USD } from "./mpp-stripe.js";
import { creditsSalesEnabled } from "./credits-sales.js";
import { powCostPhrase, POW_DIFFICULTY, isComputePayable } from "./pow.js";
import { LIMITS_LABEL as POW_LIMITS_LABEL } from "./rate-limit.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { ORG_SAME_AS } from "./repo-link.js";

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
const words = (n) => NUM_WORDS[n] || String(n);
const listAnd = (xs) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const listOr = (xs) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} or ${xs[1]}` : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
const priceUsd = (p) => Number(String(p ?? "").replace(/[^0-9.]/g, ""));

const TOC = [
  ["#rule", "One rule on every rail"],
  ["#x402", "x402: a stablecoin from a wallet"],
  ["#mpp", "MPP: Tempo, EVM and card"],
  ["#credits", "Prepaid credits"],
  ["#free", "Free with proof-of-work"],
  ["#mcp", "From an MCP host"],
  ["#failed", "When a call fails"],
  ["#check", "Where to check"],
];

const mono = "font-family:var(--font-mono);";
const eyebrow = (t, lit = false) => `<div style="${mono}font-size:var(--fs-sm);color:var(--${lit ? "accent-lit" : "accent"});margin-bottom:12px;">${esc(t)}</div>`;
const h2 = (t, panel = false) => `<h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--${panel ? "on-panel" : "ink"});">${t}</h2>`;
const h3 = (t) => `<h3 style="font-weight:600;font-size:var(--fs-xl);margin:28px 0 10px;color:var(--ink);">${t}</h3>`;
const p = (t, extra = "") => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;${extra}">${t}</p>`;
const note = (t) => `<p style="font-size:var(--fs-base);line-height:1.65;color:var(--faint);max-width:820px;margin:0 0 18px;">${t}</p>`;
const link = (href, t) => `<a href="${esc(href)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${t}</a>`;
const code = (t) => `<code style="${mono}font-size:var(--fs-code-inline);color:var(--ink);">${esc(t)}</code>`;
const pre = (label, s) => `<div style="border:1px solid var(--hairline);background:var(--panel);max-width:820px;margin:0 0 22px;">
    <div style="padding:10px 18px;border-bottom:1px solid var(--panel-rule-2);${mono}font-size:var(--fs-2xs);letter-spacing:.06em;color:var(--on-panel-dim);">${esc(label)}</div>
    <pre style="margin:0;padding:18px;${mono}font-size:var(--fs-xs);line-height:1.8;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;">${esc(s)}</pre>
  </div>`;
const section = (id, inner, wide = false) => `<section id="${id}" style="max-width:${wide ? 1180 : 900}px;margin:0 auto;padding:64px 30px 0;">${inner}</section>`;
const th = (t, right = false) => `<th scope="col" style="text-align:${right ? "right" : "left"};font-weight:700;padding:13px 18px;">${esc(t)}</th>`;
const thead = (cols) => `<thead><tr style="border-bottom:1px solid var(--hairline);${mono}font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);">${cols.map((c) => (Array.isArray(c) ? th(c[0], c[1]) : th(c))).join("")}</tr></thead>`;
const table = (cols, rows) => `<div class="hp-scroll"><table style="font-size:var(--fs-base);border:1px solid var(--hairline);background:var(--card);border-collapse:collapse;width:100%;">${thead(cols)}<tbody>${rows}</tbody></table></div>`;
const td = (t, style = "") => `<td style="padding:12px 18px;color:var(--muted);vertical-align:top;${style}">${t}</td>`;
const tdMono = (t, style = "") => td(`<span style="${mono}font-size:var(--fs-sm);color:var(--ink);">${t}</span>`, style);
const row = (cells) => `<tr style="border-bottom:1px solid var(--hairline);">${cells.join("")}</tr>`;

/** The catalog entry for a slug, or null without a catalog. */
function defOf(catalog, slug) {
  if (!catalog) return null;
  for (const d of Object.values(catalog)) if (d && d.slug === slug) return d;
  return null;
}

export function howToPayPage(baseUrl, catalog = null, { networks = null } = {}) {
  // The chains this instance takes, from the networks enabled at boot (the
  // same filter /.well-known/x402 applies); without the list, the full table.
  const enabledSet = Array.isArray(networks) ? new Set(networks.map((n) => String(n).toLowerCase())) : null;
  const rails = enabledSet ? liveRails().filter((r) => enabledSet.has(railKey(r))) : RAILS;
  const canonical = `${baseUrl}/how-to-pay`;
  const title = "How to pay for a call: x402, MPP, credits or proof-of-work";
  const description =
    "From nothing to a paid call on every rail Agent402 takes: a stablecoin over x402 on each listed chain, MPP over Tempo, EVM or card, prepaid credits, or the free proof-of-work tier. What you need, the 402 flow, a snippet to paste, what the receipt looks like, and what happens when a call fails.";

  // ---- derived facts -------------------------------------------------------
  const usdcRails = rails.filter((r) => r.asset === "USDC");
  const otherRails = rails.filter((r) => r.asset !== "USDC");
  const evmRails = rails.filter((r) => typeof r.chainId === "number");
  const nonEvmRails = rails.filter((r) => typeof r.chainId !== "number");
  const railCount = words(rails.length);
  const railPhrase = `USDC on ${listAnd(usdcRails.map((r) => r.name))}${otherRails.length ? `, plus ${listAnd(otherRails.map((r) => `${r.asset} on ${r.name}`))}` : ""}`;

  const probe = defOf(catalog, "hash");
  const probePrice = probe ? probe.price : null;
  const probeAmount = probe ? String(Math.round(priceUsd(probe.price) * 1e6)) : "<amount>";
  const extract = defOf(catalog, "extract");
  const priceTag = (d, slug) => (d ? esc(d.price) : `the price on ${link("/api/pricing", "/api/pricing")} for ${code(slug)}`);

  const tools = catalog ? Object.values(catalog).filter((d) => d && d.slug) : [];
  const freeCount = tools.filter((d) => isComputePayable(d)).length;
  const evmOnlyCount = tools.filter((d) => x402EvmOnly(d)).length;

  const mpp = mppMethodsSummary();
  const mppRows = catalog ? mppFlagshipRows(catalog) : [];
  const snipRow = mppRows.find((r) => r.slug === MPP_FLAGSHIP_SNIPPET_SLUG) || mppRows[0] || null;
  const mppSnippet = snipRow
    ? mppFlagshipSnippet(snipRow, baseUrl, snipRow.slug === "crypto-price" ? "?coins=BTC,ETH&currency=usd" : "")
    : `import { Mppx, tempo, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppx = Mppx.create({ methods: [tempo.charge({ account }), evm.charge({ account })] });

// the first request returns 402, mppx pays and retries
const res = await mppx.fetch("${baseUrl}/api/uuid");
console.log(res.status, res.headers.get("payment-receipt"), await res.json());`;

  const creditsOn = creditsSalesEnabled();
  const idemMinutes = Math.round(IDEM_TTL_MS / 60000);

  // ---- structured data -------------------------------------------------------
  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS };
  const crumbsLd = breadcrumbLd(baseUrl, [["Agent402", "/"], ["How to pay", "/how-to-pay"]]);
  const howToLd = { "@type": "HowTo", "@id": `${canonical}#howto`, name: "Pay for one Agent402 call", description, step: [
    { "@type": "HowToStep", name: "Ask", text: "Send the request with no payment. The answer is 402 Payment Required with the price and every way to pay it." },
    { "@type": "HowToStep", name: "Pay", text: "Sign the payment with your wallet key (or present a credits key, or a solved proof-of-work puzzle) and repeat the identical request with the credential in a header." },
    { "@type": "HowToStep", name: "Read the receipt", text: "A 200 carries the result and a receipt header naming the settlement; a 4xx or 5xx on x402, MPP evm, Tempo charge, card and credits is not charged." },
  ] };

  const extraCss = `
.hp-scroll{overflow-x:auto;max-width:100%;margin:0 0 22px}
.hp-scroll table{min-width:560px}
@media (max-width:900px){.hp-2col{grid-template-columns:minmax(0,1fr)!important}}
`;

  const tocHtml = TOC.map(([href, label]) =>
    `<a href="${href}" style="padding:11px 18px;border-bottom:1px solid var(--panel-rule);text-decoration:none;color:var(--on-panel-soft);font-size:var(--fs-md);">${esc(label)}</a>`
  ).join("");

  // ---- rails table -----------------------------------------------------------
  const railsRows = rails.map((r) => row([
    `<th scope="row" style="text-align:left;font-weight:700;padding:12px 18px;color:var(--ink);white-space:nowrap;">${esc(r.name)}</th>`,
    tdMono(esc(r.asset)),
    td(r.chainId ? "EVM: the facilitator sponsors gas, so the wallet needs only the stablecoin" : `${esc(r.name)} wallet and its own x402 scheme package`),
    tdMono(`<span style="color:var(--faint);">${esc(r.caip2)}</span>`),
  ])).join("");

  // ---- MPP methods ----------------------------------------------------------------
  const mppMethodRows = [];
  if (mpp.tempo) mppMethodRows.push(row([tdMono("tempo"), td(`${esc(listOr(mpp.tempo.currencies.map((c) => c.label)))} on Tempo`), td("A key holding the stablecoin on Tempo. The challenge is settled natively through Tempo; withheld on identity-bound and long-running routes.")]));
  if (mpp.evm) mppMethodRows.push(row([tdMono("evm"), td(`USDC on ${esc(listOr(mpp.evm.rails.map((r) => r.chain)))}`), td("The same EVM key as x402: the credential is the same signed EIP-3009 authorization, settled by the same facilitator at the same price.")]));
  if (mpp.stripe) mppMethodRows.push(row([tdMono("stripe"), td(`card, on routes priced $${mpp.stripe.minUsd.toFixed(2)} or more`), td("A shared payment token issued by a card wallet your agent holds. The charge is captured only after a final 200.")]));
  const mppTable = mppMethodRows.length
    ? table(["method", "pays with", "what you need"], mppMethodRows.join(""))
    : p(`This instance has no MPP method switched on, so its 402s carry the x402 offer only. The hosted service lists the methods it takes in ${link("/.well-known/x402", "/.well-known/x402")} under ${code("mpp")}.`);
  const mppOrder = mpp.enabled ? `The 402 lists the methods in this order: ${esc(mpp.order.join(", then "))}. A stock mppx client takes the first one it holds a method for.` : "";

  // ---- card ---------------------------------------------------------------------
  const cardHtml = mpp.stripe
    ? p(`<strong style="color:var(--ink);font-weight:700;">Card over MPP.</strong> On routes priced $${STRIPE_MIN_USD.toFixed(2)} or more the same 402 carries a ${code("stripe")} challenge. Your agent presents a shared payment token from its card wallet in ${code("Authorization: Payment")}; the card is captured only after the handler has answered with a 200, and a 4xx or 5xx on the card path leaves nothing captured. A person can also buy a finished report by card at ${link("/reports", "/reports")} with no agent at all.`)
    : p(`<strong style="color:var(--ink);font-weight:700;">Card.</strong> The hosted service offers a card method over MPP on routes priced $${STRIPE_MIN_USD.toFixed(2)} or more; this instance does not have it switched on. A person can buy a finished report by card at ${link("/reports", "/reports")} where that storefront is open.`);

  // ---- credits ---------------------------------------------------------------------
  const creditsLede = creditsOn
    ? p(`Prepaid credits are on sale at ${link("/credits", "/credits")}: a card checkout issues one ${code("a402_")} key, spent across the paid tools at list price, for an agent that will not hold a wallet.`)
    : p(`New credits are not on sale. A key already issued (${code("a402_...")}) keeps working exactly as described here; a new buyer pays per call with a wallet over x402 or MPP, or uses the free tier below.`);

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" class="ml-crumb" style="${mono}font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">how to pay</span>
    </nav>
    <div class="hp-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.94;margin:0 0 24px;color:var(--ink);text-wrap:balance;">How to pay for <span style="color:var(--accent);">one call</span></h1>
        <p style="font-size:var(--fs-lg);line-height:1.5;color:var(--muted);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">Every paid route answers an unpaid request with a 402 that names the price and every way to pay it.</strong> Pay with a stablecoin from a wallet over ${link("/what-is-x402", "x402")} or ${link("/what-is-mpp", "MPP")}, with a card where the price allows it, with a prepaid key, or with a solved puzzle on the pure-CPU tools. Same URL, same answer, same receipt.</p>
        <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0;">This page is the whole path for each rail: what you need, the handshake in plain words, a snippet to paste, what comes back, and what happens to the money when a call fails. Prices on this page are read from the catalog that ${link("/api/pricing", "/api/pricing")} serves.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--panel);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--panel-rule-2);${mono}font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--on-panel-dim);">ON THIS PAGE</div>
        <div style="display:flex;flex-direction:column;">${tocHtml}</div>
      </div>
    </div>
  </div>
</header>

${section("rule", `
  ${eyebrow("01 / THE RULE")}
  ${h2("One handshake, and one rule about money.")}
  ${p(`The handshake is two requests. The first carries no payment and gets a 402 with the terms. The second is the identical request plus one header holding the payment, and it gets the answer plus a receipt header. Nothing on the way asks for an account, a key or a person.`)}
  ${p(`The rule is the order of operations: <strong style="color:var(--ink);font-weight:700;">the handler runs first, and the payment settles only after a response below 400 is ready.</strong> On x402, on MPP's evm method, on a Tempo charge, on a card and on credits, a 4xx or 5xx cancels settlement and nothing is charged; a 200 is charged only if its settlement then succeeds, and if it does not, the answer is withheld and you get a 402 instead of a result you paid for.`)}
  ${p(`One exception is stated wherever it applies below: a Tempo <em>push</em> transfer is already on chain before the request arrives, so on that path an undelivered answer is a debt to you, recorded in the refund ledger and repaid after on-chain proof. ${link("/proof", "/proof")} shows settled receipts next to their quotes.`)}
`)}

${section("x402", `
  ${eyebrow("02 / X402")}
  ${h2("x402: a stablecoin from your own wallet.")}
  ${p(`x402 is served on every paid route. This server settles it on ${railCount} chain${rails.length === 1 ? "" : "s"}: ${esc(railPhrase)}. On the EVM chains the facilitator sponsors gas, so the wallet needs only the stablecoin; ${esc(listAnd(nonEvmRails.map((r) => r.name)))} each use their own wallet and their own scheme package.`)}
  ${h3("What you need")}
  ${p(`A private key for a wallet that holds a little of the stablecoin on one chain from the table. The key never leaves your process: the client signs a transfer authorization for exactly the quoted amount, and the facilitator moves the funds wallet to wallet. ${evmOnlyCount ? `${evmOnlyCount} routes (the identity-bound ones such as memory, and the long-running report routes) take an EVM authorization only; ${link("/api/pricing", "/api/pricing")} lists each route's networks and its 402 offers only those.` : ""}`)}
  ${table(["chain", "asset", "wallet", "caip-2"], railsRows)}
  ${h3("See a quote, free")}
  ${pre("the 402 and what it carries", `curl -i -X POST ${baseUrl}/api/hash \\
  -H 'Content-Type: application/json' -d '{"text":"hello world"}'
# HTTP/2 402  (the same terms ride base64 in the PAYMENT-REQUIRED header)
# {"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453",
#   "amount":"${probeAmount}","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
#   "payTo":"0x…","maxTimeoutSeconds":…}, … one entry per chain …]}`)}
  ${p(`${code("amount")} is in the asset's smallest unit (six decimals for USDC), so ${probePrice ? `${esc(probePrice)} reads as ${code(probeAmount)}` : `a price reads as its micro-units`}. Every accept entry names its own ${code("network")}, ${code("asset")} and ${code("payTo")}; a client picks the one it can sign.`)}
  ${h3("Pay it")}
  ${pre("JavaScript, EVM chains", `import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // keep your own ceiling in code instead
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("${baseUrl}/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(res.status, res.headers.get("payment-response"), await res.json());`)}
  ${p(`That one wrapped ${code("fetch")} pays every route on the EVM chains at ${priceTag(extract, "extract")} for ${code("/api/extract")} and the catalog price elsewhere. For ${esc(listAnd(nonEvmRails.map((r) => r.name)))}, register that chain's exact scheme on the same client. The buyer SDK wraps the same thing with spend caps and a stable idempotency key per call:`)}
  ${pre("the buyer SDK, same fetch", `import { Agent402 } from "agent402-client";

const a = new Agent402({ fetch: payFetch, maxPerCallUsd: 0.05, dailyLimitUsd: 2 });
const article = await a.call("extract", { url: "https://example.com/article" });`)}
  ${h3("What the receipt looks like")}
  ${pre("a settled 200", `HTTP/2 200
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4…
# base64 JSON: {"success":true,"transaction":"0x…","network":"eip155:8453","payer":"0x…"}
{ "title": "…", "markdown": "…", "wordCount": 1180 }`)}
  ${p(`${code("transaction")} is the on-chain settlement, so you can check on the chain's explorer what was paid. A refused payment answers 402 again with a ${code("reason")} naming the field that differed from the offer; ${link("/x402-test", "/x402-test")} lists every reason this server emits, and a refusal costs nothing.`)}
`, true)}

${section("mpp", `
  ${eyebrow("03 / MPP")}
  ${h2("MPP: the same handshake in HTTP auth headers.")}
  ${p(`MPP, the Machine Payments Protocol, carries the quote in ${code("WWW-Authenticate: Payment")} and the payment in ${code("Authorization: Payment")}, and the settled answer returns a ${code("Payment-Receipt")}. The same 402 carries both the x402 offer and the MPP challenges, so your client picks the dialect.`)}
  ${mppTable}
  ${mppOrder ? p(mppOrder) : ""}
  ${h3("What you need")}
  ${p(`For the ${code("tempo")} method, a key funded with the stablecoin on Tempo. For ${code("evm")}, the same EVM key you would use for x402. For a card, a shared payment token from the card wallet your agent holds. The ${code("mppx")} client signs the challenge it can satisfy and retries for you.`)}
  ${pre(`mppx: ${snipRow ? `${snipRow.method} ${snipRow.path}` : "a paid route"}`, mppSnippet)}
  ${h3("What the receipt looks like")}
  ${pre("a settled 200 over MPP", `HTTP/2 200
Payment-Receipt: eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4…
# base64url JSON: {"method":"tempo","reference":"0x…","status":"success","timestamp":"2026-…"}`)}
  ${p(`${code("reference")} is the settlement transaction on the method's chain (for the ${code("evm")} method it is the same transaction an x402 receipt would carry). Tempo settlements are listed with their explorer links on ${link("/revenue", "/revenue")}.`)}
  ${p(`<strong style="color:var(--ink);font-weight:700;">Charge and push.</strong> A Tempo <em>charge</em> credential is broadcast by this server only after the handler answers below 400, so a 4xx or 5xx on a Tempo charge is not charged. A Tempo <em>push</em> credential is a transfer your client already sent; the server finalizes it before the handler runs, and if the answer then fails or never reaches you, the amount is booked as owed to your wallet in the refund ledger.`)}
  ${cardHtml}
`, true)}

${section("credits", `
  ${eyebrow("04 / PREPAID CREDITS")}
  ${h2("Prepaid credits: a key instead of a wallet.")}
  ${creditsLede}
  ${h3("How a key pays")}
  ${pre("one header on any paid tool", `curl -X POST ${baseUrl}/api/extract \\
  -H "Authorization: Bearer a402_YOUR_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"url":"https://example.com/article"}'
# 200 with the answer, and X-Credits-Balance: <what is left>

curl -H "Authorization: Bearer a402_YOUR_KEY" ${baseUrl}/api/credits/balance`)}
  ${p(`The gate authorizes before the handler runs (the balance must cover the route's list price), holds that amount, and debits it only on a final 200; a 4xx or 5xx on credits releases the hold. The ${code("X-Credits-Balance")} header on every answer carries what is left, and a refused call answers 402 with the balance and nothing debited. Credits never expire.`)}
  ${p(`Credits are refused on the identity-bound routes (memory, usage, attest, feedback), where the signed payer address is the identity; those take a wallet. The buyer SDK sends the key for you: pass it as ${code("creditsKey")} to ${code("new Agent402()")} and every wallet-only call carries the header.`)}
`)}

${section("free", `
  ${eyebrow("05 / FREE TIER")}
  ${h2("No wallet: pay the pure-CPU tools with proof-of-work.")}
  ${p(`${freeCount ? `${freeCount} tools` : "The pure-CPU tools"} (hashing, encoding, JSON, dates, text, finance math and more) also accept a solved sha256 puzzle instead of money: ${esc(powCostPhrase())} at the current difficulty of ${POW_DIFFICULTY} bits. No money and no model are involved on these tools. Each one is marked ${code("computePayable: true")} on ${link("/api/pricing", "/api/pricing")}, and the 402 of an eligible route names its challenge URL in ${code("X-Pow-Challenge")}.`)}
  ${pre("curl: challenge, solve, send", `curl -s "${baseUrl}/api/pow/challenge?slug=hash"
# { "challenge": "…", "difficulty": ${POW_DIFFICULTY}, "token": "…", "ttlSeconds": … }

# find an integer nonce so sha256("<challenge>:<nonce>") has at least
# <difficulty> leading zero bits, then send the TOKEN (not the challenge):
curl -X POST ${baseUrl}/api/hash \\
  -H 'Content-Type: application/json' \\
  -H "X-Pow-Solution: <token>:<nonce>" \\
  -d '{"text":"hello world"}'`)}
  ${pre("JavaScript: the same loop", `import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=hash")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
const res = await fetch("${baseUrl}/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n },
  body: JSON.stringify({ text: "hello world" }),
});`)}
  ${p(`A solved call answers 200 with ${code("X-Pow-Accepted: true")}; a wrong or reused solution answers 402 with ${code("X-Pow-Error")} naming why. A challenge is single-use, scoped to one tool, and expires. The free tier is rate-limited per client (${esc(POW_LIMITS_LABEL)}); a limited call says so in ${code("X-Pow-Limits")}. The buyer SDK solves the puzzle for you: ${code("new Agent402()")} with no fetch pays every eligible tool this way.`)}
`)}

${section("mcp", `
  ${eyebrow("06 / MCP")}
  ${h2("From an MCP host, the payment rides underneath.")}
  ${p(`The hosted connector at ${code(`${baseUrl}/mcp`)} serves the free tier with no install and no wallet${mppShimEnabled() ? `, and makes the wallet-only tools payable over MPP from an mppx-aware MCP client` : ""}. The npm server pays over x402 from a key you give it, with spend caps checked before any payment is signed.`)}
  ${pre("install lines", `# hosted, no wallet: the proof-of-work tools
claude mcp add --transport http agent402 ${baseUrl}/mcp

# npm server with a funded EVM key: every paid tool over x402
claude mcp add agent402 -s user -e AGENT_KEY=0xYOUR_FUNDED_KEY -- npx -y agent402-mcp@latest

# a credits key already issued works there too
claude mcp add agent402 -s user -e AGENT402_CREDITS_KEY=a402_YOUR_KEY -- npx -y agent402-mcp@latest`)}
  ${p(`Every host's verified config block is in the ${link("/guides/agent-hosts", "agent-hosts guide")}; ${link("/quickstart", "/quickstart")} has the same first call for curl, JavaScript and the model gateway.`)}
`)}

${section("failed", `
  ${eyebrow("07 / WHEN A CALL FAILS")}
  ${h2("What happens to the money, rail by rail.")}
  ${table(["rail", "a 4xx or 5xx", "a 200 whose settlement fails", "an answer that never reached you"], [
    row([tdMono("x402"), td("Not charged: the error cancels settlement before any facilitator call."), td("The result is withheld and you get a 402; nothing settled."), td("Not charged while the hang-up budget holds (below); past it, the charge is booked as owed.")]),
    row([tdMono("MPP evm"), td("Not charged: the same settlement path as x402."), td("Same as x402."), td("Same as x402.")]),
    row([tdMono("Tempo charge"), td("Not charged: the credential is broadcast only after a response below 400."), td("A 402 and nothing broadcast."), td("Same budget rule as x402.")]),
    row([tdMono("Tempo push"), td("The transfer was already on chain: the amount is booked as owed to you."), td("Booked as owed."), td("Booked as owed.")]),
    row([tdMono("card"), td("Nothing captured."), td("Nothing captured."), td("Same budget rule as x402.")]),
    row([tdMono("credits"), td("The hold is released; the balance is unchanged."), td("Not debited."), td("The hold is released while the budget holds; past it, the debit is booked as owed.")]),
    row([tdMono("proof-of-work"), td("The solution is spent; fetch a new challenge."), td("Not applicable: nothing settles."), td("Fetch a new challenge.")]),
  ].join(""))}
  ${p(`<strong style="color:var(--ink);font-weight:700;">The hang-up budget is bounded on purpose.</strong> A buyer whose connection closes before the first response byte is not settled while the service holds a forgiveness ticket for that request, priced at what it would have charged, against a per-wallet, per-IP and service-wide budget that a paid success never refills. The budget never refuses service: once it is spent, the call is settled as it would be without the rule, and the charge is booked as owed and repaid from the refund ledger after on-chain proof. Routes whose effect outlives the answer (memory writes, attestations, purchases from outside sellers) never take a ticket.`)}
  ${p(`<strong style="color:var(--ink);font-weight:700;">Retries.</strong> Send an ${code("Idempotency-Key")} header (or the x402 ${code("payment-identifier")} extension) and a repeat of the same credential, route and body within ${idemMinutes} minutes replays the settled 200 without a second settlement. On the x402 wallet path the key is bound to the exact signed authorization: a fresh signature is a fresh payment, so keep the signed request and resend it yourself, or use a credits key for the calls you retry. A request re-sent with the same signed EVM payment and no key is replayed the same way inside that window (${code("X-Replayed-Answer: 1")}); routes with a lasting effect and streamed calls are the exception.`)}
  ${p(`<strong style="color:var(--ink);font-weight:700;">Refunds.</strong> A charged-but-undelivered call is recorded as a debt with its settlement transaction as evidence and repaid from a separate, capped job after review; the server never holds a spending key. A refused payment is free to get wrong: ${link("/x402-test", "/x402-test")} decodes each refusal.`)}
`, true)}

${section("check", `
  ${eyebrow("08 / WHERE TO CHECK")}
  ${h2("Read it yourself before you pay.")}
  <ul class="ml-ticks" style="max-width:820px;font-size:var(--fs-base);">
    <li>${link("/api/pricing", "/api/pricing")}: every route, its price, its networks, and ${code("computePayable")} on the free ones.</li>
    <li>${link("/.well-known/x402", "/.well-known/x402")}: the machine-readable manifest, with the chains and MPP methods this instance takes.</li>
    <li>${link("/x402-test", "/x402-test")}: point any client at a real paid route and read why it was refused.</li>
    <li>${link("/proof", "/proof")}: settled receipts next to the quotes they were paid against.</li>
    <li>${link("/status", "/status")}: the paid path measured from outside, continuously.</li>
    <li>${link("/revenue", "/revenue")}: every settlement on these rails, read from the chains.</li>
  </ul>
`)}

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div class="ml-cta-panel" style="background:var(--panel);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      ${h2("Make the first call.", true)}
      <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);margin:0 0 28px;max-width:540px;">Start on the free tier with no wallet, then fund a key on one chain and the same client pays 500+ tools.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="btn btn-primary on-panel" href="/quickstart">Quickstart →</a>
        <a class="btn btn-secondary on-panel" href="/api/pricing">See every price</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/how-to-pay",
    jsonLd: [orgLd, crumbsLd, howToLd],
    extraCss,
    body,
  });
}
