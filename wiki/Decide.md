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

The first call answers 402 with the price for that depth; pay it with any x402 or MPP client and repeat. To see the shape of a plan first, `GET /api/find?q=<task>` answers a multi-step task with a free keyword sketch, and that sketch runs through `POST /api/decide/execute` without a decision.

A `decisionId` comes only from a paid `/api/decide` answer. `POST /api/decide/execute` answers an id it never issued with a free 404 that says so, before any 402.

## Depths

- `quick`: the single best tool for the whole job, with fallbacks.
- `plan` (the default): the job split into steps, each with a primary tool, fallbacks, dependencies and params filled from your task.
- `full`: the plan plus a compiled prompt an agent can run as is, with more time to plan.

Every depth carries cost and latency estimates, a confidence score and any gaps.

## What a plan contains

Each step names its tool, endpoint, seller, price, input params and fallbacks, and says whether the tool is ours (`firstParty`). Values the task gives are filled in. A value the task does not give is named as a `<placeholder>` and listed in `exampleParamsNeedInput`, so the agent knows what to supply.

**Chained steps.** When a later step needs something an earlier step produces (an address an ENS lookup resolved, say), the plan writes `{{step N}}` for it and lists the earlier step in `dependsOn`. When the earlier step's field has another name (a lookup that returns `ticker` for a `symbol` input), the plan writes `{{step N.field}}`. An agent replaces it with the matching field from that step's response. When the plan runs through `/api/decide/execute`, Agent402 fills it in itself: from the named field, a field with the parameter's name, or the one address or IP the earlier step returned. If the value cannot be named without guessing, the step is skipped and nothing is paid for it.

**Running a free sketch.** A multi-step task sent to `/api/find` or `/api/route` gets a free sketch (one tool per step, keyword-matched, no model) that carries an `execute` body. `POST /api/decide/execute` with `steps` (the slugs in order, no `decisionId`) and `params` for step 1 runs it at list price; a later step whose tool has one required input takes it from the step before. A sketch step's `dependsOn` lists only the steps whose output it uses, so steps that take only your params list none. Execute starts a step once every step it lists has finished, so steps that share nothing run side by side (a few at a time); a step that saves state (a memory write, say) keeps plan order. The run is kept as a settled decision of depth `sketch`, so it can be repeated and given feedback like a paid one.

## How a plan is built

A base planner builds every plan: it splits the task into steps, retrieves and judges candidate tools for each step, ranks them, and fills params.

For `plan` and `full`, a small model call then reads the task and the base plan's shape (its steps, gaps, missing params and step links) and may pick one specialized planner for the task's kind:

| Planner | Tasks it serves | The one part it changes |
| --- | --- | --- |
| `chained-lookups` | one lookup feeds the next (a name to an address, then its balances) | which earlier step a value comes from, by field name |
| `onchain-identifiers` | addresses, transaction hashes, ENS names and chains | params: identifiers read from the task and checked before they are written |
| `market-series` | price history, candles, indicators over a range | steps: fetch with the stated range, then compute |
| `research-sources` | questions answered from sources | steps: search, read, then a cited answer |
| `media-pipeline` | generated media in a stated format or size | steps: generate, then convert with the format |

Each specialized planner inherits the base and changes that one part only; retrieval, scoring, the primary tool, backups and their order are the same rules for every planner and every seller. Its plan is served only when it is no worse than the base plan on gaps, runnable steps, params that validate and step links. Otherwise, and whenever the pick is unsure, the base plan is served. The decision names the planner that built it in `harness.id`, with `plannerVersion`. Planning never runs a step or pays a seller.

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
