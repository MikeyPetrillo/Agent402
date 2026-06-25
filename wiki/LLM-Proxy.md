# LLM Proxy Gateway

Three tiers of OpenAI inference, paywalled via x402. An agent sends a standard `chat/completions` request and pays per call with USDC on Base -- no OpenAI API key needed on the caller's side, no signup, no account. The operator's own `OPENAI_API_KEY` handles upstream auth; per-tier input and output caps keep worst-case upstream cost well below the x402 price.

## Tiers

| Endpoint | Price | Models | Input cap | Output cap |
|---|---|---|---|---|
| `POST /api/llm` | $0.01 | `gpt-4o-mini` | 16k chars | 4,096 tokens |
| `POST /api/llm-pro` | $0.10 | `gpt-4o`, `gpt-4.1` | 16k chars | 2,048 tokens |
| `POST /api/llm-premium` | $0.50 | `o3-mini` (reasoning) | 32k chars | 2,048 tokens |

All three tiers are **wallet-only** -- there is no proof-of-work free tier because every call burns real upstream inference credit. See [[Security Model]] for the wallet-only rationale.

## Request format

Every tier accepts the same OpenAI-shaped JSON body:

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are a concise assistant." },
    { "role": "user", "content": "Summarize x402 in two sentences." }
  ],
  "max_tokens": 256,
  "temperature": 0.7,
  "top_p": 1,
  "stop": "\n"
}
```

| Field | Required | Notes |
|---|---|---|
| `model` | yes | Must match the tier (e.g. `gpt-4o-mini` for `/api/llm`) |
| `messages` | yes | Array of `{role, content}` objects; max 50 messages |
| `max_tokens` | no | Default 1,024; silently clamped to the tier's output cap |
| `temperature` | no | 0--2; controls randomness |
| `top_p` | no | 0--1; nucleus sampling |
| `stop` | no | Stop sequence(s) |

## Response format

Every tier returns the same OpenAI-shaped envelope:

```json
{
  "model": "gpt-4o-mini-2025-07-18",
  "provider": "openai",
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 31,
    "total_tokens": 55
  },
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "x402 is an open HTTP payment standard that uses the 402 status code to let servers charge per request, settled on-chain in USDC. Buyers need only a wallet -- no API key, no account."
      },
      "finish_reason": "stop"
    }
  ]
}
```

## Curl examples

### Basic tier ($0.01 -- GPT-4o-mini)

```bash
curl -X POST https://agent402.tools/api/llm \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "max_tokens": 64
  }'
```

### Pro tier ($0.10 -- GPT-4o / GPT-4.1)

```bash
curl -X POST https://agent402.tools/api/llm-pro \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Explain proof-of-work in three sentences."}],
    "max_tokens": 256
  }'
```

### Premium tier ($0.50 -- o3-mini reasoning)

```bash
curl -X POST https://agent402.tools/api/llm-premium \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "o3-mini",
    "messages": [{"role": "user", "content": "What are the trade-offs of on-chain vs off-chain settlement?"}],
    "max_tokens": 512
  }'
```

All three return `402` without a valid x402 payment header -- the same flow as every other paid tool. See [[Paying with x402]] for how to sign and attach payment.

## Operator caps that protect margins

The per-tier caps are set so that the worst-case upstream OpenAI cost stays comfortably below the x402 price charged to the caller:

- **Input cap** (chars) limits how much prompt text the caller can send, bounding prompt-token cost.
- **Output cap** (tokens) hard-limits `max_completion_tokens` sent to OpenAI, bounding completion-token cost.
- **Model allowlist** per tier prevents a caller from requesting a more expensive model than the tier's price covers (e.g. sending `gpt-4o` to the $0.01 endpoint returns `400`).
- **Message count** is capped at 50 per request.

These caps are enforced server-side before the upstream call is made -- a misconfigured client cannot cause the operator to lose money.

## Environment gating

The kit reads `OPENAI_API_KEY` at call time, not at boot. If the key is missing or empty, calls return `503 Service Unavailable` and the rest of the server continues running normally. Self-hosters who don't want to offer LLM proxy simply omit the env var -- no code change needed.

## See also

- [[Paying with x402]] -- the USDC payment flow these endpoints require
- [[Security Model]] -- why these tools are wallet-only (no PoW free tier)
- [[API Reference|API-Reference]] -- full HTTP endpoint reference
- [[Tool Catalog]] -- where these three tools sit in the 1,338-tool catalog
