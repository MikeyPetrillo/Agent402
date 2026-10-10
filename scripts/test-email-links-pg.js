// The signed email links on a server in database mode, for a record another
// container made after this server last read the row: the confirm,
// unsubscribe and stop routes read the row on a miss (the *Async methods),
// so the link works instead of answering "did not work". Boots the server
// against a Postgres (required under CI); the records are made by a second
// engine instance on the same schema, standing in for the other container.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { requireTestPg } from "./lib/test-pg.js";
const { schema } = requireTestPg({ label: "test-email-links-pg" });
const sdb = await import("../src/state-db.js");
const { createFreeAlerts } = await import("../src/free-alerts.js");
const { createWalletDigest } = await import("../src/wallet-digest.js");
const { createFollowups } = await import("../src/followups.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The route answers once the change is applied in memory; its row write lands just after.
const eventually = async (f, ms = 5000) => { for (const end = Date.now() + ms; ; await sleep(50)) { try { if (await f()) return true; } catch { /* not yet */ } if (Date.now() > end) return false; } };
const SECRET = "email-links-test-secret";
const DIR = mkdtempSync(join(tmpdir(), "email-links-"));
const quiet = () => {};
// The server's own email stores keep their default files (outside DIR), and a
// database boot imports such a file once: every record here is new per run.
const RUN = Math.random().toString(36).slice(2, 10);
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
let log = "";
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, STATE_DB_SCHEMA: schema, FREE_MODE: "true", PORT: String(PORT), POW_SECRET: SECRET, FREE_ALERTS_SECRET: "", MPP_SECRET_KEY: "",
    FREE_ALERTS: "off", WALLET_DIGEST: "off", FOLLOWUPS: "off", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    STATS_DB_DIR: DIR, MEMORY_DB_FILE: join(DIR, "agent402.db"), POW_DB_PATH: join(DIR, "pow.db"), STATUS_DB_PATH: join(DIR, "status.db"),
    X402_ECONOMY_DB: join(DIR, "economy.db"), SALES_LEDGER_DB: join(DIR, "sales.db"), REFUND_DB_DIR: DIR, DECIDE_LEDGER_DB: join(DIR, "decide.db"),
    REVENUE_LEDGER_DB: join(DIR, "revenue.db"), TRAFFIC_DIR: join(DIR, "traffic"), WISH_FILE: join(DIR, "wishes.jsonl"), OUTBOUND_LEDGER_FILE: join(DIR, "outbound.ndjson"),
    HANGUP_FORGIVE_FILE: join(DIR, "hangup.json"), WALLET_DAILY_LEDGER_FILE: join(DIR, "spend.json"), EMAIL_STATUS_FILE: join(DIR, "email.json"), MPP_RECONCILE_FILE: join(DIR, "reconcile.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
  ok(up, "the server boots in database mode");
  if (!up) console.error(log.slice(-2000));

  // The other container makes one record of each kind, after this server read the rows.
  const fa = createFreeAlerts({ storePath: join(DIR, "other", "free-alerts.json"), probes: { insider: async () => ({ ids: [] }) }, validators: { insider: (t) => String(t).toUpperCase() }, sendEmail: async () => true, secret: SECRET, log: quiet });
  await fa.ready();
  await fa.signup({ email: `links-${RUN}@example.com`, kind: "insider", target: "TSTX", source: "test" });
  await fa.flush();
  const aid = Object.values((await sdb.documents.get("free-alerts.json")).body.alerts).find((a) => a.email === `links-${RUN}@example.com`)?.id;
  const conf = await fetch(`${B}/alerts/confirm?id=${aid}&k=${fa.sign(aid, "confirm")}`);
  ok(conf.status === 200 && /Alert confirmed/.test(await conf.text()), `an alert made on the other container is confirmed by its link here (${conf.status})`);
  ok(await eventually(async () => (await sdb.documents.get("free-alerts.json")).body.alerts[aid]?.status === "active"), "...and is active in the row");
  const unsub = await fetch(`${B}/alerts/unsubscribe?id=${aid}&k=${fa.sign(aid, "unsubscribe")}`, { method: "POST" });
  ok(unsub.status === 200, `its one-click unsubscribe answers 200 (${unsub.status})`);

  const wd = createWalletDigest({ storePath: join(DIR, "other", "wallet-digest.json"), sendEmail: async () => true, secret: SECRET, usage: () => ({}), verifySignature: async () => true, log: quiet });
  await wd.ready();
  const link = new URL(wd.preEnrolCredits({ keyId: `k_links_${RUN}`, email: `digest-${RUN}@example.com` }));
  await wd.flush();
  const did = link.searchParams.get("id");
  const dc = await fetch(`${B}/digest/confirm?id=${did}&k=${link.searchParams.get("k")}`);
  ok(dc.status === 200, `a digest made on the other container is confirmed by its link here (${dc.status})`);
  ok(await eventually(async () => (await sdb.documents.get("wallet-digest.json")).body.subs[did]?.status === "active"), "...and is active in the row");

  const fu = createFollowups({ storePath: join(DIR, "other", "followups.json"), sendEmail: async () => true, secret: SECRET, monitorFor: () => null, log: quiet });
  await fu.ready();
  const sid = `cs_links_${RUN}`;
  fu.enqueue({ sessionId: sid, email: `fu-${RUN}@example.com`, product: "p", kind: "k", label: "l", input: "i" });
  await fu.flush();
  const { createHmac } = await import("node:crypto");
  const stopK = createHmac("sha256", SECRET).update(`stop:${sid}`).digest("base64url").slice(0, 32);
  const st = await fetch(`${B}/followups/stop?id=${sid}&k=${stopK}`);
  ok(st.status === 200, `a follow-up made on the other container is stopped by its link here (${st.status})`);
  ok(await eventually(async () => Boolean((await sdb.documents.get("followups.json")).body.seqs[sid]?.stopped)), "...and is stopped in the row");
} finally {
  child.kill("SIGKILL");
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
