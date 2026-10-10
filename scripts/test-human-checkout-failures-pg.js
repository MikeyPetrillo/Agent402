// The human checkout when the state database fails after a report was
// generated or before a refund is recorded, on a REAL Postgres behind a
// relay a test can cut (every statement fails) or arm so a statement lands
// and its reply is lost:
//   - the delivered record whose write landed but whose reply was lost is
//     never followed by a refund (the retry finds it already there);
//   - a delivered record that cannot land is kept on local disk and served
//     from memory, lands once the database is back, and a stale-claim
//     takeover never generates the report a second time;
//   - a failed report's refund is never issued before a record names it.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

requireTestPg({ label: "test-human-checkout-failures-pg" });
const relay = await startPgRelay(process.env.STATE_DATABASE_URL);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
delete process.env.ZEPTOMAIL_TOKEN; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
const sdb = await import("../src/state-db.js");
const { createHumanCheckout } = await import("../src/human-checkout.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = mkdtempSync(join(tmpdir(), "hc-fail-pg-"));
const row = async (id) => (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = 'human-checkout' AND id = $1`, [id])).rows[0]?.body ?? null;
const age = async (id) => sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.records SET body = jsonb_set(body, '{claimedAt}', to_jsonb(($2)::bigint)) WHERE collection = 'human-checkout' AND id = $1`, [id, Date.now() - 11 * 60_000]);

const pool = await sdb.stateDb();
const lost = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
const armed = [];
const origQuery = pool.query.bind(pool);
pool.query = async (text, values, cb) => {
  const r = await origQuery(text, values, cb);
  const a = armed.find((x) => x.left > 0 && x.re.test(String(text?.text ?? text)) && (!x.id || (values || []).includes(x.id)));
  if (a) { a.left--; throw lost(); }
  return r;
};

let gens = 0, genHook = null, failGen = false;
const refunds = [], sales = [];
const stripe = {
  refunds: { create: async (o, opts) => { refunds.push({ pi: o.payment_intent, key: opts?.idempotencyKey }); return { id: `re_${refunds.length}` }; } },
  checkout: { sessions: { retrieve: async (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 200, customer_details: { email: id.includes("mail") ? "buyer@example.test" : null }, metadata: { product: "dossier", input: "MSFT" } }) } },
};
const hc = createHumanCheckout({ stripe, baseUrl: "https://example.test", storeDir: DIR, log: () => {}, onSale: (s) => sales.push(s.sessionId),
  generate: async () => { gens++; if (genHook) await genHook(); if (failGen) throw new Error("upstream failed"); return { report: "# R\nbody", title: "t", sources: [], tables: [] }; } });
await hc.ready();
const settle = async (id) => { for (let i = 0; i < 60; i++) { const p = await hc.peek(id).catch(() => null); if (p && p.status !== "generating") return p; await wait(50); } return hc.peek(id).catch(() => null); };
const sid = (tag) => `cs_${tag}_${randomBytes(3).toString("hex")}`;

try {
  // The delivered record's write lands and its reply is lost: no refund, delivered once.
  {
    const id = sid("acklost");
    gens = 0; refunds.length = 0; sales.length = 0;
    // Armed once the report is generated, so it hits the delivered record's write.
    genHook = async () => { armed.push({ re: /INSERT INTO .*records/, id, left: 1 }); };
    await hc.fulfill(id);
    const first = await settle(id);
    genHook = null;
    await wait(500);
    const r = await row(id);
    ok(first?.status === "done" && r?.status === "done" && refunds.length === 0 && gens === 1 && sales.length === 1, `a delivered record whose reply was lost: poll ${first?.status}, row ${r?.status}, refunds ${refunds.length}, generations ${gens}, sales ${sales.length}`);
  }
  // The database down right after generation: served from memory, kept on disk, lands after; no second generation.
  for (const tag of ["down", "downmail"]) {
    const id = sid(tag);
    gens = 0; refunds.length = 0; sales.length = 0;
    genHook = async () => { relay.cut(); };
    await hc.fulfill(id);
    const first = await settle(id);
    genHook = null;
    const onDisk = existsSync(join(DIR, "_pending-finals.ndjson")) && readFileSync(join(DIR, "_pending-finals.ndjson"), "utf8").includes(id);
    ok(first?.status === "done" && onDisk && refunds.length === 0, `${tag}: the database away after generation: this container serves ${first?.status}, the record is on local disk (${onDisk}), refunds ${refunds.length}`);
    const polled = await hc.fulfill(id).catch(() => ({ status: "threw" }));
    ok(polled?.status === "done", `${tag}: ...and a poll on it answers ${polled?.status} while the database is away`);
    relay.heal();
    for (let i = 0; i < 40 && (await row(id))?.status !== "done"; i++) await wait(100);
    const r = await row(id);
    ok(r?.status === "done" && r.report, `${tag}: the record lands once the database is back (${r?.status})`);
    const inflight = (await row("_inflight")) || {};
    ok(!(id in inflight), `${tag}: ...and its claim leaves the in-flight index`);
    // Ten minutes on, a poll on another container finds the report, not a stale claim.
    const other = createHumanCheckout({ stripe, baseUrl: "https://example.test", storeDir: mkdtempSync(join(tmpdir(), "hc-fail-other-")), log: () => {}, generate: async () => { gens++; return { report: "# again" }; } });
    await other.ready();
    const again = await other.fulfill(id);
    ok(again?.status === "done" && gens === 1 && refunds.length === 0, `${tag}: no second generation, no refund (generations ${gens}, refunds ${refunds.length}, sales ${sales.length})`);
  }
  // A failed report with the database away: no refund is issued until a record names it.
  {
    const id = sid("failgen");
    gens = 0; refunds.length = 0;
    failGen = true;
    genHook = async () => { relay.cut(); };
    await hc.fulfill(id);
    const first = await settle(id);
    genHook = null; failGen = false;
    ok(refunds.length === 0 && first?.status === "error" && first.refundOwed === true, `a failed report with the database away: no refund before its record (${refunds.length}), the buyer reads ${first?.status} "${first?.error}"`);
    relay.heal();
    for (let i = 0; i < 40 && (await row(id))?.status !== "error"; i++) await wait(100);
    const owed = await row(id);
    ok(owed?.status === "error" && owed.refundOwed === true && owed.refundId === null, `...the owed record lands once the database is back (${owed?.status}, owed ${owed?.refundOwed})`);
    const issues = (await row("_issues")) || {};
    ok(issues[id]?.kind === "refund-owed", "...and is listed for the operator");
    const polled = await hc.fulfill(id);
    const r = await row(id);
    ok(refunds.length === 1 && polled?.refundId === "re_1" && r?.refundId === "re_1" && !(id in ((await row("_issues")) || {})), `...the next poll issues the refund once and records it (${refunds.length}, ${r?.refundId})`);
    ok(refunds[0]?.key === `agent402-refund-pi_${id}`, "...under a key of its own, so a re-issue returns the same refund");
    await age(id).catch(() => {});
    const later = await hc.fulfill(id);
    ok(refunds.length === 1 && gens === 1 && later?.status === "error", `...and nothing after: no second refund, no generation (${refunds.length}, ${gens})`);
  }
  // A failed report with the database up: the owed record lands before the refund, then the refund is recorded.
  {
    const id = sid("failup");
    gens = 0; refunds.length = 0;
    failGen = true;
    let rowAtRefund = null;
    const create = stripe.refunds.create;
    stripe.refunds.create = async (o, opts) => { rowAtRefund = await row(id); return create(o, opts); };
    await hc.fulfill(id);
    let fin = null;
    for (let i = 0; i < 60 && !fin?.refundId; i++) { fin = await hc.peek(id); await wait(50); }
    stripe.refunds.create = create; failGen = false;
    ok(rowAtRefund?.status === "error" && rowAtRefund.refundOwed === true, `the owed record is on the row when the refund is issued (${rowAtRefund?.status})`);
    ok(fin?.status === "error" && fin.refundId === "re_1" && (await row(id))?.refundId === "re_1", `...then the refund id is recorded (${fin?.refundId})`);
  }
  // A report lands on the row (another container, or this one's replay)
  // between a stale-claim read and the refund's pre-refund record: the
  // record is refused by the row, so no refund is issued for the delivered
  // report and the poll answers with the report.
  for (const tag of ["held", "heldrefund"]) {
    const id = sid(tag);
    gens = 0; refunds.length = 0;
    const done = tag === "held"
      ? { status: "done", kind: "dossier", slug: "dossier", input: "MSFT", report: "# landed elsewhere", title: "t", sources: [], tables: [], at: new Date().toISOString() }
      : { status: "error", refundId: "re_elsewhere", refundOwed: false, error: "refunded", at: new Date().toISOString() };
    await sdb.stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body) VALUES ('human-checkout', $1, $2::jsonb)`, [id, JSON.stringify({ status: "generating", claimedAt: Date.now() - 11 * 60_000, takeovers: 1, at: new Date().toISOString() })]);
    const origQ = pool.query;
    let flipped = false;
    pool.query = async (text, values, cb) => {
      if (!flipped && /->> 'status' = 'generating'/.test(String(text?.text ?? text)) && (values || []).includes(id)) {
        flipped = true;
        await origQuery(`UPDATE ${sdb.stateDbSchema()}.records SET body = $2::jsonb WHERE collection = 'human-checkout' AND id = $1`, [id, JSON.stringify(done)]);
      }
      return origQ(text, values, cb);
    };
    let ans;
    try { ans = await hc.fulfill(id); } finally { pool.query = origQ; }
    await wait(300);
    const r = await row(id);
    const issues = (await row("_issues")) || {};
    ok(flipped && refunds.length === 0 && r?.status === done.status && r?.refundId === done.refundId && !(id in issues), `${tag}: a pre-refund record the row refuses issues no refund (refunds ${refunds.length}, row ${r?.status}/${r?.refundId ?? null}, issues entry ${id in issues})`);
    ok(ans?.status === done.status, `${tag}: ...and the poll answers with what the row holds (${ans?.status})`);
  }
} finally {
  relay.heal();
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch (e) { console.error("drop failed", e.message); }
  await sdb.closeStateDb();
  await relay.close();
}
console.log(`\ntest-human-checkout-failures-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
