# AgentCore x402 buyer - buy an Agent402 tool from a Bedrock AgentCore agent

A minimal sample showing an **AWS Bedrock AgentCore** agent paying for an
**Agent402** tool over **x402**. The AgentCore-managed wallet holds the funds and
the AgentCore **Payments** service signs each micropayment; the agent code contains
no keys and no payment logic.

Two entry points:

| File | What it is | Use it to |
|------|------------|-----------|
| `direct_buy.py` | Deterministic loop, no LLM: fetch → 402 → sign → retry → verify | **Prove the wallet works.** Reliable, scriptable. |
| `agent_buy.py` | A Strands agent + the AgentCore Payments plugin + an HTTP tool | **Showcase.** The agent runs a web search, then a cited answer, and the plugin settles each 402. |

`agent_buy.py` runs a web search and then a cited answer, each paid from the wallet:
`GET https://agent402.tools/api/search?q=x402+payment+protocol+adoption&count=5`, then
`GET https://agent402.tools/api/answer?q=what+is+the+x402+payment+protocol%3F`.

`direct_buy.py` buys a deterministic target, `POST https://agent402.tools/api/hash` with
`{"text":"hello world","algo":"sha256"}`, so it can verify the paid response equals
`sha256("hello world")`.

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run
free with proof-of-work and no wallet, through the [adapters](../../adapters) or the
hosted `/mcp` connector. This sample pays for `hash` from the wallet only so the
proof loop has an answer it can check.

## How the payment works

Agent402 (and 10,000+ x402 sellers) return **HTTP 402** with the payment terms in
a `payment-required` header. AgentCore Payments (built with Coinbase + Stripe)
reads that 402, authorizes a USDC micropayment from the agent's scoped wallet, and
the request is retried with the payment proof - settling on-chain to the seller's
own address. AgentCore Payments speaks **both x402 and MPP**, which are exactly the
two rails Agent402 serves.

> Note: the payment service pays an MPP challenge whenever the 402 it is handed carries
> one. `direct_buy.py` pays over x402, so it passes the `payment-required` header and the
> body and leaves out `WWW-Authenticate`. The plugin's built-in `http_request` calls
> sellers with the `python-httpx` User-Agent, and agent402.tools answers that client with
> the x402 offer alone (no `WWW-Authenticate: Payment` challenge), so the plugin pays over
> x402 too, with no extra configuration. To pay over MPP on Tempo instead, send
> `X-Payment-Offers: mpp` with the request, hold Tempo funds, and configure the plugin with
> `network_preferences_config=["tempo:4217", "eip155:4217"]` (Tempo first) and
> `buyer_pays_gas_fees=True`, as [`tempo-mpp-probe/mpp_tempo_buy.py`](tempo-mpp-probe/mpp_tempo_buy.py) does.

> Note: AgentCore's Gateway cannot pay a 402 on the Gateway→target hop - payment is
> an **agent-side** capability (this Payments plugin). That's why this sample runs
> the buy from the agent, and why the headline discovery path for paid tools is the
> **Coinbase x402 Bazaar** Gateway target + this plugin.

## Card-funded wallets

The agent pays from an embedded wallet that AgentCore Payments holds for the end
user, and the wallet can be topped up by card, debit, Apple Pay, Google Pay or ACH
(availability depends on the wallet provider and the country) as well as with USDC.
The agent code is the same either way: it never sees a card, a key or a stablecoin
transfer, and the Payment Session's spend limit bounds every call it pays for.

## Finding Agent402 tools from an AgentCore agent

AgentCore Gateway lists the x402 Bazaar as a pre-configured target ("Coinbase x402
Bazaar"), so an agent that searches it for a task can reach Agent402's listings
there and pays them with this plugin. Each listing carries its input schema, a
sample output (or, for a large one, a link to it in `/openapi.json`) and the price
in its 402, the same prices `GET https://agent402.tools/api/pricing` publishes.

## Tested without an AWS account

`scripts/test-agentcore-recipe.js` runs `direct_buy.py` as written against the real
402 that `POST /api/hash` answers (the server booted locally in paid mode), with
stand-in `boto3` and `bedrock_agentcore.payments` modules in place of AWS. It checks
that the payment service is handed the 402 whole, that the retry carries the header
it returns, that the digest checked is the field the tool answers, and that a
retry the seller refuses fails the run:

```bash
node scripts/test-agentcore-recipe.js
```

## Prerequisites

1. **AWS account + Agent Toolkit** (one-time). Sign in (`aws login --profile agent402`)
   and install the `aws-agents` plugin (`claude plugin install aws-agents@agent-toolkit-for-aws`).
2. **Bedrock model access** for the agent's LLM (Console → Bedrock → Model access) -
   `agent_buy.py` only.
3. **Payment resources** - let the `agents-pay` skill provision them:
   in Claude Code, *"set up microtransactions for my agent using the agents-build skill."*
   It creates a **Payment Credential Provider → Payment Manager → Connector → Instrument
   → Session**, pausing to (a) enter your wallet-provider secrets (**Coinbase CDP** -
   which needs an AWS Marketplace subscription to *Coinbase Wallets for AgentCore
   Payments* - or **Stripe Privy**) and (b) fund + authorize the wallet.
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

- Spend is bounded by the **Payment Session** limit you set (default $5) - the agent
  cannot exceed it.
- On the FREE AWS plan, a project **spend limit** can pause the project; if a
  previously-working call starts returning AccessDenied, check AWS Settings → Billing.
- Sell side: Agent402 is the seller here. To gate *your own* site the same way, see
  the [`agent402-tollbooth`](../../tollbooth) package (x402 + MPP pay-per-crawl).
