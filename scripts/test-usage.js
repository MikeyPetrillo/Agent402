// Unit tests for the wallet-keyed usage report — the payer-scoped sales-ledger
// view and the /api/my-usage tool's identity gate. Offline: SALES_LEDGER_DB
// points at a temp file, and the x402 identity is a hand-built EIP-3009
// X-PAYMENT header (the same shape payerFromRequest verifies in prod).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SALES_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "usage-test-")), "sales.db");

const { recordSale, payerUsage } = await import("../src/sales-ledger.js");
const { USAGE_TOOLS } = await import("../src/tools/usage-kit.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BUYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

// Seed: 3 buys from BUYER (2 base + 1 polygon), 1 from OTHER, 1 PoW row
// (payer null), 1 old BUYER row outside a 1-day window.
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xaaa" });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xbbb" });
recordSale({ slug: "extract", priceUsd: 0.005, rail: "usdc", network: "polygon", payer: BUYER, tx: "0xccc" });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: OTHER, tx: "0xddd" });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null });

const u = payerUsage(BUYER, { days: 30, limit: 50 });
ok(u.wallet === BUYER, "report echoes the payer wallet");
ok(u.totals.calls === 3, `only the payer's own money-rail rows count (got ${u.totals.calls})`);
ok(Math.abs(u.totals.paidUsd - 0.007) < 1e-9, `paidUsd sums the payer's rows (got ${u.totals.paidUsd})`);
ok(u.byNetwork.base?.calls === 2 && u.byNetwork.polygon?.calls === 1, "per-network breakdown is payer-scoped");
ok(u.bySlug[0]?.slug === "hash" && u.bySlug[0]?.calls === 2, "slug table sorts by count");
ok(u.recent.length === 3 && u.recent.every((r) => typeof r.tx === "string"), "recent receipts carry settle txs");
ok(!JSON.stringify(u).includes(OTHER), "another wallet's rows never leak into the report");

const uOther = payerUsage(OTHER, { days: 30 });
ok(uOther.totals.calls === 1, "the other wallet sees exactly its own row");

const uEmpty = payerUsage("0x3333333333333333333333333333333333333333", { days: 30 });
ok(uEmpty.totals.calls === 0 && uEmpty.bySlug.length === 0 && uEmpty.recent.length === 0, "unknown wallet gets an empty (not erroring) report");

// The tool: identity comes ONLY from the verified X-PAYMENT authorization.
// By SLUG, never by position: a tool appended to the kit must not be able to
// re-point this at a different handler.
const tool = USAGE_TOOLS.find((t) => t.slug === "my-usage");
const header = Buffer.from(JSON.stringify({ payload: { authorization: { from: BUYER } } })).toString("base64");
const reqWithPayment = { header: (n) => (n.toLowerCase() === "x-payment" ? header : undefined) };
const viaTool = await tool.handler({ days: 30 }, reqWithPayment);
ok(viaTool.wallet === BUYER && viaTool.totals.calls === 3, "tool resolves identity from the signed payment and returns that wallet's report");

const reqBare = { header: () => undefined };
await tool.handler({}, reqBare).then(
  () => ok(false, "no payment must not produce a report"),
  (e) => ok(e.statusCode === 400 && /keyed to the wallet/i.test(e.message), "no verified payer → self-explaining 400")
);

// A wallet field in the BODY must never be an identity: it is simply ignored.
const viaSpoof = await tool.handler({ days: 30, wallet: OTHER }, reqWithPayment);
ok(viaSpoof.wallet === BUYER, "a body-supplied wallet cannot redirect the report (payment wins)");

await tool.handler({ days: 0 }, reqWithPayment).then(
  () => ok(false, "days=0 must reject"),
  (e) => ok(e.statusCode === 400, "days bounds enforced")
);
await tool.handler({ limit: 9999 }, reqWithPayment).then(
  () => ok(false, "limit=9999 must reject"),
  (e) => ok(e.statusCode === 400, "limit bounds enforced")
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
