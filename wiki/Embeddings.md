# Text Embeddings

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

> **Looking for the OpenAI wire path?** `POST /v1/embeddings` ($0.002) speaks the standard OpenAI embeddings format - batch up to 64 inputs / 16k chars per request, `dimensions` and `encoding_format` pass through, and byte-identical repeats within 10 minutes are served **free** (except a Tempo transfer you send before the call, which is final when sent) automatically (embeddings are deterministic; opt out with `cache: false`). See [[LLM Gateway (OpenAI /v1)|LLM-Gateway]]. The `/api/embed*` tools below remain available as the simpler custom-JSON shape.

Two tiers of text embedding generation, paywalled via x402. Send text, get back a vector for semantic search, RAG, clustering, or similarity. The operator's `OPENAI_API_KEY` handles upstream auth.

## Tiers

| Endpoint | Price | Model | Dimensions | Text cap |
|---|---|---|---|---|
| `POST /api/embed` | $0.002 | `text-embedding-3-small` | 1,536 | 32,000 chars |
| `POST /api/embed-large` | $0.01 | `text-embedding-3-large` | 3,072 | 32,000 chars |

Both tiers are **wallet-only** - every call burns real upstream embedding credit. See [[Security Model]].

## Request / Response

```json
// Request
{ "text": "Agent402 is an open-source x402 tool server." }

// Response
{ "model": "text-embedding-3-small", "provider": "openai",
  "embedding": [0.0023, -0.0091, 0.0152, ...],
  "dimensions": 1536,
  "usage": { "total_tokens": 12 } }
```

## When to use which tier

- **embed** ($0.002) - good enough for most RAG, search, and clustering. 1,536 dimensions.
- **embed-large** ($0.01) - higher accuracy for precision-critical applications. 3,072 dimensions.

## See also

- [[LLM Proxy Gateway|LLM-Proxy]] - text inference
- [[Paying with x402]] - the USDC payment flow
