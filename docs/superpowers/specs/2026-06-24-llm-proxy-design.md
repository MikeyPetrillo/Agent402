# LLM Proxy Gateway — OpenAI Capabilities Expansion

## Goal

Extend Agent402's existing 3-tier LLM proxy (`/api/llm`, `/api/llm-pro`,
`/api/llm-premium`) with vision and structured output support, and add a
standalone moderation endpoint. All OpenAI-only, all wallet-only.

## Scope

1. **Vision** — accept `image_url` content blocks in chat messages (all 3 tiers)
2. **Structured output** — accept `response_format` parameter for JSON mode / JSON schema (all 3 tiers)
3. **Moderation** — new `POST /api/moderate` endpoint ($0.002, 100% margin)

No new LLM endpoints. Vision and structured output are optional parameters on
existing routes. Existing callers sending text-only messages see zero change.

## Non-goals

- Multi-provider (no Anthropic, no Groq, no Gemini)
- Streaming / SSE
- Function calling / tool_choice
- Image editing
- Base64 image upload (URL-only)

---

## 1. Vision support

### Input format

Messages may contain mixed content arrays instead of plain strings:

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this image." },
        { "type": "image_url", "image_url": { "url": "https://example.com/photo.jpg", "detail": "low" } }
      ]
    }
  ]
}
```

Plain string `content` continues to work (backward compatible).

### Guardrails (margin protection)

| Constraint | Value | Why |
|---|---|---|
| Max images per request | **2** | 2 high-detail 2048x2048 images on o3 = $0.056 upstream. With text, worst-case total = $0.218 vs $0.50 price (56% margin). |
| URL format | HTTPS/HTTP only | No `data:` URIs — prevents multi-MB base64 payloads bypassing size checks. |
| URL max length | 2048 chars | Prevents absurd URLs. |
| `detail` on basic tier | Forced to `"low"` | Caps image tokens at 85/image ($0.00001 on gpt-4o-mini). |
| `detail` on pro/premium | Defaults to `"auto"` | OpenAI decides based on image size. Caller can request `"low"` or `"high"`. |
| Allowed `detail` values | `"low"`, `"high"`, `"auto"` | Reject anything else. |

### Validation rules

1. If `content` is an array, each element must have `type: "text"` or `type: "image_url"`.
2. At least one `text` block must exist (no image-only requests).
3. `image_url.url` must start with `https://` or `http://`.
4. Total text chars across ALL text blocks in ALL messages still capped by `maxInputChars`.
5. Image count across ALL messages capped at 2.
6. Only `user` role may contain `image_url` blocks (OpenAI constraint).

---

## 2. Structured output

### Input format

Optional `response_format` parameter on any tier:

```json
{
  "model": "gpt-4o",
  "messages": [...],
  "response_format": { "type": "json_object" }
}
```

Or with strict schema enforcement:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "weather",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "temp": { "type": "number" } },
        "required": ["temp"],
        "additionalProperties": false
      }
    }
  }
}
```

### Guardrails

| Constraint | Value | Why |
|---|---|---|
| Allowed types | `"json_object"`, `"json_schema"`, `"text"` | Reject unknown format types. `"text"` is the default (no-op). |
| Schema size cap | `JSON.stringify(json_schema)` <= 2000 chars | Prevents massive schemas eating context window. |
| `json_schema.name` | Required, string, 1-64 chars, `/^[a-zA-Z0-9_-]+$/` | OpenAI requires it; validate to prevent injection. |
| `json_schema.strict` | If present, must be `true` | OpenAI only supports strict mode for JSON schema. |
| No cost premium | Same token pricing | Zero margin impact. |

### Validation rules

1. If `response_format` is provided and not `{ type: "text" }`, pass it to OpenAI.
2. If `type` is `"json_schema"`, `json_schema` object must be present with `name` (string).
3. Reject if stringified schema exceeds 2000 chars.
4. OpenAI validates the schema itself — pass upstream errors back as 400/502.

---

## 3. Moderation endpoint

### New file: `src/tools/moderate-kit.js`

Single endpoint: `POST /api/moderate`

- **Price:** $0.002
- **Upstream cost:** $0 (OpenAI moderation API is free)
- **Margin:** 100%
- **Model:** `omni-moderation-latest`

### Input

```json
{ "text": "content to check" }
```

### Output

```json
{
  "model": "omni-moderation-latest",
  "flagged": false,
  "categories": {
    "harassment": false,
    "harassment/threatening": false,
    "hate": false,
    "hate/threatening": false,
    "illicit": false,
    "illicit/violent": false,
    "self-harm": false,
    "self-harm/intent": false,
    "self-harm/instructions": false,
    "sexual": false,
    "sexual/minors": false,
    "violence": false,
    "violence/graphic": false
  },
  "category_scores": {
    "harassment": 0.00012,
    "hate": 0.00003
  }
}
```

### Guardrails

| Constraint | Value | Why |
|---|---|---|
| Max text | 10,000 chars | Reasonable limit; moderation doesn't need novel-length input. |
| Text required | Non-empty string | No empty requests. |
| Wallet-only | Added to `WALLET_ONLY_SLUGS` | No PoW free tier — all AI tools are wallet-only. |

---

## Files changed

| File | Change |
|---|---|
| `src/tools/llm-kit.js` | Extend `validateInput()` for vision + structured output; pass new params to `callOpenAI()` |
| `src/tools/moderate-kit.js` | **New file** — moderation handler + tool definition |
| `src/pow.js` | Add `"moderate"` to `WALLET_ONLY_SLUGS` |
| `src/server.js` | Import + register `MODERATE_TOOLS` |
| `scripts/test-all.js` | Existing coverage (example still works — backward compatible) |

## Margin summary (worst-case per tier)

| Tier | Price | Worst-case upstream (text + 2 images) | Margin |
|------|------:|--------------------------------------:|-------:|
| llm | $0.010 | $0.004 | 60% |
| llm-pro | $0.100 | $0.045 | 55% |
| llm-premium | $0.500 | $0.218 | 56% |
| moderate | $0.002 | $0.000 | 100% |
