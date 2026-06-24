# Image Generation Gateway

Three tiers of text-to-image generation, paywalled via x402. An agent sends a prompt and pays per call with USDC on Base -- no OpenAI API key needed on the caller's side, no signup, no account. The operator's own `OPENAI_API_KEY` handles upstream auth; per-tier prompt caps and locked quality/size settings keep worst-case upstream cost well below the x402 price.

## Tiers

| Endpoint | Price | Model | Quality | Size | Prompt cap |
|---|---|---|---|---|---|
| `POST /api/image-gen` | $0.03 | `gpt-image-1-mini` | low | 1024x1024 | 1,000 chars |
| `POST /api/image-gen-hd` | $0.10 | `gpt-image-1-mini` | medium | 1024x1024 | 2,000 chars |
| `POST /api/image-gen-premium` | $0.30 | `gpt-image-2` | medium | 1024x1024 | 4,000 chars |

All three tiers are **wallet-only** -- there is no proof-of-work free tier because every call burns real upstream inference credit. See [[Security Model]] for the wallet-only rationale.

## Request format

Every tier accepts the same JSON body:

```json
{
  "prompt": "A photorealistic red apple on a white background, studio lighting"
}
```

| Field | Required | Notes |
|---|---|---|
| `prompt` | yes | Text description of the desired image; max length varies by tier |

## Response format

Every tier returns the same envelope:

```json
{
  "model": "gpt-image-1-mini",
  "provider": "openai",
  "quality": "low",
  "size": "1024x1024",
  "image": "<base64-encoded PNG>",
  "revised_prompt": "A photorealistic red apple on a white background, studio lighting"
}
```

| Field | Description |
|---|---|
| `model` | The model that generated the image |
| `provider` | Always `openai` |
| `quality` | The quality setting used (`low` or `medium`) |
| `size` | The image dimensions |
| `image` | Base64-encoded PNG image data |
| `revised_prompt` | The prompt as interpreted by the model (may differ from input) |

## Curl examples

### Standard tier ($0.03 -- GPT Image mini, low quality)

```bash
curl -X POST https://agent402.tools/api/image-gen \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "A single red apple on a white background"
  }'
```

### HD tier ($0.10 -- GPT Image mini, medium quality)

```bash
curl -X POST https://agent402.tools/api/image-gen-hd \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "A detailed watercolor painting of a mountain village at sunset"
  }'
```

### Premium tier ($0.30 -- GPT Image 2, medium quality)

```bash
curl -X POST https://agent402.tools/api/image-gen-premium \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "An isometric 3D render of a futuristic city block with neon signs and flying cars, cyberpunk aesthetic"
  }'
```

All three return `402` without a valid x402 payment header -- the same flow as every other paid tool. See [[Paying with x402]] for how to sign and attach payment.

## Operator caps that protect margins

The per-tier caps are set so that the worst-case upstream OpenAI cost stays comfortably below the x402 price charged to the caller:

- **Prompt cap** (chars) limits how much text the caller can send, bounding input-token cost.
- **Quality lock** per tier prevents a caller from requesting higher quality than the tier's price covers.
- **Size lock** (1024x1024) prevents a caller from requesting larger images that cost more upstream.
- **Model lock** per tier prevents a caller from requesting a more expensive model than the tier covers.

These caps are enforced server-side before the upstream call is made -- a misconfigured client cannot cause the operator to lose money.

## Environment gating

The kit reads `OPENAI_API_KEY` at call time, not at boot. If the key is missing or empty, calls return `503 Service Unavailable` and the rest of the server continues running normally. Self-hosters who don't want to offer image generation simply omit the env var -- no code change needed.

## See also

- [[LLM Proxy Gateway|LLM-Proxy]] -- the text inference proxy (same pattern, different modality)
- [[Paying with x402]] -- the USDC payment flow these endpoints require
- [[Security Model]] -- why these tools are wallet-only (no PoW free tier)
- [[API Reference|API-Reference]] -- full HTTP endpoint reference
- [[Tool Catalog]] -- where these three tools sit in the catalog
