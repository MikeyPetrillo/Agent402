# Decide

> **Payment wires:** the two paid Decide routes accept **x402** and **MPP** on the same 402, and prepaid card credits keys already issued; `/api/decide/feedback` is free. See [[Paying with x402]] and [[Paying with MPP]].

Describe a job in plain language and get back a call-ready plan: which tools, in what order, with fallbacks and parameters that validate against each tool's schema. The plan covers this catalog and outside x402 sellers that answered a live 402 in the last 7 days. Run the plan yourself, or send it back to Agent402 to run it, and the decision fee returns as credit.

The live page, with the current price per depth: https://agent402.tools/decide

## The three routes

| Route | MCP tool | What it does |
| --- | --- | --- |
| `POST /api/decide` | `decide.plan` | Returns a decision: a plan, cost and latency estimates, a confidence score and any gaps. |
| `POST /api/decide/execute` | `decide.execute` | Runs a decision's plan within your budget and returns each step's result with its receipt. |
| `POST /api/decide/feedback` | `decide.feedback` | Free. Reports whether one step worked; feeds future rankings within a bounded range. |

```bash
curl -X POST https://agent402.tools/api/decide \
  -H "Content-Type: application/json" \
  -d '{"task":"Resolve the ENS name vitalik.eth and list its token balances on Base","depth":"plan"}'
```

The first call answers 402 with the price for that depth; pay it with any x402 or MPP client and repeat.

## Depths

- `quick`: the single best tool for the whole job, with fallbacks.
- `plan`: the job split into steps, each with a primary tool, fallbacks and dependencies.
- `full`: the plan plus params filled from your task, a compiled prompt to run it, and cost and latency estimates.

## What a plan contains

Each step names its tool, endpoint, seller, price, input params and fallbacks, and says whether the tool is ours (`firstParty`). Values the task gives are filled in. A value the task does not give is named as a `<placeholder>` and listed in `exampleParamsNeedInput`, so the agent knows what to supply.

**Chained steps.** When a later step needs something an earlier step produces (an address an ENS lookup resolved, say), the plan writes `{{step N}}` for it and lists the earlier step in `dependsOn`. An agent replaces it with the matching field from that step's response. When the plan runs through `/api/decide/execute`, Agent402 fills it in itself: from a field with the parameter's name, or the one address or IP the earlier step returned. If the value cannot be named without guessing, the step is skipped and nothing is paid for it.

## How tools are ranked

One formula for every seller, ours included: fit to the step, observed reliability, price, schema quality and a freshness pass mark. The weights are the same for every tool and the formula has no term for who sells it. The model that judges fit sees the same bounded description for every tool, and outside listing text is treated as data, never as instructions.

## Running a plan through Agent402

- The decision fee comes back as a credit worth 100% of it, valid 24 hours, toward running that plan.
- Our tools run at list price. Outside tools are bought from the seller and resold at the seller's price plus a disclosed 5% markup.
- Spend stops at your budget, fallbacks run in order, and a run where no step succeeds is not charged.
- Every step returns its own receipt; outside results are marked as untrusted content.

## See also

- [[x402 Index and Router|x402-Index-and-Router]]: the seller index Decide plans over.
- [[MCP Connector]]: `decide.plan`, `decide.execute` and `decide.feedback` on the hosted connector.
- [[Tool Catalog]]
