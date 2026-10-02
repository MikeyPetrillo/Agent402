# API Reference

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

All endpoints live at `https://agent402.tools` (hosted instance) or your self-hosted root. Discovery endpoints are free and unpaywalled. Tool endpoints require payment (x402, MPP, a prepaid credits key, or proof-of-work on the pure-CPU tools) unless `FREE_MODE=true`.

## Discovery endpoints

These are always free. No wallet, no PoW, no auth.

### `GET /api/find?q={task}&k={limit}`

Resolve a natural-language task description to the best matching tool(s). Lexical ranking against the full catalog.

```bash
curl 'https://agent402.tools/api/find?q=convert%20pdf%20to%20text&k=3'
```

Returns an **object**, not a bare array:

```json
{
  "query": "convert pdf to text",
  "count": 3,
  "results": [
    { "slug": "pdf-to-markdown", "name": "…", "route": "…", "price": "$0.010",
      "callExample": "…", "example": { }, "required": ["url"], "inputSchema": { },
      "category": "web", "description": "…", "score": 42,
      "computePayable": false, "docs": "https://agent402.tools/tools/pdf-to-markdown" }
  ],
  "packs": []
}
```

`results` holds the ranked tools; `count` is how many came back; `packs` holds any
matching [[Skill Pack|Skill-Packs]] for the same query, so a task-shaped question
can point at a whole workflow instead of one tool.

### `POST /api/route`

Cross-seller Smart Order Router. Ranks the tools that match a task across Agent402 and the x402 sellers it has indexed: candidates are shortlisted by how well they match the task, then ordered by crawl health, by distinct payers over the last 30 days and by price; each row's `why.tiebreaks` names the order applied. The response returns the top N and carries `matched` for how many scored.

```bash
curl -X POST https://agent402.tools/api/route \
  -H 'Content-Type: application/json' \
  -d '{"query":"screenshot webpage","top":3,"include":"external"}'
```

### `GET /api/pricing`

Full catalog: every tool with its price, category, input schema, and example input.

```bash
curl https://agent402.tools/api/pricing
```

### Other discovery surfaces

| Endpoint | Returns |
|---|---|
| `GET /openapi.json` | OpenAPI **3.1.0** spec for all tool endpoints |
| `GET /llms.txt` | Agent-oriented plain-text catalog description |
| `GET /.well-known/x402` | x402 service manifest (payment capabilities, networks, wallet) |
| `GET /.well-known/agent-card.json` | Our A2A AgentCard (also served at `/.well-known/agent.json`). Declares `HTTP+JSON`, not the spec's default `JSONRPC`, because that default implies a JSON-RPC endpoint we do not run |
| `GET /.well-known/agent-registration.json` | Our ERC-8004 registration file: agent **94639** in the identity registry at `eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, owned by the wallet our 402s name as payTo. Lists every way to reach us and declares `x402Support` |
| `GET /api/reliability` | Uptime and health report |
| `GET /api/stats` | Aggregate call counts, revenue, cache statistics |
| `GET /api/leaderboard?top={n}&include={all\|external}&sort={usd\|calls}` | On-chain ranking of x402 sellers by Base USDC volume (`limit` is an alias of `top`) |
| `GET /health` | Liveness probe. The **public** body is only `{ "ok": true, "meta": { "toolCount": <n>, "build": "<short sha>" } }`. Process uptime and the operating-mode flags are **operator-only** and appear on the authenticated response, not here |

## Tool invocation

Tools accept `GET` (query params) or `POST` (JSON body), depending on the tool. The catalog (`/api/pricing`, `/openapi.json`) specifies the method and schema for each.

### `GET /api/x402/seller-trust?origin={url}` ($0.005, paid)

Trust evidence for one x402 seller origin, so a buyer can vet a seller before
routing money to it. Returns whether the origin is indexed, whether its manifest
parses, how many tools it publishes, which chains it actually advertises, how
many settled calls it has been observed receiving on-chain, and whether the
Smart Order Router would spend buyer money there. The router's gate comes back
**field by field**, so a refusal is explainable.

It never fetches the seller at call time: this is accumulated crawl and
settlement evidence, not a liveness probe.

### `POST /api/seller-dossier` ($0.05, paid)

The same question, answered from everything we hold rather than the gate alone.
One origin in, and back comes identity and crawl history; the catalog with the
**provenance of every price** (read from a live 402 or from the manifest, when
it was read, whether it is stale, whether it disagrees with the seller's own
declaration); the wallets the origin advertises set against the wallets that
were actually paid, including evidence it inherits from a shared payTo and who
else claims that wallet; settlement evidence kept **per source** rather than
summed (our own Base leaderboard, the Bazaar's measurement labelled as theirs,
Solana SPL credits, MPP transfers); the router's dispatch verdict per chain with
its reason and any recent refusal; and what happened the times our router
actually paid it.

It ends in plain-English flags and deliberately carries **no score** - a number
reads as a verdict we did not measure. Like `seller-trust` it never fetches the
seller: it is the assembled record, which is why it is priced above the list
endpoints.

### `POST /api/seller-payability` ($0.10, paid)

The live counterpart to the two reads above: this one **spends real USDC from
our wallet** to find out whether a seller can actually be paid right now. It
reports the unpaid call's status, the 402 decoded (accepts, chains, payTo,
asset, price), whether the accept's EIP-712 domain name matches the token it
names (the defect that silently makes a whole catalog unpayable to every stock
client), whether a stock client's signed payment was accepted, the settlement
receipt and transaction, a slice of the response body, and how long each leg
took. Up to $0.02 of the seller's price per check. Point it at your own endpoint
before you launch.

### SQL execution certificates

`POST /api/sql-guard` ($0.004) reviews one SQL statement an agent is about to run
and returns a verdict (`pass` / `warn` / `block`) with the risks named; on `pass`
it also returns an Ed25519 certificate binding that verdict to the SHA-256 of the
exact statement. `POST /api/sql-cert-verify` ($0.001) is the gate your database
layer calls before it obeys the agent, checking the signature, the version, the
expiry, and that the statement hash matches. See [[Tool Catalog]] for the full
behavior and the honest scope of the check.

### Report products (`/v1`)

Outcome-priced reports on the same 402: `POST /v1/research` ($0.60; `/pro` $0.85, `/max` $1.10, `/market-brief` $0.85), `POST /v1/dossier` ($0.85; `/max` $1.10), `POST /v1/ticker-pack` ($2.00), `POST /v1/fund` ($0.60; `/max` $0.85), `POST /v1/filing-report` ($0.85), `POST /v1/domain-audit` ($0.60; `/pro` $0.85), `POST /v1/recall-report` ($0.60), `POST /v1/insider-report` ($0.60), `POST /v1/token-brief` ($0.60), `POST /v1/token-risk` ($0.60; `/pro` $0.85), `POST /v1/linkedin-article` ($1.10), `POST /v1/ipo-report` ($0.05, deterministic). JSON bodies and inputs are on [[Reports, Monitors and Credits|Reports-and-Monitors]]; all are wallet-only (x402 / MPP / prepaid credits), never proof-of-work, never cached.

### Card front door and credits

`/reports`, `/monitors` and `/credits` are HTML pages backed by Stripe Checkout (`POST /api/buy`, `POST /api/subscribe`, `POST /api/credits/checkout`; each answers `503` when the instance has no Stripe key, and the credits checkout also answers `503` while new credits are not on sale, which is the default unless the operator sets `CREDITS_SALES=on`; keys already issued keep working). Each report's card price is listed on `/reports` and each monitor's monthly price on `/monitors`: the card price includes payment processing, and an agent paying per call pays the lower tool price for the same report. A paid report renders at `/r/<session>`, a monitor report at `/m/<id>`. A prepaid credits key pays any priced catalog route with `Authorization: Bearer a402_…` (the response carries `X-Credits-Balance`; insufficient or unknown keys get `402` with `{ reason, balanceUsd, topup }`; identity-bound routes answer `402` `reason: "identity-bound"`), and `GET /api/credits/balance` with the same header returns the balance.

### OpenAI wire paths

Chat, embeddings, rerank, image and video generation, and text-to-speech are also served OpenAI-compatibly under `/v1` - `POST /v1/{nano,auto,pro,premium}/chat/completions`, `POST /v1/chat/completions`, `POST /v1/grounded/chat/completions`, `POST /v1/metered/chat/completions` (the 402 quotes each request from its body), the Anthropic Messages wire at `POST /v1/{nano,auto,pro,premium}/messages` and `POST /v1/messages`, the OpenAI Responses wire at `POST /v1/{nano,auto,pro,premium}/responses` and `POST /v1/responses`, `POST /v1/embeddings`, `POST /v1/rerank`, `POST /v1/images/generations`, `POST /v1/images/fast`, `POST /v1/images/pro`, `POST /v1/videos/generations`, `POST /v1/audio/speech`, with `GET /v1/models` free. See [[LLM Gateway (OpenAI /v1)|LLM-Gateway]] for tiers, the metered tier, the model-optional auto router, streaming, and caching. `POST /api/route/execute` (and its `execute-plus`, `execute-max`, `execute-pro` rungs) runs the resolver's top pick in one paid call, and `POST /api/my-usage` returns the paying wallet's own purchase history.

### GET example

```bash
curl 'https://agent402.tools/api/dns?name=example.com&type=A'
```

### POST example

```bash
curl -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello world"}'
```

### Response shape

Successful responses return `200` with a JSON body. The shape varies by tool but is documented in each tool's `inputSchema` / example in the catalog.

## Payment headers

### x402 flow (USDC)

1. Call a paid tool without payment.
2. Server responds `402` with a JSON body containing `x402Version`, `accepts` (array of payment options: price, network, asset, pay-to address).
3. Sign a USDC `transferWithAuthorization` from your wallet.
4. Retry the same request with the payment header (as specified by the x402 protocol).
5. The facilitator verifies and settles on-chain; the server returns the tool result.

```bash
# Step 1: see the quote
curl -i -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
# HTTP/2 402
# payment-required: eyJ4NDAyVmVyc2lvbiI6Mi... (base64 JSON, authoritative)
# {"altPayment":{...},"x402Version":2,"error":"Payment required","resource":{...},"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"1000",...}],"extensions":{...}}
```

See [[Paying with x402]] for full code examples in JavaScript and with Stripe's `purl`.

### Proof-of-work flow (free tier)

1. `GET /api/pow/challenge?slug={tool}` -- receive `{ challenge, difficulty, token, expiresAt }`.
2. Find a `nonce` such that `sha256(challenge + ":" + nonce)` has at least `difficulty` leading zero bits.
3. Retry the tool request with header `X-Pow-Solution: {token}:{nonce}`.

```bash
# Get challenge
curl 'https://agent402.tools/api/pow/challenge?slug=hash'

# After solving, call the tool
curl -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' \
  -H 'X-Pow-Solution: TOKEN:NONCE' \
  -d '{"text":"hello"}'
```

Challenges are single-use, short-lived, and scoped to exactly one slug. See [[Paying with Compute]] for a reference solver.

## Idempotency

Send an `Idempotency-Key` header to enable idempotent requests. If the same key is seen again for the same method, path, payment credential and request body, the server replays the cached result without re-charging.

```bash
curl -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-unique-key-123' \
  -H 'X-Pow-Solution: TOKEN:NONCE' \
  -d '{"text":"hello"}'
```

Cache key formula: `sha256(METHOD + path + Idempotency-Key + gate-credential + sha256(body))`. Without the header, every request is treated as unique.

The cache is **settlement-aware**: a response body is captured when the handler produces it but is only committed to the cache once the *final* status is `200`, i.e. after settlement succeeded. A `200` whose settlement then failed (and therefore became a `402`) is never cached and never replayed. Streamed responses are never replayable.

## Rate limits

| Surface | Limit | Notes |
|---|---|---|
| PoW tier | Natural (CPU cost per challenge) | 150+ pure-CPU tools only; difficulty 16 = ~65k hashes |
| MCP connector (`/mcp`) | 20/min, 120/hr per IP | Free pure-CPU set via `catalog.call`; override with `AGENT402_MCP_MAX_PER_MIN/HOUR`. Wallet-only tools are payable in the call over MPP |
| Card endpoints (`/api/buy`, `/api/subscribe`, `/api/credits/checkout`, session reads) | per-IP | Each makes an outbound Stripe call, so they are capped and unknown session ids are negatively cached |

## Error format

All errors return a JSON body with an `error` string field.

```json
{ "error": "description of what went wrong" }
```

### Status codes

| Code | Meaning |
|---|---|
| `400` | Bad request -- missing or invalid input parameters |
| `402` | Payment required -- x402 quote in the `payment-required` header, mirrored as the same object in the JSON body (MPP challenges in `WWW-Authenticate: Payment`); for a prepaid credits key, a JSON body with `reason` (`insufficient`, `unknown`, `disabled`, `identity-bound`) and `topup` |
| `404` | Tool not found |
| `409` | Conflict -- the request cannot be served as asked, and the body says how to fix it. Two cases: an execution tier too small for the resolved tool (retry on the rung named in the error, or call the tool directly), and external routing on a chain with no spending wallet (the error names the chains that are supported) |
| `413` | Payload too large -- for the memory tools, the namespace quota is full: either the per-namespace key count (`MEMORY_MAX_NS_KEYS`, default 10,000) or the total-value byte budget (`MEMORY_MAX_NS_BYTES`, default 32 MB). Delete keys or shrink values |
| `422` | Unprocessable -- the payment itself is structurally unusable. On Algorand, a signed transaction whose validity window cannot outlive the tool is rejected *before* the handler runs, so a dead transaction is never started. Re-sign with a longer validity window |
| `429` | Rate limited -- retry after the `Retry-After` header value |
| `500` | Internal server error |
| `502` | Bad gateway -- upstream dependency failed |
| `503` | Service unavailable -- upstream temporarily unreachable, or an optional integration is unconfigured on this instance |
| `504` | Gateway timeout -- upstream timed out |

Handlers throw errors with `.statusCode` set; the server maps these to the appropriate HTTP response.

**Every code in the `4xx`/`5xx` rows above cancels settlement**, so none of them charge you. Only a `200` that then settles successfully is billed. See [[Architecture]] for the ordering.

## See also

- [[Tool Catalog]] -- what the 500+ tools are and how agents discover them
- [[Paying with x402]] -- USDC payment flow with code examples
- [[Paying with Compute]] -- proof-of-work protocol and reference solver
- [[MCP Connector]] -- hosted connector and the `agent402-mcp` npm server
- [[Self-Hosting]] -- deploying on your own infrastructure
