# Contributing

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

The fastest, most valuable contribution is a new tool; bug fixes and docs are just as welcome. The full guide is [CONTRIBUTING.md](https://github.com/MikeyPetrillo/Agent402/blob/main/CONTRIBUTING.md); this page is the short version.

## Before you open a pull request

1. Sign off every commit (`git commit -s`) and put the agreement sentence from [CLA.md](https://github.com/MikeyPetrillo/Agent402/blob/main/CLA.md) in the description. CI checks both.
2. Run the fast offline checks: `npm test` (no server, no network).
3. Regenerate what your change touches:
   - `node scripts/published-slugs.js --write` after adding a tool or a skill pack
   - `node scripts/gen-page-dates.js --write` after editing a page module or a tool kit
   - `node scripts/gen-config-reference.js --write` after reading a new environment variable
4. For a new tool, boot `FREE_MODE=true npm start` and run `TARGET_URL=http://localhost:3000 node scripts/test-all.js`: every tool must answer its own published example.

## How changes land

`main` mostly moves through one batch pull request at a time, so an accepted outside change may be merged as part of the next batch. Your commits keep their authorship and sign-off, and the batch description credits your pull request.

Edit the wiki in [`wiki/`](https://github.com/MikeyPetrillo/Agent402/tree/main/wiki) in the repository: CI publishes it from `main`, so don't edit the GitHub wiki directly.

See also [[Configuration]] and [[Architecture]].
