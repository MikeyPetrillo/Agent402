// The per-payer unsettled-spend ceiling (src/external-spend-guard.js) holds
// ACROSS replicas on a REAL Redis: two processes, each its own module
// instance, reserve for one payer at the same moment, and the payer's shared
// window never holds more than the ceiling (the reservation is one script on
// Redis, not a read and a separate add). Run without and with the state
// database (the chain ledger's Postgres path reserves the payer half first
// too). Controls: a settled spend frees its room for the other replica; a
// reservation the chain ceiling refuses gives its payer room back.
// Requires REDIS_URL (under CI a missing one fails); the database rounds run
// when STATE_DATABASE_URL is set.
import { spawn } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-external-spend-guard-redis: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '') and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
const CAP = 6, EACH = 1.5, PER_PROC = 4;

if (process.argv[2] === "child") {
  // One replica: PER_PROC reservations for the payer at XC_AT, all in flight at once.
  const G = await import("../src/external-spend-guard.js");
  await G.__ready();
  const at = Number(process.env.XC_AT) || 0;
  await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const payer = process.env.XC_PAYER;
  const chain = process.env.XC_CHAIN || undefined;
  const out = await Promise.all(Array.from({ length: PER_PROC }, () => G.reserveSpend(payer, EACH, { chain, maxUnsettledUsd: CAP, walletDailyMaxUsd: 1000, maxGlobalUnsettledUsd: 1000 })));
  const granted = out.filter((d) => d?.ok).length;
  if (process.env.XC_SETTLE === "1") for (const d of out) if (d?.ok) G.resolveSpend(d.handle, true);
  await new Promise((r) => setTimeout(r, 300));
  const { closeSharedRedis } = await import("../src/shared-limit.js");
  await closeSharedRedis();
  if (G.__backend === "pg") { await G.__flush(); const { closeStateDb } = await import("../src/state-db.js"); await closeStateDb(); }
  console.log(JSON.stringify({ granted }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "esg-redis-"));
const PREFIX = `esgr${process.pid}${Date.now().toString(36)}`;
const replica = (env) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SELF, "child"], { env: { ...process.env, SHARED_LIMITS_PREFIX: PREFIX, WALLET_DAILY_LEDGER_FILE: join(TMP, `w-${randomBytes(3).toString("hex")}.json`), ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`replica exited ${code}: ${out}`)); } });
});
const race = async (env) => {
  const payer = `0x${randomBytes(20).toString("hex")}`;
  const at = Date.now() + 2500;
  const rs = await Promise.all([replica({ ...env, XC_PAYER: payer, XC_AT: String(at) }), replica({ ...env, XC_PAYER: payer, XC_AT: String(at) })]);
  return { payer, granted: rs.map((r) => r.granted) };
};

const rounds = [{ label: "redis", env: { STATE_DATABASE_URL: "" } }];
if (String(process.env.STATE_DATABASE_URL || "").trim()) rounds.push({ label: "redis + database", env: { STATE_DB_SCHEMA: `t_${randomBytes(5).toString("hex")}`, XC_CHAIN: "base" } });
for (const { label, env } of rounds) {
  for (let i = 0; i < 3; i++) {
    const { granted } = await race(env);
    const total = granted[0] + granted[1];
    ok(total * EACH <= CAP && total === CAP / EACH, `${label}, race ${i + 1}: two replicas reserving $${EACH} x ${PER_PROC} each for one payer grant $${(total * EACH).toFixed(2)} in all (${granted.join("+")}), never above the $${CAP} ceiling`);
  }
  // Control: spends that settle free their room, so the other replica's next reservations pass.
  {
    const payer = `0x${randomBytes(20).toString("hex")}`;
    const a = await replica({ ...env, XC_PAYER: payer, XC_SETTLE: "1" });
    const b = await replica({ ...env, XC_PAYER: payer });
    ok(a.granted === CAP / EACH && b.granted === CAP / EACH, `${label}: settled spends free the payer's room for the other replica (${a.granted} then ${b.granted})`);
  }
}

// A reservation the chain ceiling refuses gives its payer room back (in process, shared mode).
{
  process.env.SHARED_LIMITS_PREFIX = PREFIX;
  process.env.WALLET_DAILY_LEDGER_FILE = join(TMP, "inproc.json");
  delete process.env.STATE_DATABASE_URL;
  const G = await import("../src/external-spend-guard.js");
  ok(G.__sharedPayerLedger === true, "the guard writes the payer ledger to the shared store");
  const payer = `0x${randomBytes(20).toString("hex")}`;
  const refused = await G.reserveSpend(payer, 5, { chain: "base", walletDailyMaxUsd: 1, maxUnsettledUsd: CAP });
  ok(refused.ok === false && refused.code === "wallet_daily_ceiling", "setup: the chain ceiling refuses a $5 spend");
  await new Promise((r) => setTimeout(r, 200));
  const after = await G.reserveSpend(payer, 5, { maxUnsettledUsd: CAP, maxGlobalUnsettledUsd: 1000 });
  ok(after.ok === true, `...and the payer's $${CAP} room is whole again (a $5 reservation passes: ${after.ok})`);
  // The global unsettled window is shared too: the replicas' unsettled spend
  // above (at least $24 across distinct payers) counts against this process.
  const other = `0x${randomBytes(20).toString("hex")}`;
  const global = await G.reserveSpend(other, 1, { maxUnsettledUsd: CAP, maxGlobalUnsettledUsd: 20 });
  ok(global.ok === false && global.code === "global_unsettled_ceiling", `the global ceiling counts other replicas' unsettled spend (code ${global.code})`);
  const { closeSharedRedis } = await import("../src/shared-limit.js");
  await closeSharedRedis();
}

console.log(`\ntest-external-spend-guard-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
