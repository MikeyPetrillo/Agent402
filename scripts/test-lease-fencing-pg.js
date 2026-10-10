// Lease fencing at the external effect: a scheduled tick whose lease was lost
// part-way (no renew landed for a full ttl, so another container may hold it
// now) stops before its next send, pull or paid run, and hands back the claim
// it took. Each loop is driven for real against a Postgres (required under
// CI); the loss is made by moving the clock past the lease's ttl inside the
// first external effect, so the second one must not happen.
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-lease-fencing-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "lease-fencing-"));
const quiet = () => {};
const secret = "fencing-secret";
const DAY = 86_400_000;
const realNow = Date.now;
// Past every loop's lease ttl (the longest is the monitor lock, 20 min).
const loseLease = () => { Date.now = () => realNow() + 2 * 60 * 60_000; };
const restore = () => { Date.now = realNow; };

try {
  // ---- follow-ups: after the claim, before the send -----------------------------
  {
    const { createFollowups } = await import("../src/followups.js");
    let clock = realNow();
    let sends = 0, armed = true;
    const fu = createFollowups({
      storePath: join(DIR, "fu", "followups.json"), secret, now: () => clock, log: quiet,
      monitorFor: () => ({ product: "m", label: "Monitor", priceUsd: "$1" }),
      sendEmail: async () => { sends++; if (armed) loseLease(); return true; },
    });
    await fu.ready();
    for (const n of [1, 2, 3]) fu.enqueue({ sessionId: `cs_f${n}`, email: `f${n}@example.com`, product: "p", kind: "k", label: "l", input: `i${n}` });
    await fu.flush();
    clock += 3 * DAY;
    let r;
    try { r = await fu.tick(); } finally { restore(); }
    ok(sends === 1 && r?.lost === true, `followups: after the lease is lost the tick sends nothing more (${sends} sent, ${JSON.stringify(r)})`);
    const seqs = Object.values((await sdb.documents.get("followups.json")).body.seqs);
    ok(seqs.filter((x) => typeof x.sent?.monitor === "number").length === 1 && !seqs.some((x) => typeof x.sent?.monitor === "string"), "followups: one step is recorded sent, and no claim is left on the others");
    sends = 0; armed = false;
    const r2 = await fu.tick();
    ok(sends === 2 && !r2.lost, `followups: the next tick under a held lease sends the rest (${sends})`);
  }

  // ---- free alerts: after the claim, before the change email ---------------------
  {
    const { createFreeAlerts } = await import("../src/free-alerts.js");
    let clock = realNow();
    let ids = ["a"];
    let armed = false, sends = 0;
    const fa = createFreeAlerts({
      storePath: join(DIR, "fa", "free-alerts.json"), probes: { domain: async () => ({ ids }) }, validators: { domain: (t) => t },
      now: () => clock, secret, log: quiet,
      sendEmail: async () => { if (armed) { sends++; loseLease(); } return true; },
    });
    await fa.ready();
    const key = (id, p) => createHmac("sha256", secret).update(`${p}:${id}`).digest("base64url").slice(0, 32);
    for (const t of ["x", "y", "z"]) await fa.signup({ email: `${t}@example.com`, kind: "domain", target: `${t}.example` });
    await fa.flush();
    for (const a of Object.values((await sdb.documents.get("free-alerts.json")).body.alerts)) ok((await fa.confirmAsync(a.id, key(a.id, "confirm"))).ok, `free-alerts: confirmed ${a.email}`);
    await fa.flush();
    await fa.tick({ force: true }); // baselines
    ids = ["a", "b"]; clock += 2 * DAY; armed = true;
    let r;
    try { r = await fa.tick({ force: true }); } finally { restore(); }
    ok(sends === 1 && r?.lost === true, `free-alerts: after the lease is lost no further change email goes (${sends} sent, ${JSON.stringify(r)})`);
    const alerts = Object.values((await sdb.documents.get("free-alerts.json")).body.alerts);
    ok(alerts.filter((a) => a.lastNotifiedAt).length === 1, `free-alerts: only the alert that was emailed carries its notification (${alerts.map((a) => a.lastNotifiedAt ? 1 : 0).join(",")})`);
  }

  // ---- wallet digest: after the claim, before the digest -----------------------------
  {
    const { createWalletDigest } = await import("../src/wallet-digest.js");
    let clock = realNow();
    let armed = false, sends = 0;
    const usage = () => ({ totals: { calls: 3, paidUsd: 0.03 }, bySlug: [{ slug: "hash", calls: 3, usd: 0.03 }], byNetwork: {} });
    const wd = createWalletDigest({
      storePath: join(DIR, "wd", "wallet-digest.json"), secret, now: () => clock, usage, verifySignature: async () => true, log: quiet,
      sendEmail: async () => { if (armed) { sends++; loseLease(); } return true; },
    });
    await wd.ready();
    const key = (id, p) => createHmac("sha256", secret).update(`digest:${p}:${id}`).digest("base64url").slice(0, 32);
    const idOf = (l) => new URL(l).searchParams.get("id");
    const links = ["k1", "k2", "k3"].map((k) => wd.preEnrolCredits({ keyId: k, email: `${k}@example.com` }));
    await wd.flush();
    for (const l of links) ok((await wd.confirmAsync(idOf(l), key(idOf(l), "confirm"))).ok, "wallet-digest: confirmed");
    await wd.flush();
    armed = true;
    let r;
    try { r = await wd.tick(); } finally { restore(); }
    ok(sends === 1 && r?.lost === true, `wallet-digest: after the lease is lost no further digest goes (${sends} sent, ${JSON.stringify(r)})`);
    const subs = Object.values((await sdb.documents.get("wallet-digest.json")).body.subs);
    ok(subs.filter((x) => x.lastSentAt).length === 1, `wallet-digest: only the digest that went has its clock advanced (${subs.map((x) => x.lastSentAt ? 1 : 0).join(",")})`);
  }

  // ---- monitor scheduler: before each paid run ---------------------------------
  {
    const { createMonitorScheduler } = await import("../src/monitor-scheduler.js");
    let generated = 0;
    const recs = ["one", "two", "three"].map((t) => ({ subId: `sub_${t}`, product: "domain-monitor", target: `${t}.example`, status: "active" }));
    const M = createMonitorScheduler({
      subs: { listActive: () => recs }, storePath: join(DIR, "m", "monitor-runs.json"), ownerId: "M",
      generate: async () => { generated++; if (generated === 1) loseLease(); return { report: "r", title: "t" }; },
      probeDomain: async () => ({ signals: { grade: "A" }, fingerprint: "fp" }), normDomain: (d) => d,
      latestFiling: async () => null, resolveManager: async () => null, notify: async () => true,
      baseUrl: "https://t.example", log: quiet, sleep: async () => {},
    });
    await M.ready();
    let r;
    try { r = await M.tick(); } finally { restore(); }
    ok(generated === 1 && r?.lost === true, `monitors: after the lease is lost no further paid run starts (${generated} run, ${JSON.stringify(r)})`);
    const row = (await sdb.documents.get("monitor-runs.json"))?.body;
    ok(row?.subs?.sub_one?.lastFullAt && !row?.subs?.sub_two?.lastFullAt && !(row?.subs?.sub_two?.failures), "monitors: the run that happened is stored; the others are untouched (no failure counted)");
    ok((await sdb.leases.holder("monitor-scheduler")) === null, "monitors: the lease row is released");
    // The database cannot answer: no container runs the tick, however old.
    const old = createMonitorScheduler({ subs: { listActive: () => recs }, storePath: join(DIR, "m2", "monitor-runs.json"), ownerId: "O", uptimeMs: () => 60 * 60_000,
      generate: async () => { generated++; return { report: "r" }; }, probeDomain: async () => ({}), normDomain: (d) => d, latestFiling: async () => null, resolveManager: async () => null, notify: async () => true, baseUrl: "https://t.example", log: quiet, sleep: async () => {} });
    await old.ready();
    const before = generated;
    const live = process.env.STATE_DATABASE_URL;
    await sdb.closeStateDb();
    process.env.STATE_DATABASE_URL = "postgres://postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=1";
    const t = await old.tick();
    await sdb.closeStateDb();
    process.env.STATE_DATABASE_URL = live;
    ok(t.skipped === "locked" && generated === before, `monitors: with the database down even an old container skips its tick (${JSON.stringify(t)})`);
  }
} finally {
  restore();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
