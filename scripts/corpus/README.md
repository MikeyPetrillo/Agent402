# Correctness corpus

Second inputs for every tool, run by `scripts/test-corpus.js` on a FREE_MODE boot. No payment,
no canary: a case asserts the answer is *populated* (values, counts, honest empties, self-explaining
refusals), not merely shaped. Tiers are derived from the live catalog, never declared here:

- **T0** pure-CPU tools: every push, $0.
- **T1** free public upstreams (SEC, FRED-less macro, openFDA, DefiLlama, Hyperliquid, CoinGecko demo, open-meteo,
  public RPCs, Kalshi): nightly (`corpus-nightly.yml`), $0, upstream failures reported not fatal.
- **T2** paid upstreams (`METERED_SLUGS`): `--tier 2` by hand with the OpenRouter audit key, cheap links only.

Case shape and the assertion vocabulary are documented at the top of the runner. Rules for writing a case:
the input must differ from the documented example; a known-empty input asserts the tool *says* it is empty
(`count`, `note`, `found:false`), never a bare `[]`; an invalid input asserts a 4xx that names the field.
When a case fails, decide first whether the tool or the expectation is wrong - the first pass over the
top-200 tools was roughly half and half, and every tool-side miss was a silent fallback or a hollow 200.

Pacing: a file may declare `pace` (ms between case starts, whatever the concurrency) and `paceKey`
(the clock those starts are spaced on; default the file name). A case may override both. Cases that
share one rate-limited upstream must share one key across files - the CoinGecko cases in `chain.json`,
`crypto-defi.json` and `data-finance-gov.json` all carry `"paceKey": "coingecko", "pace": 5000`, because
three per-file clocks together started 60/min against the server's 25/min CoinGecko bucket.
