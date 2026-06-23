# API Reference

All endpoints live at `https://agent402.tools` (hosted instance) or your self-hosted root. Discovery endpoints are free and unpaywalled. Tool endpoints require payment (x402 or proof-of-work) unless `FREE_MODE=true`.

## Discovery endpoints

These are always free. No wallet, no PoW, no auth.

### `GET /api/find?q={task}&k={limit}`

Resolve a natural-language task description to the best matching tool(s). Lexical ranking against the full catalog.

```bash
curl 'https://agent402.tools/api/find?q=convert%20pdf%20to%20text&k=3'
```

Returns an array of matching tool objects with `slug`, `name`, `description`, `price`, `route`, and `inputSchema`.

### `POST /api/route`

Cross-seller Smart Order Router. Finds the cheapest healthy tool for a task across Agent402 and every x402 seller crawled from the Coinbase CDP Bazaar.

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
| `GET /openapi.json` | OpenAPI 3.0 spec for all tool endpoints |
| `GET /llms.txt` | Agent-oriented plain-text catalog description |
| `GET /.well-known/x402` | x402 service manifest (payment capabilities, networks, wallet) |
| `GET /api/reliability` | Uptime and health report |
| `GET /api/stats` | Aggregate call counts, revenue, cache statistics |
| `GET /api/leaderboard?top={n}` | On-chain ranking of x402 sellers by Base USDC volume |
| `GET /health` | Server health check with uptime and feature flags |

## Tool invocation

Tools accept `GET` (query params) or `POST` (JSON body), depending on the tool. The catalog (`/api/pricing`, `/openapi.json`) specifies the method and schema for each.

### GET example

```bash
curl 'https://agent402.tools/api/convert/kilometers-to-miles?value=42'
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
# {"x402Version":2,"accepts":[{"price":"1000","network":"eip155:8453",...}]}
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

Send an `Idempotency-Key` header to enable idempotent requests. If the same key is seen again for the same method, path, and payment credential, the server replays the cached result without re-charging.

```bash
curl -X POST https://agent402.tools/api/hash \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-unique-key-123' \
  -H 'X-Pow-Solution: TOKEN:NONCE' \
  -d '{"text":"hello"}'
```

Cache key formula: `sha256(METHOD + path + Idempotency-Key + gate-credential)`. Without the header, every request is treated as unique.

## Rate limits

| Surface | Limit | Notes |
|---|---|---|
| PoW tier | Natural (CPU cost per challenge) | ~1,100 pure-CPU tools only; difficulty 16 = ~65k hashes |
| MCP connector (`/mcp`) | 20/min, 120/hr per IP | Pure-CPU set only; override with `AGENT402_MCP_MAX_PER_MIN/HOUR` |
| Marketplace bridge (`/mkt/`) | Global rate cap + per-slug token auth | Leaked URL exposes only its one tool |

## Error format

All errors return a JSON body with an `error` string field.

```json
{ "error": "description of what went wrong" }
```

### Status codes

| Code | Meaning |
|---|---|
| `400` | Bad request -- missing or invalid input parameters |
| `402` | Payment required -- x402 quote included in body |
| `404` | Tool not found |
| `429` | Rate limited -- retry after the `Retry-After` header value |
| `500` | Internal server error |
| `502` | Bad gateway -- upstream dependency failed |
| `503` | Service unavailable -- upstream temporarily unreachable |
| `504` | Gateway timeout -- upstream timed out |

Handlers throw errors with `.statusCode` set; the server maps these to the appropriate HTTP response.

## See also

- [[Tool Catalog]] -- what the 1,323 tools are and how agents discover them
- [[Paying with x402]] -- USDC payment flow with code examples
- [[Paying with Compute]] -- proof-of-work protocol and reference solver
- [[MCP Connector]] -- hosted connector and the `agent402-mcp` npm server
- [[Self-Hosting]] -- deploying on your own infrastructure
