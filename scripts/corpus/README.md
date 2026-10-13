# Correctness corpus

Second inputs for every tool, run by `scripts/test-corpus.js` on a FREE_MODE boot. No payment,
no canary: a case asserts the answer is *populated* (values, counts, honest empties, self-explaining
refusals), not merely shaped. Tiers are derived from the live catalog, never declared here:

- **T0** pure-CPU tools: every push, $0.
- **T1** free public upstreams (SEC, FRED-less macro, openFDA, DefiLlama, Hyperliquid, CoinGecko demo, open-meteo,
  public RPCs, Kalshi): nightly (`corpus-nightly.yml`), $0, upstream failures reported not fatal.
- **T2** paid upstreams (`METERED_SLUGS`): `--tier 2` by hand with a separate OpenRouter key, cheap links only.

Case shape and the assertion vocabulary are documented at the top of the runner. Rules for writing a case:
the input must differ from the documented example; a known-empty input asserts the tool *says* it is empty
(`count`, `note`, `found:false`), never a bare `[]`; an invalid input asserts a 4xx that names the field.
When a case fails, decide first whether the tool or the expectation is wrong - the first pass over the
top-200 tools was roughly half and half, and every tool-side miss was a silent fallback or a hollow 200.

Targets: a case whose input carries a URL points the tool at that host, and its expected value
then depends on that host answering. Prefer a target we operate (`agent402.tools`: an unknown
`/api` path is a reliable JSON 404, `/health` a 200, a paid route an unpaid 402) whenever the
case is about the tool's reading and not about a particular document. When the case needs an
outside document (a PDF, an image, a feed), keep the outside host: the runner reads the host
from the input (`targetHostOf`) and reports that host's 5xx, timeout or 429 as `upstream`
with the host named, never as our code. Our own hollow 200s, our 4xx on a valid input and our
500s stay fatal whatever the input points at.

Keys: a pack whose first step is a keyed tool declares `requires` with that key (the equities
packs: `DATABENTO_API_KEY`), the same as a keyed tool's own cases. Without it, a keyless boot
makes every step fail, the pack answers 502, and the nightly reports a host outage that never
happened. A case that carries a `_why` is one that was wrong once; read it before changing the case.

Pacing: a file may declare `pace` (ms between case starts, whatever the concurrency) and `paceKey`
(the clock those starts are spaced on; default the file name). A case may override both. Cases that
share one rate-limited upstream must share one key across files - the CoinGecko cases in `chain.json`,
`crypto-defi.json` and `data-finance-gov.json` all carry `"paceKey": "coingecko", "pace": 5000`, because
three per-file clocks together started 60/min against the server's 25/min CoinGecko bucket.
