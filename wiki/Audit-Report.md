# Audit Report

`POST /api/audit-report` returns one wallet's paid history with Agent402, a record of every paid call: every tool called, every payment, and the signed receipt for each call, the repayments recorded for the wallet beside them, and a summary receipt over the report itself.

## Who can read a report

The wallet that pays for the call. There is no wallet parameter: the report covers the wallet that signed the EIP-3009 authorization for this payment, which the payment middleware verifies before the handler runs. The route is offered on EVM x402 rails only. A Solana, Stellar or Algorand payment carries no signed payer the server can verify, so those rails are not offered; Tempo, card and prepaid credits payments are refused for the same reason. A prepaid credits key's history is on its own balance page. On a server running in `FREE_MODE` no payment is verified, so the route always answers 400 there.

The price is listed on [`/api/pricing`](https://agent402.tools/api/pricing) and on the tool page.

## Request

```json
{ "from": "2026-10-01", "to": "2026-11-01", "limit": 200 }
```

| Field | Meaning |
|---|---|
| `from`, `to` | ISO dates or timestamps, inclusive. Default: the 30 days before now. The window is at most 366 days. |
| `limit` | Rows per page, 1 to 1000 (default 200). A larger value is clamped and the answer says so (`requestedExceededMax`). |
| `cursor` | The `nextCursor` of the previous page. It carries the window, so send it alone. |
| `format` | `"json"` (default) or `"csv"`. |

## What the report holds

`report.rows`, oldest first, one per paid call:

| Field | Meaning |
|---|---|
| `at` | When the call settled. |
| `slug`, `route` | The tool and the route that served it. |
| `priceUsd`, `quotedUsd` | What the wallet paid; for a metered call, the quoted ceiling it settled under. |
| `rail`, `network` | `x402`, `gateway-batched`, `mpp-evm` or `mpp-tempo`, and the chain. |
| `settlement` | The chain transaction, the Gateway transfer id or the MPP reference. |
| `requestSha256`, `responseSha256` | The digests the call's receipt signed. |
| `receiptId`, `receipt` | The signed receipt issued for the call (the `Agent402-Receipt` value), where one was issued and is still kept; `null` otherwise. |

Beside the rows: `totals`, `byTool` and `byDay` cover the whole window, whatever the page; `returned`, `matched`, `complete` and `truncated` say how much of the window this page holds; `page.nextCursor` is the next page (`null` on the last). `receipts.read` reads `unavailable` when the receipt store could not be read, and every row then carries `receipt: null`.

`report.refunds` lists the wallet's own refund rows recorded in the window: a charged call that failed or was not delivered, `owed` until it is repaid and `paid` with the repayment transaction (`refundTx`) once it is. `owedUsd` and `repaidUsd` sum them. They are never subtracted from `totals` (`netted: false`): the totals are what the wallet paid, and a refund can stand for a payment no row holds (one that landed on chain after an error answer). The block reads the wallet's newest 500 refund rows; when that read fills inside the window, `complete` is `false`. `read: "unavailable"` means the refund ledger could not be read. One transaction's refund status is also free at `GET /api/refunds?tx=<settlement>`. The CSV holds the call rows only.

`format: "csv"` answers the same rows as a `text/csv` file. The summary receipt rides in the `Agent402-Audit-Summary` header, the next page's cursor in `Agent402-Audit-Next-Cursor`.

## Verifying a report

The key published at [`/.well-known/agent402-receipt-key.json`](https://agent402.tools/.well-known/agent402-receipt-key.json) signs every receipt, and each receipt is a compact JWS (Ed25519, `alg` EdDSA).

- **The summary.** `summaryReceipt` signs the SHA-256 of `JSON.stringify(report)` (`reportSha256`), or of the CSV bytes. Its `payer` is the wallet, its `rail` is `audit-summary`, and it names no price or settlement. Check it with `POST /api/receipts/verify` and `{ "receipt": summaryReceipt, "body": JSON.stringify(report) }`: `valid: true` means this server signed exactly this report for this wallet. A changed amount, a dropped row or another wallet named fails it.
- **Each row.** `POST /api/receipts/verify` with the row's `receipt`, and the answer bytes you kept as `body`. The record's `settlement` is the row's.
- **Offline.** Take the key whose `kid` the JWS header names; verify the Ed25519 signature over the ASCII bytes `header.record`; check the record's `iat` falls inside the key's `validFrom` and `validUntil`; compare `responseSha256` and `requestSha256` with your own copies. The report's `verification` section lists the same steps.
- **On chain.** Each `settlement` is checkable on its network without asking Agent402.

## Retention

Each receipt a buyer received is kept from the moment its response finished with a final 200, and deleted 400 days after it was issued (`RECEIPT_STORE_DAYS` on a self-hosted server), so a report covers a full year. The sales ledger rows the report reads are kept as described on [/privacy](https://agent402.tools/privacy). A server without a receipt signing key issues no receipts: its reports carry the rows, `receipt: null` and no summary receipt, and say so.
