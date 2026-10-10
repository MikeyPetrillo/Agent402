// The signed email links in database mode when the row write cannot land.
// An unsubscribe or stop clicked while the database is unreachable must not
// answer ok and then email the person again: the async methods (the routes)
// wait for the row write and answer "unavailable" (the routes send 503, so a
// mail client's one-click POST retries); the retry lands. A confirm for a
// record the other container already unsubscribed answers from the row.
// Requires STATE_DATABASE_URL (CI fails without it; locally it skips).
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

requireTestPg({ label: "test-email-links-outage-pg" });
const relay = await startPgRelay(process.env.STATE_DATABASE_URL);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "800";
const sdb = await import("../src/state-db.js");
const { createFreeAlerts } = await import("../src/free-alerts.js");
const { createFollowups } = await import("../src/followups.js");
const { createWalletDigest } = await import("../src/wallet-digest.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "email-links-outage-"));
const secret = "s", quiet = () => {};
const sig = (p, id) => createHmac("sha256", secret).update(`${p}:${id}`).digest("base64url").slice(0, 32);
const heal = async () => { relay.heal(); for (let i = 0; i < 6; i++) { try { await sdb.stateQuery("SELECT 1"); return; } catch { /* a dead pooled connection */ } } };
let clock = Date.now();

try {
  // ---- free alerts: unsubscribe during an outage, then the retry ----------------
  {
    const sent = []; let ids = ["a"];
    const mk = (sub) => createFreeAlerts({ storePath: join(DIR, sub, "free-alerts.json"), probes: { domain: async () => ({ ids }) }, validators: { domain: (t) => t }, now: () => clock, secret, sendEmail: async (m) => { sent.push(m.to); return true; }, log: quiet });
    const A = mk("a");
    await A.ready();
    await A.signup({ email: "x@example.com", kind: "domain", target: "x.example" }); await A.flush();
    const id = Object.values((await sdb.documents.get("free-alerts.json")).body.alerts)[0].id;
    A.confirm(id, sig("confirm", id)); await A.flush();
    await A.tick({ force: true }); // baseline
    relay.cut();
    const r = await A.unsubscribeAsync(id, sig("unsubscribe", id));
    await A.flush();
    ok(!r.ok && r.reason === "unavailable", `free-alerts: an unsubscribe whose row write fails answers unavailable (${JSON.stringify(r)})`);
    await heal();
    const r2 = await A.unsubscribeAsync(id, sig("unsubscribe", id));
    ok(r2.ok === true, "free-alerts: the retried unsubscribe answers ok");
    ok((await sdb.documents.get("free-alerts.json")).body.alerts[id].status === "unsubscribed", "free-alerts: ...and the row is unsubscribed");
    ids = ["a", "b"]; clock += 2 * 86_400_000; sent.length = 0;
    await A.tick({ force: true });
    ok(sent.length === 0, `free-alerts: no email follows the unsubscribe (${sent.length})`);

    // A signed link for a record this container never read, during an outage.
    relay.cut();
    const r3 = await mk("c").unsubscribeAsync("al_abcdefgh12", sig("unsubscribe", "al_abcdefgh12"));
    ok(!r3.ok && r3.reason === "unavailable", `free-alerts: a link for an unread record during an outage answers unavailable (${JSON.stringify(r3)})`);
    await heal();

    // Confirm on this container for a record the other container unsubscribed.
    const B = mk("b");
    await B.ready();
    await B.signup({ email: "y@example.com", kind: "domain", target: "y.example" }); await B.flush();
    const id2 = Object.values((await sdb.documents.get("free-alerts.json")).body.alerts).find((a) => a.email === "y@example.com").id;
    const A2 = mk("a2"); await A2.ready(); // reads the row: id2 is pending here
    ok(A2._store().alerts[id2]?.status === "pending", "free-alerts: the second container holds the record as pending");
    await B.unsubscribeAsync(id2, sig("unsubscribe", id2));
    const c = await A2.confirmAsync(id2, sig("confirm", id2));
    ok(!c.ok && c.reason === "unsubscribed", `free-alerts: confirming a record the other container unsubscribed answers unsubscribed (${JSON.stringify(c)})`);
    ok((await sdb.documents.get("free-alerts.json")).body.alerts[id2].status === "unsubscribed", "free-alerts: ...and the row stays unsubscribed");
  }

  // ---- follow-ups: stop during an outage, then the retry --------------------------
  {
    const sent = [];
    const F = createFollowups({ storePath: join(DIR, "f", "followups.json"), secret, now: () => clock, monitorFor: () => ({ product: "m", label: "Monitor", priceUsd: "$1" }), sendEmail: async (m) => { sent.push(m.to); return true; }, log: quiet });
    await F.ready();
    F.enqueue({ sessionId: "cs_test_1234", email: "b@example.com", product: "p", kind: "domain", label: "R", input: "x" }); await F.flush();
    const k = createHmac("sha256", secret).update("stop:cs_test_1234").digest("base64url").slice(0, 32);
    relay.cut();
    const r = await F.stopAsync("cs_test_1234", k);
    await F.flush();
    ok(!r.ok && r.reason === "unavailable", `followups: a stop whose row write fails answers unavailable (${JSON.stringify(r)})`);
    await heal();
    const r2 = await F.stopAsync("cs_test_1234", k);
    ok(r2.ok === true, "followups: the retried stop answers ok");
    ok(Boolean((await sdb.documents.get("followups.json")).body.seqs.cs_test_1234?.stopped), "followups: ...and the row is stopped");
    clock += 3 * 86_400_000;
    await F.tick();
    ok(sent.length === 0, `followups: no email follows the stop (${sent.length})`);
  }

  // ---- weekly digest: unsubscribe during an outage, confirm after unsubscribe ------
  {
    const mk = (sub) => createWalletDigest({ storePath: join(DIR, sub, "wallet-digest.json"), sendEmail: async () => true, secret, usage: () => ({}), verifySignature: async () => true, now: () => clock, log: quiet });
    const D = mk("d");
    await D.ready();
    const link = new URL(D.preEnrolCredits({ keyId: "k_outage_1", email: "d@example.com" }));
    await D.flush();
    const id = link.searchParams.get("id");
    relay.cut();
    const r = await D.unsubscribeAsync(id, sig("digest:unsubscribe", id));
    await D.flush();
    ok(!r.ok && r.reason === "unavailable", `wallet-digest: an unsubscribe whose row write fails answers unavailable (${JSON.stringify(r)})`);
    await heal();
    const r2 = await D.unsubscribeAsync(id, sig("digest:unsubscribe", id));
    ok(r2.ok === true && (await sdb.documents.get("wallet-digest.json")).body.subs[id].status === "unsubscribed", "wallet-digest: the retry answers ok and the row is unsubscribed");

    const link2 = new URL(D.preEnrolCredits({ keyId: "k_outage_2", email: "e@example.com" }));
    await D.flush();
    const id2 = link2.searchParams.get("id");
    const D2 = mk("d2"); await D2.ready();
    ok(D2._store().subs[id2] && D2._store().subs[id2].status !== "unsubscribed", "wallet-digest: the second container holds the record as not unsubscribed");
    await D.unsubscribeAsync(id2, sig("digest:unsubscribe", id2));
    const c = await D2.confirmAsync(id2, link2.searchParams.get("k"));
    ok(!c.ok && c.reason === "unsubscribed", `wallet-digest: confirming a record the other container unsubscribed answers unsubscribed (${JSON.stringify(c)})`);
  }
} finally {
  relay.heal();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
