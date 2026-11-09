// Server-rendered technical guides — the prose layer for organic search.
// Machine surfaces (llms.txt, OpenAPI) serve agents; these serve the humans
// googling "x402 example" or "AI agent payments" before their agents do.
import { siteOrgRef } from "./site-org.js";
import { REPO_URL, repoUrl } from "./repo-link.js";
import { networkFloorUsd, ROBINHOOD_CAIP2 } from "./network-floors.js";
// The renderer and its heading ids (GitHub-style slugs, so the dev shortlinks
// such as /claude -> /guides/agent-hosts#claude-code can deep-link a section)
// are configured in one place, shared with the markdown-to-html tool.
import { marked, headingId } from "./tools/markdown-render.js";
export { headingId };
import { ledgerShell, ledgerFooterCompact, esc, breadcrumbTrail } from "./ledger-chrome.js";
import { fitTitle } from "./seo-meta.js";
import { GUIDE_INTEGRATIONS, integrationBySlug } from "./integration-pages.js";
import { RAILS_COUNT, RAILS_COUNT_MD, resolveRailCountTokens, chainDisplayName } from "./rails.js";
import { routerPayChains } from "./tools/route-execute.js";
import { TIERS, METERED_MAX_QUOTE_USD, EMBEDDINGS_PRICE, METERED_MAX_INPUT_CHARS_CEILING } from "./tools/llm-gateway-kit.js";
import { routingProofSentence, routerRankingSentence } from "./routing-proof.js";
import { mppEvmDiscoveryRails, mppShimEnabled } from "./mpp-shim.js";
import { FLAGSHIP_SLUGS, FLAGSHIP_MCP_NAMES } from "./mcp-flagship.js";
import { creditsSalesEnabled, creditsPrepaymentPhrase } from "./credits-sales.js";
import { TYPICAL_PRICE_RANGE } from "./typical-price-range.js";
import { meteredRoutesInline, meteredFromPrice, meteredQuoteSentence, meteredDefaultModel, flatTiersLine } from "./metered-lead.js";
// The buying-at-volume guide quotes each limit from the code that enforces it.
import { unpaidQuoteBudgetPerHour, METERED_UNPAID_QUOTES_PER_MIN, METERED_UNPAID_QUOTES_PER_HOUR, PAID_CLIENT_QUOTE_MULTIPLIER, PAID_CLIENT_METERED_QUOTES_PER_MIN, PAID_CLIENT_METERED_QUOTES_PER_HOUR } from "./unpaid-quote-budget.js";
import { PAID_QUOTE_TRUST_MINUTES, METERED_QUOTE_CREDITS_PER_CALL } from "./paid-quote-trust.js";
import { MAX_FAILS as SETTLE_BREAKER_MAX_FAILS, WINDOW_MS as SETTLE_BREAKER_WINDOW_MS, HARD_MAX_FAILS as SETTLE_BREAKER_HARD_MAX } from "./gateway-settle-breaker.js";
import { ASYNC_JOBS_PER_CLIENT } from "./async-jobs.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { IDEM_MAX_BODY_LABEL } from "./idempotency-limits.js";
import { LATE_SETTLE_EXCEPTION } from "./front-door.js";
import { AGENT402_MCP_VERSION } from "./mcp-flagship.js";
import { OCR_LARGE_PIXELS } from "./tools/ocr-kit.js";
import { asyncProfileOf } from "./slow-routes.js";
import { needsAsyncOrWait } from "./slow-sync-window.js";
import { COMPOSITE_GUARD_LIMITS, isLongRunningSlug } from "./composite-spend-guard.js";
import { UNPAID_BODY_MAX_BYTES, UNPAID_LIMITS as LARGE_BODY_UNPAID } from "./large-body-gate.js";
// The report and media routes' per-buyer guard, read from the module that
// enforces it (its env overrides included).
const COMPOSITE_GUARD = COMPOSITE_GUARD_LIMITS;
/** A failure share in prose: 0.5 reads "half", so the guide says "more than half"
 *  from the limit itself (other shares read as a percentage). */
export function failShareWords(share) {
  const words = { 0.25: "a quarter", 0.5: "half", 0.75: "three quarters" };
  return words[share] ?? `${Math.round(share * 100)} percent`;
}
// The large-body gate's unpaid limiter (server.js "large-body-unpaid") reads the
// same export; it is keyed on the client address alone and has no paid-address raise.
const LARGE_BODY_UNPAID_PER_MIN = LARGE_BODY_UNPAID.PER_MIN;
const LARGE_BODY_UNPAID_PER_HOUR = LARGE_BODY_UNPAID.PER_HOUR;
// The content-pipeline guide reads the speech and transcription caps from their kits.
import { TTS_TIERS, VOICES as TTS_VOICES, FORMATS as TTS_FORMATS, LITE_FORMATS as TTS_LITE_FORMATS } from "./tools/tts-kit.js";
import { STT_TIERS, MAX_AUDIO_BYTES as STT_MAX_AUDIO_BYTES } from "./tools/stt-kit.js";
/** Where the buying-at-volume guide lives (the metered quote limiter's 429 links it). */
export const BUYING_AT_VOLUME_PATH = "/guides/buying-at-volume";
// Whether prepaid credits are sold now. Copy that tells a reader to buy a pack
// is only true while they are; read once at module load, like the env it reads.
const CREDITS_ON = creditsSalesEnabled();

// Prices in guide prose are never typed: a guide writes {{price:<slug>}} (the
// list price), {{amount:<slug>}} (the same price in USDC atomic units, as an
// x402 v2 accepts entry carries it) or {{routerTiers}} (the route-execute tier
// table), and guidePage() resolves them against the live catalog. An unknown
// slug throws, so a retired tool fails the page test instead of shipping a
// stale figure. Without a catalog (offline renders) the tokens point at
// /api/pricing.
const priceUsd = (p) => Number(String(p ?? "").replace(/[^0-9.]/g, ""));
const fmtUsd = (n) => `$${n.toFixed(n < 0.01 ? 3 : 2)}`;
/** The long-running routes among `slugs`, as "`a`, `b` and `c`". */
export function evmOnlyStagesText(slugs) {
  const longOnes = slugs.filter((s) => isLongRunningSlug(s)).map((s) => `\`${s}\``);
  if (!longOnes.length) throw new Error(`guide token {{evmOnly:${slugs.join(",")}}} names no long-running route`);
  return longOnes.length === 1 ? longOnes[0] : `${longOnes.slice(0, -1).join(", ")} and ${longOnes[longOnes.length - 1]}`;
}
// Every content-pipeline stage, in the order of its stage table.
export const PIPELINE_STAGE_SLUGS = ["answer", "research", "v1-chat-metered", "tts-lite", "tts", "tts-hd", "v1-images-fast", "v1-images-pro", "v1-images-edit", "transcribe", "transcribe-pro", "srt-convert", "skill-subtitle-pipeline", "dub", "media-info", "audio-convert", "audio-normalize"];
const PIPELINE_TOKEN = `{{evmOnly:${PIPELINE_STAGE_SLUGS.join(",")}}}`;
function resolveGuideTokens(text, catalog) {
  const bySlug = catalog ? new Map(Object.values(catalog).filter((d) => d && d.slug).map((d) => [d.slug, d])) : null;
  const def = (slug) => {
    const d = bySlug.get(slug);
    if (!d) throw new Error(`guide token names "${slug}", which is not in the catalog`);
    return d;
  };
  return resolveRailCountTokens(String(text))
    .replace(/\{\{price:([a-z0-9-]+)\}\}/g, (_, slug) => (bySlug ? def(slug).price : "(price on /api/pricing)"))
    .replace(/\{\{amount:([a-z0-9-]+)\}\}/g, (_, slug) => (bySlug ? String(Math.round(priceUsd(def(slug).price) * 1e6)) : "<amount>"))
    // {{jobs:<slug>[,<slug>]}}: whether a route runs as a job, read from the
    // async profile the catalog carries (src/slow-routes.js) and the slow-sync
    // window (SLOW_SYNC_WINDOW_SECONDS): "yes, required" when a paid call
    // without Prefer: respond-async (or a long enough Prefer: wait) is refused,
    // "on request" when the route takes the header, "no" otherwise. The slugs
    // on one row must agree.
    .replace(/\{\{jobs:([a-z0-9,-]+)\}\}/g, (_, list) => {
      const answers = [...new Set(list.split(",").map((slug) => {
        const profile = asyncProfileOf(bySlug ? def(slug) : { slug });
        return !profile ? "no" : needsAsyncOrWait(profile) ? "yes, required" : "on request";
      }))];
      if (answers.length !== 1) throw new Error(`guide token {{jobs:${list}}} names routes that run differently`);
      return answers[0];
    })
    // {{evmOnly:<slug>,...}}: of the routes named, the long-running ones
    // (isLongRunningSlug), which take x402 exact on EVM chains only, as a
    // code-formatted list. A list with none of them is an error.
    .replace(/\{\{evmOnly:([a-z0-9,-]+)\}\}/g, (_, list) => evmOnlyStagesText(list.split(",")))
    .replace(/\{\{routerTiers\}\}/g, () => {
      if (!bySlug) return "The tiers and their prices are listed at [/api/pricing](https://agent402.tools/api/pricing).";
      const rows = [...bySlug.values()]
        .filter((d) => /^route-execute(-|$)/.test(d.slug) && Number.isFinite(d.underlyingMaxUsd))
        .sort((a, b) => priceUsd(a.price) - priceUsd(b.price));
      return "| Route | Price | Covers tools listed up to |\n| --- | --- | --- |\n" +
        rows.map((d) => `| \`${d.route}\` | ${fmtUsd(priceUsd(d.price))} | ${fmtUsd(d.underlyingMaxUsd)} |`).join("\n");
    })
    .replace(/\{\{mcpRunActions\}\}/g, () => {
      // The flagship actions the connector lists: a flagship is listed only
      // when its slug is in the catalog, so the guide names the same set.
      const slugs = bySlug ? FLAGSHIP_SLUGS.filter((slug) => bySlug.has(slug)) : FLAGSHIP_SLUGS.filter((slug) => !slug.startsWith("decide"));
      return slugs.map((slug) => "`" + FLAGSHIP_MCP_NAMES[slug] + "`").join(", ");
    })
    // The connector pays a wallet-only tool over MPP only while MPP is on
    // (the same MPP_SECRET_KEY switch the connector's loopback reads).
    .replace(/\{\{connectorPaidAnswer\}\}/g, () => (mppShimEnabled()
      ? "answer with their MPP payment challenge instead of a result: an MCP client that pays MPP settles it in the same call"
      : "answer with payment setup instead of a result"))
    .replace(/\{\{routingProof\}\}/g, () => routingProofSentence())
    .replace(/\{\{routerRanking\}\}/g, () => routerRankingSentence())
    // The router's other chains, read from route-execute (its fixed map plus
    // the EVM chains SOR_EVM_CHAINS lists), so the guide names every one.
    .replace(/\{\{routerOtherLegs\}\}/g, () => {
      const names = routerPayChains().filter((c) => c !== "base").map((c) => `**${chainDisplayName(c)}**${c === "tempo" ? " (MPP)" : ""}`);
      return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
    })
    .replace(/\{\{mppEvmRails\}\}/g, () => {
      const names = mppEvmDiscoveryRails().map((r) => r.name);
      return names.length ? `(${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} on this instance; [/.well-known/x402](/.well-known/x402) lists them)` : "(listed in [/.well-known/x402](/.well-known/x402) when MPP is on)";
    });
}
// Derived at module load from the live tier table so the guide can never say a
// price the gateway does not charge (the first version typed these).
const FLAT_TIER_ROWS = Object.entries(TIERS)
  .filter(([slug, t]) => slug.startsWith("v1-chat") && !t.stealth && !t.lockedModel && !t.metered)
  .map(([slug, t]) => ({ slug, label: slug === "v1-chat" ? "base" : slug.replace("v1-chat-", "") + (t.router ? (slug.endsWith("grounded") ? " (web search on every call)" : " (routed)") : ""), path: t.route.split(" ")[1].replace("/chat/completions", ""), price: t.price < 0.01 ? t.price.toFixed(3) : t.price.toFixed(2), maxTokens: t.maxTokens }));
const FLAT_TIER_TABLE = "| tier | baseUrl path | per call | max output tokens |\n|---|---|---|---|\n" + FLAT_TIER_ROWS.map((r) => `| ${r.label} | \`${r.path}\` | $${r.price} | ${r.maxTokens} |`).join("\n");

const GUIDES = [
  {
    slug: "x402-in-5-minutes",
    title: "Make your AI agent pay for what it needs: x402 in 5 minutes",
    description:
      `A working example of the x402 payment protocol: your agent calls an API, gets an HTTP 402 quote, pays ${RAILS_COUNT} from its own wallet, and gets the result - no signup, no API key.`,
    md: `
The useful web hides behind signups, captchas, and API keys - none of which an
autonomous agent can obtain mid-task. [x402](https://x402.org) fixes this with
the HTTP status code that sat unused for thirty years: **402 Payment Required**.
Settlement infrastructure exists from Coinbase, with open client tooling from Stripe; this guide uses a
live service ([agent402.tools](https://agent402.tools)) you can pay right now.

## The protocol in one paragraph

Your client calls a paid endpoint and gets a \`402\` quote; it signs a USDC
authorization from its own wallet and retries, and the server settles only when
the response succeeds, so a failed x402 call is not charged. The headers, step
by step: [how x402 works](/learn/x402).

## See a quote (free)

\`\`\`bash
curl -i -X POST https://agent402.tools/api/extract \\
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
# HTTP/2 402  (the same terms ride base64-encoded in the PAYMENT-REQUIRED header)
# {"x402Version":2,…,"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"{{amount:extract}}",
#   "asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0x…",…},…]}
\`\`\`

## Pay it (JavaScript)

Fund a wallet with a little ${RAILS_COUNT_MD} (no gas needed on EVM chains - the facilitator sponsors it), then:

\`\`\`js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // @x402/core 2.23+ refuses anything over $1 or off the pegged-asset list by default; keep your own ceiling in code instead
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(await res.json()); // { title, markdown, wordCount, … }
\`\`\`

That one wrapped \`fetch\` now covers 500+ tools - browser rendering,
live search, PDFs, durable memory - most a flat ${TYPICAL_PRICE_RANGE.text} per call, with premium AI, media and multi-tool packs priced higher.
The full catalog is machine-readable at
[/api/pricing](https://agent402.tools/api/pricing).

## Call a model with the same fetch

The model gateway's default route is metered, and the same wrapped \`fetch\`
pays it: ${meteredRoutesInline()}, no key, model-backed, from
${meteredFromPrice()} a call. ${meteredQuoteSentence()}

\`\`\`js
const chat = await payFetch("https://agent402.tools/v1/metered/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "${meteredDefaultModel()}", max_tokens: 200,
    messages: [{ role: "user", content: "Summarize x402 in one line" }] }),
});
console.log((await chat.json()).choices[0].message.content);
\`\`\`

${flatTiersLine()}

## No gas per call: pay from a Circle Gateway deposit

Where the 402 on Arc or Base carries a second \`exact\` accept whose
\`extra.name\` is \`GatewayWalletBatched\` (it does while the operator turns the
option on; \`/api/pricing\` says under \`payment.gatewayNanopayments\`), a buyer
who deposited USDC into Circle Gateway once (an on-chain transfer through
Circle's GatewayWallet contract, gas paid once) pays each call by signing the
same EIP-3009 authorization under the Gateway domain the accept carries, for
the same price to the same payTo. Circle Gateway verifies it against the
deposit, settles it off chain and lands the batch on chain later. A stock
x402 client signs under the USDC contract's domain and keeps paying the plain
accept, which stays first; [agent402-client](https://www.npmjs.com/package/agent402-client)
0.8.20 and later pays the batched one when it is given the signer:

\`\`\`js
import { Agent402 } from "agent402-client";
import { privateKeyToAccount } from "viem/accounts";

const a = new Agent402({ gateway: { signer: privateKeyToAccount(process.env.AGENT_KEY) }, maxPerCallUsd: 0.05 });
const out = await a.call("extract", { url: "https://example.com/article" });
\`\`\`

agent402-client has no dependencies: install viem for \`privateKeyToAccount\`, or pass any EIP-712 signer with \`address\` and \`signTypedData\`.

Off by default; a 402 with no batched accept falls back to the plain payment
fetch. The mechanism, the pending-settlement resend and the signing helpers:
[wiki: Circle Gateway](${REPO_URL}/wiki/Circle-Gateway).

## Or from the command line

Stripe's open-source [purl](https://github.com/stripe/purl) is "curl for paid
endpoints":

\`\`\`bash
purl wallet add --name me --type evm -k 0xYOUR_KEY -p pass --set-active=true
purl "https://agent402.tools/api/dns?name=example.com&type=A"
\`\`\`

## No wallet? Pay with CPU

The pure-CPU tools also accept **proof-of-work** - a sub-second sha256
puzzle solved by the caller, no money involved (each one is marked
\`computePayable: true\` at [/api/pricing](https://agent402.tools/api/pricing),
which always has the current list):

\`\`\`js
import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("https://agent402.tools/api/pow/challenge?slug=hash")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
const res = await fetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n },
  body: JSON.stringify({ text: "hello world" }),
});
\`\`\`

Or skip all of this: paste \`https://agent402.tools/mcp\` into Claude as a
custom connector and the free tier just works, or run
\`npx -y agent402-mcp@0.13.31\` with an \`AGENT_KEY\` for the full catalog with spend
caps enforced before any payment is signed.

## Why this matters

Per-call payment with no accounts means an agent can acquire capabilities at
the moment it discovers it needs them - and the seller can prove every cent of
revenue on-chain. Every claim in this guide is verifiable: the server is
[open source](${REPO_URL}) and settled calls land
at a [public wallet](https://agent402.tools/api/stats).
`,
  },
  {
    slug: "buying-at-volume",
    title: "Buying at volume: limits, retries and spend caps for AI agents",
    seoTitle: "Buying at volume from an AI agent",
    description:
      "Run hundreds or thousands of paid calls in a burst: the limits and their Retry-After, retries that never pay twice, spend caps, job links and the errors to handle.",
    md: `
An agent that buys a thousand calls in an hour needs what a buyer of one call
needs, at a larger scale: a price it can check before it pays, a retry that
never pays twice, a ceiling on what it spends, and limits it can plan around.
The limits on this page are rendered from the code that enforces them.

## Before the burst: read the prices

Every route and its list price is in [/api/pricing](https://agent402.tools/api/pricing)
(free). Each row also names the chains it takes (\`networks\`, null for every
offered chain) and, on a route that runs as a job, its \`async\` block. Read it
at the start of each burst rather than from memory: list prices change, and
each change is on the [changelog](https://agent402.tools/changelog).

\`\`\`bash
curl -s https://agent402.tools/api/pricing \\
  | jq -c '.endpoints[] | select(.slug=="onchain-sql") | {path, price, networks}'
\`\`\`

The 402 is the quote for the request in hand: each \`accepts\` entry carries
the amount in the asset's smallest unit on that chain, with any settlement
premium or price floor of the chain included (\`/api/pricing\` lists them under
\`payment.premiumUsdByNetwork\` and \`payment.minPriceUsdByNetwork\` for the chains
that have one). On the metered model routes the quote is computed from the
request body, and the paid retry is priced again from its own body, so send the
paid retry with the body you were quoted for. Compare the quote with your
ceiling before you sign; the clients below do that on their own.

## Throughput limits

There is no per-wallet rate limit on paid calls. The limits below bound unpaid reads,
failed settlements and concurrent heavy runs. Each one answers
before any payment is taken, and the last column says how long to wait.

| What is counted | Limit | Answer |
|---|---|---|
| Unpaid price checks (a request with no payment) to priced catalog routes | ${unpaidQuoteBudgetPerHour().toLocaleString("en-US")} an hour per client address; ${(unpaidQuoteBudgetPerHour() * PAID_CLIENT_QUOTE_MULTIPLIER).toLocaleString("en-US")} an hour for the rest of the clock hour once that address settles a payment, and for ${PAID_QUOTE_TRUST_MINUTES} minutes after each paid call | 429, \`Retry-After\` until the hour turns |
| Unpaid quotes on \`/v1/metered\` | ${METERED_UNPAID_QUOTES_PER_MIN} a minute and ${METERED_UNPAID_QUOTES_PER_HOUR.toLocaleString("en-US")} an hour per client address; past that, ${METERED_QUOTE_CREDITS_PER_CALL} more for each paid \`/v1/metered\` call from that address, used within ${PAID_QUOTE_TRUST_MINUTES} minutes, up to ${PAID_CLIENT_METERED_QUOTES_PER_MIN} a minute and ${PAID_CLIENT_METERED_QUOTES_PER_HOUR.toLocaleString("en-US")} an hour | 429, \`Retry-After: 60\` |
| Refused payment credentials on \`/v1/metered\` | the same figures, counted once a credential is refused | 429, \`Retry-After: 60\` |
| Payments that verified and then failed to settle, per wallet and per network | refused on that network at ${SETTLE_BREAKER_MAX_FAILS} in ${Math.round(SETTLE_BREAKER_WINDOW_MS / 60_000)} minutes while they are more than half of the wallet's outcomes there, or at ${SETTLE_BREAKER_HARD_MAX} whatever it settled | 429 naming the network and when it lifts (\`refusedNetwork\`, \`retryAfterSeconds\`, \`retry: "other-network"\`); the same wallet can pay on another network the route offers at once |
| Report and media runs that failed to settle or failed after the run, per buyer | blocked for ${Math.round(COMPOSITE_GUARD.BLOCK_MS / 60_000)} minutes at ${COMPOSITE_GUARD.MAX_FAILS} in ${Math.round(COMPOSITE_GUARD.WINDOW_MS / 60_000)} minutes while they are more than ${failShareWords(COMPOSITE_GUARD.MIN_FAIL_SHARE)} of the buyer's outcomes there, or at ${COMPOSITE_GUARD.HARD_MAX_FAILS} whatever it settled | 429 without \`Retry-After\`; the block lifts on its own |
| Unpaid requests with a body over ${Math.round(UNPAID_BODY_MAX_BYTES / 1024)} KB to a route that reads its price from the body | ${LARGE_BODY_UNPAID_PER_MIN} a minute and ${LARGE_BODY_UNPAID_PER_HOUR.toLocaleString("en-US")} an hour per client address, the same once that address has paid | 429, \`Retry-After: 60\` |
| Concurrent runs of the report and media routes from one wallet | the wallet's balance covers every run in flight plus the new one | 429, \`Retry-After: 30\` |
| Jobs per client address | ${ASYNC_JOBS_PER_CLIENT} running at once | 429, \`Retry-After: 30\` |

An IPv6 /64 is one address. A request carrying a payment, a credits key or a
proof-of-work solution is never counted as an unpaid price check. On the two
failed-settlement rows a buyer's failures count against that buyer alone. A
Tempo sender, a credits key and a buyer keyed by address are each one key
there, with no network to switch. The report
and media guard keys a buyer by its signed payer, its verified Tempo sender,
its credits key or, for any other payment, its address. Once an
address has paid (a final 200 that settled on any rail, or a credits debit), its
unpaid price checks read against ${PAID_CLIENT_QUOTE_MULTIPLIER} times the figure for the rest of that clock hour
and for ${PAID_QUOTE_TRUST_MINUTES} minutes after each paid call. A \`/v1/metered\` quote reads the whole
body, so past its plain figure each paid \`/v1/metered\` call earns ${METERED_QUOTE_CREDITS_PER_CALL} more quotes (its own
and one retry), used within ${PAID_QUOTE_TRUST_MINUTES} minutes. A payment credential that is refused still counts. \`Retry-After: 60\` on a \`/v1/metered\` 429 is the
minute window; an address past the hourly figure waits until its oldest quote in
the last hour ages out, so a retry loop backs off further after repeated 429s.

How to plan a burst around them:

- A stock x402 client reads the 402 and then sends the paid retry, so each
  call is one unpaid read plus one paid request, and only the unpaid read is
  counted. On \`/v1/metered\` an address gets ${METERED_UNPAID_QUOTES_PER_MIN} quotes a minute, plus
  ${METERED_QUOTE_CREDITS_PER_CALL} for each paid \`/v1/metered\` call, so a steady buyer is paced by its own
  paid calls, up to ${PAID_CLIENT_METERED_QUOTES_PER_MIN} a minute.
- Keep the paying wallet funded above everything in flight. Each payment is
  verified on its own; a wallet that runs dry partway through a burst turns its
  later calls into failed settlements, which is what the per-wallet limit counts.
- On a 429 or a 503, wait \`Retry-After\` (or the block named above) and send
  the call again.

## Retries that never pay twice

On x402 a response of 400 or above is not settled, so a retry after one costs
nothing extra. For a call that may have succeeded (a timeout, a dropped
connection), use the replay rules:

- **Send an \`Idempotency-Key\`.** The same key with the same credential (the
  same signed payment), route, query and body returns the first 200 answer (up
  to ${IDEM_MAX_BODY_LABEL}, kept ${Math.round(IDEM_TTL_MS / 60_000)} minutes) with
  \`X-Idempotent-Replay: true\`: the tool does not run again and nothing settles
  again. A copy that arrives while the first is still running gets 409
  \`idempotent_request_in_flight\` with \`Retry-After: 2\`; on x402 it is not charged.
- **On an EVM payment the signed payment is the key.** Send the same request
  again with the same payment header within ${Math.round(IDEM_TTL_MS / 60_000)} minutes
  and the first answer comes back marked \`X-Replayed-Answer: 1\`, with no
  second settlement (identity-bound routes, routes with a lasting effect and
  streamed calls excepted).
- **On Solana, send the key yourself.** A Solana payment has no implicit key,
  so pair an \`Idempotency-Key\` with the exact payment header that went out the
  first time.
- **A fresh signature is a new payment.** Sign again only after an answer of
  400 or above.

Each answer says whether it settled:

- No \`PAYMENT-RESPONSE\` header: nothing settled.
- \`PAYMENT-RESPONSE\` whose receipt reads \`success: false\`: settlement was
  refused, nothing moved.
- \`PAYMENT-RESPONSE\` with a status under 400: charged and served.

${LATE_SETTLE_EXCEPTION}

## Long or slow calls: take a job link

Every route whose \`/api/pricing\` row has an \`async\` block runs as a job: the
report products, video, the premium image tier, the router's execute tiers and
the rest the rows mark. Send the paid call with \`Prefer: respond-async\` and it
answers 202 at once with a \`Location\` job link. Poll \`GET /api/jobs/{id}\`
(free), waiting \`Retry-After\` between polls, until \`status\` is \`completed\` or
\`failed\`; \`state\`, \`stage\`, \`progress\` and \`etaSeconds\` say where it is. The
payment settles only when the result is ready, and on x402 a failed run is not
charged. A row whose block carries \`preferWait\` also takes
\`Prefer: wait=<maxSeconds>\` to wait on the connection, and a paid call there
with neither header is answered 400 before any payment.

With ${ASYNC_JOBS_PER_CLIENT} jobs per client address at once, a burst of slow
calls is a queue on your side: collect a finished job before you start the
next. agent402-client and agent402-mcp switch to jobs on their own.

## Spend caps in the clients

Every cap below is checked before a payment is signed, so a quote above it is
refused with nothing sent.

**agent402-client.** The caps are constructor options, held in the client
instance's memory; give each worker its own instance with its own share.

\`\`\`js
import { Agent402 } from "agent402-client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // the caps below replace the library default
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const a = new Agent402({
  fetch: payFetch,
  x402Client: client,   // the caps are checked on the payment that is signed
  maxPerCallUsd: 0.05,  // refuse any single quote above this
  dailyLimitUsd: 25,    // rolling 24 hours, this instance
  maxPerHostUsd: 10,    // rolling 24 hours, per seller host
});
const out = await a.call("extract", { url: "https://example.com/article" });
\`\`\`

A refused call throws \`SpendingLimitError\` naming the cap, the quote and the
list price. A payment that was sent and answered with an error counts as held
until its authorization can no longer settle.

**agent402-mcp.** The per-call cap is on by default (\`off\` removes it); the
session budget is opt-in.

\`\`\`bash
export AGENT_KEY=0x...                # or SOLANA_AGENT_KEY for a Solana wallet
export AGENT402_MAX_PER_CALL=0.10     # USD per call
export AGENT402_BUDGET=20             # USD for the whole session
export AGENT402_NETWORKS=solana       # pay only on these chains, in this order
npx -y agent402-mcp@${AGENT402_MCP_VERSION}
\`\`\`

**agent402-openclaw.** \`maxPerCallUsd\` in the plugin config, or
\`AGENT402_MAX_PER_CALL_USD\`, defaults to the metered per-call cap below;
\`off\` removes it only beside \`allowUncappedPayments: true\`.

All three refuse an accept that asks for a signing validity longer than a day,
and refuse to send a payload signed past it.

## Choosing a rail for volume

| Rail | When it settles | When the call fails |
|---|---|---|
| x402 exact on an EVM chain | after the tool answers, only for a response under 400 | not charged; the signed payment is its own replay key |
| x402 exact on Solana | after the tool answers, only for a response under 400 | not charged; send an \`Idempotency-Key\` for replays |
| x402 exact on Stellar | after the tool answers, only for a response under 400 | not charged |
| x402 exact on Algorand | after the tool answers, only for a response under 400 | not charged |
| x402 exact, Gateway batched (where offered; paid from a Circle Gateway deposit) | settled off chain by Circle Gateway after the tool answers, only for a response under 400 | not charged |
| MPP \`evm\` charge | the same x402 settlement underneath | not charged |
| MPP Tempo pull (a signed transaction the relay broadcasts) | broadcast after the tool answers, only for a response under 400 | not charged |
| MPP Tempo push (a transfer you already sent) | final before the call runs | booked as a refund owed to the paying wallet, repaid after on-chain proof |

On the EVM chains and Tempo pull, a settlement whose outcome is not known when
the call is answered is read on chain again; one that lands after a failed
answer is booked as a refund owed and repaid after on-chain proof.

- The report products and other long routes take x402 exact on EVM chains
  only: their run outlives a Solana payment's recent blockhash, an Algorand
  transaction's rounds and a Tempo credential. Tempo is also not offered on the
  identity-bound routes.
- A Solana payment embeds a recent blockhash that lives about a minute, so sign
  each payment right before you send it rather than signing a batch ahead.
- A Solana payment refused for a missing USDC account or too little USDC
  answers with \`retry: "fund-wallet"\` and a \`Retry-After\`; fund the wallet
  before the next call.
- MPP methods appear in the 402 while this instance offers them;
  [/.well-known/x402](https://agent402.tools/.well-known/x402) lists them.
- On the metered routes, a 402 carrying an \`upto\` accept lets a wallet with a
  one-time Permit2 approval for USDC sign the quote as a ceiling and settle
  actual usage under it.

## Metered chat at volume

- **Model ids.** \`GET /v1/models\` lists every id; send one verbatim. An id the
  upstream does not list is refused with a 400 before any payment, carrying
  \`suggestions\` (the closest served ids, at most three) and a \`howToCall\`
  retried with the first. A version written with a hyphen (\`v4-1\`) is served
  as the dotted id when that exact id is listed.
- **Input size.** Every model takes ${TIERS["v1-chat-metered"].maxInputChars.toLocaleString("en-US")} input characters,
  and a model with a larger context window takes three characters per window
  token, up to ${METERED_MAX_INPUT_CHARS_CEILING.toLocaleString("en-US")}. \`/v1/models\` publishes each model's
  own figure as \`x402.meteredMaxInputChars\`. A body over it is refused before
  payment with code \`input_too_large\`, \`maxInputChars\`, \`inputChars\`,
  \`hint: "trim-input"\` and \`suggestions\` of models whose window takes it.
- **Per-call cap.** A request quoting above $${METERED_MAX_QUOTE_USD} is refused
  with a 400 before any upstream call: lower \`max_tokens\` or the input. On
  x402 it is not charged.

\`\`\`bash
curl -s https://agent402.tools/v1/models \\
  | jq -c '.data[] | select(.x402.meteredMaxInputChars) | {id, maxInputChars: .x402.meteredMaxInputChars}'
\`\`\`

## Errors to handle

| Status | What it means | What to do |
|---|---|---|
| 400 | the input was refused before the tool ran; the body carries \`expected\`, \`required\`, \`example\` and \`howToCall\` (method, URL and a ready body) | fix the request from \`howToCall\`; not charged on x402 |
| 402 | the quote, or a refused payment; the first-contact 402 body carries the offer, \`howToCall\` and, on a job route, \`async\` | pay, or fund the wallet the refusal names |
| 409 | the same keyed call is still running | wait \`Retry-After\`, then resend the same key with the same payment header to get its answer |
| 422 | the tool cannot serve this input (an image too large to read, a body that is not an image) | read \`error\` and the \`howToCall\` note; not charged on x402 |
| 429 | one of the limits above | wait \`Retry-After\` |
| 503 | busy or briefly paused; image-ocr reading another image over ${OCR_LARGE_PIXELS / 1e6} megapixels answers \`hint: "large-image-busy"\` | wait \`Retry-After\`, or send a smaller image, which is read at once |
| 502, 504 with \`attribution: "upstream"\` | a source the tool reads failed (a host timed out or refused the connection) | not your input: retry later or pick another source; not charged on x402 |

A loop that honors all of it, shown with plain \`fetch\` (pass your payment
\`fetch\` in its place):

\`\`\`js
const BASE = process.env.AGENT402_URL || "https://agent402.tools";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body, { pay = fetch, tries = 5 } = {}) {
  // The key replays a stored answer only with the same signed payment; a payment
  // client signs afresh on each retry, so each retry here is its own paid call.
  // This loop retries only answers that are not charged on x402.
  const key = crypto.randomUUID();
  for (let i = 0; i < tries; i++) {
    const res = await pay(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (![409, 429, 502, 503, 504].includes(res.status)) throw new Error(JSON.stringify(await res.json()));
    const wait = Number(res.headers.get("retry-after")) || 2 ** i;
    await sleep(wait * 1000);
  }
  throw new Error("gave up after " + tries + " tries");
}

console.log(await call("/api/hash", { text: "hello world" }));
\`\`\`

The recovery contract in brief is at [/agents.md](https://agent402.tools/agents.md),
and the whole service at [/llms.txt](https://agent402.tools/llms.txt). A worked
chain of paid stages, from research to subtitles, is in
[content pipelines](/guides/content-pipeline).
`,
  },
  {
    slug: "content-pipeline",
    title: "Content pipelines: research, script, voice, images and subtitles from one wallet",
    seoTitle: "A content pipeline for AI agents, paid per call",
    description:
      "A recipe for podcast, short-video and voiceover pipelines: research, script, speech, images, transcripts, subtitles, dubbing and media checks, each stage one paid call from one wallet, no API keys.",
    md: `
A content pipeline turns a topic into a finished piece: find the facts, write
the script, voice it, illustrate it, transcribe it, subtitle it, dub it and
check the files. Here each stage is one paid call to the same service, paid
from one wallet over x402 or MPP, with no API key and no account to open.

Most stages are model-backed: a model answers, writes, speaks, draws, listens
or translates. Subtitle conversion and the media checks are deterministic code.

## The stages

| Stage | Slug | Price | Model-backed | Runs as a job |
|---|---|---|---|---|
| Answer with citations | \`answer\` | {{price:answer}} | yes | {{jobs:answer}} |
| Research report | \`research\` | {{price:research}} | yes | {{jobs:research}} |
| Script | \`v1-chat-metered\` | quoted per request, from {{price:v1-chat-metered}} | yes | {{jobs:v1-chat-metered}} |
| Voiceover | \`tts-lite\` | {{price:tts-lite}} | yes | {{jobs:tts-lite}} |
| Voiceover | \`tts\`, \`tts-hd\` | quoted from the text, from {{price:tts}} and {{price:tts-hd}} | yes | {{jobs:tts,tts-hd}} |
| Images | \`v1-images-fast\`, \`v1-images-pro\` | {{price:v1-images-fast}}, {{price:v1-images-pro}} | yes | {{jobs:v1-images-fast,v1-images-pro}} |
| Image edit | \`v1-images-edit\` | {{price:v1-images-edit}} | yes | {{jobs:v1-images-edit}} |
| Transcription | \`transcribe\`, \`transcribe-pro\` | {{price:transcribe}}, {{price:transcribe-pro}} | yes | {{jobs:transcribe,transcribe-pro}} |
| Subtitles | \`srt-convert\` | {{price:srt-convert}}, or free with proof-of-work | no | {{jobs:srt-convert}} |
| Subtitles in one call | \`skill-subtitle-pipeline\` | {{price:skill-subtitle-pipeline}} | yes | {{jobs:skill-subtitle-pipeline}} |
| Dubbing | \`dub\` | quoted by tier, from {{price:dub}} | yes | {{jobs:dub}} |
| Media probe | \`media-info\` | {{price:media-info}} | no | {{jobs:media-info}} |
| Audio track to MP3 | \`audio-convert\` | {{price:audio-convert}} | no | {{jobs:audio-convert}} |
| Loudness | \`audio-normalize\` | {{price:audio-normalize}} | no | {{jobs:audio-normalize}} |

Prices are read from [/api/pricing](https://agent402.tools/api/pricing) when
this page renders. Each example below is the tool's published example.

## Set up once

One client pays every stage. The caps are checked before each payment is
signed, against the quote for that request.

\`\`\`js
import { Agent402 } from "agent402-client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // the caps below replace the library default
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const a = new Agent402({
  fetch: payFetch,
  x402Client: client,  // the caps are checked on the payment that is signed
  maxPerCallUsd: 1,    // refuse any single quote above this
  dailyLimitUsd: 25,   // rolling 24 hours, this instance
});
\`\`\`

Over plain HTTP, the same request without a payment answers 402 with the
quote, and your x402 or MPP client pays it:

\`\`\`bash
curl -i -X POST https://agent402.tools/api/tts \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"Hello from Agent402!","voice":"alloy","format":"mp3"}'
# HTTP/2 402, the x402 accepts in PAYMENT-REQUIRED and the MPP challenges in WWW-Authenticate
\`\`\`

## 1. Research

\`answer\` (\`GET /api/answer\`) returns a short answer grounded in live web
search, with its citations:

\`\`\`js
const brief = await a.call("answer", { q: "what is the x402 payment protocol?" });
// { query, answer, citations: [{ url, snippet, number }], citationCount }
\`\`\`

\`research\` (\`POST /v1/research\`) plans sub-questions, runs several searches
and returns one cited report. It runs as a job: the client sends
\`Prefer: respond-async\` and collects the report from the job link.

\`\`\`js
const report = await a.call("research", { query: "What are the leading agentic-payment protocols in 2026 and how do they differ?", recency: "year" });
// { report, sources: [{ n, title, url, snippet }], sub_questions, meta }
\`\`\`

## 2. Script

The metered chat route quotes each request from its input and \`max_tokens\`,
so a short script costs what a short script uses. Name any id from
[/v1/models](https://agent402.tools/v1/models) in \`model\`, or leave it out for
the default.

\`\`\`js
const messages = [
  { role: "system", content: "Write a 60-second voiceover script in plain sentences." },
  { role: "user", content: brief.answer },
];
const draft = await a.call("v1-chat-metered", { max_tokens: 600, messages });
const script = draft.choices[0].message.content;
\`\`\`

The flat tiers take the same body at one price per call, from
\`/v1/nano/chat/completions\` ({{price:v1-chat-nano}}) up.

## 3. Voiceover

\`\`\`js
const voice = await a.call("tts", { text: "Hello from Agent402!", voice: "alloy", format: "mp3" });
const audio = Buffer.from(voice.audio, "base64"); // { model, voice, format, audio, chars }
\`\`\`

- **Tiers.** \`tts-lite\` for high-volume narration where timbre matters less,
  \`tts\` for natural speech, \`tts-hd\` for the most expressive delivery (it
  reads inline tags such as \`[whispering]\` as cues). One request shape for all three.
- **Length.** ${TTS_TIERS.tts.maxChars.toLocaleString("en-US")} characters a call on \`tts\` and \`tts-hd\`,
  ${TTS_TIERS["tts-lite"].maxChars.toLocaleString("en-US")} on \`tts-lite\`. Split a longer script at sentence ends and send one call per part.
- **Voices.** The ten standard names on every tier: ${[...TTS_VOICES].map((v) => "`" + v + "`").join(", ")}.
  \`tts\` and \`tts-hd\` also take the named voices listed on [/speech](https://agent402.tools/speech).
- **Formats.** ${[...TTS_FORMATS].map((f) => "`" + f + "`").join(", ")} on \`tts\` and \`tts-hd\`; ${[...TTS_LITE_FORMATS].map((f) => "`" + f + "`").join(" or ")} on \`tts-lite\`.

## 4. Images

\`/v1/images/fast\` and \`/v1/images/pro\` take a prompt and return one picture
inline on the OpenAI images wire; pro is the higher-fidelity tier.

\`\`\`js
const cover = await a.call("v1-images-fast", { prompt: "A minimalist line drawing of a lighthouse at dawn" });
const jpeg = Buffer.from(cover.data[0].b64_json, "base64");
\`\`\`

\`/v1/images/edits\` changes a picture you already have: send one to four PNG
or JPEG references (base64 or \`data:\` URLs) and describe the change in the
prompt. The output follows the first reference's aspect ratio.

\`\`\`js
const ref = "data:image/jpeg;base64," + cover.data[0].b64_json;
const edited = await a.call("v1-images-edit", { prompt: "Add a warm sunrise glow behind the lighthouse", image: ref });
\`\`\`

## 5. Transcription

\`transcribe\` reads audio from a public URL, up to ${STT_TIERS.transcribe.maxMinutes} minutes
(\`transcribe-pro\` up to ${STT_TIERS["transcribe-pro"].maxMinutes}) and ${Math.round(STT_MAX_AUDIO_BYTES / 1024 / 1024)} MB. Add
\`diarize: true\` for speaker labels and word timestamps, which the subtitle
stage turns into timed cues.

\`\`\`js
const t = await a.call("transcribe", { url: "https://agent402.tools/fixtures/sample-speech.wav", diarize: true });
// { text, language, duration, speakers, words: [{ word, start, end, speaker }] }
\`\`\`

For audio you hold as bytes, \`POST /v1/audio/transcriptions\` takes the same
models as a multipart \`file\` upload (\`/v1/pro/audio/transcriptions\` for the
longer cap).

## 6. Subtitles

\`srt-convert\` turns timed cues into SRT, WebVTT, plain text or JSON. It is
pure CPU, so agent402-client pays it with a proof-of-work solution and no
wallet.

\`\`\`js
const words = t.words.filter((w) => w.word.trim() && w.start != null);
const cues = [];
for (let i = 0; i < words.length; i += 7) {
  const line = words.slice(i, i + 7);
  cues.push({ start: Math.round(line[0].start * 1000), end: Math.round(line.at(-1).end * 1000), text: line.map((w) => w.word).join(" ") });
}
const subs = await a.call("srt-convert", { cues, to: "srt" });
// { detected, to, count, result }: result is the SRT file
\`\`\`

The subtitle-pipeline skill pack runs transcribe, srt-convert and text-stats
in one payment. Its file is one cue spanning the clip, so use the diarized
words above when each line needs its own timing.

\`\`\`js
const pack = await a.call("skill-subtitle-pipeline", { url: "https://agent402.tools/fixtures/sample-speech.wav", format: "vtt" });
\`\`\`

## 7. Dubbing

\`dub\` translates a text and speaks the translation in one call. \`tier\`
\`"hd"\` speaks it on the tts-hd voice, and the quote is the sum of the two
steps. The text cap applies to the translation.

\`\`\`js
const es = await a.call("dub", { text: "Hello from Agent402! Every tool is paid per call.", targetLanguage: "es", voice: "nova", format: "mp3", json: true });
// { translation, detectedSourceLanguage, targetLanguage, tier, voice, format, audio, chars }
\`\`\`

Without \`json: true\` the answer is the audio bytes, with the translation in
the \`X-Dub-Translation\` header (base64 JSON).

## 8. Media checks

Each reads a public URL and runs ffprobe or ffmpeg on it.

\`\`\`js
const info = await a.call("media-info", { url: "https://agent402.tools/fixtures/sample-audio.wav" });
// { formatName, durationSec, bitrate, bytes, streams: [{ type, codec, sampleRate, channels }] }
const level = await a.call("audio-normalize", { url: "https://agent402.tools/fixtures/sample-audio.wav", targetLufs: -16 });
// { format: "mp3", targetLufs, truePeakDb, bytes, mp3Base64 }
const track = await a.call("audio-convert", { url: "https://agent402.tools/fixtures/sample-audio.wav", bitrate: "192k" });
// { format: "mp3", bitrate, bytes, mp3Base64 }: the audio track of a video, as MP3
\`\`\`

## End to end

The stages that read a URL (transcription, the media checks) need the audio
at a public address, so the flow puts each file where your pipeline already
keeps its media. Stages that need only the script run side by side.

\`\`\`js
// Your storage: put the bytes somewhere public and return the URL.
async function publish(name, bytes) {
  throw new Error("upload " + name + " (" + bytes.length + " bytes) and return its public URL");
}

const topic = "what is the x402 payment protocol?";
const brief = await a.call("answer", { q: topic });

const messages = [
  { role: "system", content: "Write a 60-second voiceover script in plain sentences." },
  { role: "user", content: brief.answer },
];
const draft = await a.call("v1-chat-metered", { max_tokens: 600, messages });
const script = draft.choices[0].message.content;

const [voice, cover, es] = await Promise.all([
  a.call("tts", { text: script, voice: "nova", format: "mp3" }),
  a.call("v1-images-fast", { prompt: "Cover art as a minimalist line drawing: " + topic }),
  a.call("dub", { text: script, targetLanguage: "es", voice: "nova", format: "mp3", json: true }),
]);

const rawUrl = await publish("episode-raw.mp3", Buffer.from(voice.audio, "base64"));
const level = await a.call("audio-normalize", { url: rawUrl, targetLufs: -16 });
const episodeUrl = await publish("episode.mp3", Buffer.from(level.mp3Base64, "base64"));
const info = await a.call("media-info", { url: episodeUrl });

const t = await a.call("transcribe", { url: episodeUrl, diarize: true });
const words = t.words.filter((w) => w.word.trim() && w.start != null);
const cues = [];
for (let i = 0; i < words.length; i += 7) {
  const line = words.slice(i, i + 7);
  cues.push({ start: Math.round(line[0].start * 1000), end: Math.round(line.at(-1).end * 1000), text: line.map((w) => w.word).join(" ") });
}
const subs = await a.call("srt-convert", { cues, to: "srt" });

console.log(info.durationSec, subs.count, es.translation, a.spendingSummary());
\`\`\`

Cite the sources \`brief.citations\` names in the episode's show notes;
\`a.spendingSummary()\` totals what the run spent.

## Pipeline notes

### Slow stages and jobs

A route runs as a job when its [/api/pricing](https://agent402.tools/api/pricing)
row carries an \`async\` block. In this recipe:

- \`research\` requires one: send \`Prefer: respond-async\` (202 and a job
  link at once) or \`Prefer: wait=<maxSeconds>\`; a paid call with neither
  is answered 400 before any payment. agent402-client sends the header for you.
- \`v1-images-fast\` and \`v1-images-pro\` take \`Prefer: respond-async\` on
  request. They answer in seconds, so waiting on the connection also works.
- Every other stage answers on the connection, and the header is ignored there.

Poll \`GET /api/jobs/{id}\` (free), waiting \`Retry-After\` between polls,
until \`status\` is \`completed\` or \`failed\`. A client address runs
${ASYNC_JOBS_PER_CLIENT} jobs at once, so a batch of research reports is a queue
on your side.

### Spend caps

\`maxPerCallUsd\`, \`dailyLimitUsd\` and \`maxPerHostUsd\` are checked before a
payment is signed. On the quoted stages (\`tts\`, \`tts-hd\`, \`dub\`, metered
chat) the check reads the quote for that request, so a longer script meets
the cap before it is paid. A refused call throws \`SpendingLimitError\`.
The caps live in one client instance: give each worker its own.

In agent402-mcp, \`AGENT402_MAX_PER_CALL\` and \`AGENT402_BUDGET\` set the
per-call and session ceilings.

### At volume

A pipeline that renders hundreds of episodes meets the per-address limits,
retries and replay rules on [buying at volume](/guides/buying-at-volume):
send an \`Idempotency-Key\` per stage so a retried stage returns its first
answer instead of paying twice, and wait \`Retry-After\` on a 429 or 503.

### Choosing a rail

${PIPELINE_TOKEN} run long enough that they take x402 exact on
EVM chains only; their /api/pricing rows list those \`networks\`. Every other
stage here takes every offered chain, over x402 or MPP.

| Rail | When it settles | A stage that fails |
|---|---|---|
| x402 exact on an EVM chain | after the tool answers, only for a response under 400 | not charged |
| x402 exact on Solana | after the tool answers, only for a response under 400 | not charged |
| MPP \`evm\` charge | the same x402 settlement underneath | not charged |
| MPP Tempo pull (a signed transaction) | broadcast after the tool answers, only for a response under 400 | not charged on Tempo pull: the transaction is never broadcast |
| MPP Tempo push (a transfer already sent) | final before the call runs | the transfer is booked as a refund owed to the paying wallet, repaid after on-chain proof |

Tempo is offered on every stage except ${PIPELINE_TOKEN}. A
pull credential (\`payload\` type \`transaction\`) is a signed transaction
the relay broadcasts only once the stage has answered under 400, so a stage
that fails is never broadcast. A push credential (\`payload\` type \`hash\`)
is a transfer you already sent: it is final before the stage runs, so a stage
that fails then is repaid from the refund ledger. For a pipeline, pay with
pull credentials: pin \`mode: "pull"\` on the Tempo charge method, since a
JSON-RPC wallet account sends push by default. If your connection closes
before the answer, a pull payment can still be broadcast, and it is then
booked as owed in the same way.

\`\`\`js
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mpp = Mppx.create({ methods: [tempo.charge({ account, mode: "pull" })], polyfill: false });
const res = await mpp.fetch("https://agent402.tools/api/tts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello from Agent402!", voice: "alloy", format: "mp3" }),
});
console.log(res.status, res.headers.get("payment-receipt"));
\`\`\`

The agent402-client caps read x402 quotes. On Tempo, compare each
challenge's amount with your own ceiling before your MPP client pays it. The
MPP methods this instance offers are listed at
[/.well-known/x402](https://agent402.tools/.well-known/x402), and the wire
itself is in [x402 and MPP](/guides/x402-and-mpp).
`,
  },
  {
    slug: "durable-memory-for-agents",
    title: "Durable memory for AI agents - no accounts, the wallet is the identity",
    seoTitle: "Durable memory for AI agents, keyed to the wallet",
    description:
      "How autonomous agents persist state across sessions and share it across owners using wallet-keyed memory: writes, cross-wallet grants, tamper-evident audit logs, and semantic recall - authenticated by payment, not API keys.",
    md: `
Agent sessions are ephemeral. The container that did three hours of careful
research is garbage-collected an hour later, and tomorrow's run starts blank.
Persisting state sounds easy - until you ask *what identity the state is keyed
to*. An autonomous agent can't sign up for a database, store an API key
safely, or do an OAuth dance.

It already holds the answer: **its wallet**. On
[agent402.tools](https://agent402.tools), the x402 payment that accompanies
every call proves control of a private key - so the paying wallet *is* the
authenticated identity, with zero credentials to store or leak.

## Write today, read next week, different machine

\`\`\`bash
# machine A, today ({{price:memory-write}})
POST /api/memory   {"key":"deploy-fix","value":{"cause":"build OOM","fix":"NODE_VERSION=22"}}

# machine B, next week - same wallet key, nothing else
GET  /api/memory?key=deploy-fix
\`\`\`

Namespaces are isolated per wallet: only the owner wallet, or a wallet it
grants access to (below), can read a key. TTLs expire what shouldn't live forever; deletes are owner-only.

## The unusual part: memory shared across owners

Two agents that **don't share an owner** can share state - payment identity is
the only primitive needed:

\`\`\`bash
# wallet A grants wallet B read access (time-boxed)
POST /api/memory/grant   {"grantee":"0xB…","mode":"read","ttlSeconds":86400}

# wallet B reads A's namespace by naming the owner
GET  /api/memory?key=deploy-fix&owner=0xA…
\`\`\`

Add \`POST /api/memory/incr\` - an atomic counter - and you have a
coordination primitive: two independent agents handing off jobs through one
shared number, no race conditions. Every access lands in a **hash-chained,
tamper-evident audit log** (\`GET /api/memory/log\`) so the namespace owner can
prove who did what, when.

## Semantic recall, no embeddings API required

\`\`\`bash
POST /api/memory/remember  {"text":"Railway deploy failed: build out of memory"}
POST /api/memory/recall    {"query":"why did the deploy break?","k":3}
\`\`\`

Store prose now, search it by meaning later. The default scorer is local and
deterministic: it calls no model and no external API.

## Why not just use a database?

You could - if you can keep credentials, run migrations, and pay a monthly
bill. The point of wallet-keyed memory is that an agent **mid-task** can't do
any of that, and doesn't need to: the credential it already holds for payment
doubles as its identity, a write costs {{price:memory-write}} and a read {{price:memory-read}}, and state outlives
any single sandbox. The whole implementation is
[open source](${REPO_URL}) - see the
[memory wiki page](${repoUrl("wiki/Memory-and-Coordination")})
for the full API.
`,
  },
  {
    slug: "sell-your-api-over-x402",
    title: "Sell your API to AI agents over x402 - no billing system required",
    seoTitle: "Sell your API to AI agents over x402",
    description:
      `Put a per-call USDC paywall in front of any HTTP endpoint with the x402 protocol: quote over HTTP 402, settle in ${RAILS_COUNT} through a facilitator, and get discovered by agents - no accounts, invoices, or payment forms.`,
    md: `
If you run an API, the next wave of customers can't sign up for it. Autonomous
agents don't have credit cards, can't pass captchas, and won't wait for a sales
call - but they hold funded wallets and speak HTTP. [x402](https://x402.org)
lets you charge them per call with about as much code as adding a middleware.

## The seller's side of the protocol

You return \`402 Payment Required\` with a quote (price, USDC, network, your
wallet address). The buyer signs a transfer authorization and retries; a
**facilitator** verifies the signature, your handler runs, and the facilitator
settles on-chain to your wallet. You never touch
keys, cards, or PCI anything - your "billing system" is one HTTP header check.

## Express example

\`\`\`js
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme());

const app = express();
app.use(express.json());
app.use(paymentMiddleware({
  "POST /api/summarize": {
    accepts: { scheme: "exact", price: "$0.005", network: "eip155:84532", payTo: "0xYOUR_WALLET" },
    description: "Summarize a document",
  },
}, server));
app.post("/api/summarize", (req, res) => res.json({ ok: true }));
app.listen(3000);
\`\`\`

That example settles USDC on Base Sepolia (\`eip155:84532\`) through a public
testnet facilitator. For mainnet, switch the network to \`eip155:8453\` and point
\`HTTPFacilitatorClient\` at a facilitator that settles Base mainnet. Check the
quote yourself: \`curl -i -X POST http://localhost:3000/api/summarize\` answers
\`402\` with the accept, and any x402 client pays it.

## What we learned operating one (the honest part)

[agent402.tools](https://agent402.tools) runs 500+ tools this way -
[fully open source](${REPO_URL}). The lessons:

1. **x402 settles after your handler runs, and only on success.**
   \`@x402/express\` verifies the payment, runs the handler, and settles only a
   response below 400; an error answer cancels settlement, so the buyer is
   not charged on x402. You still paid for any upstream work that failed, so anything that
   can't be served reliably (upstreams that block datacenter IPs, flaky APIs)
   should be removed, not monetized.
2. **Discovery is half the product.** Publish a machine-readable catalog
   (/api/pricing, OpenAPI, llms.txt), and settle through a facilitator that
   runs the x402 Bazaar discovery extension: a route is listed there after its
   first settled payment.
3. **Trust is provable, so prove it.** Your revenue wallet is public; link it.
   Run your test suite against your own documented examples in CI. Anonymous
   sellers are the default in this economy - a named maintainer and an
   auditable repo are differentiation.
4. **Offer a free taste.** Pure-CPU endpoints can accept a
   [proof-of-work](/guides/x402-in-5-minutes) instead of money - it converts
   wallet-less agents into integrated users who fund a wallet later.
5. **Expose it over MCP too.** A hosted connector
   (\`https://agent402.tools/mcp\` is ours) puts your tools one paste away from
   every Claude user, and an npm MCP server with client-side spend caps makes
   paid adoption safe for buyers.

The entire stack described here - paywall, PoW tier, MCP servers, CI, even the
on-chain customer detector - is in
[one repo](${REPO_URL}) you can fork.
`,
  },
  {
    slug: "x402-payments-toolkit",
    title: "Let your agent pay anyone: the non-custodial x402 payments toolkit",
    seoTitle: "The non-custodial x402 payments toolkit",
    description:
      "Discover a 402 quote, resolve an ENS recipient, check USDC balance and gas, build the EIP-3009 authorization your agent signs with its own key, and verify the settlement on-chain - across Base, Polygon, Arbitrum, Optimism and Ethereum. These tools never touch funds.",
    md: `
An autonomous agent that can *pay* is far more useful than one that can't - but
you don't want a middleman holding your money. Agent402's payments tools are
**non-custodial**: they help an agent move its *own* USDC with its *own* key.
These tools never hold, sign, or send funds - they decode quotes, read public
chain state, and build the authorization *you* sign. (Two paths elsewhere on
the service are not non-custodial and we say so: ${creditsPrepaymentPhrase()}, and a card report purchase is held by the payment
processor until the report is delivered.) Everything below works on
**Base, Polygon, Arbitrum, Optimism and Ethereum** (\`network\` param, default
base); \`tx-status\` and \`gas-estimate\` also read Robinhood Chain. None of it
needs an API key.

## 1. What does this endpoint cost? - \`/api/x402-quote\`

Point it at any paid URL and get the decoded HTTP 402 terms:

\`\`\`bash
curl "https://agent402.tools/api/x402-quote?url=https://agent402.tools/api/uuid&method=GET"
# { "url": "https://agent402.tools/api/uuid", "status": 402, "paymentRequired": true, "x402Version": 2,
#   "accepts": [{ "scheme": "exact", "network": "eip155:8453", "amount": "{{amount:uuid}}",
#                 "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0x…",
#                 "maxTimeoutSeconds": 300, "extra": { "name": "USD Coin", "version": "2" } }, … ] }
\`\`\`

## 2. Who am I paying? - \`/api/ens-resolve\`

Turn a human-readable name into a payable address:

\`\`\`bash
curl "https://agent402.tools/api/ens-resolve?name=vitalik.eth"
# { "name":"vitalik.eth", "address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "found":true }
\`\`\`

## 3. Can I afford it? - \`/api/usdc-balance\` + \`/api/gas-estimate\`

\`\`\`bash
curl "https://agent402.tools/api/usdc-balance?address=0xYOURWALLET&network=base"
# { "usdc":"12.5", "raw":"12500000", "network":"base" }
curl "https://agent402.tools/api/gas-estimate?network=base"
# { "gasPriceGwei":"0.0051", "network":"base" }
\`\`\`

## 4. Build the authorization to sign - \`/api/transfer-authorization\`

This returns the exact EIP-3009 \`transferWithAuthorization\` typed data for a
**gasless** USDC transfer. Agent402 builds it; your agent signs it locally:

\`\`\`bash
curl -X POST https://agent402.tools/api/transfer-authorization \\
  -H "Content-Type: application/json" \\
  -d '{"from":"0xYOURWALLET","to":"0xRECIPIENT","amount":0.01,"network":"base"}'
# { "typedData": { "domain":{...}, "primaryType":"TransferWithAuthorization", "message":{...} }, ... }
\`\`\`

Sign it with your own key - Agent402 never sees it:

\`\`\`js
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.AGENT_KEY);
const { typedData } = await (await fetch("https://agent402.tools/api/transfer-authorization", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: account.address, to: recipient, amount: 0.01 }),
})).json();
const signature = await account.signTypedData(typedData); // submit to the facilitator / payTo's x402 flow
\`\`\`

## 5. Did it settle? - \`/api/x402-verify\`

After a payment lands, confirm it on-chain - and optionally that it paid the
right address at least a minimum amount:

\`\`\`bash
curl "https://agent402.tools/api/x402-verify?hash=0xTXHASH&network=base&to=0xRECIPIENT&min=0.001"
# { "settled":true, "status":"success", "transfers":[{"from":"0x…","to":"0x…","usdc":"0.001"}], "matched":true }
\`\`\`

## Why non-custodial matters

These tools never touch your
money: you keep your key, you sign, you send. That's the right architecture for
agent payments, and it's the one Agent402 ships. The whole kit is
[open source](${REPO_URL}) and priced per call in
USDC; these tools are wallet-only (no proof-of-work tier).
`,
  },
  {
    slug: "usdg-payments-robinhood-chain",
    title: "Accept USDG payments on Robinhood Chain over x402",
    description:
      "How AI agents pay in USDG (Global Dollar) on Robinhood Chain via the x402 protocol - and how to accept it as a seller: chain parameters, gasless EIP-3009 settlement, buyer code, and how to verify a settlement on-chain.",
    md: `
Robinhood Chain (an Arbitrum Orbit L2, chain id **4663**) reached mainnet on
2026-07-01, and its canonical stablecoin is **USDG (Global Dollar)** - not
Circle USDC. Agent402 settled a real x402 payment in USDG on the chain's
second day of mainnet, and this guide documents everything that took: the
chain parameters, the buyer flow, the seller config, and how to recognize an
x402 settlement on a block explorer.

## Chain parameters

| | |
|---|---|
| Chain id | 4663 (CAIP-2: \`eip155:4663\`) |
| RPC | \`https://rpc.mainnet.chain.robinhood.com\` |
| Explorer | \`https://robinhoodchain.blockscout.com\` |
| Stablecoin | USDG (Global Dollar) - \`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168\`, 6 decimals |
| EIP-712 domain | name \`"Global Dollar"\`, version \`"1"\` |

## How a payment works (same x402, different stablecoin)

Nothing about the protocol changes: the buyer hits a paid endpoint, gets an
HTTP **402** whose \`accepts\` includes an \`eip155:4663\` option carrying the
USDG contract address and its EIP-712 domain, signs an **EIP-3009
\`transferWithAuthorization\`** with its own key, and retries. A facilitator
submits the transfer on-chain and pays the gas - the buyer needs only USDG,
no ETH, no bridge, no account.${networkFloorUsd(ROBINHOOD_CAIP2) > 0 ? ` On Agent402 the \`eip155:4663\` option quotes
the tool's price or $${networkFloorUsd(ROBINHOOD_CAIP2)}, whichever is higher.` : ""}

## Buy something on Robinhood Chain (JavaScript)

The standard x402 EVM client signs USDG as-is (asset + domain come from the
402's \`accepts\` entry). One subtlety: a multi-chain seller offers several
networks, and the default client may pick another chain - filter the accepts
to \`eip155:4663\` to force USDG settlement:

\`\`\`js
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // @x402/core 2.23+ refuses anything over $1 or off the pegged-asset list by default; keep your own ceiling in code instead
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const http = new x402HTTPClient(client);

const url = "https://agent402.tools/api/hash";
const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) };
const challenge = await fetch(url, init);                       // → 402
const required = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json().catch(() => undefined));
const robinhood = required.accepts.filter((a) => a.network === "eip155:4663");
const payload = await client.createPaymentPayload({ ...required, accepts: robinhood });
const res = await fetch(url, { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) } });
// 200 - and the PAYMENT-RESPONSE header carries the on-chain tx hash
\`\`\`

## Accept USDG as a seller (self-hosted Agent402)

The open-source server ships the rail; enabling it is config:

\`\`\`bash
PAYMENT_NETWORKS=base,solana,polygon,arbitrum,stellar,robinhood \\
ROBINHOOD_FACILITATOR_URL=<an x402 facilitator that settles eip155:4663> \\
WALLET_ADDRESS=0xYourRevenueWallet npm start
\`\`\`

Every paid route's 402 now offers USDG on Robinhood Chain alongside USDC on
the other chains. If the facilitator URL is unset, the server degrades
gracefully - the robinhood option is simply omitted; every other rail keeps
serving.

## How to recognize an x402 settlement on Blockscout

On-chain there is no "402" label - the tell is the shape of the transaction:

1. **Method is \`transferWithAuthorization\`** (EIP-3009, selector
   \`0xe3ee160e\`) on the USDG contract - not a plain \`transfer\`.
2. **The tx sender is the facilitator's relayer**, not the buyer - the buyer
   only signed; it paid no gas. "Sender ≠ the address whose USDG moved" is
   the gasless-settlement signature.
3. **The decoded transfer** shows \`from\` = the buyer's wallet, \`to\` = the
   seller's revenue wallet, value = the quoted price.

A real example - the settlement that verified this guide:
[\`0xae8e3e40…f826\`](https://robinhoodchain.blockscout.com/tx/0xae8e3e4048a28a1db30ad17ac83d998885623c764d0e3d27abf8e817f578f826).

## Reads, not just payments

Agent402's keyless chain tools speak Robinhood Chain too - \`tx-status\` and
\`gas-estimate\` accept \`network=robinhood\` against the public RPC, so an
agent can verify its own settlement for a fraction of a cent without an RPC key.
`,
  },
  {
    slug: "create-agent-wallet",
    title: "Give your agent a wallet - non-custodial, from zero to first x402 payment",
    seoTitle: "Give your agent a non-custodial wallet",
    description:
      "The secure way to create and fund a wallet for an AI agent: generate the key locally (it never touches any server, including ours), rehearse the full x402 payment loop with faucet USDC on Base Sepolia, then fund it for real with a card via a single-use Coinbase Onramp link.",
    md: `
Agents need wallets, and the single most important property of an agent
wallet is that **nobody else ever sees the private key** - not a SaaS,
not a marketplace, and not Agent402. This guide is the flow we test in CI
end to end: a keypair born inside the test runner completes a real x402
purchase, and the run fails if the key ever appears in any log.

## The trust model, stated plainly

- **Your key is generated on YOUR machine** and never transmitted. Every
  Agent402 tool below takes only your **address** - public information.
- **Payments are gasless.** The x402 "exact" scheme uses EIP-3009
  \`transferWithAuthorization\`: your agent signs an off-chain
  authorization and the facilitator pays the gas. A fresh wallet needs
  only USDC - no ETH, ever.
- **Rehearse before you risk.** The full payment loop runs on Base
  Sepolia with free faucet USDC first; the mainnet flow is byte-for-byte
  identical.

## 1. Create the wallet (locally - one line)

\`\`\`js
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pk = generatePrivateKey();          // stays on YOUR machine
const account = privateKeyToAccount(pk);
console.log("agent address:", account.address);  // the ONLY thing you share
\`\`\`

Store \`pk\` in your secret manager (env var, keychain, KMS) - never in
code, never in git. If you prefer managed custody, Coinbase's
[Embedded Wallets](https://docs.cdp.coinbase.com/) give end users
email-login wallets where you never handle keys at all; everything below
works the same since only addresses are exchanged.

## 2. Rehearse on testnet (free money)

Fund the new address with testnet USDC via the paid
[\`testnet-fund\`](/tools/testnet-fund) tool - a tenth of a cent buys a
full testnet dollar from the Coinbase faucet:

\`\`\`bash
curl -X POST https://agent402.tools/api/testnet-fund \\
  -H "Content-Type: application/json" \\
  -d '{"address":"<your agent address>","token":"usdc"}'
\`\`\`

Then point your x402 client at any base-sepolia seller (or run the
open-source Agent402 server locally with \`NETWORK=base-sepolia\`) and
make a paid call:

\`\`\`js
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
client.setSpendControls?.(false); // @x402/core 2.23+ refuses anything over $1 or off the pegged-asset list by default; keep your own ceiling in code instead
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("http://localhost:3000/api/hash", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "first paid call" }),
});
// The PAYMENT-RESPONSE header carries the on-chain settlement tx.
\`\`\`

## 3. Fund it for real

When the rehearsal settles, fund the same address with real USDC on Base.
Two ways:

- **Card / Apple Pay** - [\`onramp-link\`](/tools/onramp-link) mints a
  single-use Coinbase Onramp URL for your agent's address with a
  fee-inclusive quote. Open it, pay, done.
- **Transfer** - send USDC on Base from any exchange or wallet to the
  agent's address.

Verify with [\`wallet-balances\`](/tools/wallet-balances), then the same
buyer code works against any x402 v2 seller on Base in
[the index](/marketplace) - and every tool here. Budget guardrails: the
[agent402-mcp](https://www.npmjs.com/package/agent402-mcp) server adds
pre-signature spend controls (per-call and per-session caps) on top.

## How we hold ourselves to this

The flow above runs in our CI in two legs. On every push, a **fresh keypair
is generated inside the runner** and the test scans every byte of its own
output for the key material (with and without the \`0x\` prefix) and **fails
the build on any hit**. In the paid-test job the same fresh key is
faucet-funded and completes a real x402 settlement against a paid-mode server
on a testnet, and the scan covers the server's full log too. Keys in,
addresses out.
`,
  },
  {
    slug: "smart-order-router",
    title: "One payment, any proven seller: the x402 Smart Order Router",
    description:
      "Describe a task, pay once, and the router resolves the best tool - from Agent402's own 500+ catalog or from an external x402 seller in the open economy, proven sellers first - buys the result from that seller on the chain you paid on and sells it to you with an on-chain receipt.",
    md: `
The open x402 economy has a discovery problem and a trust problem. Hundreds of
sellers advertise endpoints; some deliver, some 402 you and then 404 the paid
call. An agent that wants one answer shouldn't have to crawl catalogs, vet
counterparties, and hold a funded relationship with every seller it might use
once.

**Route-and-execute** collapses all of that into one call: describe the task,
pay a single flat price, get the result and a receipt. If the best tool is in
Agent402's own 500+ catalog, it runs internally. If it lives with an external
seller in the open index, **we buy the result from that seller with our own
wallet and sell it to you**. Two on-chain settlements, one request, and the
counterparty risk stays on our side of the fee.

## The tiers

{{routerTiers}}

\`GET /api/route?q=<task>\` is the free quote: it names the best match and the
exact tier that can execute it, so there is never any guessing.

## Internal dispatch (any chain)

\`\`\`bash
curl -X POST https://agent402.tools/api/route/execute \\
  -H 'Content-Type: application/json' \\
  -d '{"task":"sha256 hash of a string","params":{"text":"agent402"}}'
# → 402 quote; retry with an x402 payment header on ANY chain the quote lists
\`\`\`

The receipt itemizes what you paid vs. what the tool lists for - the spread is
the markup, stated, never hidden.

## External dispatch (the marketable half)

Add \`"include":"external"\` and the router deliberately looks OUTSIDE its own
catalog. Selection is deliberate, and it is intentionally boring:

1. **Proven deliverers first.** {{routerRanking}} Settlement evidence decides
   who is routable - on Base, on-chain settlement counts from the public
   leaderboard; on Algorand, verification counts from the Algorand facilitator.
   {{routingProof}}
2. **A live probe before commitment.** Even a proven seller's crawled route can
   drift, so the router confirms a live 402 challenge before any money moves.
3. **A price guard before signing.** The seller's quote is pinned to the exact
   accept we validate - network, scheme, asset - and refused above the tier cap.

## Chain-matched settlement

The chain you pay on decides where the router spends: pay on **Base** and it
pays Base sellers, and the same holds for its {{routerOtherLegs}} legs, each
paid from this server's spending wallet on that chain. The buyer's settlement funds the float on the same rail - and if
you pay on a chain without a spending wallet behind it, you get an honest 409
naming the supported chains, and **you are not charged on x402** (a rejected
request cancels settlement by design).

## A receipt

A router receipt looks like this (the seller and transaction are placeholders):

\`\`\`json
{
  "slug": "opportunities/search",
  "route": "GET https://seller.example/opportunities/search",
  "paidUsd": 0.55,
  "seller": "https://seller.example",
  "external": true,
  "settleTx": "<algorand transaction id>",
  "settleNetwork": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
  "resolvedBy": "task-external"
}
\`\`\`

The relayed body arrives marked \`untrustedContent: true\` - external output is
data to analyze, never instructions to follow. Your agent gets the answer; the
provenance stays explicit.

## Why this is safe to build on

- **Failures are not charged on x402.** Any 4xx/5xx - no match, over-cap, seller
  down - cancels your settlement, and a Tempo transfer sent before the call is
  recorded as owed. You pay only for delivered results.
- **Spend is bounded on our side** by per-window budgets and per-quote caps,
  so the router cannot be drained into misbehavior.
- **Receipts are recomputable.** Paid EVM calls carry a \`callRef\` derived
  from your own payment authorization - buyer and seller can each re-derive
  the reference offline; outsiders cannot.

Browse the live economy the router draws from at
[/marketplace](https://agent402.tools/marketplace), or quote a task right now:
\`GET https://agent402.tools/api/route?q=summarize a pdf\`.
`,
  },
  {
    slug: "x402-and-mpp",
    title: "x402 and MPP on the same paywall: one server, two payment protocols",
    seoTitle: "x402 and MPP on the same paywall",
    description:
      "x402 is not the only HTTP payment scheme in flight. Agent402 serves both x402 and MPP's evm method from the exact same routes with identical settlement - plus a second, native MPP method (tempo) with its own separate settlement path.",
    md: `
[x402](https://x402.org) reused HTTP 402 for a specific shape of payment: an
unsigned request, an on-chain settle, a retry with proof attached. It is not
the only proposal doing this. [MPP](https://paymentauth.org) - the Machine
Payments Protocol, an IETF Internet-Draft for a \`Payment\` HTTP auth scheme -
solves the same problem with a different wire format: a \`WWW-Authenticate:
Payment\` challenge instead of a PAYMENT-REQUIRED header, and an \`Authorization: Payment\`
credential on retry instead of a custom header.

Two clients, two conventions, one seller who doesn't want to run two paywalls.
So Agent402 speaks both, from the same routes, with the same settlement
underneath - for MPP's \`evm\` method specifically.

**MPP itself now has a second method, \`tempo\`, that this guide's "shim"
model does NOT cover.** Tempo (the chain MPP's own reference implementation
targets) settles natively via TIP-1034/TIP-20 primitives through Tempo's own
relay - not EIP-3009, no x402 facilitator involved, a genuinely separate
settlement path from everything below. A 402 on this server carries both
\`evm\` and \`tempo\` MPP challenges (the buyer's client picks whichever it
speaks), except on wallet-identity-bound routes (memory, usage) and
long-running ones (the report products), which carry no \`tempo\` challenge.
Only \`evm\`'s mechanics are what the rest of this guide describes.

## What actually changes on the wire (the \`evm\` method)

Nothing about settlement. **\`@x402/express\` keeps sole settlement
authority** - it still verifies, still settles, still decides pass or fail.
What changes is the envelope around it:

- A 402 also carries \`WWW-Authenticate: Payment\`, one HMAC-bound challenge
  per EVM rail that MPP's evm method covers {{mppEvmRails}}. The x402 \`accepts\` entry for that rail rides inside
  the challenge's own metadata, verbatim - so the challenge needs nothing
  stored server-side to issue or check later. Same statelessness x402 already
  has, extended to a second header.
- An inbound \`Authorization: Payment\` credential that verifies against that
  HMAC gets re-encoded as \`PAYMENT-SIGNATURE\` and falls through the normal
  x402 pipeline unchanged - the same replay guard, the same payer
  attribution, the same idempotency-key handling an x402 buyer gets.
- A settled 200 mirrors its \`PAYMENT-RESPONSE\` back as \`Payment-Receipt\`,
  MPP's expected receipt header.

The shim is a pure translation layer sitting in front of the paywall, not a
second payment path beside it. \`mppx\` (the reference codec) is only used for
encode/decode primitives here - its own request-guard and settle path are
never mounted, because two components with settlement authority is how you
get a double-settle bug.

## Try it

If you already have an MPP-capable client, point it at any paid Agent402
route the normal way - no separate config, no MPP-specific endpoint:

\`\`\`bash
curl -i -X POST https://agent402.tools/api/hash \\
  -H 'Content-Type: application/json' -d '{"text":"hi","algo":"sha256"}'
# HTTP/2 402
# www-authenticate: Payment id="…", realm="agent402.tools", method="tempo",
#   intent="charge", request="eyJhbW91bnQiOi…", expires="…",
#   Payment id="…", realm="agent402.tools", method="evm",
#   intent="charge", request="eyJhbW91bnQiOi…", expires="…", opaque="eyJ4NDAyIjoi…"
\`\`\`

Sign against that challenge the way your MPP client already knows how to,
retry with \`Authorization: Payment ...\`, and you get back \`200\` plus a
\`Payment-Receipt\` header - not a custom Agent402 format, the receipt shape
MPP itself defines.

## One thing to get right: the EIP-712 domain name

An \`evm\`/\`charge\` credential is an EIP-3009 \`TransferWithAuthorization\`
signed under the **token's own EIP-712 domain**, and that domain's \`name\` is
not the same on every chain. Base USDC is \`"USD Coin"\`. Celo, Monad and Sei
USDC each report \`"USDC"\`. A client that hardcodes one of them signs a digest
that no facilitator and no contract will accept on the chains that use the
other, and the failure is quiet: the signature is well-formed, so it looks like
a rejected payment rather than a wrong one.

You never have to guess. The challenge carries the exact x402 accepts entry it
was minted from, and that entry's \`extra.name\` and \`extra.version\` are the
domain to sign under, read from the token on chain.

If a credential does arrive signed under a different known name, we recover the
signer and recognize it before spending a facilitator round trip on it. You get
a \`402\` with an RFC 9457 \`application/problem+json\` body naming both the name
you signed under and the one the token uses, so the mistake is readable instead
of looking like an outage. That response also carries no \`WWW-Authenticate\`
header, on purpose: a client whose manager prefers MPP has nothing to select and
falls through to the x402 offer sitting in the same \`402\`, which the same wallet
can pay today. It is a short, self-clearing hold, and any request that presents a
credential is never held.

## Why bother running two protocols

Because the buyer shouldn't have to guess which one a seller picked. An agent
built against MPP tooling should be able to pay an x402-native seller without
a special case, and vice versa - and that only holds if sellers on both sides
actually do it, not just say they support it. This one is verified end to
end: a real \`mppx\` client buying over the native wire against this server,
one verify-and-settle, the EIP-712 signature checked against Base USDC's
actual on-chain domain, x402 traffic on the same routes untouched, and a
tampered or expired challenge rejected before it reaches a handler.

Rollout is a single switch server-side (present or absent, no partial state),
and which EVM rails get an MPP challenge is configurable per deployment - so
a seller can offer MPP on their primary chain without promising it everywhere
they offer x402. The two protocols don't have to agree on everything to both
work today.
`,
  },
  {
    slug: "why-twelve-chains",
    title: "Why Agent402 settles on {{railCount}} chains instead of just Base",
    description:
      "Base is where x402 volume actually is today. Agent402 also settles on {{usdcRailsButBase}}, and Robinhood Chain (USDG) anyway - here's the actual reason, chain by chain.",
    md: `
Most x402 volume, ours included, settles on Base. That's not a secret and
this guide isn't going to pretend otherwise. So the honest question is: why
run {{railsMore}} more rails if that's where the traffic already is?

## The reason isn't "more chains, more revenue"

It's optionality. An agent doesn't get to choose what chain its wallet
already holds USDC on - it was funded once, for some other reason, on
whatever chain that happened to be. A seller who only accepts Base is
invisible to every agent funded anywhere else, no matter how good the tool
is. {{RailCount}} chains means {{railCount}} populations of already-funded buyers who never
have to bridge, swap, or wait for a transfer just to pay for one API call.

## What's actually live, and who settles it

Every rail below is a real, working \`payTo\` you can quote against right now.
Each tool's \`402\` (or \`GET https://agent402.tools/api/x402-quote?url=...\`)
lists its live \`accepts\` per network, and
[\`/api/rails\`](https://agent402.tools/api/rails) lists the rails offered. Each
rail settles through a facilitator that supports it, with a fallback where one
exists:

- **Base** - the primary rail, and where the x402 Bazaar discovery listing
  lives.
- **Solana, Polygon, Arbitrum, Avalanche, Sei, Monad, Celo** - USDC, each
  through a facilitator that settles that network.
- **Optimism** - USDC; its settlement carries a fee, so its quote carries a
  small network premium, shown in the \`402\`. What you're quoted is what
  actually clears.
- **Arc** - USDC, through the facilitator that settles that network; Arc pays
  its own gas in USDC, and the facilitator covers it, so a buyer needs only USDC.
- **Stellar** - USDC via our own self-hosted Soroban facilitator (open source,
  in this repository); settlement here is confirmed against the chain itself,
  not just trusted from the facilitator's word, because Stellar's ~5-second
  ledger close can outlast a synchronous HTTP request.
- **Algorand** - USDC via a dedicated AVM facilitator; every payment carries a
  signed validity window sized to the tool it's paying for, so a slow tool can
  never receive a payment that expires mid-call.
- **Robinhood Chain** - the one non-USDC rail: USDG.${networkFloorUsd(ROBINHOOD_CAIP2) > 0 ? ` Its quote
  never goes below $${networkFloorUsd(ROBINHOOD_CAIP2)} a call, shown in the \`402\`.` : ""}

Every facilitator is health-checked at boot. A facilitator that fails its boot
check drops only its own rail from the offer - the other rails, and the free
proof-of-work tier, are unaffected.

## What doesn't change per chain

The settlement rule is the same everywhere: a call that answers an error
status, or whose payment does not match the offer, is not settled, on any of
the {{railCount}} chains. Chain choice changes *where* the USDC moves, not the rule
that decides *whether* it moves.

## The Smart Order Router uses this directly

When [the router](/guides/smart-order-router) buys from an external seller
to resell the result to you, it settles on the SAME chain you paid it on - an Algorand
payment funds an Algorand purchase, a Base payment funds a Base purchase.
{{RailCount}} chains isn't just about who can pay us; it's what lets the router keep
your money on the chain you already trusted it on, instead of quietly
routing everything through one chain regardless of what you sent.
`,
  },
  {
    slug: "pay-with-coinbase-agentic-wallet",
    title: "Pay Agent402 from Coinbase's own agent tooling: Agentic Wallet CLI, Agentic Wallet MCP, purl, and the CDP SDK",
    seoTitle: "Pay Agent402 from Coinbase's agent tooling",
    description:
      "Already holding a Coinbase Agentic Wallet, the Agentic Wallet MCP tools, Stripe's purl, or a CDP-managed wallet in code? Every Agent402 endpoint is a plain x402 resource on Base, so those pay it unchanged - here are the exact commands, the spend caps to set, and the two extensions we honor (payment-identifier, bazaar).",
    md: `
Agent402 is indexed on the Coinbase x402 Bazaar and every paid endpoint is a
plain x402 v2 resource settling USDC on Base (plus {{railsMore}} more rails). So the
buyer tooling Coinbase and Stripe ship for x402 pays it with no Agent402-specific
setup. This guide is the command sheet. Nothing here needs an API key from us:
the payment is the identity.

## Agentic Wallet CLI (\`awal\`)

Coinbase's wallet CLI for agents signs x402 payments from a hosted Agentic
Wallet. Sign in once, then discover and pay:

\`\`\`bash
npx awal@latest auth login you@example.com      # one-time sign-in
npx awal@latest status

# find us on the Bazaar (keyword search over the x402 index; cached 12h)
npx awal@latest x402 bazaar search "decode a VIN" -k 5
npx awal@latest x402 details https://agent402.tools/api/vin-decode

# pay a GET endpoint (query params with -q), capped at $0.01 (atomic USDC units)
npx awal@latest x402 pay https://agent402.tools/api/vin-decode -q '{"vin":"1HGCM82633A004352"}' --max-amount 10000

# pay a POST endpoint with a JSON body
npx awal@latest x402 pay https://agent402.tools/api/extract -X POST \\
  -d '{"url":"https://example.com/article"}' --max-amount 10000 --json
\`\`\`

\`--max-amount\` is the per-payment ceiling in atomic units (USDC has 6
decimals: \`10000\` = $0.01). Read the price off the 402 first with
\`x402 details\`; every Agent402 price is also in
[/api/pricing](https://agent402.tools/api/pricing).

## Agentic Wallet MCP (Claude, Cursor, any MCP host)

The same wallet exposed as MCP tools. The flow an agent follows is:
\`list-bazaar-resources\` or \`get-resource-details\` to find the endpoint,
\`check-payment-requirements\` to read our 402 (price, network, pay-to) without
paying, then \`make-x402-request\` to pay and fetch. Point them at any
\`https://agent402.tools/api/...\` URL from [/api/pricing](https://agent402.tools/api/pricing)
or resolve a task first with \`GET https://agent402.tools/api/find?q=<task>\`
(free) and hand the returned \`url\` to \`make-x402-request\`.

## Stripe's \`purl\` (x402 curl)

Stripe's open-source x402 client. Install with Homebrew (\`brew install
stripe/purl/purl\`) or build from [github.com/stripe/purl](https://github.com/stripe/purl),
add a wallet, and treat any paid URL like curl:

\`\`\`bash
purl wallet add --name agent --type evm -k 0x<private key> --set-active=true
purl --dry-run "https://agent402.tools/api/dns?name=example.com&type=A"   # parse the 402 quote, pay nothing
purl "https://agent402.tools/api/dns?name=example.com&type=A"             # pay and fetch
\`\`\`

We run purl against production from CI on demand (the purl interop job), so a
purl that cannot parse our 402 shows up as a failed job on our side.

## CDP SDK in code (\`CdpX402Client\`)

A CDP-managed wallet with server-side spend controls, wrapped around fetch:

\`\`\`ts
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base

const client = new CdpX402Client({
  spendControls: {
    maxAmountPerPayment: { atomic: 50_000n, asset: USDC_BASE },   // $0.05 per call
    maxCumulativeSpend:  { atomic: 2_000_000n, asset: USDC_BASE }, // $2 per window
    maxCumulativeSpendWindow: "24h",
    allowedNetworks: ["eip155:8453"],
  },
});
const pay = wrapFetchWithPayment(globalThis.fetch, client);
const r = await pay("https://agent402.tools/api/extract", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
\`\`\`

Or swap the wallet for our buyer SDK's caps: \`new Agent402({ fetch: pay,
maxPerCallUsd: 0.05, dailyLimitUsd: 2 })\` from
[agent402-client](https://www.npmjs.com/package/agent402-client) adds
\`find()\`, caching and idempotent retries on top of any payment-aware fetch.

## Two x402 extensions we honor

- **payment-identifier** - every 402 declares it (optional). Attach a
  \`pay_...\` id to your payment payload and an exact retry of that payment
  (same credential, same body) replays the original result with no second
  settle, exactly as our \`Idempotency-Key\` header does. A fresh
  authorization carrying the same id is a new payment.
- **bazaar** - every endpoint carries the discovery extension (input schema,
  output example), which is what makes it show up in \`awal x402 bazaar
  search\` and the Agentic Wallet MCP's resource list at all.

## What you get back

A \`200\` with JSON and a \`PAYMENT-RESPONSE\` header (the settle receipt).
A \`4xx\`/\`5xx\` is not charged on x402: settlement runs after the handler and only
for a successful response, and you can verify that from the headers you hold
(no \`PAYMENT-RESPONSE\` = nothing settled). One exception: a transfer that
lands after a timed-out settle, a disconnect during settle, or a settle the
facilitator answered as pending whose receipt was not read in time, is booked
as a refund owed and repaid after on-chain proof. Prefer MPP? The same 402 also
carries a \`WWW-Authenticate: Payment\` challenge - see
[x402 and MPP on the same paywall](/guides/x402-and-mpp).
`,
  },
  {
    slug: "coinbase-business-get-paid-by-agents",
    title: "Get paid by AI agents into your Coinbase Business account with agent402-tollbooth",
    seoTitle: "Get paid by AI agents into Coinbase Business",
    description:
      "Coinbase Business accounts receive x402 payments from AI agents. agent402-tollbooth is the one-middleware way to put a USDC price on your API or site, settle through Coinbase's facilitator, and land every payment in that account. Three env vars, one command, one example server.",
    md: `
Coinbase Business now takes payments from AI agents over x402: an agent pays
your x402 URL in USDC and the funds settle into your Coinbase Business account,
where you reconcile, withdraw, or hold them. Coinbase's own path is a hosted
checkout that returns an x402 URL. If you sell an API and want a price on every
request, this guide puts x402 in front of the API itself and settles into the
same account.

[agent402-tollbooth](https://www.npmjs.com/package/agent402-tollbooth) is an
open-source (MIT) gate for Express, Next.js, Cloudflare or a plain reverse
proxy: humans browse normally, AI agents and crawlers get a 402 with a USDC
price and pay it, and the gate settles through the facilitator you name. Point
it at your Coinbase Business address and every settled call lands there.

## 1. Two things from Coinbase

1. Your **USDC receive address on Base** from the Coinbase Business account
   (Receive, network Base, asset USDC; Coinbase's Deposit Destinations API is
   the programmatic route to a receive address). This is the \`payTo\` on
   every 402 you serve, so funds settle straight into the account.
2. A **CDP API key** (id + secret) from the Coinbase Developer Platform. The
   tollbooth uses it to sign requests to Coinbase's x402 facilitator, which
   verifies and settles each payment. On Base no fee is taken from the payment
   itself; the facilitator's own usage pricing is on Coinbase's developer
   platform pages.

## 2. One command in front of anything

\`\`\`bash
npm i agent402-tollbooth @x402/express @x402/core @x402/evm @coinbase/x402
set -a; . ./.env; set +a   # TOLLBOOTH_CDP_API_KEY_ID + TOLLBOOTH_CDP_API_KEY_SECRET
TOLLBOOTH_PAYTO=0xYourCoinbaseBusinessBaseAddress \\
TOLLBOOTH_PRICE='$0.005' \\
TOLLBOOTH_UPSTREAM=http://localhost:8080 \\
npx agent402-tollbooth
\`\`\`

The CDP key stays out of your shell history: its id and secret (exactly as
Coinbase issued it) live in a \`.env\` file kept out of version control, or in
your secret store, and the \`set -a\` line loads them.

That is a reverse proxy in front of your existing API on :8080. In the
default mode known AI crawlers (matched by user agent) get a 402 quoting $0.005
in USDC on Base, pay it, and are proxied through; the payment settles into the
Coinbase Business account before the response is released, and browsers pass
untouched. To charge every non-browser caller, stock x402 clients included, set
\`TOLLBOOTH_MODE=strict\`. \`TOLLBOOTH_MODE=all\` charges every caller, browsers
included; in code, a \`free()\` predicate exempts your own clients.

## 3. Or as Express middleware, with the price per route

\`\`\`js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";

const PAY_TO = process.env.COINBASE_BUSINESS_ADDRESS;  // USDC receive address on Base
const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
);
const server = new x402ResourceServer(facilitator).register("eip155:8453", new ExactEvmScheme());
const x402 = paymentMiddleware(
  { "GET /api/quote": { accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, price: "$0.005" }] } },
  server
);

const app = express();
app.use(createTollbooth({ x402 }));            // known AI crawlers pay, MPP accepted too; mode: "strict" or "all" charges every agent
app.get("/api/quote", (req, res) => res.json({ price: 42 }));
app.listen(8080);
\`\`\`

The gate delegates verify and settle to \`@x402/express\` in its own order
(verify, run your handler, settle only on a success response) and, by default,
also accepts the MPP wire, so agents on either protocol can pay. The full
runnable example is in the repo:
[examples/coinbase-business-tollbooth](${repoUrl("tree/main/examples/coinbase-business-tollbooth")}).

## 4. Prove it with one paid call

We ran exactly this path with real money before publishing: the CLI's own
middleware built from CDP keys, paid $0.001 by a stock x402 client, settled
through Coinbase's facilitator on Base
([transaction](https://basescan.org/tx/0x8175178ac4e2229dfd9385a3c78c491ffe554b08fdf52cf92f99425c983ec5d1)).
One rule to know: Coinbase's facilitator refuses a payment whose payer is the
payTo (\`self_send_not_allowed\`), so test from a second wallet, never from the
receiving address.

Any stock x402 client pays it; we proved it with \`@x402/fetch\` and the
[agent402-client](https://www.npmjs.com/package/agent402-client) SDK speaks the
same wire. The receipt on the 200 response (\`PAYMENT-RESPONSE\`) carries the
settlement; it lands on Base within seconds and Coinbase credits the deposit on
its normal schedule.

## What you get

- Payments from agents settle in USDC into the account you already reconcile
  from, with no card network, no invoices and no agent accounts.
- Discoverable: list the endpoint on Agent402's open index ([/sell](/sell));
  agents can find it at once, and once it shows settled transactions the
  router at [/api/route](/api/route) can buy from you and resell the result;
  a route can also carry the x402 Bazaar discovery extension for Coinbase's
  own directory.
- The rest of the tollbooth: proof-of-work for callers with no wallet,
  observe-before-charge mode, per-route prices, analytics, and native MPP on
  Tempo if you want a second rail. See [/tollbooth](/tollbooth).
`,
  },
  {
    slug: "agent-hosts",
    title: "Use Agent402 from Claude Code, Cursor, VS Code, Windsurf, Cline, Roo Code, Codex CLI, Gemini CLI, Continue, ElizaOS, Paperclip, HarnessRouter, AgentCore and any OpenAI SDK",
    seoTitle: "Use Agent402 from Claude Code, Cursor and more",
    description:
      "Two doors into Agent402 from the agent host you already run: models through an OpenAI-compatible base URL (metered, from $" + TIERS["v1-chat-metered"].price + " a call, paid from a wallet over x402" + (CREDITS_ON ? " or with a prepaid credits key" : ", or with a credits key bought earlier") + "), and 500+ tools through MCP. Copy the block for your host.",
    md: `
Agent402 opens two doors to an agent host:

- **Models**: an OpenAI-compatible gateway. Run the local wallet proxy
  (\`agent402-openclaw proxy\`, below) and point any client that accepts a
  base URL at \`http://127.0.0.1:8412/v1\`: it pays each call from your wallet
  over x402. With ${CREDITS_ON ? "a credits key" : "a credits key you already hold"}, a client can instead use
  \`https://agent402.tools/v1/metered\` directly with the key as its API key. Each request is quoted from its own
  body (input plus your \`max_tokens\`), from $${TIERS["v1-chat-metered"].price} a call.
  \`GET https://agent402.tools/v1/models\` lists every id with its price and
  input cap; \`auto\` (routed per prompt, flat
  $${TIERS["v1-chat-auto"].price}) lives at \`https://agent402.tools/v1/auto\`.
- **Tools**: the hosted MCP connector at \`https://agent402.tools/mcp\`
  (discovery and the free tier need no key at all), or the
  [\`agent402-mcp\`](https://www.npmjs.com/package/agent402-mcp) stdio server,
  which pays wallet-only tools from a wallet when \`AGENT_KEY\` is set (an EVM
  key holding USDC; \`SOLANA_AGENT_KEY\` pays on Solana).

${CREDITS_ON ? `A prepaid credits key works too: buy a pack by card at
[agent402.tools/credits](https://agent402.tools/credits); the key (\`a402_…\`)
is shown once and emailed, and it goes in \`AGENT402_CREDITS_KEY\` in place of
\`AGENT_KEY\` in every stdio block below.` : `Already hold a credits key (\`a402_…\`) from before? It keeps working: put it
in \`AGENT402_CREDITS_KEY\` in place of \`AGENT_KEY\` in any stdio block below.`}
\`GET /api/credits/balance\` (Bearer) reports what a credits key has left. Use a
low-value wallet funded only with what you mean to spend. Every route also answers a stock x402 \`402\`
(${RAILS_COUNT_MD}) and an MPP challenge, so any x402 client pays per call with no key.

## Pay from a wallet (local proxy)

The proxy runs on your machine, signs an x402 payment for each call from a
wallet you hold (the key never leaves the machine), and forwards to the
gateway. Any OpenAI-compatible client then uses it as its base URL:

\`\`\`bash
npm i agent402-openclaw @x402/fetch @x402/evm viem   # in one folder
export AGENT402_WALLET_KEY=0x...      # an EVM key holding USDC on Base
export AGENT402_MAX_PER_CALL_USD=2    # per-call ceiling checked before signing
npx agent402-openclaw proxy           # run from that folder; serves http://127.0.0.1:8412/v1
\`\`\`

Install the four packages together and run the proxy from the same folder: the
wallet packages are optional peers, so a proxy started without them runs unpaid
and logs that x402 payment is unavailable.

Use model \`auto\` or any id from \`GET /v1/models\`. Run
\`npx agent402-openclaw permit2-approve\` once to settle metered calls at actual
usage instead of the quote. The proxy also answers the Anthropic wire
(\`POST /v1/messages\`), so Claude Code pays from the same wallet (next section).

## Claude Code

Claude Code as an LLM client, billed per request under a quoted ceiling. With
the local proxy running (above), point Claude Code at it and it pays each turn
from your wallet:

\`\`\`bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8412
export ANTHROPIC_AUTH_TOKEN=unused    # the proxy pays; this value is ignored
claude --model anthropic/claude-sonnet-5.5
\`\`\`

${CREDITS_ON ? "Or" : "With a credits key you already hold, you can instead"} point
it at the metered tier with the credits key as the auth token (Bearer), keep
your usual model names - dated ids like \`claude-haiku-4-5-20251001\` resolve
to the live model:

\`\`\`bash
export ANTHROPIC_BASE_URL=https://agent402.tools/v1/metered
export ANTHROPIC_AUTH_TOKEN=a402_...
claude --model anthropic/claude-sonnet-5.5
\`\`\`

Verified 2026-08-27 with claude-cli 2.1.250: a full turn (110 KB system
prompt + 22 tool schemas, adaptive thinking, streaming) and a tool-use round
trip both complete; each turn is quoted from its own body (\`/v1/metered\`
accepts bodies to 1 MB, with at least 200k input chars) and settles at actual usage, so an
idle turn costs cents, never the ceiling. Not carried on this wire:
\`output_config\`, \`context_management\` (dropped, the model default applies)
and server-side tools (web search, computer use) - Claude Code's own tools are
client tools and work as usual.

Tools over the hosted connector (free tier and discovery, no key):

\`\`\`bash
claude mcp add --transport http agent402 https://agent402.tools/mcp
\`\`\`

Paid tools from a wallet, through the stdio server:

\`\`\`bash
claude mcp add agent402 -e AGENT_KEY=0x... -- npx -y agent402-mcp@0.13.31
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

Or in \`.mcp.json\` at the project root:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "\${AGENT_KEY}" }
    }
  }
}
\`\`\`

## Cursor

\`.cursor/mcp.json\` in the project (or \`~/.cursor/mcp.json\` for every
project). Remote, no key:

\`\`\`json
{ "mcpServers": { "agent402": { "url": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools from a wallet:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "0x..." }
    }
  }
}
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

## Paperclip

Add the hosted connector to a Paperclip company as a custom MCP server:

1. Open **Connectors**, then **Connect your own MCP server**.
2. Paste \`https://agent402.tools/mcp\`. Paperclip inspects the server; the
   connector needs no sign-in and no key, so it goes straight to the
   discovered actions.
3. Choose which agents can use the connection, then save.

With no wallet, \`catalog.search\`, \`catalog.find\`, \`payment.info\` and
\`server.describe\` answer for free, and \`catalog.call\` runs the pure-CPU
tools (hash, uuid, base64, markdown, JSON and more) free through
proof-of-work, rate-limited. Wallet-only tools, the flagship web and market
tools among them, {{connectorPaidAnswer}}, and a call that carries no payment
is never charged. Paperclip's connectors take a URL; to pay from your own
wallet, add the stdio server from the Cursor block above, with \`AGENT_KEY\`
set, as an MCP server on the agent itself. Prices are on [/pricing](/pricing).

Each action has its own setting on the connection's **Permissions** tab:
**Allowed** runs it without review, **Ask first** waits for a person to
approve each call, and **Off** removes it from the agent. A new connection
starts every action at **Allowed**. \`catalog.call\` and each flagship action
({{mcpRunActions}}) run a tool; set all of them to **Ask first** to review
every run.

## HarnessRouter

Add the hosted connector to a HarnessRouter workspace as a remote MCP server
(HarnessRouter connects remote servers over Streamable HTTP by default):

1. In the console, open **Add-ons** and add an MCP server.
2. Name it \`agent402\` and give it the address \`https://agent402.tools/mcp\`.
   The connector needs no sign-in and no key, so leave the server's token
   field empty.
3. To change which tools one setup uses, open the setup in **Studio** and
   choose **Settings**.

Over the API, a harness lists the connector in \`mcp_servers\` when you
create it:

\`\`\`bash
curl -s -X POST "$HARNESSROUTER_BASE_URL/v1/harnesses" \\
  -H "Authorization: Bearer $HARNESSROUTER_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Research agent","base":"claude-code",
       "mcp_servers":[{"name":"agent402","url":"https://agent402.tools/mcp","transport":"http"}]}'
\`\`\`

\`PUT /v1/harnesses/{id}\` replaces the whole configuration, so to add the
connector to a harness that already exists, read it first and send back its
current fields with the entry appended to \`mcp_servers\`.

With no wallet, \`catalog.search\`, \`catalog.find\`, \`payment.info\` and
\`server.describe\` answer for free, and \`catalog.call\` runs the pure-CPU
tools (hash, uuid, base64, markdown, JSON and more) free through
proof-of-work, rate-limited. Wallet-only tools, the flagship web and market
tools among them, {{connectorPaidAnswer}}, and a call that carries no payment
is never charged. To pay from your own wallet, put the stdio server from the
Cursor block above, with \`AGENT_KEY\` set, in a plugin's \`mcp.json\`:
HarnessRouter runs a stdio server only from a plugin, inside the session,
where the agent can read its variables. Prices are on [/pricing](/pricing).

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

## Continue

\`config.yaml\`. A model entry for chat, plus the connector for agent mode:

\`\`\`yaml
models:
  - name: Agent402 (metered)
    provider: openai
    apiBase: http://127.0.0.1:8412/v1   # the local wallet proxy (above)
    apiKey: unused                      # the proxy pays from your wallet
    model: openai/gpt-4o-mini
    roles:
      - chat
mcpServers:
  - name: Agent402
    type: streamable-http
    url: https://agent402.tools/mcp
\`\`\`

Any id from \`/v1/models\` works as \`model\`. With a credits key you already
hold, use \`apiBase: https://agent402.tools/v1/metered\` and the key as
\`apiKey\` instead. The metered route takes
${TIERS["v1-chat-metered"].maxInputChars.toLocaleString("en-US")} characters of input per request on every model, and more on a
model with a larger context window, up to ${METERED_MAX_INPUT_CHARS_CEILING.toLocaleString("en-US")}.

## ElizaOS

Tools: the [\`elizaos-plugin-agent402\`](https://www.npmjs.com/package/elizaos-plugin-agent402)
plugin adds \`AGENT402_FIND\` / \`AGENT402_CALL\` / \`AGENT402_ABOUT\` actions
(\`"plugins": ["elizaos-plugin-agent402"]\`, setting \`AGENT402_WALLET_KEY\` to an
EVM key holding USDC, or \`AGENT402_CREDITS_KEY\` for a credits key you already hold).
Models: the OpenAI plugin reads its base URL from the environment, so no code
changes. With the local wallet proxy running (above):

\`\`\`bash
OPENAI_BASE_URL=http://127.0.0.1:8412/v1
OPENAI_API_KEY=unused
OPENAI_LARGE_MODEL=anthropic/claude-sonnet-5.5
OPENAI_MEDIUM_MODEL=openai/gpt-4o-mini
\`\`\`

The proxy serves chat. Embeddings live at \`/v1/embeddings\`
($${EMBEDDINGS_PRICE} a call), which the proxy does not forward: with a credits
key you already hold, set \`OPENAI_EMBEDDING_URL=https://agent402.tools/v1\` and
\`OPENAI_EMBEDDING_MODEL=text-embedding-3-small\`, with the key as the API key.

## Any OpenAI SDK

With the local wallet proxy running (above), point the SDK at it; the proxy
pays each call from your wallet:

\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8412/v1", api_key="unused")
r = client.chat.completions.create(model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "One sentence on x402."}], max_tokens=60)
print(r.choices[0].message.content)
\`\`\`

With a credits key you already hold, exported as \`AGENT402_CREDITS_KEY\`, call
the metered route directly:

\`\`\`python
import os
from openai import OpenAI
client = OpenAI(base_url="https://agent402.tools/v1/metered", api_key=os.environ["AGENT402_CREDITS_KEY"])
r = client.chat.completions.create(model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "One sentence on x402."}], max_tokens=60)
print(r.choices[0].message.content)
\`\`\`

\`\`\`js
import OpenAI from "openai";
const apiKey = process.env.AGENT402_CREDITS_KEY;
// Stop here when it is unset: the SDK would otherwise fall back to OPENAI_API_KEY
// and send that key to this base URL.
if (!apiKey) throw new Error("export AGENT402_CREDITS_KEY first");
const client = new OpenAI({ baseURL: "https://agent402.tools/v1/metered", apiKey });
const r = await client.chat.completions.create({ model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "One sentence on x402." }], max_tokens: 60 });
console.log(r.choices[0].message.content);
\`\`\`

Send an \`Idempotency-Key\` header on retries and a retried call replays the
paid answer instead of paying again.

The same metered pricing is on the Responses wire too, for the OpenAI Agents
SDK and \`responses.create()\`: base URL \`https://agent402.tools/v1/metered\`
(route \`/v1/metered/responses\`), function tools only, \`store\` always false.

## Any Anthropic SDK (Messages wire)

The same metered pricing on the Anthropic Messages wire. From a wallet, point
the SDK's base URL at the local proxy (\`http://127.0.0.1:8412\`, which answers
\`POST /v1/messages\`) with any placeholder key. With a credits key you already
hold, use \`https://agent402.tools/v1/metered\` (route \`/v1/metered/messages\`)
and pass the key as the SDK's \`auth_token\` (sent as \`Authorization: Bearer\`, which
the credits gate reads), not \`api_key\` (sent as \`x-api-key\`):

\`\`\`python
import os
from anthropic import Anthropic
client = Anthropic(base_url="https://agent402.tools/v1/metered", auth_token=os.environ["AGENT402_CREDITS_KEY"])
m = client.messages.create(model="anthropic/claude-haiku-4.5", max_tokens=60,
    messages=[{"role": "user", "content": "One sentence on x402."}])
print(m.content[0].text)
\`\`\`

\`\`\`js
import Anthropic from "@anthropic-ai/sdk";
const authToken = process.env.AGENT402_CREDITS_KEY;
if (!authToken) throw new Error("export AGENT402_CREDITS_KEY first");
// apiKey: null keeps the SDK from reading ANTHROPIC_API_KEY from the
// environment and sending it here as x-api-key.
const client = new Anthropic({ baseURL: "https://agent402.tools/v1/metered", apiKey: null, authToken });
const m = await client.messages.create({ model: "anthropic/claude-haiku-4.5", max_tokens: 60,
  messages: [{ role: "user", content: "One sentence on x402." }] });
console.log(m.content[0].text);
\`\`\`

## Amazon Bedrock AgentCore

An AgentCore Gateway turns \`https://agent402.tools/openapi.json\` into MCP
tools with an OpenAPI target (\`agentcore add gateway-target --type
open-api-schema --schema <path to openapi.json>\`), or aggregates the hosted
connector as an MCP server target. Paid calls ride
[AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-concepts.html):
the agent forwards our \`402\` payload, AgentCore signs it from its managed
wallet, and the retry carries the signed payment header; every Agent402 route
answers a stock x402 v2 challenge, so nothing on our side needs configuring.

## VS Code

GitHub Copilot's agent mode reads \`.vscode/mcp.json\` in the workspace (or
the user profile via the \`MCP: Open User Configuration\` command; \`MCP: Add
Server\` in the palette writes either). Remote, free tier, no key:

\`\`\`json
{ "servers": { "agent402": { "type": "http", "url": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools from a wallet, through the stdio server with the key held in a
prompted input (VS Code stores it, the file never carries it):

\`\`\`json
{
  "inputs": [{ "type": "promptString", "id": "agent402-key", "description": "EVM private key holding USDC (0x...)", "password": true }],
  "servers": {
    "agent402": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "\${input:agent402-key}" }
    }
  }
}
\`\`\`

## Windsurf

Cascade reads \`~/.codeium/windsurf/mcp_config.json\` (Streamable HTTP, SSE
and stdio are all supported; note Cascade caps the tools it can see at 100 in
total across servers, and this connector lists a small fixed set, not the
whole catalog). Remote, free tier:

\`\`\`json
{ "mcpServers": { "agent402": { "serverUrl": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools from a wallet, with the key read from the environment (\`\${env:VAR}\`
interpolation is Windsurf's own):

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "\${env:AGENT_KEY}" }
    }
  }
}
\`\`\`

## Cline

MCP Servers icon in the top toolbar, Configure tab, then Configure MCP
Servers (the CLI reads \`~/.cline/mcp.json\`). Remote, free tier:

\`\`\`json
{
  "mcpServers": {
    "agent402": { "type": "streamableHttp", "url": "https://agent402.tools/mcp", "disabled": false, "autoApprove": [] }
  }
}
\`\`\`

Paid tools from a wallet:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "0x..." },
      "disabled": false,
      "autoApprove": []
    }
  }
}
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

Cline's own "OpenAI Compatible" provider also accepts a base URL, so the
models door works too: base URL \`http://127.0.0.1:8412/v1\` (the local wallet
proxy, above) with any placeholder API key, and a model id from
\`/v1/models\`. A credits key you already hold works with base URL
\`https://agent402.tools/v1/metered\` and the key as the API key.

## Roo Code

Settings icon in the Roo pane, then Edit Global MCP (\`mcp_settings.json\`) or
Edit Project MCP (\`.roo/mcp.json\`, which wins on a name clash). Remote,
free tier:

\`\`\`json
{
  "mcpServers": {
    "agent402": { "type": "streamable-http", "url": "https://agent402.tools/mcp", "alwaysAllow": [], "disabled": false }
  }
}
\`\`\`

Paid tools from a wallet:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "0x..." },
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

## OpenAI Codex CLI

One command for the free tier:

\`\`\`bash
codex mcp add agent402 --url https://agent402.tools/mcp
\`\`\`

Or in \`~/.codex/config.toml\`, paid tools from a wallet through the stdio server:

\`\`\`toml
[mcp_servers.agent402]
command = "npx"
args = ["-y", "agent402-mcp@0.13.31"]
env = { AGENT_KEY = "0x..." }
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

Codex as a model host, with a credits key you already hold (the local proxy
does not serve the Responses wire): its \`model_providers\` speak the Responses wire, and
the metered tier serves it at \`/v1/metered/responses\` (quoted per request
from the body, settled at actual usage for a credits key). In
\`~/.codex/config.toml\`:

\`\`\`toml
model_provider = "agent402"
model = "anthropic/claude-haiku-4.5"

[model_providers.agent402]
name = "Agent402 (metered)"
base_url = "https://agent402.tools/v1/metered"
env_key = "AGENT402_CREDITS_KEY"
wire_api = "responses"
\`\`\`

Then \`export AGENT402_CREDITS_KEY=a402_...\` and run \`codex\`. The route is
proven daily by the paid canary; a full Codex session against it has not yet
been run end to end, so if a turn is refused, the 400 body says exactly which
field (server tools and \`previous_response_id\` are not served).

## Gemini CLI

One command for the free tier:

\`\`\`bash
gemini mcp add --transport http agent402 https://agent402.tools/mcp
\`\`\`

Or in \`~/.gemini/settings.json\` (\`httpUrl\` is the Streamable HTTP key;
\`url\` means SSE), paid tools from a wallet through the stdio server:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp@0.13.31"],
      "env": { "AGENT_KEY": "0x..." }
    }
  }
}
\`\`\`

**Use a new wallet holding only a few dollars of USDC. Never your main wallet.**

## What the same wallet buys

The wallet (or credits key) that pays for chat pays for the rest: four wires on every
tier (OpenAI chat, OpenAI Responses, Anthropic Messages, Gemini generateContent), embeddings, rerank,
images, speech and transcription, 500+ tools, finished reports
and monitors, and a router that buys from other sellers and resells the
result, proven sellers first. Why pay here, with the proof links:
[agent402.tools/docs#why](https://agent402.tools/docs#why).
`,
  },
  {
    slug: "openclaw-model-provider",
    title: CREDITS_ON ? "Use Agent402 as your OpenClaw model provider - pay by card, no wallet" : "Use Agent402 as your OpenClaw model provider - pay per call",
    seoTitle: "Agent402 as your OpenClaw model provider",
    description:
      CREDITS_ON
        ? "Point OpenClaw at Agent402's OpenAI-compatible gateway with a prepaid credits key: one config block, auto-routed models at a flat per-call price, paid by card. Or pay per call in USDC from a wallet over x402."
        : "Point OpenClaw at Agent402's OpenAI-compatible gateway and pay per call in USDC from a wallet over x402: the agent402-openclaw plugin mints the wallet and writes the provider block. A credits key bought earlier still works in the plain config block.",
    md: `
[OpenClaw](https://openclaw.ai) talks to any OpenAI-compatible provider through
one block in \`openclaw.json\`. Agent402's LLM gateway is one of those. ${CREDITS_ON ? `It can be paid **by card**, through a prepaid credits key, so an agent
runs without a crypto wallet. USDC over x402 works too, if you'd rather.

## 1. Get a credits key (card, two minutes)

Buy a pack at [agent402.tools/credits](https://agent402.tools/credits) by card.
The key (\`a402_…\`) is shown once on the thanks page and emailed. It spends on
any paid route, including every gateway tier below, and
\`GET /api/credits/balance\` (Bearer) reports what is left.` : `New credits keys are not on sale, so the
plugin path in [Pay from a wallet](#pay-from-a-wallet-instead) below is the way
in: it mints a wallet you fund with USDC on Base. The plain config block in
this section is for a credits key (\`a402_…\`) bought earlier, which keeps
working; \`GET /api/credits/balance\` (Bearer) reports what is left.

## 1. Use a credits key you already hold`}

Put it in the environment OpenClaw runs in:

\`\`\`bash
export AGENT402_CREDITS_KEY=a402_…
\`\`\`

## 2. Add the provider

OpenClaw sends roughly 70k characters of system prompt and tool schemas before
your first word, so the model it talks to must accept that much input. The
routed \`auto\` tier caps input at ${TIERS["v1-chat-auto"].maxInputChars.toLocaleString("en-US")} characters and OpenClaw refuses it
as a context overflow before any call is made; the metered route
(\`${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}\`, at least ${TIERS["v1-chat-metered"].maxInputChars.toLocaleString("en-US")} characters and more on a model
with a larger context window, up to ${METERED_MAX_INPUT_CHARS_CEILING.toLocaleString("en-US")}, each model's cap read from
\`meteredMaxInputChars\` on GET /v1/models; each request is quoted from its body from
$${TIERS["v1-chat-metered"].price}) is the one to point OpenClaw at:

\`\`\`json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      model: { primary: "agent402/anthropic/claude-haiku-4.5" },
    },
  },
  models: {
    providers: {
      agent402: {
        baseUrl: "https://agent402.tools${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}",
        // OpenClaw resolves \${VAR} from the environment at runtime, so the key
        // never sits in this file.
        apiKey: "\${AGENT402_CREDITS_KEY}",
        api: "openai-completions",
        timeoutSeconds: 120,
        models: [
          {
            id: "anthropic/claude-haiku-4.5",
            name: "Claude Haiku 4.5 via Agent402 (metered, from $${TIERS["v1-chat-metered"].price}/call)",
            reasoning: false,
            input: ["text"],
            // Agent402 bills per call (the 402 quotes each request), not per token,
            // so OpenClaw's per-token cost display does not apply and stays at zero.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: ${Math.floor(TIERS["v1-chat-metered"].maxInputChars / 4)},
            maxTokens: ${TIERS["v1-chat-metered"].maxTokens},
          },
        ],
      },
    },
  },
}
\`\`\`

Restart the gateway (\`openclaw gateway restart\`). Every model call now goes to
\`${TIERS["v1-chat-metered"].route}\` with your credits key, paying what
that call costs (quoted from input plus \`max_tokens\`, capped at
$${METERED_MAX_QUOTE_USD} per call). Any id from
[\`/v1/models\`](https://agent402.tools/v1/models) can take Haiku's place.

## Explicit models and the other tiers

The gateway has ${FLAT_TIER_ROWS.length} flat chat tiers, each a fixed price per call, plus a metered route, \`${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}\`, that quotes each request from its body (from $${TIERS["v1-chat-metered"].price} per call):

${FLAT_TIER_TABLE}

To pin a model, add a second provider whose \`baseUrl\` is that tier's path and
whose \`models[]\` list ids from [\`/v1/models\`](https://agent402.tools/v1/models),
for example \`baseUrl: "https://agent402.tools/v1/premium"\` with
\`{ id: "openai/gpt-5" }\` and \`{ id: "anthropic/claude-opus-5" }\`. A model sent
to another flat tier's route is priced at its home tier: the 402 quotes that
tier's price, and the paid call is served under that tier's caps.

## Pay from a wallet instead

Every tier answers an x402 \`402\` (${RAILS_COUNT_MD}) and an MPP challenge, so any
x402-capable client can pay per call with no key at all. For OpenClaw the
[\`agent402-openclaw\`](https://www.npmjs.com/package/agent402-openclaw) plugin
runs a loopback proxy that pays and forwards, with a credits key or an x402
wallet, and writes the provider block for you. Explicit models go to the metered
route by default (each request quoted from its body, from
$${TIERS["v1-chat-metered"].price}); \`--flat\` keeps the flat tiers:

\`\`\`bash
openclaw plugins install agent402-openclaw
npx agent402-openclaw setup --write        # no key? it mints a wallet and prints the address to fund
openclaw gateway restart
\`\`\`

OpenClaw 2026.10.1 and later reserve the verified-source badge for plugins in
OpenClaw's own official inventory, so \`openclaw plugins doctor\` lists agent402
as a source it "can't verify" (\`reason=provenance-invalid\`), as it does every
community plugin. The plugin loads and serves as before: it registers a model
provider and a service, and uses no feature OpenClaw keeps for trusted plugins.

With no credits key and no \`AGENT402_WALLET_KEY\`, \`setup\` generates a wallet
into \`~/.openclaw/agent402/wallet.key\` (0600, never printed) and tells you the
address: send it USDC on Base and every call is paid from it over x402, from
$${TIERS["v1-chat-metered"].price} a call. \`agent402-openclaw wallet\` shows the
balance; \`--credits-key a402_...\` uses a credits key you already hold instead. Every forwarded
call carries an \`Idempotency-Key\`, so a retry replays the paid answer instead
of paying twice. The plain config block above needs no plugin and
stays the simplest path for a credits key.

## What you get that a plain router does not

The same key and the same base URL reach the rest of the catalog: 500+
tools (search, extract, render, PDF, EDGAR, openFDA, on-chain data), the [smart order router](https://agent402.tools/guides/smart-order-router)
that buys from other x402 sellers and resells the result, and receipts for every
call. Every price on this page is rendered from the live gateway configuration.

## What else the same key buys

The credits key (or the wallet) that pays for chat is the same one that pays
for everything else on the gateway and the catalog, with one 402 shape and one
receipt shape:

- **Four wires on every tier**: OpenAI chat, OpenAI Responses, Anthropic
  Messages and Gemini generateContent, plus streaming, embeddings, rerank, images, video, speech and
  transcription, and a grounded tier that cites the web on every answer.
- **500+ tools** over MCP or HTTP: web search, news, cited
  answers, browser render, market quotes, SEC filings, crypto and DeFi data,
  PDFs, OCR, DNS and TLS checks, a code sandbox, wallet-keyed memory.
- **Finished reports and monitors**: dossiers, insider flow, 13F holdings,
  domain audits, token risk, deep research, market briefs, a LinkedIn article
  package; monitors that re-run a report only when the facts change.
- **Routing that sources from other sellers**: \`POST /api/route/execute\` buys
  the result from the best-matching external seller for a task, proven sellers
  first, and sells it to you.

Why pay here, in one section with the proof links:
[agent402.tools/docs#why](https://agent402.tools/docs#why). The short version: usage is
priced under a ceiling you see before you pay, a failed x402 call is not charged and the
receipt shows it, a keyed retry never pays twice, and uptime and transactions are published from
outside production.
`,
  },
];

const GUIDE_INDEX_CSS = `
.gi-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.gi-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:10px;}
.gi-wrap h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;}
.gi-desc{font-size:var(--fs-base);line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.gi-list{display:flex;flex-direction:column;gap:20px;}
.gi-card{display:block;background:var(--card);border:1px solid var(--hairline);padding:24px 26px;text-decoration:none;transition:border-color .2s;}
.gi-card:hover{border-color:var(--accent);}
.gi-card h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-lg);line-height:1.15;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);}
.gi-card p{font-size:var(--fs-base);line-height:1.55;color:var(--muted);margin:0;}
@media(max-width:600px){.gi-wrap h1{font-size:var(--fs-3xl);}}
`;

const GUIDE_PAGE_CSS = `
.gp-wrap{max-width:760px;margin:0 auto;padding:56px 30px 48px;}
.gp-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:10px;}
.gp-wrap h1{font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);text-wrap:balance;}
@media(max-width:640px){.gp-wrap h1{font-size:var(--fs-2xl);line-height:1.1;}}
.gp-body{font-size:var(--fs-base);line-height:1.55;color:var(--muted);}
.gp-body h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);line-height:1.1;letter-spacing:-.02em;color:var(--ink);margin:32px 0 12px;}
.gp-body p{margin:0 0 16px;}
.gp-body ul,.gp-body ol{margin:0 0 16px;padding-left:24px;}
.gp-body li{margin-bottom:6px;}
.gp-body strong{color:var(--ink);}
.gp-body em{font-style:italic;}
.gp-body a{color:var(--accent);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px;}
.gp-body a:hover{text-decoration:underline;}
.gp-body code{font-family:var(--font-mono);font-size:var(--fs-sm);background:var(--card);border:1px solid var(--hairline);padding:2px 6px;}
.gp-body pre{background:var(--panel);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.55;padding:16px 20px;overflow-x:auto;margin:0 0 16px;border:1px solid var(--hairline);}
.gp-body pre code{background:none;border:none;padding:0;color:inherit;font-size:var(--fs-sm);}
.gp-tw{overflow-x:auto;margin:0 0 16px;}
.gp-back{display:inline-block;margin-top:28px;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);text-decoration:none;font-weight:700;}
.gp-back:hover{text-decoration:underline;}
`;

export function guidesIndex(baseUrl) {
  const title = "Guides: x402 payments, MPP, and memory for AI agents";
  const description = "Practical guides to the machine-to-machine economy: paying APIs with x402 or proof-of-work, and durable wallet-keyed memory for autonomous agents.";
  const canonical = `${baseUrl}/guides`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  };

  const items = GUIDES.map(
    (g) => `<a href="/guides/${esc(g.slug)}" class="gi-card">
        <h2>${esc(resolveRailCountTokens(g.title))}</h2>
        <p>${esc(resolveRailCountTokens(g.description))}</p>
      </a>`
  ).join("\n      ");

  const body = `<div class="gi-wrap">
  <section>
  <div class="gi-eyebrow">$ GET /guides</div>
  <h1>Guides</h1>
  <p class="gi-desc">Working code, no fluff - everything here runs against the live service.</p>
  </section>
  <section>
  <div class="gi-list">
      ${items}
  </div>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss: GUIDE_INDEX_CSS, body });
}

export function guidePage(baseUrl, slug, catalog = null) {
  const found = GUIDES.find((x) => x.slug === slug);
  if (!found) return null;
  const g = { ...found, title: resolveRailCountTokens(found.title), md: resolveGuideTokens(found.md, catalog), description: resolveGuideTokens(found.description, catalog) };

  const title = fitTitle([`${g.title} - Agent402`, g.seoTitle ? `${g.seoTitle} - Agent402` : "", g.seoTitle || g.title]);
  const canonical = `${baseUrl}/guides/${g.slug}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: g.title,
    description: g.description,
    url: canonical,
    image: `${baseUrl}/card.png`,
    author: siteOrgRef(baseUrl),
    publisher: siteOrgRef(baseUrl),
  };

  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], ["Guides", "/guides"], [g.title, `/guides/${g.slug}`]]);
  const body = `<div class="gp-wrap">
  ${crumbs.nav}
  <h1 title="${esc(g.title)}">${esc(g.title)}</h1>
  <div class="gp-body">
    ${marked.parse(g.md).replace(/<table>/g, '<div class="gp-tw"><table>').replace(/<\/table>/g, "</table></div>")}
  </div>
  ${integrationsBlock(g.slug)}
  <a href="/guides" class="gp-back">Back to guides</a>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description: g.description, canonical, baseUrl, activePath: "__none__", jsonLd: [jsonLd, crumbs.ld], extraCss: GUIDE_PAGE_CSS, body });
}

export const guideSlugs = () => GUIDES.map((g) => g.slug);
export const guideTitles = () => Object.fromEntries(GUIDES.map((g) => [g.slug, resolveRailCountTokens(g.title)]));

// The packages a reader of this guide will install next, each linking to its
// /integrations page (map derived in integration-pages.js).
function integrationsBlock(slug) {
  const list = (GUIDE_INTEGRATIONS[slug] || []).map(integrationBySlug).filter(Boolean);
  if (!list.length) return "";
  return `<div class="gp-body"><h2>Packages for this guide</h2><ul>${list.map((i) => `<li><a href="/integrations/${esc(i.slug)}">${esc(i.name)}</a> (<code>${esc(i.pkg)}</code>)</li>`).join("")}</ul></div>`;
}
