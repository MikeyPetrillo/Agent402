# Tempo MPP probe (AgentCore buyer)

Scripts for buying an Agent402 tool over **MPP on Tempo mainnet** from an AWS
Bedrock AgentCore agent (Strands + the AgentCore Payments plugin, Stripe Privy
instrument), and for reproducing a **Tempo relay bug** we found doing it.

These are the working copies of what we ran; they build on the Payments stack
provisioned by AWS's own Tutorial 00 + 08
([`awslabs/agentcore-samples` → `08-agents-that-transact`](https://github.com/awslabs/agentcore-samples/tree/main/01-features/08-agents-that-transact)).
They read the shared `.env` those tutorials write (`PAYMENT_MANAGER_ARN`,
`INSTRUMENT_ID`, `USER_ID`), so run them from that tutorial directory or point
`.env` at those values. No secrets live in these files.

| File | What it does |
|------|--------------|
| `mpp_tempo_buy.py` | The **probe**. AgentCore agent buys `POST agent402.tools/api/hash` ($0.001) over MPP/Tempo mainnet; verifies the paid answer equals `sha256("hello world")`. $0.10 session cap. |
| `mpp_tempo_buy_other_seller.py` | Same buy against an unrelated Tempo MPP seller, the cross-seller control that shows the relay behavior is not specific to us. |
| `capture-402.mjs` | Local 402 replay server: serves agent402.tools' live tempo challenges to the plugin and captures the credential it mints, without broadcasting. |
| `capture_credential_buy.py` | `mpp_tempo_buy.py` pointed at the local capture server — drives the plugin to mint a credential into a file. |
| `relay_raw_repro.mjs` | Posts a captured credential **straight to Tempo's relay** over plain fetch — no seller code, no AWS SDK — and checks the chain. The definitive isolation of the bug. Needs `viem`. |

## Relay behavior

Tempo's relay `POST /v1/mpp/broadcast` returns
`invalid_payment: "Broadcast transaction hash does not match the signed
transaction"` for payments that **settle on-chain anyway**. Mechanism: the
Privy signer packs the signature with a recovery-id `v` byte (`0x00`/`0x01`);
the Tempo node accepts the transaction and stores the canonical `0x1b`/`0x1c`
form, so the canonical txid no longer equals `keccak256(submitted bytes)`, and
the relay's post-broadcast hash check fails a transaction that landed. The
buyer is told 402, retries, and is charged twice.

`relay_raw_repro.mjs` isolates this with zero code of ours in the path:
`validate` returns `success:true`, `broadcast` returns `invalid_payment`, and
the **v-swapped** candidate txid is on-chain with status `0x1`.

### How Agent402 handles it (until Tempo fixes the relay)

Our gate and `agent402-tollbooth` both ship a **chain-truth confirm**
(`src/tempo-confirm.js`): on a broadcast failure, derive the two txids the
credential's signed bytes could have landed under (submitted + v-swapped) and,
if one succeeded on-chain paying our recipient the right amount in the right
currency, serve the response as paid. Verification only — nothing is
re-broadcast, so it can never double-charge. That is why `mpp_tempo_buy.py`
returns a verified answer with exactly one charge even while the relay reports
failure.
