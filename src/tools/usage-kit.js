// Buyer usage report — the wallet IS the identity, exactly like the memory
// tools: there is no wallet parameter, no API key, no account. The buyer pays
// for the report via x402 with an EIP-3009 authorization, and the response
// covers the purchase history of the wallet that SIGNED that payment
// (payerFromRequest — the cryptographically verified field, never a loose
// body/header claim). Nobody can browse another wallet's purchase profile:
// the only way to unlock a report is to spend from the wallet it describes.
//
// SVM/Stellar payments carry no signed payer the server can verify, so they
// get a self-explaining 400 instead of a report.
import { payerFromRequest } from "../payer.js";
import { payerUsage, payerReceipts } from "../sales-ledger.js";
import { refundsForPayer } from "../refund-ledger.js";
import { ownRefundsView } from "../refund-lookup.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}


/** Flat CSV for a subledger import. Every field is quoted and every embedded
 *  quote doubled, so a slug containing a comma cannot shift a column; a leading
 *  =,+,-,@ is prefixed with a quote because spreadsheet software executes those
 *  as formulas (the same rule the paid report viewer already follows). */
export function receiptsCsv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cols = ["settledAt", "item", "amountUsd", "quotedUsd", "rail", "network", "wire", "settlementTx", "responseSha256", "attestationUid"];
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

// NOTE ordering: my-usage stays FIRST. Consumers index this array
// positionally (scripts/test-usage.js reads USAGE_TOOLS[0]), so a new tool is
// APPENDED - prepending one silently re-points every positional reference at
// the wrong tool, which is exactly how this was caught.
export const USAGE_TOOLS = [
  {
    route: "POST /api/my-usage",
    name: "My usage (wallet-keyed purchase history)",
    slug: "my-usage",
    category: "payments",
    price: "$0.005",
    description:
      "Your own purchase history, keyed to the wallet that pays for the call - no wallet parameter, no signup: the x402 payment IS the identity, so nobody can read another wallet's profile. Returns totals, per-tool counts, per-chain breakdown, recent receipts with settle tx hashes (independently verifiable on-chain), and this wallet's refunds: any payment that settled for a call that failed to deliver, with its status and our refund transaction once sent. Anyone holding a settlement tx can also check it for free at GET /api/refunds/lookup?tx=<hash>. Requires an EIP-3009 payment (USDC on Base, Polygon, or Arbitrum); Solana/Stellar payments carry no signed payer the server can verify.",
    tags: ["usage", "receipts", "billing", "audit", "wallet", "x402", "history"],
    discovery: {
      bodyType: "json",
      input: { days: 30 },
      inputSchema: {
        properties: {
          days: { type: "number", description: "Aggregation window in days, 1-365 (default 30). The recent list is always the latest rows regardless." },
          limit: { type: "number", description: "Max recent receipts to return, 1-200 (default 50)" },
        },
        required: [],
      },
      output: {
        example: {
          wallet: "0x902dcf34e53695bdea2ffb354b1a2e58bd598256",
          days: 30,
          persistent: true,
          totals: { calls: 42, paidUsd: 1.234, firstAt: "2026-07-01T00:00:00.000Z", lastAt: "2026-07-09T00:00:00.000Z" },
          byNetwork: { base: { calls: 40, usd: 1.2 }, polygon: { calls: 2, usd: 0.034 } },
          bySlug: [{ slug: "hash", calls: 12, usd: 0.012, lastAt: "2026-07-09T00:00:00.000Z" }],
          recent: [{ at: "2026-07-09T00:00:00.000Z", slug: "hash", priceUsd: 0.001, network: "base", tx: "0x…" }],
          refunds: { count: 1, owedUsd: 0, paidUsd: 0.005, rows: [{ tx: "0x…", status: "paid", amountUsd: 0.005, network: "eip155:8453", chain: "base", refundTx: "0x…", refundTxUrl: "https://basescan.org/tx/0x…", refundedAt: "2026-07-09T01:00:00.000Z", recordedAt: "2026-07-09T00:00:00.000Z" }] },
          note: "Every USDC row keeps its settle tx - verifiable on-chain.",
        },
      },
    },
    handler: async (input, req) => {
      const wallet = payerFromRequest(req);
      if (!wallet) {
        throw bad(
          "This report is keyed to the wallet that PAYS for it. Pay via x402 with an EIP-3009 authorization (USDC on any EVM chain this route offers) and the response covers that wallet's history. Solana/Stellar payments carry no signed payer the server can verify, so they cannot unlock a report."
        );
      }
      const days = input?.days === undefined ? 30 : parseInt(input.days, 10);
      if (Number.isNaN(days) || days < 1 || days > 365) throw bad('"days" must be an integer between 1 and 365 (default 30)');
      const limit = input?.limit === undefined ? 50 : parseInt(input.limit, 10);
      if (Number.isNaN(limit) || limit < 1 || limit > 200) throw bad('"limit" must be an integer between 1 and 200 (default 50)');
      // The wallet's own refunds, all time (a refund can lag the call it repays).
      return { ...payerUsage(wallet, { days, limit }), refunds: ownRefundsView(refundsForPayer(wallet, { limit })) };
    },
  },
  {
    route: "POST /api/receipts",
    name: "Receipts (your settled calls, as accounting rows)",
    slug: "receipts",
    category: "payments",
    price: "$0.005",
    description:
      "Your own settled calls in the shape a finance system posts: one row per payment with what was bought, the amount settled, the quoted ceiling where one applied, and the evidence - settlement transaction, sha256 of the bytes delivered, and the on-chain attestation id where one exists. Keyed to the wallet that pays for the call, so nobody can read another wallet's payables; no account, no export request, no support ticket. Requires an EIP-3009 payment (USDC on Base, Polygon, or Arbitrum). Use format \"csv\" for a subledger import.",
    tags: ["receipts", "accounting", "reconciliation", "audit", "erp"],
    aliases: ["invoice", "invoices", "journal", "ledger-export", "accounts-payable"],
    discovery: {
      bodyType: "json",
      input: { from: "2026-09-01", limit: 100 },
      inputSchema: {
        properties: {
          from: { type: "string", description: "ISO date or timestamp, inclusive. Default 90 days ago." },
          to: { type: "string", description: "ISO date or timestamp, inclusive. Default now." },
          limit: { type: "number", description: "Max rows per page, 1-5000 (default 500). `total` is the uncapped count for the window and `truncated` says when the page is short of it." },
          format: { type: "string", description: '"json" (default) or "csv" - the flat form a subledger imports.' },
        },
        required: [],
      },
      output: {
        example: {
          wallet: "0x902dcf34e53695bdea2ffb354b1a2e58bd598256",
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-11T00:00:00.000Z",
          returned: 2,
          total: 2,
          truncated: false,
          currency: "USD",
          rows: [
            { settledAt: "2026-09-09T10:03:05.816Z", item: "v1-chat-metered", amountUsd: 0.642466, quotedUsd: 0.74, rail: "usdc", network: "solana", wire: "x402", settlementTx: "5Nk…", responseSha256: "9f86d0…", attestationUid: null },
            { settledAt: "2026-09-08T13:15:07.000Z", item: "hash", amountUsd: 0.001, quotedUsd: null, rail: "usdc", network: "base", wire: "x402", settlementTx: "0x6563…", responseSha256: "2c26b4…", attestationUid: "0x76e736…" },
          ],
          note: "Every row's settlementTx is verifiable on the named chain without asking us.",
        },
      },
    },
    handler: async (input, req) => {
      const wallet = payerFromRequest(req);
      if (!wallet) {
        throw bad(
          "Receipts are keyed to the wallet that PAYS for the call. Pay via x402 with an EIP-3009 authorization (USDC on any EVM chain this route offers) and the response covers that wallet's own payables. Solana/Stellar payments carry no signed payer the server can verify, so they cannot unlock receipts."
        );
      }
      const limit = input?.limit === undefined ? 500 : parseInt(input.limit, 10);
      if (Number.isNaN(limit) || limit < 1 || limit > 5000) throw bad('"limit" must be an integer between 1 and 5000 (default 500)');
      const out = payerReceipts(wallet, { from: input?.from ?? null, to: input?.to ?? null, limit });
      if (out.error) throw bad(`"from"/"to" must be an ISO date or timestamp (${out.error})`);
      out.note = "Every row's settlementTx is verifiable on the named chain without asking us.";

      const format = String(input?.format || "json").toLowerCase();
      if (format === "csv") return { ...out, csv: receiptsCsv(out.rows) };
      if (format !== "json") throw bad('"format" must be "json" or "csv"');
      return out;
    },
  },
];
