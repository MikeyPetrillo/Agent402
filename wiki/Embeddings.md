# Text Embeddings

Two tiers of text embedding generation, paywalled via x402. Send text, get back a vector for semantic search, RAG, clustering, or similarity. The operator's `OPENAI_API_KEY` handles upstream auth.

## Tiers

| Endpoint | Price | Model | Dimensions | Text cap |
|---|---|---|---|---|
| `POST /api/embed` | $0.005 | `text-embedding-3-small` | 1,536 | 32,000 chars |
| `POST /api/embed-large` | $0.01 | `text-embedding-3-large` | 3,072 | 32,000 chars |

Both tiers are **wallet-only** — every call burns real upstream embedding credit. See [[Security Model]].

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

- **embed** ($0.005) — good enough for most RAG, search, and clustering. 1,536 dimensions.
- **embed-large** ($0.01) — higher accuracy for precision-critical applications. 3,072 dimensions.

## See also

- [[LLM Proxy Gateway|LLM-Proxy]] — text inference
- [[Paying with x402]] — the USDC payment flow
