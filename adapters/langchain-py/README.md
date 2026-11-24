# agent402-structured-tools (Python)

Turn [Agent402](https://agent402.tools)'s catalog of 500+ pay-per-call tools
and skill packs into structured tools for Python agents, for use with LangChain.

Works with LangChain for Python (`langchain-core`). Agent402 is not affiliated with or endorsed by LangChain.

Formerly `agent402-langchain`: the same API under a new name. Change the dependency and the import specifier; nothing else changes.

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; this package pays wallet-only tools through the `x402_fetch` callable you pass (below).

Pure-CPU tools (hashing, encoding, QR, markdown, JSON, readability…) are **free**
via built-in proof-of-work - no wallet, no API keys. Live-data tools (market
data, web search, EDGAR, on-chain) are wallet-only and settle in USDC.

```bash
pip install "agent402-structured-tools[langchain]"
```

```python
from agent402_structured_tools import Agent402Toolkit

toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()   # four meta-tools your agent can call
```

It exposes **four meta-tools** rather than 500+ individual ones (frameworks and
LLMs both choke on thousands of tools):

| Tool | What it does |
| --- | --- |
| `agent402_find` | Resolve a task description to the best tool (slug, price, schema, example) |
| `agent402_route` | Cross-seller x402 router across the sellers Agent402 indexes |
| `agent402_call` | Call a tool by slug - auto-pays via proof-of-work (free) or your x402 fetch (paid) |
| `agent402_about` | The service manifest (identity, payment options, trust signals) |

## Paid (wallet-only) tools

Pass `x402_fetch` - a callable with the `requests`-style signature
`(method, url, **kwargs) -> requests.Response` that signs the USDC payment:

```python
toolkit = Agent402Toolkit(base_url="https://agent402.tools", x402_fetch=my_signed_fetch)
```

The callable is passed `allow_redirects=False`: a paid call never follows a
redirect, and one is refused with the origin it pointed to, so point `base_url`
at the address that serves the routes directly.

Without it, calling a wallet-only tool raises a clear error naming what's needed;
the free proof-of-work tier keeps working regardless.

**Spending caps.** A paid call is checked before `x402_fetch` runs: a tool
whose listed price is above `max_per_call_usd` (default 5, the same default as
the JS client; `0` or `"off"` turns it off) is refused, and so is a call that
would bring the rolling 24-hour total above `daily_limit_usd` (opt-in). Every
call sent through `x402_fetch` counts its list price against that total,
whatever its outcome. A refusal raises `SpendingLimitError` (its `limit` names
the cap) and nothing is paid:

```python
toolkit = Agent402Toolkit(x402_fetch=my_signed_fetch, max_per_call_usd=0.05, daily_limit_usd=2)
```

A proof-of-work challenge above 28 bits (`MAX_POW_DIFFICULTY`) is refused
before any work.

## Without LangChain

`agent402_tool_specs()` returns the same four entries as framework-agnostic dicts
(`name`, `description`, JSON Schema, and a plain `execute` callable) - no
langchain-core needed.

MIT © Havok Holdings LLC · [github.com/MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402)
