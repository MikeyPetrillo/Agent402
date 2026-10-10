// Two containers on one database (a deploy's overlap): two instances of each
// email store share one schema, each with its own in-memory copy. A write
// on one must never be undone by the other's save, a record made on one is
// seen by the other, an email is sent once when both tick at the same time,
// and a load that fails during an outage never leads to an overwrite.
// Requires STATE_DATABASE_URL (CI fails without it).
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
requireTestPg({ label: "test-overlap-stores-pg" });
const relay = await startPgRelay(process.env.STATE_DATABASE_URL);
process.env.STATE_DATABASE_URL = relay.url;
const sdb = await import("../src/state-db.js");
const { createFollowups } = await import("../src/followups.js");
const { createFreeAlerts } = await import("../src/free-alerts.js");
const { createWalletDigest } = await import("../src/wallet-digest.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "overlap-stores-"));
const quiet = () => {};
const secret = "overlap-secret";
const heal = async () => { relay.heal(); for (let i = 0; i < 6; i++) { try { await sdb.stateQuery("SELECT 1"); return; } catch { /* a dead pooled connection */ } } };
const DAY = 86_400_000;

try {
  // ---- follow-ups --------------------------------------------------------------
  {
    let clock = 1_000_000_000_000;
    const sent = [];
    const mk = (tag) => createFollowups({ storePath: join(DIR, tag, "followups.json"), secret, now: () => clock, monitorFor: () => ({ product: "m", label: "Monitor", priceUsd: "$1" }), sendEmail: async (m) => { sent.push(`${tag}:${m.to}`); return true; }, log: quiet });
    const stopKey = (id) => createHmac("sha256", secret).update(`stop:${id}`).digest("base64url").slice(0, 32);
    const A = mk("a"); await A.ready();
    A.enqueue({ sessionId: "cs_buyer_one", email: "one@example.com", product: "p", kind: "k", label: "L", input: "X" }); await A.flush();
    const B = mk("b"); await B.ready(); // the second container boots and reads the row
    ok(A.stop("cs_buyer_one", stopKey("cs_buyer_one")).ok, "followups: the stop link works on A");
    await A.flush();
    B.enqueue({ sessionId: "cs_buyer_two", email: "two@example.com", product: "p", kind: "k", label: "L", input: "Y" }); await B.flush();
    const row = (await sdb.documents.get("followups.json")).body.seqs;
    ok(row.cs_buyer_one?.stopped === true && row.cs_buyer_one?.email === null && Boolean(row.cs_buyer_two), "followups: an unsubscribe on A is not undone by B's next write, and B's record lands");
    A.enqueue({ sessionId: "cs_from_a", email: "a@example.com", product: "p", kind: "k", label: "L", input: "Z" }); await A.flush();
    B.enqueue({ sessionId: "cs_from_b", email: "b@example.com", product: "p", kind: "k", label: "L", input: "W" }); await B.flush();
    const C = mk("c"); await C.ready();
    ok(["cs_from_a", "cs_from_b"].every((id) => Object.hasOwn(C._store().seqs, id)), "followups: writes from both containers survive each other");
    // B never saw cs_from_a at boot; it buys again on B: every open sequence for that address stops, on the row.
    B.markRepeat("a@example.com"); await B.flush();
    ok((await sdb.documents.get("followups.json")).body.seqs.cs_from_a?.stopped === true, "followups: a repeat buyer seen on B stops a sequence only A had in memory");
    // A step is emailed once: both containers tick at once, then again in turn.
    clock += 3 * DAY;
    sent.length = 0;
    await Promise.all([A.tick(), B.tick()]);
    const twoSent = sent.filter((x) => x.endsWith("two@example.com")).length;
    ok(twoSent === 1, `followups: two containers ticking at once send the day-2 step once (sent ${twoSent}: ${JSON.stringify(sent)})`);
    await A.tick(); await B.tick();
    ok(sent.filter((x) => x.endsWith("two@example.com")).length === 1, "followups: a later tick on either container does not send it again");
    // The claim alone, both at once on an open step: exactly one container wins it.
    A.enqueue({ sessionId: "cs_claim", email: "c@example.com", product: "p", kind: "k", label: "L", input: "C" }); await A.flush();
    const claims = await Promise.all([A._claimStep("cs_claim", "another"), B._claimStep("cs_claim", "another")]);
    ok(claims.filter(Boolean).length === 1, `followups: a step claimed by two containers at once is won by one (${claims.filter(Boolean).length})`);
    ok((await B._claimStep("cs_claim", "another")) === null, "followups: a claimed step cannot be claimed again");
    // A tick reads the row first: a record made on A after B's last read is in B's copy after B's tick.
    A.enqueue({ sessionId: "cs_late", email: "late@example.com", product: "p", kind: "k", label: "L", input: "L" }); await A.flush();
    await B.tick();
    ok(Object.hasOwn(B._store().seqs, "cs_late"), "followups: a tick starts from the row as it is now");
    const r2 = (await sdb.documents.get("followups.json")).body.seqs.cs_buyer_two;
    ok(typeof r2.sent.monitor === "number", "followups: the step is recorded as sent with its time");
    ok(!sent.some((x) => x.endsWith("one@example.com")), "followups: the stopped sequence is never emailed");
  }

  // ---- free alerts -------------------------------------------------------------
  {
    let clock = 1_000_000_000_000;
    const sent = [];
    let ids = ["a"];
    const probes = { domain: Object.assign(async () => ({ ids })) };
    const mk = (tag) => createFreeAlerts({ storePath: join(DIR, tag, "free-alerts.json"), probes, validators: { domain: (t) => t }, now: () => clock, secret, sendEmail: async (m) => { sent.push(`${tag}:${m.to}:${m.subject}`); return true; }, log: quiet });
    const key = (id, p) => createHmac("sha256", secret).update(`${p}:${id}`).digest("base64url").slice(0, 32);
    const A = mk("a"); await A.ready();
    const B = mk("b"); await B.ready();
    await A.signup({ email: "x@example.com", kind: "domain", target: "x.example" }); await A.flush();
    await B.signup({ email: "y@example.com", kind: "domain", target: "y.example" }); await B.flush();
    let row = (await sdb.documents.get("free-alerts.json")).body.alerts;
    const byEmail = (e) => Object.values(row).find((a) => a.email === e);
    ok(byEmail("x@example.com") && byEmail("y@example.com"), "free-alerts: a signup on A is not lost by B's signup");
    const xid = byEmail("x@example.com").id, yid = byEmail("y@example.com").id;
    // Confirm on B a record A made (B read it at its signup), unsubscribe on A.
    ok(B.confirm(xid, key(xid, "confirm")).ok && (await A.confirmAsync(yid, key(yid, "confirm"))).ok, "free-alerts: each container confirms a record the other made (the async link route reads the row on a miss)");
    await A.flush(); await B.flush();
    ok(A.unsubscribe(xid, key(xid, "unsubscribe")).ok, "free-alerts: unsubscribe on A");
    await A.flush();
    await B.signup({ email: "z@example.com", kind: "domain", target: "z.example" }); await B.flush();
    row = (await sdb.documents.get("free-alerts.json")).body.alerts;
    ok(row[xid].status === "unsubscribed" && row[xid].email === null && row[yid].status === "active", "free-alerts: the unsubscribe on A survives B's next write, and the confirms both landed");
    // An unsubscribe link for a record this container never read still works (on the row).
    const D = mk("d"); await D.ready();
    await A.signup({ email: "w@example.com", kind: "domain", target: "w.example" }); await A.flush();
    const wid = Object.values((await sdb.documents.get("free-alerts.json")).body.alerts).find((a) => a.email === "w@example.com").id;
    ok(D.unsubscribe(wid, key(wid, "unsubscribe")).ok, "free-alerts: a signed unsubscribe for a record made elsewhere answers ok");
    await D.flush();
    ok((await sdb.documents.get("free-alerts.json")).body.alerts[wid].status === "unsubscribed", "...and unsubscribes it on the row");
    // Baseline then a change: both tick at once, one email.
    await Promise.all([A.tick({ force: true }), B.tick({ force: true })]);
    ids = ["a", "b"]; clock += 2 * DAY; sent.length = 0;
    await Promise.all([A.tick({ force: true }), B.tick({ force: true })]);
    const ySends = sent.filter((x) => x.includes(":y@example.com:")).length;
    ok(ySends === 1, `free-alerts: two containers ticking at once send one change email (sent ${ySends})`);
    ok(!sent.some((x) => x.includes(":x@example.com:")), "free-alerts: the unsubscribed address is never emailed");
    // A failed first load: the instance starts empty and its signup must not erase the row.
    const before = Object.keys((await sdb.documents.get("free-alerts.json")).body.alerts).length;
    relay.cut();
    const F = mk("f");
    await F.ready();
    await heal();
    let threw = null;
    try { await F.signup({ email: "new@example.com", kind: "domain", target: "n.example" }); } catch (e) { threw = e; }
    await F.flush();
    const after = (await sdb.documents.get("free-alerts.json")).body.alerts;
    ok(Object.keys(after).length === before + (threw ? 0 : 1) && after[yid] && after[xid], `free-alerts: a signup after a failed first load keeps every stored alert (${before} before, ${Object.keys(after).length} after)`);
  }

  // ---- wallet digest -----------------------------------------------------------
  {
    let clock = 1_000_000_000_000;
    const sent = [];
    const usage = () => ({ totals: { calls: 3, paidUsd: 0.03 }, bySlug: [{ slug: "hash", calls: 3, usd: 0.03 }], byNetwork: {} });
    const mk = (tag) => createWalletDigest({ storePath: join(DIR, tag, "wallet-digest.json"), secret, now: () => clock, usage, verifySignature: async () => true, sendEmail: async (m) => { sent.push(`${tag}:${m.to}:${m.subject}`); return true; }, log: quiet });
    const key = (id, p) => createHmac("sha256", secret).update(`digest:${p}:${id}`).digest("base64url").slice(0, 32);
    const A = mk("a"); await A.ready();
    const B = mk("b"); await B.ready();
    const la = A.preEnrolCredits({ keyId: "k1", email: "p@example.com" }); await A.flush();
    const lb = B.preEnrolCredits({ keyId: "k2", email: "q@example.com" }); await B.flush();
    let row = (await sdb.documents.get("wallet-digest.json")).body.subs;
    ok(Object.keys(row).length === 2, "wallet-digest: pre-enrolments on both containers both land");
    const idOf = (l) => new URL(l).searchParams.get("id");
    const pid = idOf(la), qid = idOf(lb);
    await A.refresh();
    ok(A.confirm(pid, key(pid, "confirm")).ok && A.confirm(qid, key(qid, "confirm")).ok, "wallet-digest: confirms on A");
    await A.flush();
    await B.refresh();
    ok(B.unsubscribe(pid, key(pid, "unsubscribe")).ok, "wallet-digest: unsubscribe on B");
    await B.flush();
    A.preEnrolCredits({ keyId: "k3", email: "r@example.com" }); await A.flush();
    row = (await sdb.documents.get("wallet-digest.json")).body.subs;
    ok(row[pid].status === "unsubscribed" && row[pid].email === null && row[qid].status === "active", "wallet-digest: B's unsubscribe survives A's next write");
    sent.length = 0;
    await Promise.all([A.tick(), B.tick()]);
    ok(sent.filter((x) => x.includes(":q@example.com:")).length === 1 && !sent.some((x) => x.includes(":p@example.com:")), `wallet-digest: two containers ticking at once send one digest, none to the unsubscribed address (${sent.length})`);
    await A.tick(); await B.tick();
    ok(sent.filter((x) => x.includes(":q@example.com:")).length === 1, "wallet-digest: the week is not sent again");
  }
  // ---- monitor scheduler -------------------------------------------------------
  {
    const { createMonitorScheduler } = await import("../src/monitor-scheduler.js");
    let clock = Date.parse("2026-10-09T00:00:00.000Z");
    let generated = 0;
    const subRec = { subId: "sub_ov", product: "domain-monitor", target: "example.com", status: "active" };
    const deps = {
      subs: { listActive: () => [subRec] }, now: () => clock,
      generate: async () => { generated++; await new Promise((r) => setTimeout(r, 30)); return { report: "r", title: "t" }; },
      probeDomain: async () => ({ signals: { grade: "A" }, fingerprint: "fp" }), normDomain: (d) => d,
      latestFiling: async () => null, resolveManager: async () => null, notify: async () => true,
      baseUrl: "https://t.example", log: quiet, sleep: async () => {},
    };
    const M = createMonitorScheduler({ ...deps, storePath: join(DIR, "m", "monitor-runs.json"), ownerId: "M" });
    await M.ready();
    // Two calls at once on one container: the second must not run a tick too.
    const [t1, t2] = await Promise.all([M.tick(), M.tick()]);
    ok([t1, t2].filter((t) => t.skipped === "busy").length === 1 && generated === 1, `two ticks started at once on one container: one runs, one is busy (${JSON.stringify([t1.skipped ?? "ran", t2.skipped ?? "ran"])}, ${generated} report)`);
    // The tick's state is in the row by the time the tick has released its lease.
    const row = (await sdb.documents.get("monitor-runs.json"))?.body;
    ok(row?.lastTick?.owner === "M" && row?.subs?.sub_ov?.lastFullAt, "the tick's runs are stored before its lease is released");
    // A run whose save never landed (the row still shows the older state): the
    // next tick keeps the newer run in memory instead of paying for it again.
    const older = JSON.parse(JSON.stringify(row));
    older.subs.sub_ov = { failures: 0, runs: [] }; // the state from before the welcome run: its save never landed
    await sdb.documents.put("monitor-runs.json", older);
    clock += 60_000;
    await M.tick();
    ok(generated === 1, `a run this container made but the row lost is not run (and paid for) again (${generated} reports)`);
    // The save holds the lease: with the row locked elsewhere (the save waits),
    // the lease is still this container's until the save lands.
    const pg = (await import("pg")).default;
    const locker = new pg.Client({ connectionString: process.env.STATE_DATABASE_URL });
    await locker.connect();
    await locker.query(`SET search_path TO ${sdb.stateDbSchema()}`);
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM documents WHERE name = 'monitor-runs.json' FOR UPDATE");
    clock += 60_000;
    const pendingTick = M.tick();
    await new Promise((r) => setTimeout(r, 600));
    const holderMid = await sdb.leases.holder("monitor-scheduler");
    await locker.query("ROLLBACK"); await locker.end();
    await pendingTick;
    ok(holderMid?.owner === "M", `while the tick's save waits, the lease is still held (${holderMid?.owner ?? "released"})`);
    ok((await sdb.leases.holder("monitor-scheduler")) === null, "and it is released once the save has landed");
  }
  // ---- shared payTo listing ---------------------------------------------------
  {
    const { createSharedPayToStore } = await import("../src/shared-paytos.js");
    const W = (n) => "0x" + String(n).repeat(40);
    const A = createSharedPayToStore({ file: join(DIR, "sa", "sor-shared-paytos.json"), log: quiet }); await A.ready();
    const B = createSharedPayToStore({ file: join(DIR, "sb", "sor-shared-paytos.json"), log: quiet }); await B.ready();
    await A.add(W(1)); await B.add(W(2));
    const mid = Object.keys((await sdb.documents.get("sor-shared-paytos.json")).body.wallets).sort();
    ok(mid.join() === [W(1), W(2)].join(), `shared-paytos: an add on B (booted before A's add) keeps A's wallet (${mid.length} listed)`);
    await A.remove(W(1)); await B.add(W(3));
    const wallets = Object.keys((await sdb.documents.get("sor-shared-paytos.json")).body.wallets).sort();
    ok(wallets.join() === [W(2), W(3)].join(), `shared-paytos: each container's add and remove survive the other's (${wallets.length} listed)`);
    ok(B.has(W(2)) && B.has(W(3)) && !B.has(W(1)), "shared-paytos: the container that wrote last lists the row as it is");
  }

  // ---- email send outcome ------------------------------------------------------
  {
    process.env.EMAIL_STATUS_FILE = join(DIR, "em", "email-status.json");
    const EA = await import("../src/email.js?container-a");
    const EB = await import("../src/email.js?container-b");
    await sdb.documents.del("email-status.json");
    EA.noteEmailOutcome(true, { provider: "p" }); EB.noteEmailOutcome(true, { provider: "p" }); EA.noteEmailOutcome(false, { status: 429, code: "LE_102", provider: "p" }); EB.noteEmailOutcome(true, { provider: "p" });
    let body = null;
    for (let i = 0; i < 40; i++) { body = (await sdb.documents.get("email-status.json"))?.body; if ((body?.sentTotal || 0) + (body?.failedTotal || 0) >= 4) break; await new Promise((r) => setTimeout(r, 50)); }
    ok(body?.sentTotal === 3 && body?.failedTotal === 1, `email: both containers' send counts add up in the row (${body?.sentTotal} sent, ${body?.failedTotal} failed)`);
  }

  // ---- Stripe webhook tally --------------------------------------------------
  {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
    let n = 0;
    const stripe = { webhooks: { constructEvent: () => ({ id: `evt_${++n}`, type: "ping.test", data: { object: {} } }) } };
    const SA = createStripeSubscriptions({ stripe, baseUrl: "https://t.example", storePath: join(DIR, "ta", "stripe-subscriptions.json"), onInvoicePaid: () => {} });
    const SB = createStripeSubscriptions({ stripe, baseUrl: "https://t.example", storePath: join(DIR, "tb", "stripe-subscriptions.json"), onInvoicePaid: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 3; i++) { await SA.handleWebhook("{}", "sig").catch(() => {}); await SB.handleWebhook("{}", "sig").catch(() => {}); }
    let t = null;
    for (let i = 0; i < 40; i++) { t = (await sdb.documents.get("stripe-subscriptions.json.webhooks.json"))?.body; if ((t?.verified || 0) >= 6) break; await new Promise((r) => setTimeout(r, 50)); }
    ok(t?.verified === 6 && t?.byType?.["ping.test"] === 6, `stripe tally: both containers' verified webhooks add up in the row (${t?.verified})`);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }

  // ---- MPP reconciliation days ------------------------------------------------
  {
    const { createMppReconciler } = await import("../src/mpp-reconcile.js");
    const RA = createMppReconciler({ file: join(DIR, "ra", "mpp-reconcile.json"), log: quiet });
    const RB = createMppReconciler({ file: join(DIR, "rb", "mpp-reconcile.json"), log: quiet });
    await new Promise((r) => setTimeout(r, 300));
    await RA.runOnce({ day: "2026-10-01" });
    await RB.runOnce({ day: "2026-10-02" });
    const days = Object.keys((await sdb.documents.get("mpp-reconcile.json"))?.body?.days || {}).sort();
    ok(days.includes("2026-10-01") && days.includes("2026-10-02"), `mpp-reconcile: a day one container reconciled survives the other's run (${days.join(",")})`);
  }

  // ---- traffic rollups -----------------------------------------------------------
  {
    const { createTrafficStore } = await import("../src/traffic-classifier.js");
    const t0 = Date.parse("2026-10-09T10:00:00Z");
    const TA = createTrafficStore({ dir: join(DIR, "tra", "traffic"), salt: "s", log: quiet });
    const TB = createTrafficStore({ dir: join(DIR, "trb", "traffic"), salt: "s", log: quiet });
    await TA.load(t0); await TB.load(t0);
    const rec = (st, ip, extra = {}) => st.record({ ip, ua: "curl/8", path: "/api/hash", method: "POST", status: 200, accept: "*/*", now: t0, ...extra });
    for (let i = 0; i < 4; i++) rec(TA, "192.0.2.1");
    for (let i = 0; i < 3; i++) rec(TB, "192.0.2.2");
    rec(TA, "192.0.2.3", { paidReceipt: true, payer: "0xpayer" }); rec(TB, "192.0.2.4", { paidReceipt: true, payer: "0xpayer" });
    TA.persist(t0); await TA.flush(); TB.persist(t0); await TB.flush();
    rec(TA, "192.0.2.1"); TA.persist(t0); await TA.flush();
    const day = await sdb.records.get("traffic", "2026-10-09");
    const pay = await sdb.records.get("traffic", "payers");
    ok(day?.total === 10, `traffic: both containers' counts for the day add up in the row (${day?.total})`);
    ok(Object.values(pay || {}).reduce((a, b) => a + b, 0) === 2, "traffic: both containers' payer counts add up");
    ok(TA._days.get("2026-10-09")?.total === 10, "traffic: the container that saved last counts on from the merged day");
  }
} finally {
  relay.heal();
  for (let i = 0; i < 3; i++) { try { await sdb.__dropStateSchema(); break; } catch { /* a connection the cut killed */ } }
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
