// The first-call grant's record on the state database keeps the CLAIM time,
// not the finish (src/first-call-allowance.js finishFirstCallAllowance): a
// paid call the wallet settled while a slow free call ran is booked between
// the two, and the returning-payers figure reads sales strictly after the
// record's time, so a finish-time record would hide that return. Driven
// in-process: the claim on REAL Redis (the claim script), the record on REAL
// Postgres, a minute between claim and finish.
// Requires STATE_DATABASE_URL and REDIS_URL (CI fails without either).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-first-call-allowance-record-pg" });
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-first-call-allowance-record-pg: no REDIS_URL; start a local Redis and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
Object.assign(process.env, {
  SHARED_LIMITS_PREFIX: `fcar${process.pid}${Date.now().toString(36)}`, FIRST_CALL_ALLOWANCE: "on", FIRST_CALL_ALLOWANCE_SLUGS: "hash",
  FIRST_CALL_ALLOWANCE_DAILY_USD: "1", FIRST_CALL_ALLOWANCE_IP_PER_DAY: "100",
});
const { __dropStateSchema, closeStateDb } = await import("../src/state-db.js");
const m = await import("../src/first-call-allowance.js");

let pass = 0, failed = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`ok - ${msg}`); } else { failed++; console.error(`FAIL - ${msg}`); } };
const DEF = { route: "POST /api/hash", slug: "hash", price: "$0.001" };
const from = "0x" + randomBytes(20).toString("hex");
const accepted = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0x000000000000000000000000000000000000dead", maxTimeoutSeconds: 60 };
const payload = { x402Version: 2, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accepted.payTo, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } };
const headers = { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") };
const res = {
  statusCode: 200, sent: null, hdrs: {},
  setHeader(k, v) { this.hdrs[String(k).toLowerCase()] = v; return this; },
  getHeader(k) { return this.hdrs[String(k).toLowerCase()]; },
  json(b) { this.sent = b; return this; },
};
const req = { headers, header: (k) => headers[String(k).toLowerCase()], body: {}, method: "POST", path: "/api/hash", res };

try {
  const claimedAt = Date.now() - 60_000;
  const a = await m.claimFirstCallAllowance(req, res, DEF, { ip: "10.9.2.1", hasPaidSale: () => false, readBalance: async () => 10n ** 12n, now: claimedAt });
  ok(a.granted === true, `a new wallet's call is granted (${a.reason || "granted"})`);
  res.json({ algo: "sha256" });
  const d = m.allowanceSettleDecision({ paymentPayload: payload, requirements: accepted });
  ok(d?.skip === true && m.allowanceServed(req), "the settle hook skips the granted 200 and marks it served");
  const finishedAt = claimedAt + 60_000;
  await m.finishFirstCallAllowance(req, { now: finishedAt });
  const { grants } = await m.listServedGrants();
  const g = grants.find((x) => x.payer === from.toLowerCase() || x.payer === from);
  ok(g && g.grantedAtMs === claimedAt, `the grant's record keeps the claim time, not the finish a minute later (record ${g ? new Date(g.grantedAtMs).toISOString() : "missing"}, claim ${new Date(claimedAt).toISOString()})`);
  // A paid sale booked while the free call ran counts as a return.
  const between = claimedAt + 30_000;
  // The ledger stub holds one paid sale at `between` and answers, per grant, its first sale after the grant's time.
  const fig = await m.computeReturnedPayers({ firstPaidAfter: async (gs) => new Map(gs.filter((x) => x.grantedAtMs < between).map((x) => [x.payer, between])), now: finishedAt });
  ok(fig.paidAgain === 1, `a paid sale between the claim and the finish reads as a return (${JSON.stringify(fig)})`);
} finally {
  await __dropStateSchema().catch(() => {});
  await closeStateDb();
}
console.log(`\ntest-first-call-allowance-record-pg: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
