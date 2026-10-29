// An owed CARD refund (src/human-checkout.js: Stripe refused the refund of a
// failed report, the retries ran out) reads on the refundsOwed word of
// /api/gateway-status, the word the status Worker and the heartbeat page on,
// beside the refund ledger's rows: owed past the notice window, aging past
// the alarm hours, and the counts only for the operator. Boots the server on
// the file backends with a seeded report store (the store directory the
// server reads is fixed; an existing index file is kept and put back).
import "./lib/file-mode.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const DIR = join(existsSync("/data") ? "/data" : "/tmp", "human-checkout");
const ISSUES = join(DIR, "_issues.json");
mkdirSync(DIR, { recursive: true });
const kept = existsSync(ISSUES) ? readFileSync(ISSUES) : null;
const restore = () => { try { if (kept) writeFileSync(ISSUES, kept); else rmSync(ISSUES, { force: true }); } catch { /* best effort */ } };
const seed = (entries) => writeFileSync(ISSUES, JSON.stringify(entries));

const PORT = await getFreePort();
const TOKEN = "owed-card-test-operator-token-0123456789";
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
         AGENT402_OPERATOR_TOKEN: TOKEN, STRIPE_SECRET_KEY: "sk_test_offline_never_called" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const read = async (operator) => {
    const r = await fetch(`${base}/api/gateway-status`, operator ? { headers: { "X-Operator-Token": TOKEN } } : {});
    return (await r.json()).refundsOwed;
  };
  const MIN = 60_000, HOUR = 3600_000;
  const iso = (ago) => new Date(Date.now() - ago).toISOString();

  seed({});
  ok((await read(false)).status === "ok", "control: no owed card refund reads ok");

  seed({ cs_test_fresh: { kind: "refund-owed", at: iso(2 * MIN), attempts: 1 } });
  ok((await read(false)).status === "ok", "a card refund owed inside the notice window (a retry is due) does not page yet");

  seed({ cs_test_owed: { kind: "refund-owed", at: iso(20 * MIN), attempts: 6 } });
  const pub = await read(false);
  ok(pub.status === "owed" && Object.keys(pub).length === 1, `a card refund owed past the notice window reads owed, one word publicly (${JSON.stringify(pub)})`);
  const op = await read(true);
  ok(op.status === "owed" && op.cardOwedCount === 1 && op.cardAgingCount === 0, `the operator view counts it (${JSON.stringify(op)})`);

  seed({ cs_test_owed: { kind: "refund-owed", at: iso(20 * MIN), attempts: 6 }, cs_test_old: { kind: "refund-owed", at: iso(50 * HOUR), attempts: 6 } });
  const aging = await read(true);
  ok(aging.status === "aging" && aging.cardOwedCount === 2 && aging.cardAgingCount === 1, `one owed past the alarm hours reads aging (${JSON.stringify(aging)})`);

  rmSync(ISSUES, { force: true });
  ok((await read(false)).status === "ok", "control: once nothing is owed the word reads ok again");
} finally {
  restore();
  child.kill("SIGKILL");
}
if (fail) console.error(log.slice(-3000));
console.log(`\ntest-refund-owed-card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
