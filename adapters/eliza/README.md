# elizaos-plugin-agent402

[Agent402](https://agent402.tools) as an [elizaOS](https://github.com/elizaOS/eliza)
plugin: 500+ deterministic pay-per-call web tools (web search, browser render,
PDFs, OCR, market and crypto data, SEC filings, DNS/TLS checks, memory) your
agent can find and call, paid by prepaid card credits or in USDC over x402 or
MPP. Free-tier tools pay with proof-of-work and need neither. Agentic Finance
(AIFI) for elizaOS agents: one key, one receipt shape, every call quoted before
it is paid.

## Install

```bash
elizaos plugins add elizaos-plugin-agent402
# or: bun add elizaos-plugin-agent402
```

Character config:

```json
{
  "plugins": ["elizaos-plugin-agent402"],
  "settings": {
    "AGENT402_CREDITS_KEY": "a402_...",
    "AGENT402_MAX_PER_CALL_USD": "1"
  }
}
```

`AGENT402_CREDITS_KEY` is a prepaid card-credits key from
https://agent402.tools/credits (shown once, emailed). To pay from a wallet
instead, set `AGENT402_WALLET_KEY` (an EVM key holding USDC on Base) and
install the optional peers `@x402/fetch @x402/evm viem`. With neither, the
free tier still works.

## Actions

| Action | What it does | Cost |
|---|---|---|
| `AGENT402_FIND` | Plain-language task in (`content.task` or the message text), best-matching tools out: slug, price, whether payment is needed, a ready example input. | Free |
| `AGENT402_CALL` | `content.slug` + `content.params` in, the tool's JSON out. Proof-of-work for free-tier tools; the credits key or wallet for wallet-only tools, never above `AGENT402_MAX_PER_CALL_USD` (default $1). | $0.001 and up, quoted in every 402 |
| `AGENT402_ABOUT` | What Agent402 is, how it is paid, live tool counts. | Free |

A provider (`AGENT402`) tells the agent on every turn that the catalog exists,
how to use the two actions, and which payment mode is configured. Keys never
appear in action results or provider text.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `AGENT402_CREDITS_KEY` | | prepaid card credits (`a402_...`) |
| `AGENT402_WALLET_KEY` | | EVM private key paying USDC over x402 |
| `AGENT402_BASE_URL` | `https://agent402.tools` | self-hosters point this at their instance |
| `AGENT402_MAX_PER_CALL_USD` | `1` | refuse any single paid call above this |
| `AGENT402_DAILY_LIMIT_USD` | | refuse once rolling 24h paid spend exceeds this |

Every paid call carries an `Idempotency-Key`, so a retried call replays the
paid answer instead of paying twice. What the same key buys beyond tools:
https://agent402.tools/why. Other hosts: https://agent402.tools/guides/agent-hosts.

## License

This plugin is **MIT** (Havok Holdings LLC) - see the [LICENSE](LICENSE) in this directory, which is what npm's `license` field declares. It lives in the Agent402 monorepo, whose **server** is AGPL-3.0; GitHub's repository-level license badge reports that one, not the plugin's. Every published Agent402 package (`agent402-client`, which this plugin depends on, included) is MIT the same way.
