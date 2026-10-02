# agent402-openclaw

Part of [Agent402](https://agent402.tools), the open-source paid door for AI agents.

Agent402 as an [OpenClaw](https://openclaw.ai) model provider: the auto-routed
tier at a **flat per-call price** and explicit frontier models **priced per
request** from the body, paid in **USDC over x402** from a wallet or with a
prepaid credits key already issued (new credits are not on sale). The same key
and gateway reach Agent402's 500+ pay-per-call tools.

Guide: https://agent402.tools/guides/openclaw-model-provider

## Install

```bash
openclaw plugins install agent402-openclaw
npx agent402-openclaw setup --write        # no key? it mints a wallet and prints the address to fund
openclaw gateway restart
```

With no credits key and no `AGENT402_WALLET_KEY`, `setup` generates an EVM
wallet into `~/.openclaw/agent402/wallet.key` (0600, the only copy, never
printed) and prints its address: send it USDC on Base and every call is paid
from it over x402. `agent402-openclaw wallet` shows the address and balance;
`--no-wallet` skips the generation. Holding a credits key already issued? Run
`AGENT402_CREDITS_KEY=a402_... npx agent402-openclaw setup --write` (key by env,
or `--credits-key -` on stdin).

(`openclaw plugins install` copies the plugin into `~/.openclaw/extensions` and
does not link its CLI, hence `npx`.) `setup` stores a credits key under
`~/.openclaw/agent402/credits.key` (0600) and prints the `openclaw.json` block;
add `--write` to merge it in. The primary model it writes is the cheapest
metered model that can hold OpenClaw's own prompt: OpenClaw sends roughly 70k
characters of system prompt and tool schemas before your first word, and the
routed `auto` tier caps input at 16k, so `auto` stays listed for short one-off
prompts but is never made primary (OpenClaw would refuse every turn as a
context overflow). The plugin starts a loopback proxy (`127.0.0.1:8412`) that
pays Agent402 and forwards; OpenClaw only ever sees a local OpenAI-compatible URL.

Tested in CI against a real `openclaw@latest` install: plugin install, setup,
model listing, gateway boot and one agent turn (`test-real-install.js`).

No OpenClaw? `agent402-openclaw proxy` runs the proxy alone; point any OpenAI
client at `http://127.0.0.1:8412/v1` with model `auto`.

## Pay from a wallet instead

```bash
npm i @x402/fetch @x402/evm viem
export AGENT402_WALLET_KEY=0x...     # an EVM key holding USDC on Base
export AGENT402_MAX_PER_CALL_USD=2   # per-call ceiling checked before signing (default 2, the gateway's metered cap; 0 disables)
```

With no credits key present the proxy signs an x402 payment per call from that
wallet. The key never leaves the machine.

Two ways the wallet can pay a metered call:

- **exact** (default): the 402 quotes the call from its body (input + your
  `max_tokens`) and the wallet pays that quote.
- **upto, actual usage**: run `agent402-openclaw permit2-approve` once (one USDC
  approval transaction on Base; the wallet needs a little ETH for gas). From
  then on the proxy authorizes the quote as a CEILING and the gateway settles
  what the call actually used, so a short answer costs a fraction of the
  quote. `agent402-openclaw doctor` says which mode the wallet is in.

Credits-key buyers already pay actual usage on metered calls.

## Models and pricing

`auto` (routed per prompt, flat $0.01/call) plus every id from
`GET https://agent402.tools/v1/models`. Explicit models are **metered by default**:
the proxy sends them to the gateway's metered route, where each request is quoted
from its body (input plus your `max_tokens`, from $0.001, capped at $2 per
call), so a short call costs a fraction
of a cent and a long one pays for what it asks. `--flat` (or
`AGENT402_PRICING=flat`) keeps every model on its flat per-call tier instead.
Either way OpenClaw's per-token cost fields stay zero; the price is per call. A model sent to another flat
tier's route is priced at its home tier: the 402 quotes that tier's price, and the paid call is served under
that tier's caps (the answer says so in `agent402_tier`). The router, grounded and stealth tiers still answer a
400 naming the right route; nothing is charged. A client-supplied `Idempotency-Key`
is passed through: on a credits key, a retry with the same key replays the paid
answer; on a wallet, each forwarded call signs a fresh payment, which the server
treats as a new purchase. Without a key, each call is its own payment.

The proxy answers native clients on loopback only: requests carrying a browser
`Origin` header or a non-loopback `Host` are refused, so a web page cannot spend
the key.

## Commands

- `agent402-openclaw setup [--credits-key K | --credits-key - (stdin) | AGENT402_CREDITS_KEY env] [--no-wallet] [--write] [--port N] [--flat]`
- `agent402-openclaw proxy [--port N] [--upstream URL]`
- `agent402-openclaw doctor`
- `agent402-openclaw wallet [--rpc URL]` (address + USDC balance of the wallet the proxy pays from)
- `agent402-openclaw permit2-approve [--rpc URL]` (one-time USDC approval so the wallet pays actual usage over upto)

## What else the same key buys

The key or wallet that pays for chat also pays for the rest of the gateway and
the catalog, with one 402 shape and one receipt shape: OpenAI Responses and
Anthropic Messages wires, embeddings, rerank, images, video, speech,
transcription, grounded answers with citations, 500+ tools over
MCP or HTTP, wallet-keyed memory, finished reports (dossiers, insider flow, 13F,
domain audits, token risk, deep research) and monitors, plus routing that buys
from external sellers on the agent's behalf.

Why pay here, with every claim linked to its proof: https://agent402.tools/why.
Usage is priced under a ceiling quoted before you pay, a failed call is not
charged and the receipt proves it, a keyed retry on a credits key is not
debited twice, and uptime and transactions are published from outside
production.

Zero dependencies. MIT. Maintained by Havok Holdings LLC.
