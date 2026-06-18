# Strands agent paying a tollbooth — agents paying agents

This is the **reverse flow** of [`examples/agentcore/`](../agentcore). Instead of a Strands agent buying from Agent402, here a Strands agent (the kind you'd deploy on AWS Bedrock AgentCore) **pays** a self-hosted [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth) gate over x402.

End to end: agent → tollbooth-gated site → 402 → proof-of-work → 200 + content. No CDN, no Stripe, no Cloudflare, no signup — just the two open-source halves of x402 meeting in the middle.

## Run it

```bash
cd examples/agentcore-tollbooth
node run.js
```

Expected output:

```
[demo] tollbooth-gated site:  http://localhost:54XXX
[demo] agent invoked tool: fetch_paid
[demo] tool result: { paidVia: 'pow',
                      url: '/article',
                      body: 'premium content for paying clients only.' }
PASS — Strands agent paid the tollbooth over x402-style PoW and got the gated content.
```

## What just happened

1. We booted a tiny Express app with `createTollbooth({ price: "$0.002", ... })` in front. AI-agent user-agents get charged; humans pass.
2. The Strands agent has one tool, `fetch_paid`. Its callback hits the URL, sees a 402 with proof-of-work options, and solves a sub-second sha256 puzzle.
3. The retry with `X-Pow-Solution: <token>:<nonce>` gets a 200 and the content. The `x-tollbooth-paid: pow` response header proves which rail was used.

## On AgentCore

For the wallet-paid path (USDC over x402, not PoW), replace the `solvePow()` step with the `fetch` AgentCore Payments hands you — it signs with the CDP key your `PaymentCredentialProvider` holds in AgentCore Identity:

```ts
const fetchPaid = tool({
  name: "fetch_paid",
  description: "Fetch a URL that may be x402-gated; pays in USDC.",
  inputSchema: { url: "string" },
  callback: async ({ url }) => {
    const res = await agentcoreX402Fetch(url);   // handles 402 + signs USDC tx
    return await res.json();
  },
});
```

The tollbooth doesn't change — same `createTollbooth({ payTo: "0xYourWallet" })`. Same headers, same wire format. That's the whole point of x402: the buyer and seller never have to know about each other's framework.

## Why this demo matters

- **Open both sides.** One script shows the **buyer** (spending) and **seller** (charging) sides of x402 working end-to-end against each other — fully open source, no hidden middleman.
- **AgentCore-ready.** The Strands agent shape is exactly what AgentCore deploys. CloudWatch sees every paid call once you swap in the real `fetch`.
- **Realistic settlement.** Tollbooth's PoW rail proves the loop closes even when the buying agent has *no wallet*. USDC just changes the rail, not the contract.

## See also

- [`examples/agentcore/`](../agentcore) — buy side: Strands agent calling Agent402 tools
- [Wiki: AWS Bedrock AgentCore](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore) — the 5-minute recipe
- [Wiki: Pay-per-crawl](https://github.com/MikeyPetrillo/Agent402/wiki/Pay-per-crawl) — tollbooth modes (observe / bots / all / strict), dashboard, deploy templates
- [`tollbooth/demo.js`](../../tollbooth/demo.js) — the original narrated demo (no Strands, just an HTTP client)
