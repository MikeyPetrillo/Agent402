// A write that fails is kept and retried, never dropped after the in-memory
// view was updated: the status history, the economy history, the shared PoW
// replay table, the Stripe shadow queue and the wish log each record while
// their table is unreachable (renamed away), then the table comes back and
// the next flush lands every row exactly once. Requires STATE_DATABASE_URL
// (CI fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
const { schema } = requireTestPg({ label: "test-store-write-retry-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "store-write-retry-"));
Object.assign(process.env, {
  STATUS_DB_PATH: join(DIR, "status.db"), X402_ECONOMY_DB: join(DIR, "econ.db"), POW_DB_PATH: join(DIR, "pow.db"), POW_ALLOW_EPHEMERAL: "true",
  POW_SECRET: "write-retry-secret", POW_DIFFICULTY: "8", POW_PG_REFRESH_MS: "60000", WISH_FILE: join(DIR, "wishes.jsonl"),
});
const sdb = await import("../src/state-db.js");
const q = (sql, p) => sdb.stateQuery(sql, p);
const count = async (table, where = "true", p = []) => Number((await q(`SELECT count(*)::bigint AS n FROM ${schema}.${table} WHERE ${where}`, p)).rows[0].n);
const away = (t) => q(`ALTER TABLE ${schema}.${t} RENAME TO ${t}_away`);
const back = (t) => q(`ALTER TABLE ${schema}.${t}_away RENAME TO ${t}`);
const quiet = console.error; const quietW = console.warn;
const mute = () => { console.error = () => {}; console.warn = () => {}; };
const unmute = () => { console.error = quiet; console.warn = quietW; };
try {
  // ---- status history -------------------------------------------------------
  const ss = await import("../src/status-store.js");
  ok(await ss.statusStoreReady(), "status: loaded");
  await away("status_probes");
  mute(); ss.recordProbe({ ts: 1_800_000_000_000, source: "s", component: "retry", ok: true }); const f1 = await ss.statusStoreFlush(); unmute();
  ok(ss.probeRows("retry", 0).length === 1, "status: the row is in the mirror while the write fails");
  await back("status_probes");
  await ss.statusStoreFlush();
  ok((await count("status_probes", "component = 'retry'")) === 1, `status: the failed write landed on the next flush, once (first flush ${f1})`);

  // ---- economy history ------------------------------------------------------
  const ec = await import("../src/x402-economy.js");
  ok(await ec.economyHistoryReady(), "economy: loaded");
  await away("economy_daily");
  mute(); const w1 = await ec.recordDailyHistory([{ day: "2026-03-01", settlements: 9, payers: 3 }]); unmute();
  ok(w1 === false, "economy: the write reports it did not land");
  await back("economy_daily");
  await ec.economyHistoryFlush();
  ok((await count("economy_daily", "day = '2026-03-01' AND settlements = 9")) === 1, "economy: the failed day landed on the next flush");

  // ---- shared PoW replay ----------------------------------------------------
  const pw = await import("../src/pow.js");
  ok(await pw.powReplayReady(), "pow: loaded");
  const { createHash } = await import("node:crypto");
  const solve = (ch) => { for (let n = 0; ; n++) { const h = createHash("sha256").update(`${ch.challenge}:${n}`).digest(); let bits = 0; for (const b of h) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } if (bits >= ch.difficulty) return `${ch.token}:${n}`; } };
  await away("pow_used");
  const ch = pw.issueChallenge("hash");
  mute(); ok(pw.verifySolution(solve(ch), "hash").ok === true, "pow: a solution is accepted while the shared table is away"); await pw.powReplayFlush(); unmute();
  await back("pow_used");
  await pw.powReplayFlush();
  ok((await count("pow_used", "challenge = $1", [ch.challenge])) === 1, "pow: the accepted challenge reached the shared table on the next flush");

  // ---- Stripe shadow queue --------------------------------------------------
  const sh = await import("../src/stripe-shadow-ledger.js");
  const shadow = sh.createShadowLedger({ env: { ...process.env, STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_SHADOW_INTERVAL_MS: "0" }, dbFile: join(DIR, "shadow.db"), log: () => {} });
  await shadow.ready();
  await away("stripe_shadow");
  mute(); shadow.record({ slug: "t", priceUsd: 0.01, rail: "usdc", network: "base", tx: "0x" + "3".repeat(64) }); await shadow.flush(); unmute();
  await back("stripe_shadow");
  await shadow.flush();
  ok((await count("stripe_shadow")) === 1, "shadow: the enqueue that failed landed on the next flush");

  // ---- wish log -------------------------------------------------------------
  const wi = await import("../src/wish.js");
  await wi.wishStoreReady();
  await away("log_lines");
  mute(); wi.recordWish({ need: "retry me please", source: "api" }); await wi.wishFlush(); unmute();
  await back("log_lines");
  await wi.wishFlush();
  ok((await count("log_lines", "stream = 'wishes'")) === 1, "wish: the append that failed landed on the next flush");
} finally {
  unmute();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-store-write-retry-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
