# agent402-client

A tiny buyer-side client for [Agent402](https://agent402.tools) (and any Agent402
instance) - the buy side of [Agentic Finance](https://agent402.tools/agentic-finance),
agents paying per request over x402 or MPP. **Resolve a task to a tool, then call it - with payment handled for
you.** Free pure-CPU tools settle with a built-in proof-of-work (no wallet, zero
dependencies); wallet-only tools settle via an x402- or MPP-wrapped fetch you
provide, or by card through a prepaid credits key. Results are cached, and every
send carries an `Idempotency-Key` that is stable per client and per operation, so
a retried lost response replays the paid answer on the credits and proof-of-work
paths (the wallet path is different: see "Retries and double charges").

```bash
npm install agent402-client
```

Runnable copy of the free-tier quickstart below: [`examples/hello-agent402.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/examples/hello-agent402.js) - discover a tool and call it in ~15 lines, no wallet.

## Free tier (proof-of-work, no wallet)

```js
import { Agent402 } from "agent402-client";

const a = new Agent402();                       // → https://agent402.tools

// Don't know the slug? Resolve a task in one call.
const matches = await a.find("extract the article from a url");
// → [{ slug: "extract", route, price, inputSchema, example, ... }]

// Call it - proof-of-work is solved automatically for free tools.
const out = await a.call("hash", { text: "hello world", algo: "sha256" });
console.log(out.hex);
```

## Paid tools: x402 or MPP, your choice of wire

Wallet-only tools settle in USDC. The SDK never touches your key: pass a
payment-aware `fetch` and it pays 402s for you. Two wires work out of the box,
because every paid route on Agent402 carries both offers on the same 402:

**Over MPP** (Machine Payments Protocol) with the [`mppx`](https://www.npmjs.com/package/mppx) client - USDC on Base/Celo (`evm`), or natively on Tempo (`tempo`):

```js
import { Fetch, evm, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppFetch = Fetch.from({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const a = new Agent402({ fetch: mppFetch, maxPerCallUsd: 0.05 });
const verdict = await a.call("sql-guard", { sql: "UPDATE users SET plan = 'pro' WHERE id = 42" });
```

The SDK's spending caps, reservations and caching apply identically on the MPP
path (pinned by `scripts/test-client-mpp.js` in the parent repo, which buys
through the SDK with a real mppx client).

**Over x402** with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) - USDC on any of the 12 x402 chains:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const a = new Agent402({ fetch: payFetch });
const article = await a.call("extract", { url: "https://example.com/article" });
```

## Pay by card instead of a wallet (prepaid credits)

Buy a credits pack ($20 / $50 / $100) at https://agent402.tools/credits, claim the
`a402_...` key once, and pass it as `creditsKey`. The SDK then sends
`Authorization: Bearer a402_...` on wallet-only calls; the server authorizes
against the key's balance before the handler runs and debits the list price only
on a successful (200) response (the `X-Credits-Balance` header carries what is
left; credits never expire). A refused call throws with the balance and a top-up
link; nothing is debited.

```js
const client = new Agent402({ creditsKey: "a402_..." });
await client.call("whois", { domain: "example.com" }); // debited per successful call
```

The same `maxPerCallUsd` / `dailyLimitUsd` / `maxPerHostUsd` caps apply (a
credits call reserves its price like a wallet call). A payment `fetch` still wins
when both are given, and free pure-CPU tools keep settling with proof-of-work.
The same Bearer header also reads the balance directly, e.g. `curl -H "Authorization: Bearer a402_..." https://agent402.tools/api/credits/balance`.

## Retries and double charges

Every send carries an `Idempotency-Key`. By default it is derived from the
client instance plus the operation (slug, params, output validator), so it is
the same key when the SDK retries inside one `call()` AND when your framework
calls `client.call(slug, params)` again after a timeout or a dropped connection.
With `{ cache: false }` on the call, identical calls are treated as distinct
purchases and the key is fresh per invocation. Pass `idempotencyKey` yourself to
override either behavior. Keys are scoped to the client instance: two processes
buying the same thing are two purchases.

What the server does with it depends on how the call was paid:

- **Prepaid credits and proof-of-work:** the server binds the key to the credits
  key (or the accepted solution) plus the route and body, and replays the
  original 200 for ten minutes. A retry of a lost response is not debited again.
- **x402 wallet:** the server binds the key to the exact signed authorization.
  An exact retry (same signed header, same key) replays without a second
  settlement, and that is what the `payment-identifier` extension gives a stock
  x402 client. A fresh `call()` through an `@x402/fetch`-wrapped fetch signs a
  fresh authorization, which the server deliberately treats as a new payment
  (a client-chosen id on an unverified payload is never a cross-authorization
  dedupe). So on the wallet path a retry after a lost response can settle twice;
  the `Idempotency-Key` cannot prevent that on its own. If that matters for your
  workload, use a credits key for the tools you retry, or keep the signed
  request and resend it yourself.

## Workflows (skill packs)

For jobs that no single tool covers - e.g. "audit a domain", "build a stock
brief" - Agent402 ships curated multi-tool **skill packs**: 5-7 catalog tools
composed into a Claude-ready task template. Discover them the same way you'd
discover a tool:

```js
const packs = await a.findWorkflows("security audit");
// → [{ slug: "security-audit", title, tagline, toolSlugs, score, url, promptName }]

// Render the full prompt with arguments substituted in (same output as MCP prompts/get).
const { messages } = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
// → feed messages straight to any LLM
```

## Cross-seller routing (neutral Smart Order Router)

`find()` searches **this host's catalog only**. To rank tools across eligible
routable seller rows in the host's **current index** (not complete ecosystem
coverage), use `route()` - free, read-only, no wallet:

```js
const task = "screenshot webpage";
const { query, include, results } = await a.route(task, {
  k: 5,
  include: "external",   // all | external | local
  network: "robinhood",  // optional chain filter (short name or CAIP-2)
});
// results[]: opaque server rows - { seller, slug, url, priceUsd, routerDispatchEligible, routerDispatchReason,
//            executeVia? (only when executeViaCallableNow is true) | executeViaWhenEligible?, ... }

// executeVia quotes which route-execute* tier fits a row's underlying price.
// It does NOT bind that row: the tier re-resolves an eligible match under its
// cap at execution time (url, route, seller, and identity can differ).
const hint = results[0]?.executeVia;
if (hint?.tool) {
  const { result, receipt } = await a.call(hint.tool, {
    task: query,
    include,
    params: { url: "https://example.com" },  // inputs the chosen operation needs
  }, { cache: false });  // routed externals can be dynamic; client cache is on by default
}
```

`executeVia` is server-reported metadata only. The SDK passes discovery rows
through unchanged, does not validate seller output, and does not guarantee
which seller or tool the execution tier will pick.

## Discover the live x402 economy

Want to see who's actually getting paid on x402 right now - not just what tools
this service exposes? `topSellers()` returns the live leaderboard of sellers
settling USDC (primarily on Base) in the last ~24h, derived from on-chain transfers. Free
to call (no payment, no proof-of-work):

```js
const { window, asOf, results, totalSellers } = await a.topSellers({ limit: 10 });
// → { window: "24h", asOf, totalSellers, results: [{ rank, name, wallet, totalUsd, callsSettled, uniqueBuyers, ... }] }

// Rank by call volume instead of USDC, and include the host's own wallet:
await a.topSellers({ sort: "calls", include: "all" });
```

## API

| Method | What |
|---|---|
| `new Agent402({ baseUrl?, fetch?, creditsKey?, cache?, fetchImpl?, maxPerCallUsd?, dailyLimitUsd?, maxPerHostUsd?, maxResponseBytes?, outputValidator? })` | `fetch` is your x402- or MPP-wrapped fetch for paid tools (optional); `creditsKey` is a prepaid card-credits key (`a402_...`) used for paid tools when no `fetch` is given; `cache` (default `true`) memoizes deterministic results; the three USD caps set optional spending limits (see below); `maxResponseBytes` (default 32MB, `null` to disable) refuses an oversized response body before it is parsed; `outputValidator` binds a caller-supplied delivery check |
| `await a.find(task, { k = 5 })` | Resolve a plain-language task to the best-matching tools on **this host** (route, price, schema, example) |
| `await a.route(task, { k?, include?, network? })` | Cross-seller Smart Order Router: rank eligible/routable seller rows from the host's current index (free, read-only; opaque results may include server-reported `executeVia`) |
| `await a.findWorkflows(task, { k = 2 })` | Resolve a task to matching multi-tool workflow templates (skill packs) |
| `await a.getWorkflowPrompt(slug, args)` | Fetch the rendered prompt messages for a skill pack with arguments substituted in |
| `await a.topSellers({ limit?, sort?, include? })` | Live x402 leaderboard: which sellers are settling the most USDC (primarily on Base) in the last ~24h (free, no payment) |
| `await a.call(slug, params, { idempotencyKey?, cache?, maxResponseBytes?, outputValidator? })` | Call a tool; auto-pays (PoW for free tools; your payment `fetch` or the credits key for wallet-only); returns the JSON result |
| `Agent402.solvePow(pow)` | Solve a proof-of-work challenge object → an `X-Pow-Solution` value |
| `a.spendingSummary()` | Rolling-24h paid spend so far: `{ dailyUsd, calls, byHost, limits }` |
| `a.clearCache()` | Drop the in-memory result cache |

## Response size ceiling

You are calling strangers and paying them, and the seller chooses the response.
By the time `r.json()` resolves, a multi-gigabyte body is already in your
agent's memory, so this is one of the few checks that cannot be done after the
fact in your own code.

Every call is capped at 32MB by default. The declared `content-length` is
refused before a byte is read, and the stream is counted as it arrives, because
`content-length` is the seller's claim about their own body.

```js
const a = new Agent402({ maxResponseBytes: 1_000_000 });   // 1MB everywhere
await a.call("hash", { text: "x" }, { maxResponseBytes: null });  // or per call
```

An oversized body throws `ResponseTooLargeError` carrying `size`, `cap`,
`source` and `paid`. Check `paid`: on a wallet-only tool the money moved before
the body arrived, so a refused response is still a spend you made.

## Buyer-owned output validation

A successful payment and HTTP 200 do not prove that the delivered result is
useful. Supply a stable contract id and a local callback to enforce the exact
output your agent needs:

```js
const a = new Agent402({
  fetch: payFetch,
  outputValidator: {
    id: "unemployment-result/v1",
    validate: (body) =>
      typeof body.current === "number" &&
      Array.isArray(body.history) &&
      typeof body.source === "string",
  },
});
```

`validate` may return `false` or throw to reject delivery, and may be async.
Use any local validator you prefer: Ajv, Zod, agent-payment-policy, or ordinary
application code. The client adds no dependency and never sends the validator
or its id to the seller.

Validation runs after bounded JSON parsing and before cache admission. A
rejected paid response throws `OutputValidationError` with `paid: true`, stays
in `spendingSummary()`, and is never cached. Contracted cache entries are
namespaced by a SHA-256 digest of `id` and revalidated on every hit, so a
different contract or a caller-mutated cached object cannot bypass the check.
The caller owns the meaning and stability of `id`; changing validation
semantics requires a new id. A per-call validator may replace the constructor
validator, but `null` or omission preserves the constructor policy rather than
silently weakening it. Use a separate client when a route intentionally has no
output contract.

**Two costs worth knowing.** `validate` is awaited inside `call()`, so it is
bounded: a validator that has not settled in **5 seconds** rejects delivery with
`OutputValidationError` rather than hanging the call. On a paid route the money
has already moved by then, so an indefinite hang would be the worst place to
have one; a timeout is a rejection, because an unfinished contract is not a
satisfied one. Override per validator with `timeoutMs`:

```js
outputValidator: { id: "big-schema/v1", validate: slowCheck, timeoutMs: 30_000 }
```

And because contracted cache entries are revalidated on **every** hit, an
expensive validator is paid for on cache hits too, not just on the network call.
Keep it cheap, or accept that cost knowingly.

## Spending caps (never overpay)

By default the client pays whatever a tool costs. Set optional hard ceilings and a
call that would exceed one is **refused before any payment is signed** (it throws
`SpendingLimitError` - no funds move):

```js
import { Agent402, SpendingLimitError } from "agent402-client";

const a = new Agent402({
  fetch: payFetch,
  maxPerCallUsd: 0.05,   // reject any single call priced above $0.05
  dailyLimitUsd: 5,      // rolling-24h ceiling across all sellers
  maxPerHostUsd: 1,      // rolling-24h ceiling per seller host
});

try {
  await a.call("some-expensive-tool", { ... });
} catch (e) {
  if (e instanceof SpendingLimitError) console.log(e.limit, e.priceUsd, e.cap);
}
```

Only **settled** paid calls count against the rolling window. A call refused or
failed before settlement never consumes budget. A paid HTTP-success response
that later fails byte, JSON, or output validation remains settled spend. Free
proof-of-work calls are never counted. Omit a cap (or leave it `null`) for no
limit; with none set, behavior is unchanged.

**What the caps check.** When a cap is set, the client preflights the `402` and
checks the ceiling against the **larger** of the advertised price (from the
seller's `/api/pricing`) and the amount the `402` challenge actually quotes - so a
server that under-advertises and then quotes more in the `402` is refused *before*
your wallet fetch signs anything. If the `402` can't be read (FREE_MODE, or an
unrecognized challenge shape) it falls back to the advertised price rather than
block a legitimate payment. Caps hold under **concurrency** too: each call reserves
its amount synchronously, so N simultaneous calls can't each pass against the same
pre-commit total. (The `402` amount is derived assuming stablecoin settlement -
`atomic / 10^decimals ≈ USD` - which matches x402's USDC/USDG rails.)

- **Zero dependencies** for the free/proof-of-work path (uses `node:crypto`).
- **Non-custodial:** paid settlement is your `@x402/fetch` / `mppx` fetch + wallet (or a prepaid credits key you bought); this client never sees a private key.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).

## Pick the settlement chain (`withNetworkPreference`)

Multi-chain sellers list Base first, so an unmodified x402 client effectively
always settles there. To pin a chain - e.g. **USDG on Robinhood Chain** -
wrap your client before building the fetch:

```js
import { withNetworkPreference } from "agent402-client";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
registerExactEvmScheme(client, { signer });
withNetworkPreference(client, ["robinhood"]);   // or ["base","solana"], or ["eip155:4663"]
const payFetch = wrapFetchWithPayment(fetch, client);
```

Short names map to CAIP-2 (`base`, `solana`, `polygon`, `arbitrum`,
`robinhood`); unknown entries pass through verbatim so future chains work
without a package update. If the preference matches none of a seller's
payment options it throws **before** any payment is signed.


## Only pay who you meant to (`withPayeeAllowlist`)

The buyer-side mirror of a spend control: bound WHO gets paid, not just how
much. Wrap your x402 client before `wrapFetchWithPayment` and any 402 whose
`accepts` would send funds to an address outside the list is refused before a
signature exists (a routed or redirected seller can never collect).

```js
import { withPayeeAllowlist } from "agent402-client";
withPayeeAllowlist(client, ["0xYourSellerPayTo", "0xAnother"]);   // 0x addresses compare case-insensitively
const payFetch = wrapFetchWithPayment(fetch, client);
```

Pairs with `maxPerCallUsd` / `dailyLimitUsd` (how much) and
`withNetworkPreference` (which chain).

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.
