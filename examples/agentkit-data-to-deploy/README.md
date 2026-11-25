# AgentKit: buy data over x402, ship it to Base

One wallet, one script. An AgentKit agent buys the live ETH price from
agent402.tools over x402 (one cent, USDC on Base, no account and no API key),
then deploys a contract to Base mainnet that stores the price it bought and the
transaction hash of the payment that bought it. The payment and the deployment
reference each other on the same chain.

    npm install
    AGENT_WALLET_KEY=0x... node agent.js

The wallet needs a little USDC on Base for the data (the x402 payment is
gasless for the buyer) and a little ETH on Base for the deployment gas
(measured under $0.001 at Base's usual gas price).

What the script does:

1. Wraps the key in AgentKit's `ViemWalletProvider` and hands it to
   [`agent402-action-provider`](https://www.npmjs.com/package/agent402-action-provider), the
   Agent402 action provider.
2. `agent402_find` picks `crypto-price` for "live ETH price in USD".
3. `agent402_call` buys it. The x402 payment is signed by the wallet provider,
   settled by the facilitator, and the settled `PAYMENT-RESPONSE` receipt is
   captured from the paid retry.
4. `walletProvider.sendTransaction` deploys `contracts/Agent402PriceSnapshot.sol`
   with the price, the source's timestamp, the source route and the payment
   transaction hash as constructor arguments.
5. The snapshot is read back from the chain and every field is checked against
   what was bought. The run prints the payment link, the deploy link and the
   contract link, and exits non-zero unless all of it holds.

`DRY_RUN=1` estimates the deployment gas from the wallet with placeholder data
and buys nothing.

The contract is compiled once with `npm run compile` (solc 0.8.28, committed as
`contracts/artifact.json`, source hash inside) so a run deploys a known blob
and needs no compiler. CI recompiles it from the source with the same solc and
requires the bytes to match. To show the source on Basescan, verify the
deployed address there with the same settings (solc 0.8.28, optimizer 200 runs,
EVM cancun, no metadata hash).

Spend bounds ride with every paid call: `maxPerCallUsd` refuses anything over
$0.02 before signing, and `AGENT402_PAYEES` (optional) refuses any 402 that
names a payee outside the allowlist.

To hand the same three actions to a model instead of a script, wrap them with
`agent402ActionProvider()` and pass it to `AgentKit.from({ walletProvider,
actionProviders })` alongside AgentKit's own wallet actions. The model can be
bought from the same place: `https://agent402.tools/v1/metered` with a prepaid
credits key is an OpenAI-compatible base URL.

Live proof from this repository's CI:
`.github/workflows/agentkit-data-to-deploy.yml` (dispatch) runs this script
with the canary burner against production.
