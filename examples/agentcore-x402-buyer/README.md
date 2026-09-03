# AgentCore x402 buyer — buy an Agent402 tool from a Bedrock AgentCore agent

A minimal sample showing an **AWS Bedrock AgentCore** agent paying for an
**Agent402** tool over **x402**. The AgentCore-managed wallet holds the funds and
the AgentCore **Payments** service signs each micropayment; the agent code contains
no keys and no payment logic.

Two entry points:

| File | What it is | Use it to |
|------|------------|-----------|
| `direct_buy.py` | Deterministic loop, no LLM: fetch → 402 → sign → retry → verify | **Prove the wallet works.** Reliable, scriptable. |
| `agent_buy.py` | A Strands agent + the AgentCore Payments plugin + an HTTP tool | **Showcase.** The agent calls the paid API and the plugin settles the 402. |

Default target: `POST https://agent402.tools/api/hash` with `{"text":"hello world","algo":"sha256"}`
— $0.001, and deterministic, so `direct_buy.py` can verify the paid response equals
`sha256("hello world")`.

## How the payment works

Agent402 (and 10,000+ x402 sellers) return **HTTP 402** with the payment terms in
a `payment-required` header. AgentCore Payments (built with Coinbase + Stripe)
reads that 402, authorizes a USDC micropayment from the agent's scoped wallet, and
the request is retried with the payment proof — settling on-chain to the seller's
own address. AgentCore Payments speaks **both x402 and MPP**, which are exactly the
two rails Agent402 serves.

> Note: on **Base**, the plugin's MPP path signs EIP-3009 under EIP-712 domain name
> `"USDC"` while Base USDC's contract domain is `"USD Coin"`, so those payments cannot
> verify (upstream: [awslabs/agentcore-samples#2002](https://github.com/awslabs/agentcore-samples/issues/2002)).
> The same instrument settles fine over x402, and agent402.tools detects the mismatch and
> steers the plugin to the x402 offer in the same 402 automatically, so `direct_buy.py`
> works as written. Nothing to configure here.

> Note: AgentCore's Gateway cannot pay a 402 on the Gateway→target hop — payment is
> an **agent-side** capability (this Payments plugin). That's why this sample runs
> the buy from the agent, and why the headline discovery path for paid tools is the
> **Coinbase x402 Bazaar** Gateway target + this plugin.

## Prerequisites

1. **AWS account + Agent Toolkit** (one-time). Sign in (`aws login --profile agent402`)
   and install the `aws-agents` plugin (`claude plugin install aws-agents@agent-toolkit-for-aws`).
2. **Bedrock model access** for the agent's LLM (Console → Bedrock → Model access) —
   `agent_buy.py` only.
3. **Payment resources** — let the `agents-pay` skill provision them:
   in Claude Code, *"set up microtransactions for my agent using the agents-build skill."*
   It creates a **Payment Credential Provider → Payment Manager → Connector → Instrument
   → Session**, pausing to (a) enter your wallet-provider secrets (**Coinbase CDP** —
   which needs an AWS Marketplace subscription to *Coinbase Wallets for AgentCore
   Payments* — or **Stripe Privy**) and (b) fund + authorize the wallet.
4. **Fund the wallet.**
   - **Testnet (free, do this first):** fund with Base Sepolia USDC from the
     [Circle faucet](https://faucet.circle.com/) and set
     `TARGET_URL=https://sandbox.node4all.com/v1/x402-test` to validate the loop.
   - **Mainnet (to buy a real Agent402 tool):** Agent402 production settles on **Base
     mainnet**, so put a few dollars of **mainnet USDC** on a **Base** instrument and
     keep the default `TARGET_URL`.

## Run

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # fill in the ARNs/ids the agents-pay skill printed
set -a; . ./.env; set +a

python direct_buy.py      # deterministic proof (recommended first)
python agent_buy.py       # the Strands-agent showcase
```

A successful `direct_buy.py` prints the 402, the signed retry returning 200, the
paid JSON, and `VERIFIED: sha256('hello world') == b94d27b9…`.

## Notes

- Spend is bounded by the **Payment Session** limit you set (default $5) — the agent
  cannot exceed it.
- On the FREE AWS plan, a project **spend limit** can pause the project; if a
  previously-working call starts returning AccessDenied, check AWS Settings → Billing.
- Sell side: Agent402 is the seller here. To gate *your own* site the same way, see
  the [`agent402-tollbooth`](../../tollbooth) package (x402 + MPP pay-per-crawl).
