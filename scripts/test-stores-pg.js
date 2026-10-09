// The migrated stores against a real Postgres: each one imports its volume
// file on the first load, writes to the database from then on, and a fresh
// instance (a new container) reads the row, not the file. Runs every store the
// batch moved; add a case here when a store moves. Requires STATE_DATABASE_URL
// (CI fails without it).
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-stores-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const D1 = mkdtempSync(join(tmpdir(), "stores-pg-1-"));
const D2 = mkdtempSync(join(tmpdir(), "stores-pg-2-"));
const quiet = () => {};
const sendEmail = async () => true;

try {
  // ---- followups --------------------------------------------------------------
  {
    const { createFollowups } = await import("../src/followups.js");
    const file = join(D1, "followups.json");
    writeFileSync(file, JSON.stringify({ seqs: { cs_old: { id: "cs_old", email: "a@x.test", product: "p", kind: "k", label: "l", input: "i", createdAt: 1, sent: {}, stopped: false } } }));
    const fu = createFollowups({ storePath: file, sendEmail, secret: "s", log: quiet });
    await fu.ready();
    ok(Object.keys(fu._store().seqs).join(",") === "cs_old", "followups: the first load imports the file");
    fu.enqueue({ sessionId: "cs_new", email: "b@x.test", product: "p", kind: "k", label: "l", input: "i" });
    await fu.flush();
    const fu2 = createFollowups({ storePath: join(D2, "followups.json"), sendEmail, secret: "s", log: quiet });
    await fu2.ready();
    ok(Object.keys(fu2._store().seqs).sort().join(",") === "cs_new,cs_old", "followups: a fresh instance reads the row (both records), not its missing file");
    ok(!existsSync(join(D2, "followups.json")) && Object.keys(JSON.parse(readFileSync(file, "utf8")).seqs).length === 2, "followups: the row is read, and the original file is kept current by write-through");
  }
  // ---- free alerts ------------------------------------------------------------
  {
    const { createFreeAlerts } = await import("../src/free-alerts.js");
    const file = join(D1, "free-alerts.json");
    writeFileSync(file, JSON.stringify({ alerts: { fa_1: { id: "fa_1", email: "a@x.test", kind: "insider", target: "T", status: "active", createdAt: 1 } } }));
    const fa = createFreeAlerts({ storePath: file, probes: {}, validators: { insider: (t) => t }, sendEmail, secret: "s", log: quiet });
    await fa.ready();
    ok(fa._store().alerts.fa_1?.status === "active", "free-alerts: imported");
    const r = await fa.signup({ email: "c@x.test", kind: "insider", target: "U" });
    ok(r.ok === true, "free-alerts: a signup writes");
    await fa.flush();
    const fa2 = createFreeAlerts({ storePath: join(D2, "free-alerts.json"), probes: {}, validators: { insider: (t) => t }, sendEmail, secret: "s", log: quiet });
    await fa2.ready();
    ok(Object.keys(fa2._store().alerts).length === 2, "free-alerts: a fresh instance sees both records from the row");
  }
  // ---- wallet digest ---------------------------------------------------------
  {
    const { createWalletDigest } = await import("../src/wallet-digest.js");
    const file = join(D1, "wallet-digest.json");
    writeFileSync(file, JSON.stringify({ subs: { dg_aaaaaaaa: { id: "dg_aaaaaaaa", email: "a@x.test", kind: "credits", status: "active", createdAt: 1 } } }));
    const wd = createWalletDigest({ storePath: file, sendEmail, secret: "s", usage: () => ({}), verifySignature: async () => true, log: quiet });
    await wd.ready();
    ok(wd._store().subs.dg_aaaaaaaa?.status === "active", "wallet-digest: imported");
    const link = wd.preEnrolCredits({ keyId: "k1", email: "d@x.test" });
    ok(typeof link === "string" && Object.keys(wd._store().subs).length === 2, "wallet-digest: a pre-enrol writes a pending record");
    await wd.flush();
    const wd2 = createWalletDigest({ storePath: join(D2, "wallet-digest.json"), sendEmail, secret: "s", usage: () => ({}), verifySignature: async () => true, log: quiet });
    await wd2.ready();
    ok(Object.keys(wd2._store().subs).length === 2, "wallet-digest: a fresh instance sees both records from the row");
  }
  // ---- shared payTo listing ---------------------------------------------------
  {
    const { createSharedPayToStore } = await import("../src/shared-paytos.js");
    const W1 = "0x" + "1".repeat(40), W2 = "0x" + "2".repeat(40);
    const file = join(D1, "sor-shared-paytos.json");
    writeFileSync(file, JSON.stringify({ version: 1, wallets: { [W1]: { addedAt: "2026-10-01T00:00:00.000Z", note: "old" } } }));
    const s1 = createSharedPayToStore({ file, log: quiet });
    await s1.ready();
    ok(s1.has(W1), "shared-paytos: imported");
    const r = await s1.add(W2, { note: "new" });
    ok(r.changed === true, "shared-paytos: add resolves once stored");
    const s2 = createSharedPayToStore({ file: join(D2, "sor-shared-paytos.json"), log: quiet });
    await s2.ready();
    ok(s2.has(W1) && s2.has(W2), "shared-paytos: a fresh instance lists both from the row");
    ok((await s2.remove(W1)).changed === true, "shared-paytos: remove resolves");
    const s3 = createSharedPayToStore({ file: join(D2, "sor-shared-paytos.json"), log: quiet });
    await s3.ready();
    ok(!s3.has(W1) && s3.has(W2), "shared-paytos: the removal is in the row");
  }
  // ---- stripe subscriptions (merge-on-save keys + tally) --------------------
  {
    const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
    const file = join(D1, "stripe-subscriptions.json");
    writeFileSync(file, JSON.stringify({ sub_old: { subId: "sub_old", status: "active", product: "domain-monitor", target: "a.test" } }));
    writeFileSync(file + ".webhooks.json", JSON.stringify({ received: 5, verified: 4, rejected: 1, unconfigured: 0, byType: { x: 4 } }));
    const stripe = { checkout: { sessions: { create: async () => ({ id: "cs", url: "u" }) } }, webhooks: { constructEvent: () => { throw new Error("no"); } } };
    const subs = createStripeSubscriptions({ stripe, baseUrl: "https://t.example", storePath: file, onInvoicePaid: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    ok(subs.get("sub_old")?.status === "active", "stripe-subscriptions: imported");
    ok(subs.webhookStats().received === 5, "stripe-subscriptions: the tally is imported");
    const subs2 = createStripeSubscriptions({ stripe, baseUrl: "https://t.example", storePath: join(D2, "stripe-subscriptions.json"), onInvoicePaid: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    ok(subs2.get("sub_old")?.status === "active" && subs2.webhookStats().received === 5, "stripe-subscriptions: a fresh instance reads the row and the tally");
    const merged = await sdb.documents.mergeKeys("stripe-subscriptions.json", { sub_new: { subId: "sub_new", status: "active" } });
    ok(merged.body.sub_old && merged.body.sub_new, "stripe-subscriptions: the row is a key-merged object, so two writers never drop each other's records");
  }
  // ---- monitor scheduler: the lease replaces the file lock ----------------
  {
    const { createMonitorScheduler, LOCK_STALE_MS } = await import("../src/monitor-scheduler.js");
    const file = join(D1, "monitor-runs.json");
    writeFileSync(file, JSON.stringify({ lock: null, subs: { sub_1: { failures: 2, runs: [] } }, reports: { rep_1: { subId: "sub_1", kind: "domain", at: "2026-10-01T00:00:00.000Z", report: "r" } }, lastTickAt: null, lastTick: null }));
    const deps = { subs: { listActive: () => [] }, generate: async () => ({}), probeDomain: async () => ({}), normDomain: (d) => d, latestFiling: async () => null, resolveManager: async () => null, notify: async () => true, baseUrl: "https://t.example", log: quiet, sleep: async () => {} };
    const a = createMonitorScheduler({ ...deps, storePath: file, ownerId: "A" });
    await a.ready();
    ok(a._store().subs.sub_1?.failures === 2 && a.reportView("rep_1")?.status === "done", "monitors: state and a delivered report are imported");
    await sdb.leases.acquire("monitor-scheduler", { owner: "Z", ttlMs: LOCK_STALE_MS });
    ok((await a.tick()).skipped === "locked", "monitors: a tick skips while another container holds the lease");
    await sdb.leases.release("monitor-scheduler", { owner: "Z" });
    const t = await a.tick();
    ok(t.skipped === undefined && (await sdb.leases.holder("monitor-scheduler")) === null, "monitors: a tick runs under the lease and releases it");
    await a.flush();
    const b = createMonitorScheduler({ ...deps, storePath: join(D2, "monitor-runs.json"), ownerId: "B" });
    await b.ready();
    ok(b.reportView("rep_1")?.status === "done" && b._store().lastTickAt, "monitors: a fresh instance reads the tick's state from the row");
  }
  // ---- mpp reconcile state ------------------------------------------------
  {
    const { createMppReconciler } = await import("../src/mpp-reconcile.js");
    const file = join(D1, "mpp-reconcile.json");
    writeFileSync(file, JSON.stringify({ days: { "2026-10-01": { status: "clean" } }, window: null, lastRunAt: 1, lastError: null, runs: 3 }));
    const rec = createMppReconciler({ file, log: quiet });
    await new Promise((r) => setTimeout(r, 300));
    const st = await rec.status();
    ok(st && typeof st === "object", "mpp-reconcile: status reads after import");
  }
  // ---- email outcome / revenue last-good / backup status (module singletons) -
  {
    writeFileSync(join(D1, "email-status.json"), JSON.stringify({ ok: true, at: "2026-10-01T00:00:00.000Z", status: 200, code: null, provider: "p", failuresSinceOk: 0, sentTotal: 9, failedTotal: 1 }));
    process.env.EMAIL_STATUS_FILE = join(D1, "email-status.json");
    process.env.EMAIL_FROM = "x@y.test"; process.env.ZEPTOMAIL_TOKEN = "t";
    const em = await import("../src/email.js");
    em.emailSendStatus();
    await sdb.stateStoresReady();
    const full = em.emailSendStatus({ full: true });
    ok(full.sentTotal === 9 && full.status === "ok", "email: the last outcome is imported");
    em.noteEmailOutcome(false, { status: 429, code: "LE_102", provider: "p" });
    await new Promise((r) => setTimeout(r, 300));
    const row = await sdb.documents.get("email-status.json");
    ok(row && row.body.failedTotal === 2 && row.body.code === "LE_102", "email: a new outcome is written to the row");
  }
  // ---- append logs: outbound spend and wishes ---------------------------------
  {
    process.env.OUTBOUND_LEDGER_FILE = join(D1, "outbound-spend.ndjson");
    const { recordOutbound, OUTBOUND_STREAM } = await import("../src/outbound-ledger.js");
    await sdb.stateStoresReady(); // the boot reconcile runs before any request, as the server does
    recordOutbound({ chain: "base", payTo: "0x" + "a".repeat(40), amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "s", origin: "https://seller.test/x", result: "delivered", tx: "0xtx" });
    await new Promise((r) => setTimeout(r, 300));
    const lines = await sdb.logLines.read(OUTBOUND_STREAM);
    ok(lines.length === 1 && lines[0].body.chain === "base" && lines[0].body.origin === "seller.test", "outbound ledger: one row per signed payment, host only");
    ok(existsSync(join(D1, "outbound-spend.ndjson")), "outbound ledger: the file is written through as well");

    const wishFile = join(D1, "wishes.jsonl");
    writeFileSync(wishFile, [JSON.stringify({ need: "old wish one", source: "api", ts: 1 }), JSON.stringify({ need: "old wish one", source: "mcp", ts: 2 }), "{not json"].join("\n") + "\n");
    process.env.WISH_FILE = wishFile; // read at import: the module imports its file on first load
    const wish = await import("../src/wish.js");
    const wishTest = true;
    if (wishTest) {
      await sdb.stateStoresReady();
      const im = await sdb.imports.done(wish.WISH_STREAM);
      ok(im && (await sdb.logLines.count(wish.WISH_STREAM)) === 2, "wishes: the file's valid lines are imported once");
      // Roll-forward: a line the old build appended to the file alone is picked up at the next boot.
      const { appendFileSync } = await import("node:fs");
      appendFileSync(wishFile, JSON.stringify({ need: "written while rolled back", source: "api", ts: 3 }) + "\n");
      const added = await sdb.reconcileLogFile(wish.WISH_STREAM, wishFile, { log: () => {} });
      ok(added === 1 && (await sdb.logLines.count(wish.WISH_STREAM)) === 3, "wishes: a line past the stream's count is appended on reconcile");
      ok((await sdb.reconcileLogFile(wish.WISH_STREAM, wishFile, { log: () => {} })) === 0, "wishes: a second reconcile adds nothing");
    } else {
      console.log("skip - wish.js exposes no file setter for tests");
    }
  }
  ok((await sdb.stateStoresReady()) === "ready", "every registered store reports ready");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(D1, { recursive: true, force: true });
  rmSync(D2, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
