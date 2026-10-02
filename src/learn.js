// /learn and /learn/<slug> - one explainer per core term. The /glossary
// defines each term in a paragraph; these pages explain it properly, with the
// headers this server actually sends. The example responses were captured
// from a local boot of this server (Base USDC entry kept, the payTo address
// replaced with a placeholder); the live 402 lists one accepts entry per
// accepted chain. Each entry's `summary` is reused verbatim by /llms-full.txt.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const DECODED_OFFER = `{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://agent402.tools/api/hash",
    "mimeType": "application/json",
    "serviceName": "Hash"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "${BASE_USDC}",
      "payTo": "0xPAYTO...",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}`;

const RAW_402 = `$ curl -i -X POST https://agent402.tools/api/hash \\
    -H 'Content-Type: application/json' -d '{"text":"hello world"}'

HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIi...
WWW-Authenticate: Payment id="Hq2dT0mB...", realm="agent402.tools", method="tempo",
  intent="charge", request="eyJhbW91bnQiOiIxMDAwIi...", expires="2026-09-24T12:41:07.520Z",
  Payment id="8w5V62E3...", realm="agent402.tools", method="evm",
  intent="charge", request="eyJhbW91bnQiOiIxMDAwIi...", expires="2026-09-24T12:41:07.520Z",
  opaque="eyJ4NDAyIjoie1wic2NoZW1l..."
  (one challenge per currency and chain: USDC.e then PathUSD on Tempo, USDC on Base then Celo)
X-Pow-Challenge: https://agent402.tools/api/pow/challenge?slug=hash

{"altPayment":{"protocol":"proof-of-work", ...},"x402Version":2,"error":"Payment required","resource":{...},"accepts":[...],"extensions":{...}}`;

const MPP_REQUEST = `// base64url-decoded "request" parameter of the evm challenge above
{
  "amount": "1000",
  "currency": "${BASE_USDC}",
  "methodDetails": { "chainId": 8453, "credentialTypes": ["authorization"], "decimals": 6 },
  "recipient": "0xPAYTO..."
}`;

const X402_CLIENT = `import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "hello world" }),
});
console.log(res.status, await res.json());   // 200, and a PAYMENT-RESPONSE header`;

const MPP_CLIENT = `import { Fetch, evm, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppFetch = Fetch.from({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const res = await mppFetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "hello world" }),
});
console.log(res.headers.get("payment-receipt"));   // signed receipt on success`;

const CLIENT_CAPS = `import { Agent402 } from "agent402-client";

// Free pure-CPU tools pay with proof-of-work; paid tools use the fetch you pass.
const agent = new Agent402({ fetch: payFetch, maxPerCallUsd: 0.05, dailyLimitUsd: 2 });

const [tool] = await agent.find("extract the main text of a web page");
const page = await agent.call(tool.slug, { url: "https://example.com" });`;

const MCP_ASK = `// tools/call on https://agent402.tools/mcp for a wallet-only tool, no credential yet
{
  "content": [{ "type": "text", "text": "This tool needs payment ..." }],
  "isError": true,
  "_meta": {
    "org.paymentauth/payment-required": {
      "httpStatus": 402,
      "challenges": [{ "id": "...", "method": "evm", "intent": "charge", "request": { "amount": "...", ... } }]
    }
  }
}

// the retry carries the credential in params._meta["org.paymentauth/credential"];
// the paid result carries _meta["org.paymentauth/receipt"]`;

const PRICING_ENTRY = `$ curl -s https://agent402.tools/api/find?q=hash+some+text
# each match carries route, price, input schema and a ready example

$ curl -s -o /dev/null -w '%{http_code}\\n' -X POST https://agent402.tools/api/hash \\
    -H 'Content-Type: application/json' -d '{"text":"hello world"}'
402   # the quote: amount "1000" = $0.001 in USDC (6 decimals), nothing charged yet`;

const P = (s) => `<p>${s}</p>`;
const C = (s) => `<code>${esc(s)}</code>`;

export const LEARN = [
  {
    slug: "x402",
    term: "x402",
    alt: ["x402 protocol", "HTTP 402 payments"],
    glossary: "x402",
    title: "What is x402? The HTTP payment protocol, explained",
    description: "x402 turns HTTP 402 Payment Required into a working payment: a machine-readable price in a header, a signed stablecoin authorization on the retry, and a receipt on the answer. How it works, with the exact headers this server sends.",
    summary: "x402 is an open protocol that makes HTTP 402 Payment Required a working payment flow: the server puts machine-readable payment terms in a PAYMENT-REQUIRED header, the client retries with a signed stablecoin authorization in PAYMENT-SIGNATURE, a facilitator verifies and settles it on chain, and the answer carries a PAYMENT-RESPONSE receipt.",
    sections: [
      ["The short version", [
        P(`x402 is an open protocol for paying for an HTTP request with the request itself. There is no account to open and no API key to issue: the server states a price, the client pays it, and the same URL answers. It is built for software that has to buy things without a human in the loop, which makes it a natural fit for AI agents paying for tools and data.`),
        P(`It uses three headers. ${C("PAYMENT-REQUIRED")} on a 402 response carries the offer. ${C("PAYMENT-SIGNATURE")} on the retry carries the payment. ${C("PAYMENT-RESPONSE")} on the successful answer carries the receipt, including the on-chain transaction.`),
      ]],
      ["How one payment works", [
        `<ol><li>The client calls a paid URL with no payment attached.</li><li>The server answers ${C("402 Payment Required")} with a ${C("PAYMENT-REQUIRED")} header: base64 JSON listing each accepted way to pay (scheme, network, asset, amount, recipient, validity window).</li><li>The client picks one entry and signs an authorization for exactly that amount to exactly that recipient. On EVM chains this is an EIP-3009 ${C("transferWithAuthorization")}, so the payer needs USDC but no gas.</li><li>The client repeats the request with the signed authorization in ${C("PAYMENT-SIGNATURE")}.</li><li>The server has a facilitator verify the signature, runs the request, and settles the transfer on chain.</li><li>The answer comes back with ${C("PAYMENT-RESPONSE")} naming the settlement transaction.</li></ol>`,
      ]],
      ["The offer this server sends", [
        P(`Here is the decoded ${C("PAYMENT-REQUIRED")} header from a request to ${C("POST /api/hash")}, trimmed to the Base entry. The live response lists one entry per chain this server accepts. ${C('"amount": "1000"')} is in the asset's smallest unit: USDC has 6 decimals, so this is $0.001.`),
        { code: DECODED_OFFER },
        P(`The header carries the offer, and this server also copies the same object into the JSON body, after its own fields. Another server's 402 with an empty body can still be a complete offer, because the terms are in the header.`),
      ]],
      ["Paying from code", [
        P(`A stock x402 client wraps ${C("fetch")}: it reads the 402, signs one of the offered entries and retries, so the calling code sees an ordinary 200.`),
        { code: X402_CLIENT },
      ]],
      ["What happens when a call fails", [
        P(`On this server the tool runs before settlement, and settlement completes only for a successful response. An error, a timeout or an upstream failure cancels the payment, so nothing moves. You can check it from the response you hold: no ${C("PAYMENT-RESPONSE")} header means you were not charged. Send an ${C("Idempotency-Key")} header and a retry of a call that was already served and paid replays the first answer.`),
      ]],
    ],
    links: [["/what-is-x402", "What is x402? (the full explainer)"], ["/x402-test", "Test your x402 client against a real 402"], ["/guides/x402-in-5-minutes", "x402 in 5 minutes"], ["/integrations/client", "agent402-client"], ["/tools/hash", "hash, the tool in the example"]],
  },
  {
    slug: "http-402",
    term: "HTTP 402 Payment Required",
    alt: ["402 status code", "402 Payment Required"],
    glossary: "http-402",
    title: "HTTP 402 Payment Required: what the status code means",
    description: "HTTP 402 Payment Required was reserved for future use for decades. Today it is the price quote in pay-per-request APIs. What a 402 means, what this server puts in one, and how to tell whether you were charged.",
    summary: "HTTP 402 Payment Required is the status code a server returns when a resource exists but costs money. Long reserved for future use, it is now the price quote in x402 and MPP: the 402 carries the payment terms in its headers, and the payment rides on the retry.",
    sections: [
      ["A status code that waited", [
        P(`HTTP defines ${C("402 Payment Required")} and, in the current specification (RFC 9110), says only that it is reserved for future use. For most of the web's history no one used it: payment happened on a separate checkout page, and the API behind it answered 401 or 403 when a key was missing.`),
        P(`Pay-per-request protocols give it a job. A 402 now means "this resource is here, and this is what it costs". The response tells the client how to pay, and the client pays by repeating the request with a payment attached. Two protocols define the details: x402, which puts the offer in a ${C("PAYMENT-REQUIRED")} header, and MPP, which uses the standard ${C("WWW-Authenticate")} header with a scheme named ${C("Payment")}.`),
      ]],
      ["What a 402 from this server contains", [
        P(`Every paid route answers an unpaid request with a 402 that carries both offers at once, plus a free path where one exists:`),
        { code: RAW_402 },
        `<ul><li>${C("PAYMENT-REQUIRED")}: the x402 offer, base64 JSON with one entry per accepted chain.</li><li>${C("WWW-Authenticate: Payment")}: the MPP challenges for the same price, one per method and currency (Tempo first, then Base and Celo), each bound to this server by a signed id and an expiry.</li><li>${C("X-Pow-Challenge")}: on tools that accept proof-of-work, where to get a puzzle instead of paying money.</li></ul>`,
        P(`A client that speaks only one of the two protocols should look for the header it understands. An unfamiliar ${C("WWW-Authenticate")} scheme does not mean there is no way to pay.`),
      ]],
      ["A 402 costs nothing", [
        P(`Reading a 402 is free. It is a quote, not a charge, and no payment is taken until a request arrives carrying a signed payment that matches one of the offers. That makes the 402 a useful discovery step: an agent can learn the price of any route before deciding to buy.`),
      ]],
      ["Was I charged?", [
        P(`On this server settlement runs after the tool, and only for a successful response. So for a wallet payment the answer you hold tells you: a 200 with a ${C("PAYMENT-RESPONSE")} header (x402) or a ${C("Payment-Receipt")} header (MPP) was paid; a response with no receipt header was not charged, and neither was one whose x402 receipt reads ${C("success: false")}. A payment that is refused comes back as another 402, and when the refusal is about the credential the body says why in plain words.`),
      ]],
    ],
    links: [["/x402-test", "See why a payment was refused"], ["/learn/x402", "x402"], ["/learn/mpp", "MPP"], ["/integrations/tollbooth", "Answer 402s on your own site"], ["/tools", "Every priced route"]],
  },
  {
    slug: "mpp",
    term: "MPP (Machine Payments Protocol)",
    alt: ["Machine Payments Protocol", "Payment HTTP authentication scheme"],
    glossary: "mpp",
    title: "What is MPP? The Machine Payments Protocol, explained",
    description: "MPP carries pay-per-request payments in HTTP's standard authentication headers: WWW-Authenticate: Payment, Authorization: Payment and Payment-Receipt. How a challenge is built, with a real one from this server, and how to pay it.",
    summary: "MPP (the Machine Payments Protocol) carries pay-per-request payments through HTTP's standard authentication headers: a 402 challenges with WWW-Authenticate: Payment, the client answers with an Authorization: Payment credential, and the settled response returns a signed Payment-Receipt. Its evm method settles USDC by EIP-3009; its tempo method settles natively on Tempo.",
    sections: [
      ["Payment as an HTTP auth scheme", [
        P(`The web already has a way for a server to say "you need to present something before I answer": the ${C("WWW-Authenticate")} and ${C("Authorization")} headers defined in RFC 9110, the mechanism behind login prompts. MPP adds a scheme to it called ${C("Payment")}. A server challenges with ${C("WWW-Authenticate: Payment")}, the client answers with ${C("Authorization: Payment")}, and a successful answer carries a signed ${C("Payment-Receipt")}.`),
        P(`MPP and x402 express the same idea in different headers. A server can speak both on one route at one price, and every paid route on this server does.`),
      ]],
      ["Anatomy of a challenge", [
        P(`This is the challenge this server sends for ${C("POST /api/hash")}:`),
        { code: `WWW-Authenticate: Payment id="8w5V62E37kA2OiliORKf6BFEX56u4_eomTkyMpYJDeY",
  realm="agent402.tools", method="evm", intent="charge",
  request="eyJhbW91bnQiOiIxMDAwIi...", expires="2026-09-24T12:41:07.520Z",
  opaque="eyJ4NDAyIjoie1wic2NoZW1l..."` },
        `<ul><li>${C("method")}: how the payment settles. ${C("evm")} is an EIP-3009 USDC authorization; ${C("tempo")} is a native transfer on the Tempo chain.</li><li>${C("intent")}: ${C("charge")} is a one-off payment for this request.</li><li>${C("request")}: base64url JSON with the amount, currency, recipient and chain.</li><li>${C("id")}: a signed binding, so the server can check it minted this challenge.</li><li>${C("expires")}: after this time the challenge is no longer accepted.</li></ul>`,
        { code: MPP_REQUEST },
      ]],
      ["Paying it", [
        P(`The ${C("mppx")} client wraps ${C("fetch")} and pays whichever method it has configured. With both methods listed it can pay on Tempo or on an EVM chain from the same key.`),
        { code: MPP_CLIENT },
      ]],
      ["When a credential is refused", [
        P(`A refused credential is answered with a 402, fresh challenges and an ${C("application/problem+json")} body in the RFC 9457 shape: a ${C("type")} URL naming the reason (for example verification-failed or payment-insufficient), a title and a ${C("detail")} sentence. Nothing is charged, and the client can retry with the new challenge.`),
      ]],
    ],
    links: [["/what-is-mpp", "What is MPP? (the full explainer)"], ["/guides/x402-and-mpp", "x402 and MPP on one route"], ["/mpp-marketplace", "Sellers on the MPP wire"], ["/integrations/client", "agent402-client over MPP"], ["/learn/mcp-payments", "MPP over MCP"]],
  },
  {
    slug: "agent-payments",
    term: "Agent payments",
    alt: ["agentic payments", "machine payments", "AI agent payments"],
    glossary: "agentic-payments",
    title: "Agent payments: how AI agents pay for APIs",
    description: "How an AI agent pays for a tool or an API on its own: read a price from a 402, pay from its own wallet or a prepaid key, keep a receipt, and stay inside spend limits set before anything is signed.",
    summary: "Agent payments are how software agents buy tools and data on their own: the agent reads a price from an HTTP 402, pays per request from its own wallet (x402 or MPP) or a prepaid key, receives a receipt, and stays inside spend limits its operator set in advance.",
    sections: [
      ["Why accounts do not work for agents", [
        P(`Most paid APIs assume a person: someone signs up, verifies an email, enters a card and copies an API key into a config file. An agent working through a task cannot do any of that, and giving it a long-lived key to every service it might need is both impractical and risky. What an agent can hold is a wallet with a small balance, or a prepaid key its operator bought for it.`),
        P(`Agent payments replace the account with the payment. The price is stated in the response, the agent pays for that one request, and the payer address on the settled payment is the only identity involved.`),
      ]],
      ["The pieces", [
        `<ul><li><strong>A price the agent can read.</strong> An HTTP 402 with machine-readable terms (x402's ${C("PAYMENT-REQUIRED")}, MPP's ${C("WWW-Authenticate: Payment")}), plus catalogs such as /api/pricing and /openapi.json that list prices up front.</li><li><strong>A way to pay.</strong> A stablecoin authorization signed by the agent's own key, a prepaid credits key sent as a Bearer token, or, for pure-CPU tools here, a short proof-of-work puzzle.</li><li><strong>A receipt.</strong> A header on the answer that names the settlement, so spend can be reconciled call by call.</li><li><strong>Limits.</strong> Per-call and daily ceilings enforced by the client before it signs anything.</li></ul>`,
      ]],
      ["Limits belong in the client", [
        P(`An agent that can pay can overspend, so the checks that matter run before a payment is signed. The buyer SDK, the MCP server and the AgentKit and elizaOS integrations here take a per-call ceiling and a daily or per-session ceiling and refuse a 402 that asks for more; the buyer SDK also reserves the price of a call before sending it, so concurrent calls cannot overshoot.`),
        { code: CLIENT_CAPS },
      ]],
      ["No wallet yet", [
        P(`Two paths need no wallet. Pure-CPU tools on this server accept a proof-of-work solve instead of money, a fraction of a second of CPU. For everything else, a prepaid card-credits key works on any paid tool: the price is held before the call and debited only on a successful response.`),
      ]],
    ],
    links: [["/agentic-finance", "Agentic Finance"], ["/guides/create-agent-wallet", "Create an agent wallet"], ["/credits", "Prepaid card credits"], ["/integrations", "Framework integrations"], ["/tools/route-execute", "route-execute: buy from another seller in one call"]],
  },
  {
    slug: "pay-per-call-api",
    term: "Pay-per-call API",
    alt: ["pay-per-request API", "per-call pricing", "usage-based API pricing"],
    glossary: "pay-per-call",
    title: "Pay-per-call APIs: pricing each request on its own",
    description: "A pay-per-call API prices each request separately and takes payment with the request, instead of a subscription or a quota behind an API key. How it works, what gets charged, and how retries and failures are handled.",
    summary: "A pay-per-call API prices every request on its own and takes payment with the request, rather than through a subscription, a quota or an API key. The price is quoted in an HTTP 402 before anything is paid, and a failed call is not charged.",
    sections: [
      ["One request, one price", [
        P(`A pay-per-call API charges for each request individually. There is no plan to pick and no monthly minimum: the caller pays the stated price for the call it makes, and a caller who makes one request pays for one request. Prices on this server start at $0.001 per call.`),
        P(`That shape suits callers whose usage is irregular or unpredictable, which describes most agents. It also suits sellers, because a stranger can buy a single call with no onboarding.`),
      ]],
      ["The price comes first", [
        P(`Every priced route answers an unpaid request with a 402 carrying its price, so a caller always knows the cost before paying. Catalogs list the same prices ahead of time: /api/pricing and /openapi.json on this server, and ${C("/api/find")} returns the price with each match.`),
        { code: PRICING_ENTRY },
        P(`Some routes price a request by its size rather than a flat fee. The metered model routes quote each request from its body, and a buyer paying through a prepaid key or a Permit2 allowance settles at actual usage under that quote.`),
      ]],
      ["What is charged, and what is not", [
        `<ul><li>A successful answer is charged once, and carries a receipt.</li><li>A failed call (an error, a timeout, an upstream outage) is not charged, because settlement runs after the tool and only on success.</li><li>A retry with the same ${C("Idempotency-Key")} and the same credential replays the first answer instead of paying again.</li><li>Reading the 402 quote is free.</li></ul>`,
      ]],
      ["Paying at volume", [
        P(`Signing and settling every request on chain is the right shape for occasional calls and the wrong one for thousands. Two options avoid it: a prepaid credits key (one card purchase, then a Bearer header on each call, debited per success) or, with a wallet on Base, a one-time Permit2 approval so metered calls settle at actual usage. Both keep the per-request price; only the settlement changes.`),
      ]],
    ],
    links: [["/pricing", "How this server prices"], ["/api/pricing", "Machine-readable prices"], ["/tools", "The catalog"], ["/integrations/client", "agent402-client"], ["/integrations/tollbooth", "Sell your own API per call"]],
  },
  {
    slug: "mcp-payments",
    term: "MCP payments",
    alt: ["paid MCP tools", "MCP tool payments"],
    glossary: "mcp",
    title: "MCP payments: how an MCP client pays for a tool call",
    description: "How paid tools work over the Model Context Protocol: a local MCP server that pays underneath with a wallet or credits key, or a hosted connector that asks for payment in the tool result and accepts an MPP credential on the retry.",
    summary: "MCP payments let an assistant pay for a tool call made over the Model Context Protocol, either through a local MCP server that signs payments underneath (wallet or prepaid key) or through a hosted connector that returns MPP challenges in the tool result and accepts a credential in _meta on the retry.",
    sections: [
      ["Two places payment can happen", [
        P(`The Model Context Protocol lets an assistant discover and call tools. It does not itself say how a tool gets paid for, so there are two practical patterns, and this server supports both.`),
        `<ol><li><strong>A local MCP server pays underneath.</strong> The assistant talks to a stdio server on your machine (${C("npx -y agent402-mcp")}). When a tool call hits a 402, that server pays it with the key you configured and returns the result. The assistant never sees the payment.</li><li><strong>A hosted connector asks, and the client pays.</strong> The assistant talks to a remote MCP endpoint (${C("https://agent402.tools/mcp")}). A wallet-only tool answers with the payment challenges attached, and a client that speaks MPP pays and repeats the call.</li></ol>`,
      ]],
      ["The local server", [
        P(`Configure one of three things: ${C("AGENT_KEY")} (an EVM key holding USDC, signing x402 payments), ${C("AGENT402_CREDITS_KEY")} (a prepaid card-credits key, sent as a Bearer token and debited only on success), or nothing, in which case the pure-CPU tools pay with proof-of-work. ${C("AGENT402_MAX_PER_CALL")} and ${C("AGENT402_BUDGET")} are checked before any payment is signed.`),
        { code: `{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_YOUR_KEY", "AGENT402_MAX_PER_CALL": "0.05" }
    }
  }
}` },
      ]],
      ["The hosted connector", [
        P(`On the hosted connector the pure-CPU tools run free (rate-limited). A wallet-only tool called without payment returns a readable tool result with the MPP challenges in ${C('_meta["org.paymentauth/payment-required"]')}, so a host that does not speak MPP still shows the user something useful. An MCP client wrapped with mppx's ${C("McpClient.wrap()")} reads the challenges, pays, and retries with the credential in ${C('_meta["org.paymentauth/credential"]')}; the result comes back with ${C('_meta["org.paymentauth/receipt"]')}. A credential that is refused is JSON-RPC error ${C("-32043")}.`),
        { code: MCP_ASK },
        P(`Behind the connector the call is replayed against the same paid HTTP route an HTTP client would use, so the price, the settlement rules and the receipt are identical either way.`),
      ]],
    ],
    links: [["/integrations/mcp", "agent402-mcp"], ["/guides/agent-hosts", "Config blocks for every MCP host"], ["/learn/mpp", "MPP"], ["/docs#add", "Add to Claude"], ["/tools/search", "search, a flagship MCP tool"]],
  },
];

export const learnSlugs = () => LEARN.map((l) => l.slug);
export const learnBySlug = (slug) => LEARN.find((l) => l.slug === slug) || null;
/** glossary id -> learn slug, read by /glossary to link each term to its page. */
export const LEARN_BY_GLOSSARY_ID = Object.fromEntries(LEARN.map((l) => [l.glossary, l.slug]));

const LEARN_CSS = `
.lp-body{max-width:780px}
.lp-body p,.lp-body li{font-size:16.5px;line-height:1.7;color:var(--muted)}
.lp-body p{margin:0 0 16px}
.lp-body ul,.lp-body ol{padding-left:22px;margin:0 0 18px}
.lp-body li{margin:0 0 8px}
.lp-body h2{font-family:var(--font-body);font-weight:800;font-size:25px;letter-spacing:-.02em;margin:38px 0 14px;color:var(--ink)}
.lp-body code{font-family:var(--font-mono);font-size:.88em;color:var(--ink)}
.lp-body strong{color:var(--ink)}
.lp-body pre{background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.8rem;line-height:1.55;padding:16px;margin:0 0 18px;overflow-x:auto;white-space:pre}
.lp-body pre code{color:inherit;font-size:inherit}
.lp-links a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent)}
`;

function renderBlock(b) {
  if (typeof b === "string") return b;
  if (b && b.code) return `<pre><code>${esc(b.code)}</code></pre>`;
  return "";
}

export function learnPage(baseUrl, slug) {
  const l = learnBySlug(slug);
  if (!l) return null;
  const canonical = `${baseUrl}/learn/${l.slug}`;
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Learn", item: `${baseUrl}/learn` },
      { "@type": "ListItem", position: 3, name: l.term, item: canonical },
    ],
  };
  const termLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    "@id": `${canonical}#term`,
    name: l.term,
    alternateName: l.alt,
    description: l.summary,
    url: canonical,
    inDefinedTermSet: { "@type": "DefinedTermSet", "@id": `${baseUrl}/glossary#set`, name: "Agentic Finance (AIFI) glossary", url: `${baseUrl}/glossary` },
  };
  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: l.title,
    description: l.description,
    url: canonical,
    about: { "@id": `${canonical}#term` },
    author: { "@type": "Organization", name: "Havok Holdings LLC" },
    publisher: { "@type": "Organization", name: "Agent402", url: baseUrl },
  };
  const sections = l.sections.map(([h, blocks]) => `<h2>${esc(h)}</h2>\n${blocks.map(renderBlock).join("\n")}`).join("\n");
  const others = LEARN.filter((x) => x.slug !== l.slug).map((x) => `<a href="/learn/${x.slug}">${esc(x.term)}</a>`).join(" &middot; ");
  const body = `
  <article style="max-width:1000px;margin:0 auto;padding:50px 30px 60px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/learn" style="color:var(--muted);text-decoration:none;">learn</a> / <span style="color:var(--ink);">${esc(l.slug)}</span></nav>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:46px;line-height:1.02;letter-spacing:-.03em;margin:0 0 18px;max-width:860px;">${esc(l.term)}</h1>
    <p style="font-size:19px;line-height:1.55;color:var(--ink);margin:0 0 8px;max-width:780px;">${esc(l.summary)}</p>
    <div class="lp-body">
${sections}
      <h2>Related</h2>
      <ul class="lp-links">${l.links.map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`).join("")}<li><a href="/glossary#${esc(l.glossary)}">Glossary entry</a></li></ul>
      <p class="lp-links" style="font-size:14px;">More explainers: ${others}</p>
    </div>
  </article>
  ${ledgerFooterCompact()}`;
  return ledgerShell({ title: l.title, description: l.description, canonical, baseUrl, activePath: "/agentic-finance", extraCss: LEARN_CSS, jsonLd: [breadcrumbLd, termLd, articleLd], body });
}

export function learnIndex(baseUrl) {
  const canonical = `${baseUrl}/learn`;
  const title = "Learn: how AI agents pay for APIs over x402 and MPP";
  const description = "Explainers for the protocols behind pay-per-request APIs for AI agents: x402, HTTP 402 Payment Required, MPP, agent payments, pay-per-call pricing and payments over MCP, each with the headers this server actually sends.";
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Learn", item: canonical },
    ],
  };
  const listLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Learn",
    itemListElement: LEARN.map((l, i) => ({ "@type": "ListItem", position: i + 1, url: `${baseUrl}/learn/${l.slug}`, name: l.term })),
  };
  const cards = LEARN.map((l) => `<a href="/learn/${l.slug}" style="display:block;border:1px solid var(--hairline);background:var(--card);padding:20px 22px;text-decoration:none;color:var(--ink);">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:21px;margin:0 0 8px;">${esc(l.term)}</h2>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;">${esc(l.summary)}</p>
    </a>`).join("\n");
  const body = `
  <section style="max-width:1180px;margin:0 auto;padding:52px 30px 64px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">learn</span></nav>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:50px;line-height:1;letter-spacing:-.03em;margin:0 0 16px;">How agents pay for APIs</h1>
    <p style="font-size:17px;line-height:1.6;color:var(--muted);max-width:720px;margin:0 0 34px;">Six explainers, each with a working example. For one-paragraph definitions of every term, see the <a href="/glossary" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">glossary</a>; to wire payments into a framework, see <a href="/integrations" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">integrations</a>.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;">
${cards}
    </div>
  </section>
  ${ledgerFooterCompact()}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/agentic-finance", jsonLd: [breadcrumbLd, listLd], body });
}
