// Agent audit report: one wallet's full paid history with this server, as a
// file a company can hand to an auditor.
//
// IDENTITY. Like my-usage and receipts, the wallet is the one that SIGNED the
// payment for this call (identityPayerOf: the EIP-3009 authorization.from the
// payment middleware verified, never a parameter, null in FREE_MODE). There is
// no wallet input: the only way to read a wallet's report is to pay from it.
// The route is identity-bound (src/payments.js isIdentityBoundRoute), so it
// is offered on EVM x402 rails only and refused on Tempo, card and credits
// gates; a credits key's history is on its own balance page.
//
// WHAT IT HOLDS. For every paid call the wallet made over the window, oldest
// first: when, the tool and its route, what the wallet paid (and the quoted
// ceiling of a metered call), the rail and network, the settlement (the chain
// transaction, the Gateway transfer id or the MPP reference), the request and
// response digests, and the signed receipt (src/receipt-signing.js) issued for
// that call where one was issued and is still kept (src/receipt-store.js).
// Totals by tool and by UTC day cover the whole window; the rows are a page
// (`limit`, `cursor`), stated in partial-answer fields (src/partial-answer.js).
//
// SIGNED SUMMARY. While receipts are served, the answer carries a summary
// receipt signed with the same key: its responseSha256 is the SHA-256 of the
// report object as sent (JSON.stringify of `report`, UTF-8) or, for
// format "csv", of the CSV bytes; its payer is the wallet; its rail is
// "audit-summary" and it names no price or settlement. POST
// /api/receipts/verify with { receipt, body } checks it, as it checks each
// row's receipt, and so does any Ed25519 library with the published keys.
//
// No write: the report reads the sales ledger and the receipt store; the
// receipt store is written by the response signer for every paid call.
import { createHash } from "node:crypto";
import { identityPayerOf, freeModeOn, FREE_MODE_IDENTITY_NOTE } from "../payer.js";
import { payerAuditRows, salesLedgerRefresh } from "../sales-ledger.js";
import { receiptsForSettlements, RECEIPT_STORE_DAYS } from "../receipt-store.js";
import { buildReceiptRecord, signReceipt, requestDigest, responseDigest, receiptKeys, receiptsServed, RECEIPT_KEYS_PATH, RECEIPT_VERIFY_PATH, RECEIPT_MAX_BYTES } from "../receipt-signing.js";
import { partialFields, clampFields } from "../partial-answer.js";
import { GATEWAY_WIRE } from "../gateway-wire.js";
import { isPrivateRail } from "../paid-rails.js";

export const AUDIT_REPORT_PATH = "/api/audit-report";
export const AUDIT_SLUG = "audit-report";
/** The rail a summary receipt names: not a payment, a statement over a report. */
export const AUDIT_SUMMARY_RAIL = "audit-summary";
export const AUDIT_SUMMARY_HEADER = "Agent402-Audit-Summary";
export const AUDIT_NEXT_CURSOR_HEADER = "Agent402-Audit-Next-Cursor";
export const AUDIT_MAX_DAYS = 366;
export const AUDIT_DEFAULT_DAYS = 30;
export const AUDIT_MAX_LIMIT = 1000;
export const AUDIT_DEFAULT_LIMIT = 200;
export const CSV_MIME = "text/csv";
const DAY_MS = 86_400_000;
const CURSOR_MAX = 200;

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// The issuer and the slug -> route map, set once by src/server.js over the
// assembled catalog.
let ctx = { iss: String(process.env.BASE_URL || "").replace(/\/+$/, ""), routeOf: () => null };
export function setAuditReportContext({ iss, routeOf } = {}) {
  ctx = { iss: typeof iss === "string" ? iss.replace(/\/+$/, "") : ctx.iss, routeOf: typeof routeOf === "function" ? routeOf : ctx.routeOf };
}

/** The receipt vocabulary's name for a ledger row's rail (src/receipt-signing.js SIGNED_RAILS). */
export function auditRailOf(row) {
  if (isPrivateRail(row.rail)) return String(row.rail);
  const w = String(row.wire || "");
  if (w === "x402") return "x402";
  if (w === "mpp") return "mpp-evm";
  if (w === GATEWAY_WIRE) return "gateway-batched";
  if (w) return w;
  return String(row.rail || "") || null;
}

function parseWhen(v, name) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw bad(`"${name}" must be an ISO date or timestamp`);
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw bad(`"${name}" must be an ISO date or timestamp`);
  return t;
}

/** The opaque page cursor: the window it belongs to and the last row served. */
export function encodeCursor({ fromMs, toMs, ts, id }) {
  return Buffer.from(JSON.stringify({ v: 1, f: fromMs, t: toMs, ts, id })).toString("base64url");
}
export function decodeCursor(s) {
  if (typeof s !== "string" || !s || s.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(s)) throw bad('"cursor" is not a cursor this route issued: send the nextCursor of the previous page');
  let c;
  try { c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { c = null; }
  const ints = c && ["f", "t", "ts", "id"].every((k) => Number.isSafeInteger(c[k]));
  if (!c || c.v !== 1 || !ints || c.t < c.f || c.t - c.f > AUDIT_MAX_DAYS * DAY_MS) throw bad('"cursor" is not a cursor this route issued: send the nextCursor of the previous page');
  return { fromMs: c.f, toMs: c.t, ts: c.ts, id: c.id };
}

/** The window and page a request asks for. Throws a 400 naming the field. */
export function auditWindowOf(input = {}, now = Date.now()) {
  const raw = input && typeof input === "object" ? input : {};
  let limit = AUDIT_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    limit = Number.parseInt(raw.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) throw bad(`"limit" must be an integer from 1 to ${AUDIT_MAX_LIMIT} (default ${AUDIT_DEFAULT_LIMIT})`);
  }
  const clamped = clampFields(raw.limit, AUDIT_MAX_LIMIT, "limit");
  limit = Math.min(limit, AUDIT_MAX_LIMIT);
  const format = String(raw.format ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") throw bad('"format" must be "json" or "csv"');
  const from = parseWhen(raw.from, "from");
  const to = parseWhen(raw.to, "to");
  if (raw.cursor !== undefined && raw.cursor !== null && raw.cursor !== "") {
    const c = decodeCursor(raw.cursor);
    if ((from !== null && from !== c.fromMs) || (to !== null && to !== c.toMs)) throw bad('"from"/"to" differ from the window the cursor belongs to: send the cursor alone, or start again without one');
    return { fromMs: c.fromMs, toMs: c.toMs, after: { ts: c.ts, id: c.id }, limit, format, clamped };
  }
  const toMs = to ?? now;
  const fromMs = from ?? toMs - AUDIT_DEFAULT_DAYS * DAY_MS;
  if (toMs < fromMs) throw bad('"from" must not be after "to"');
  if (toMs - fromMs > AUDIT_MAX_DAYS * DAY_MS) throw bad(`the window is at most ${AUDIT_MAX_DAYS} days: ask for a longer history one window at a time`);
  return { fromMs, toMs, after: null, limit, format, clamped };
}

const AUDIT_CSV_COLUMNS = Object.freeze(["at", "slug", "route", "priceUsd", "quotedUsd", "rail", "network", "settlement", "requestSha256", "responseSha256", "receiptId", "receipt"]);
/** The rows as CSV: every field quoted, a quote doubled, and a leading = + - @ prefixed so a spreadsheet never runs it. */
export function auditCsv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [AUDIT_CSV_COLUMNS.map(cell).join(","), ...rows.map((r) => AUDIT_CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** The SHA-256 a summary receipt names for a JSON report: the report object, JSON.stringify'd, UTF-8. */
export function reportDigest(report) { return createHash("sha256").update(JSON.stringify(report), "utf8").digest("hex"); }

function verificationOf(iss) {
  return {
    keys: `${iss}${RECEIPT_KEYS_PATH}`,
    verify: `${iss}${RECEIPT_VERIFY_PATH}`,
    summary: `POST ${RECEIPT_VERIFY_PATH} with { "receipt": <summaryReceipt>, "body": <the report> }, where the report is JSON.stringify(report) for this JSON answer or the CSV text for format "csv": valid true means this server signed exactly this report for this wallet.`,
    offline: [
      `Fetch the key document at ${RECEIPT_KEYS_PATH}. Each key is an Ed25519 public key (x: the raw 32 bytes, base64url) with a kid and the window it signs in (validFrom, validUntil).`,
      "Each receipt is a compact JWS: base64url(header).base64url(record).base64url(signature). The header names alg EdDSA, typ agent402-receipt+jws and the kid; verify the signature over the ASCII bytes header.record with that kid's key.",
      "Check the record's iat falls inside the key's validFrom and validUntil.",
      "For a row: the record's settlement equals the row's settlement, its responseSha256 equals the SHA-256 of the answer bytes you kept, and its requestSha256 equals the SHA-256 of \"<METHOD> <path>[?query]\\n\" followed by JSON.stringify of the request body you sent (\"-\" when it had none).",
      "For the summary: its payer is this wallet, its rail is audit-summary, and its responseSha256 equals reportSha256 (the SHA-256 of JSON.stringify(report), or of the CSV bytes).",
      "Each settlement is also checkable without us: an on-chain transaction on the row's network, a Gateway transfer id, or an MPP reference.",
    ],
  };
}

/**
 * The handler, with its readers and signer injectable so the whole path runs
 * offline in a test.
 */
export function makeAuditReportHandler(deps = {}) {
  const payerOf = deps.payerOf || identityPayerOf;
  const rowsOf = deps.payerAuditRows || payerAuditRows;
  const receiptsOf = deps.receiptsForSettlements || receiptsForSettlements;
  const refresh = deps.refresh || (async (ms = 2000) => { await Promise.race([salesLedgerRefresh().catch(() => {}), new Promise((r) => setTimeout(r, ms).unref?.())]); });
  const signerOf = deps.signer || (() => (receiptsServed() ? receiptKeys().signer : null));
  const nowOf = deps.now || (() => Date.now());

  return async (input, req) => {
    const wallet = payerOf(req);
    if (!wallet) {
      if (freeModeOn()) throw bad(FREE_MODE_IDENTITY_NOTE);
      throw bad("The audit report is keyed to the wallet that PAYS for it. Pay via x402 with an EIP-3009 authorization (USDC on any EVM chain this route offers) and the report covers that wallet's history. Solana, Stellar and Algorand payments carry no signed payer the server can verify, and a credits key's history is on its balance page.");
    }
    const now = nowOf();
    const w = auditWindowOf(input, now);
    await refresh();
    const page = rowsOf(wallet, { fromMs: w.fromMs, toMs: w.toMs, after: w.after, limit: w.limit + 1 });
    const more = page.rows.length > w.limit;
    const rows = more ? page.rows.slice(0, w.limit) : page.rows;
    const last = rows[rows.length - 1];
    const nextCursor = more && last ? encodeCursor({ fromMs: w.fromMs, toMs: w.toMs, ts: last.ts, id: last.id }) : null;

    // The kept receipts for this page's settlements, never one naming another payer.
    let receiptRead = "ok";
    let kept = new Map();
    try { kept = await receiptsOf(wallet, rows.map((r) => r.tx).filter(Boolean)); }
    catch { receiptRead = "unavailable"; }

    let withReceipt = 0;
    const out = rows.map((r) => {
      const list = (r.tx && kept.get(r.tx)) || [];
      const pick = list.find((x) => !x.replay) || list[0] || null;
      let rec = null;
      if (pick) { try { rec = JSON.parse(Buffer.from(pick.jws.split(".")[1], "base64url").toString("utf8")); } catch { rec = null; } }
      if (rec && rec.settlement !== r.tx) rec = null;
      if (rec) withReceipt++;
      const priv = isPrivateRail(r.rail);
      return {
        at: new Date(r.ts).toISOString(),
        slug: r.slug,
        route: rec ? `${rec.method} ${rec.path}` : priv ? null : (ctx.routeOf(r.slug) || null),
        priceUsd: r.priceUsd,
        quotedUsd: r.quotedUsd,
        rail: rec?.rail || auditRailOf(r),
        network: r.network,
        settlement: r.tx,
        requestSha256: rec?.requestSha256 || null,
        responseSha256: rec?.responseSha256 || r.responseSha256 || null,
        receiptId: rec ? rec.id : null,
        receipt: rec ? pick.jws : null,
      };
    });

    const partial = partialFields(page.matched, out.length);
    const report = {
      document: "agent402-audit-report",
      version: 1,
      issuer: ctx.iss || null,
      wallet,
      generatedAt: new Date(now).toISOString(),
      window: { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), maxDays: AUDIT_MAX_DAYS },
      currency: "USD",
      ...partial,
      page: { limit: w.limit, after: w.after ? encodeCursor({ fromMs: w.fromMs, toMs: w.toMs, ts: w.after.ts, id: w.after.id }) : null, nextCursor, last: !more },
      ...w.clamped,
      totals: { ...page.totals, tools: page.byTool.length, days: page.byDay.length },
      byTool: page.byTool,
      byDay: page.byDay,
      receipts: { onThisPage: withReceipt, read: receiptRead, keptDays: RECEIPT_STORE_DAYS },
      rows: out,
    };

    const signer = signerOf();
    const sign = (bodySha256) => {
      if (!signer) return null;
      const record = buildReceiptRecord({
        iss: ctx.iss || null, method: "POST", path: AUDIT_REPORT_PATH, slug: AUDIT_SLUG,
        requestSha256: requestDigest("POST", AUDIT_REPORT_PATH, input && typeof input === "object" ? input : {}),
        responseSha256: bodySha256, priceUsd: null, rail: AUDIT_SUMMARY_RAIL, network: null, payer: wallet, settlement: null, replay: false, now,
      });
      const jws = signReceipt(record, signer);
      return jws.length <= RECEIPT_MAX_BYTES ? jws : null;
    };

    if (w.format === "csv") {
      const csv = Buffer.from(auditCsv(out), "utf8");
      const summary = sign(responseDigest(csv));
      const headers = { "Agent402-Audit-Matched": String(partial.matched), "Agent402-Audit-Returned": String(partial.returned), "Content-Disposition": `attachment; filename="agent402-audit-${wallet.slice(0, 10)}.csv"` };
      if (summary) headers[AUDIT_SUMMARY_HEADER] = summary;
      if (nextCursor) headers[AUDIT_NEXT_CURSOR_HEADER] = nextCursor;
      return { __binary: csv, contentType: CSV_MIME, headers };
    }
    const reportSha256 = reportDigest(report);
    return {
      report,
      reportSha256,
      summaryReceipt: sign(reportSha256),
      verification: verificationOf(ctx.iss || ""),
      ...(signer ? {} : { note: "Signed receipts are not issued on this server, so the report carries no summary receipt; every settlement is still checkable on its network." }),
    };
  };
}

const EXAMPLE_WALLET = "0xb0b0000000000000000000000000000000000b0b";
// Example rows built by a helper, so the one literal slug in this file is the route's own.
const exTool = (slug, calls, usd) => ({ slug, calls, usd });
const exRow = (slug, at, rail, settlement, priceUsd) => ({ at, slug, route: `POST /api/${slug}`, priceUsd, quotedUsd: null, rail, network: "eip155:8453", settlement, requestSha256: "7d1a…", responseSha256: "2c26…", receiptId: "Qm9xY2Fy…", receipt: "eyJhbGciOiJFZERTQSIs…" });
export const AUDIT_TOOLS = [
  {
    route: `POST ${AUDIT_REPORT_PATH}`,
    name: "Audit report (one wallet's paid history, signed)",
    slug: "audit-report",
    category: "payments",
    price: "$0.01",
    description:
      "An audit report of your own wallet's paid history here, ready to hand to an auditor: every paid call over a window of up to a year, each with its time, tool and route, the amount paid, the rail and network, the settlement transaction or reference, the request and response SHA-256 digests, and the signed receipt issued for it, plus totals by tool and by day. The report itself carries a summary receipt signed with the same published key, so anyone can check it with POST /api/receipts/verify or offline. Keyed to the wallet that pays for the call, never a parameter: nobody can read another wallet's report. Requires an EIP-3009 payment (USDC on an EVM chain). Use format \"csv\" for the rows as a CSV file; pages with cursor.",
    tags: ["audit", "receipts", "compliance", "accounting", "export", "csv", "wallet", "history"],
    aliases: ["audit", "audit-export", "compliance-report", "spend-report", "agent-audit"],
    binaryTypes: [CSV_MIME],
    mimeType: "application/json",
    discovery: {
      bodyType: "json",
      input: { from: "2026-10-01", to: "2026-11-01", limit: 200 },
      inputSchema: {
        properties: {
          from: { type: "string", description: `ISO date or timestamp, inclusive. Default ${AUDIT_DEFAULT_DAYS} days before "to".` },
          to: { type: "string", description: `ISO date or timestamp, inclusive. Default now. The window is at most ${AUDIT_MAX_DAYS} days.` },
          limit: { type: "number", description: `Rows per page, 1-${AUDIT_MAX_LIMIT} (default ${AUDIT_DEFAULT_LIMIT}). Totals by tool and by day always cover the whole window.` },
          cursor: { type: "string", description: "The nextCursor of the previous page (it carries the window; send it alone)." },
          format: { type: "string", description: `"json" (default) or "csv": the rows as a text/csv file, with the summary receipt in the ${AUDIT_SUMMARY_HEADER} header and the next page's cursor in ${AUDIT_NEXT_CURSOR_HEADER}.` },
        },
        required: [],
      },
      output: {
        example: {
          report: {
            document: "agent402-audit-report",
            version: 1,
            issuer: "https://agent402.tools",
            wallet: EXAMPLE_WALLET,
            generatedAt: "2026-11-01T00:00:05.000Z",
            window: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", maxDays: AUDIT_MAX_DAYS },
            currency: "USD",
            returned: 2,
            matched: 2,
            complete: true,
            truncated: false,
            page: { limit: 200, after: null, nextCursor: null, last: true },
            totals: { calls: 2, paidUsd: 0.006, firstAt: "2026-10-02T09:15:00.000Z", lastAt: "2026-10-03T14:02:11.000Z", tools: 2, days: 2 },
            byTool: [exTool("hash", 1, 0.001), exTool("my-usage", 1, 0.005)],
            byDay: [{ day: "2026-10-02", calls: 1, usd: 0.001 }, { day: "2026-10-03", calls: 1, usd: 0.005 }],
            receipts: { onThisPage: 2, read: "ok", keptDays: RECEIPT_STORE_DAYS },
            rows: [
              exRow("hash", "2026-10-02T09:15:00.000Z", "x402", "0x6563…", 0.001),
              exRow("my-usage", "2026-10-03T14:02:11.000Z", "mpp-evm", "0x9f86…", 0.005),
            ],
          },
          reportSha256: "5e88…",
          summaryReceipt: "eyJhbGciOiJFZERTQSIs…",
          verification: { keys: `https://agent402.tools${RECEIPT_KEYS_PATH}`, verify: `https://agent402.tools${RECEIPT_VERIFY_PATH}`, summary: "POST /api/receipts/verify with { receipt, body }", offline: ["Fetch the key document…"] },
        },
      },
    },
    handler: makeAuditReportHandler(),
  },
];
