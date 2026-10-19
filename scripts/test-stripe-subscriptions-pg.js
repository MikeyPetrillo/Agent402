// Card subscriptions on a REAL Postgres behind a relay a test can cut:
//   - a paid subscription recorded while the database is away is kept in
//     the journal (Redis with REDIS_URL set, else local disk) and lands
//     later, so a restart before then loses nothing;
//   - a replayed record never overwrites a newer copy of the subscription;
//   - reload() shows one container a subscription another recorded since it
//     loaded (the monitor scheduler calls it inside its lease);
//   - a webhook's partial patch on a container that never loaded the
//     subscription keeps the record's product and target.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
import { journalHolds } from "./lib/journal-probe.js";

requireTestPg({ label: "test-stripe-subscriptions-pg" });
const realUrl = process.env.STATE_DATABASE_URL;
const relay = await startPgRelay(realUrl);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.SUBSCRIPTIONS_REPLAY_MS = "200";
const sdb = await import("../src/state-db.js");
const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
const { ledgerDeadLetterStatus } = await import("../src/ledger-mirror.js");
// With REDIS_URL set the journal takes an entry only once Redis persistence has read on (the gate); learn that before the first write.
if (String(process.env.REDIS_URL || "").trim()) {
  const g = await (await import("../src/ledger-journal-redis.js")).awaitJournalRedisGate({ timeoutMs: 5000 });
  if (!g.open) { console.error(`FAIL - the Redis at REDIS_URL must run with append-only persistence on for the journal to take an entry (gate: ${g.reason})`); process.exit(1); }
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = mkdtempSync(join(tmpdir(), "subs-pg-"));
const STORE = join(DIR, "subs.json");
const stripe = {
  checkout: { sessions: { retrieve: async (id) => ({ id, mode: "subscription", payment_status: "paid", subscription: `sub_${id}`, customer: "cus_1", metadata: { product: "domain-monitor", target: "example.com" }, customer_details: { email: "a@example.test" } }) } },
  subscriptions: { retrieve: async () => ({ status: "active" }) },
};
const make = () => createStripeSubscriptions({ stripe, baseUrl: "https://example.test", storePath: STORE });

try {
  const A = make();
  await wait(300);

  // A paid subscription recorded while the database is away survives a restart.
  relay.cut();
  const out = await A.recordFromSession("cs_down1");
  const onDisk = await journalHolds({ schema: sdb.stateDbSchema(), prefix: "subscriptions:", needle: "sub_cs_down1", file: `${STORE}.pending.ndjson` });
  ok(out.status === "active" && onDisk, `recorded with the database away: told ${out.status}, kept in the journal (${onDisk})`);
  relay.heal();
  // A restart: a fresh instance on the same store path replays the record.
  // A2 replays the journal itself when its first load lands; when that load
  // meets a connection the cut left dead, the still-running A lands the record
  // instead, and A2 sees it on its next reload (the scheduler's path).
  const A2 = make();
  for (let i = 0; i < 40 && !A2.get("sub_cs_down1"); i++) { await wait(100); if (i % 5 === 4) await A2.reload().catch(() => {}); }
  ok(A2.get("sub_cs_down1")?.product === "domain-monitor", `after a restart the subscription is there (${A2.get("sub_cs_down1")?.status})`);
  const docName = (await sdb.stateQuery(`SELECT name FROM ${sdb.stateDbSchema()}.documents WHERE body ? 'sub_cs_down1'`)).rows[0]?.name;
  ok(Boolean(docName), `...and in the database (${docName})`);

  // Two containers: B loaded before A records; reload() shows it to B.
  const B = make();
  await wait(300);
  await A2.recordFromSession("cs_two");
  ok(!B.listActive("domain").some((r) => r.subId === "sub_cs_two"), "B, loaded earlier, does not see A's new subscription yet");
  const changed = await B.reload();
  ok(B.listActive("domain").some((r) => r.subId === "sub_cs_two") && changed >= 1, `...and sees it after reload (${changed} changed)`);

  // A webhook's partial patch on a container that never loaded the record keeps its fields.
  {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const Stripe = (await import("stripe")).default;
    const cw = createStripeSubscriptions({ stripe: { ...stripe, webhooks: Stripe.webhooks }, baseUrl: "https://example.test", storePath: STORE });
    await wait(300);
    await A2.recordFromSession("cs_three");
    const ev = { id: "evt_x", type: "customer.subscription.deleted", data: { object: { id: "sub_cs_three" } } };
    const payload = JSON.stringify(ev);
    const before = cw.get("sub_cs_three");
    await cw.handleWebhook(Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" }));
    const r3 = (await sdb.stateQuery(`SELECT body -> 'sub_cs_three' AS r FROM ${sdb.stateDbSchema()}.documents WHERE name = $1`, [docName])).rows[0]?.r;
    ok(before === null && r3?.status === "canceled" && r3?.product === "domain-monitor" && r3?.target === "example.com", `a cancellation on a container that never loaded the record keeps product and target (${JSON.stringify(r3 && { status: r3.status, product: r3.product })})`);

    // A webhook whose record cannot reach the database answers 503 (Stripe
    // delivers it again), keeps the record in the journal, books no sale;
    // the same event delivered once the database is back answers 200 and
    // books the invoice once.
    const booked = [];
    const cw2 = createStripeSubscriptions({ stripe: { ...stripe, webhooks: Stripe.webhooks }, baseUrl: "https://example.test", storePath: STORE, onInvoicePaid: (i) => booked.push(i.invoiceId) });
    await wait(300);
    await cw2.reload();
    const send = async (ev) => { const p = JSON.stringify(ev); try { return { code: 200, body: await cw2.handleWebhook(Buffer.from(p), Stripe.webhooks.generateTestHeaderString({ payload: p, secret: "whsec_test" })) }; } catch (e) { return { code: e.statusCode || 0 }; } };
    for (const ev of [
      { id: "evt_down_upd", type: "customer.subscription.updated", data: { object: { id: "sub_cs_three", customer: "cus_1", status: "past_due", metadata: {} } } },
      { id: "evt_down_inv", type: "invoice.paid", data: { object: { id: "in_down", subscription: "sub_cs_three", amount_paid: 900, customer: "cus_1" } } },
    ]) {
      booked.length = 0;
      relay.cut();
      const first = await send(ev);
      const kept = await journalHolds({ schema: sdb.stateDbSchema(), prefix: "subscriptions:", needle: "sub_cs_three", file: `${STORE}.pending.ndjson` });
      const dl = ledgerDeadLetterStatus({ full: true });
      ok(dl.status === "pending" && dl.subscriptions?.onDisk >= 1 && ledgerDeadLetterStatus({ now: Date.now() + 60 * 60_000 }).status === "stuck", `${ev.type}: the dead-letter word counts the journaled record (${dl.status}, ${dl.subscriptions?.onDisk} on disk)`);
      ok(first.code === 503 && kept && booked.length === 0, `${ev.type} with the database away: answers ${first.code} (5xx so Stripe retries), journal kept (${kept}), sales booked ${booked.length}`);
      relay.heal();
      const again = await send(ev);
      const rx = (await sdb.stateQuery(`SELECT body -> 'sub_cs_three' AS r FROM ${sdb.stateDbSchema()}.documents WHERE name = $1`, [docName])).rows[0]?.r;
      const landed = ev.type === "invoice.paid" ? rx?.lastInvoiceId === "in_down" : rx?.status === "past_due";
      ok(again.code === 200 && !again.body?.duplicate && landed && booked.length === (ev.type === "invoice.paid" ? 1 : 0), `...Stripe's retry once it is back answers ${again.code} (duplicate ${Boolean(again.body?.duplicate)}), the record is in the database (${landed}), sales booked ${booked.length}`);
    }

    // The same invoice.paid redelivered to another container (or after a
    // restart: a fresh instance remembers no event ids) books no second sale;
    // two containers receiving one new invoice at once book it once.
    const fresh = (into) => createStripeSubscriptions({ stripe: { ...stripe, webhooks: Stripe.webhooks }, baseUrl: "https://example.test", storePath: STORE, onInvoicePaid: (i) => into.push(i.invoiceId) });
    const sendTo = async (inst, ev) => { const p = JSON.stringify(ev); try { await inst.handleWebhook(Buffer.from(p), Stripe.webhooks.generateTestHeaderString({ payload: p, secret: "whsec_test" })); return 200; } catch (e) { return e.statusCode || 0; } };
    const other = [];
    const cw3 = fresh(other);
    await wait(300);
    await cw3.reload();
    const code3 = await sendTo(cw3, { id: "evt_down_inv", type: "invoice.paid", data: { object: { id: "in_down", subscription: "sub_cs_three", amount_paid: 900, customer: "cus_1" } } });
    ok(code3 === 200 && other.length === 0, `a redelivery of a booked invoice to another container books nothing (${code3}, sales ${other.length})`);
    const x = [], y = [];
    const cx = fresh(x), cy = fresh(y);
    await wait(300);
    await Promise.all([cx.reload(), cy.reload()]);
    const evNew = { id: "evt_race_inv", type: "invoice.paid", data: { object: { id: "in_race", subscription: "sub_cs_three", amount_paid: 900, customer: "cus_1" } } };
    const codes = await Promise.all([sendTo(cx, evNew), sendTo(cy, evNew)]);
    ok(codes.every((c) => c === 200) && x.length + y.length === 1, `one new invoice delivered to two containers at once is booked once (${codes.join(",")}; sales ${x.length}+${y.length})`);
  }

  // A replayed record never overwrites a newer copy.
  relay.cut();
  await A2.recordFromSession("cs_four"); // kept on disk, status active
  // Before the replay can land (this container still cut off), another
  // container cancels it (newer): written straight to the database, so no
  // replay tick here can land the stale copy first.
  const direct = new (await import("pg")).default.Client({ connectionString: realUrl });
  await direct.connect();
  try {
    await direct.query(`UPDATE ${sdb.stateDbSchema()}.documents SET body = jsonb_set(body, '{sub_cs_four}', $2::jsonb, true), version = version + 1 WHERE name = $1`, [docName, JSON.stringify({ subId: "sub_cs_four", status: "canceled", product: "domain-monitor", target: "example.com", updatedAt: new Date(Date.now() + 60_000).toISOString() })]);
  } finally { await direct.end(); }
  relay.heal();
  await A2.replayPending(); // joins the timer tick if one is already draining
  const r4 = (await sdb.stateQuery(`SELECT body -> 'sub_cs_four' AS r FROM ${sdb.stateDbSchema()}.documents WHERE name = $1`, [docName])).rows[0]?.r;
  ok(r4?.status === "canceled", `a replay does not overwrite a newer record (${r4?.status})`);
  ok(A2.get("sub_cs_four")?.status === "canceled", "...and this container takes the newer one");
} finally {
  relay.heal();
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch (e) { console.error("drop failed", e.message); }
  await sdb.closeStateDb();
  await relay.close();
}
console.log(`\ntest-stripe-subscriptions-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
