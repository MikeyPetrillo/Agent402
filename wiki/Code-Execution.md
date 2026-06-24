# Code Execution Sandbox

Two tiers of sandboxed code execution, paywalled via x402. An agent sends source code and gets back stdout, stderr, and the expression result -- all executed in an isolated cloud VM via [E2B](https://e2b.dev). No API key needed on the caller's side, no signup, no account. The operator's own `E2B_API_KEY` handles upstream auth; per-tier timeout and code-size caps bound compute cost.

## Tiers

| Endpoint | Price | Timeout | Code cap | Languages |
|---|---|---|---|---|
| `POST /api/code-run` | $0.02 | 30s | 10,000 chars | Python, JavaScript |
| `POST /api/code-run-pro` | $0.05 | 60s | 50,000 chars | Python, JavaScript |

Both tiers are **wallet-only** -- there is no proof-of-work free tier because every call spins up a real cloud VM. See [[Security Model]] for the wallet-only rationale.

## Request format

Both tiers accept the same JSON body:

```json
{
  "code": "print('Hello from Agent402!')",
  "language": "python"
}
```

| Field | Required | Notes |
|---|---|---|
| `code` | yes | Source code to execute; max length varies by tier |
| `language` | no | `python` (default) or `javascript` |

## Response format

Both tiers return the same envelope:

```json
{
  "language": "python",
  "stdout": "Hello from Agent402!\n",
  "stderr": "",
  "result": null,
  "error": null
}
```

| Field | Description |
|---|---|
| `language` | The language the code was executed in |
| `stdout` | Standard output from the execution |
| `stderr` | Standard error from the execution |
| `result` | The value of the last expression (if any) |
| `error` | Error details if the code failed, or `null` |

### Error shape

When code raises an exception, the `error` field contains:

```json
{
  "error": {
    "name": "NameError",
    "message": "name 'x' is not defined",
    "traceback": "Traceback (most recent call last):\n  ..."
  }
}
```

## Curl examples

### Standard tier ($0.02 -- Python, 30s)

```bash
curl -X POST https://agent402.tools/api/code-run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "import math\nprint(f\"Pi is approximately {math.pi:.10f}\")\nmath.factorial(20)",
    "language": "python"
  }'
```

### Standard tier -- JavaScript

```bash
curl -X POST https://agent402.tools/api/code-run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const fib = n => n <= 1 ? n : fib(n-1) + fib(n-2); console.log(fib(10)); 55",
    "language": "javascript"
  }'
```

### Pro tier ($0.05 -- longer computations, 60s)

```bash
curl -X POST https://agent402.tools/api/code-run-pro \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "import numpy as np\narr = np.random.randn(1000000)\nprint(f\"mean={arr.mean():.4f}, std={arr.std():.4f}\")\narr.shape",
    "language": "python"
  }'
```

All endpoints return `402` without a valid x402 payment header -- the same flow as every other paid tool. See [[Paying with x402]] for how to sign and attach payment.

## Security model

Each call runs in a **fully isolated E2B sandbox** (ephemeral cloud VM):

- **No access** to the Agent402 server's filesystem, network, or secrets
- **No state** persists between callers -- the VM is destroyed after each execution
- **Timeout enforcement** prevents infinite loops from burning compute
- **Code size cap** prevents payload abuse
- The `E2B_API_KEY` is read at call time and never exposed in responses or error messages

## Environment gating

The kit lazy-loads the E2B SDK and reads `E2B_API_KEY` at call time, not at boot. If the key is missing or empty, calls return `503 Service Unavailable` and the rest of the server continues running normally. Self-hosters who don't want to offer code execution simply omit the env var -- no code change needed.

## See also

- [[LLM Proxy Gateway|LLM-Proxy]] -- text inference proxy
- [[Image Generation Gateway|Image-Gen]] -- image generation proxy
- [[Paying with x402]] -- the USDC payment flow these endpoints require
- [[Security Model]] -- why these tools are wallet-only (no PoW free tier)
- [[Tool Catalog]] -- where these tools sit in the catalog
