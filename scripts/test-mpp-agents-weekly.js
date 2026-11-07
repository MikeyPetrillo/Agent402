// Weekly outside MPP agents (operator-only, counts only). Offline ledger half
// against a throwaway DB, then a booted half for the operator route.
//
//   node scripts/test-mpp-agents-weekly.js
import "./lib/offline-stores.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const dir = mkdtempSync(join(tmpdir(), "a402-mppagents-"));
const DB = join(dir, "sales.db");
process.env.SALES_LEDGER_DB = DB;
const { recordSale, mppAgentsWeekly, mppAgentsThisWeek, weekStartOf } = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const DAY = 86_400_000, WEEK = 7 * DAY;
const NOW = Date.parse("2026-09-24T12:00:00Z"); // a Thursday
const THIS_WEEK = weekStartOf(NOW);
ok(new Date(THIS_WEEK).toISOString() === "2026-09-21T00:00:00.000Z", "weeks start Monday 00:00 UTC");

const realNow = Date.now;
const at = (ts, sale) => { Date.now = () => ts; try { recordSale(sale); } finally { Date.now = realNow; } };

const A = "0xAaAa000000000000000000000000000000000001"; // checksummed on purpose
const B = "0xbbbb000000000000000000000000000000000002";
const C = "0xcccc000000000000000000000000000000000003";
const BURNER = [...OUR_EVM_WALLETS][0];

// History: A paid over MPP evm long before the window (so A is RETURNING later).
at(THIS_WEEK - 30 * WEEK, { slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: A, tx: "t0", wire: "mpp" });
// B paid on plain x402 last week (all-rails history), first MPP this week.
at(THIS_WEEK - WEEK + DAY, { slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: B, tx: "t1", wire: "x402" });
// This week: A pays on Tempo charge AND the Base evm challenge -> one agent.
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: A.toLowerCase(), tx: "t2", wire: "mpp-tempo" });
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.002, rail: "usdc", network: "base", payer: A, tx: "t3", wire: "mpp" });
at(THIS_WEEK + 2 * DAY, { slug: "monitor", priceUsd: 5, rail: "usdc", network: "tempo", payer: B, tx: "t4", wire: "mpp-tempo-subscription" });
// C: brand new, Tempo charge.
at(THIS_WEEK + 2 * DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: C, tx: "t5", wire: "mpp-tempo" });
// Internal traffic is excluded: synthetic flag and a burner payer.
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: "0xdddd000000000000000000000000000000000004", tx: "t6", wire: "mpp-tempo", synthetic: true });
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: BURNER, tx: "t7", wire: "mpp" });
// A free (proof-of-work) call is not a payment.
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.001, rail: "pow", network: null, payer: C, tx: null, wire: null });
// A payer-less MPP payment counts in payments, never as an agent.
at(THIS_WEEK + DAY, { slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: null, tx: "t8", wire: "mpp-tempo" });

const r = mppAgentsWeekly({ weeks: 12, now: NOW });
ok(r.weeks.length === 12 && r.allRails.weeks.length === 12, "12 weekly rows for MPP and for all rails");
ok(r.weeks[11].weekStart === "2026-09-21" && r.weeks[0].weekStart === "2026-07-06", "window ends on the current week");
const cur = r.weeks[11];
ok(cur.distinctAgents === 3, `internal excluded, one wallet across Tempo + Base counts once (got ${cur.distinctAgents})`);
ok(cur.newAgents === 2 && cur.returningAgents === 1, `new vs returning measured against all MPP history (new ${cur.newAgents}, returning ${cur.returningAgents})`);
ok(cur.payments === 5 && cur.unattributedPayments === 1, `payments count external MPP settles incl. payer-less (got ${cur.payments}/${cur.unattributedPayments})`);
ok(Math.abs(cur.usd - 5.005) < 1e-9, `usd sums external MPP payments (got ${cur.usd})`);
ok(cur.byMethod.tempoCharge.distinctAgents === 2 && cur.byMethod.evm.distinctAgents === 1 && cur.byMethod.tempoSubscription.distinctAgents === 1, "split by method");
ok(r.weeks[10].distinctAgents === 0, "last week had no MPP agents (B paid on x402)");
// The operator sales page's count reads the week alone, without the history scans.
ok(mppAgentsThisWeek(NOW) === cur.distinctAgents && mppAgentsThisWeek(NOW - WEEK) === r.weeks[10].distinctAgents && mppAgentsThisWeek(THIS_WEEK) === cur.distinctAgents && mppAgentsThisWeek(THIS_WEEK + WEEK) === 0,
  `mppAgentsThisWeek equals the weekly series' current-week count (${mppAgentsThisWeek(NOW)}), last week's, and none for next week`);
const allCur = r.allRails.weeks[11], allPrev = r.allRails.weeks[10];
ok(allPrev.distinctAgents === 1 && allPrev.newAgents === 1, "all-rails series counts the x402 payer");
ok(allCur.distinctAgents === 3 && allCur.newAgents === 1 && allCur.returningAgents === 2, `all rails: B returning (paid last week), A returning, C new (got ${JSON.stringify(allCur)})`);
// A blank payer string (a row the ledger did not write through recordSale,
// which stores null) is never an agent, in the series or in the week count.
const Database = createRequire(import.meta.url)("better-sqlite3");
const raw = new Database(DB);
const insertRaw = raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, 'uuid', 0.001, 'usdc', 'tempo', ?, ?, 0, 'mpp-tempo')");
insertRaw.run(THIS_WEEK + DAY, "", "t9");
const rBlank = mppAgentsWeekly({ weeks: 12, now: NOW }).weeks[11];
ok(rBlank.distinctAgents === 3 && rBlank.unattributedPayments === 2, `the series reads a blank payer as unattributed, not an agent (agents ${rBlank.distinctAgents}, unattributed ${rBlank.unattributedPayments})`);
ok(mppAgentsThisWeek(NOW) === 3 && mppAgentsThisWeek(NOW) === rBlank.distinctAgents, `the week count never counts a blank or missing payer (got ${mppAgentsThisWeek(NOW)}, want 3)`);

const body = JSON.stringify(r);
ok(!/0x[0-9a-f]{40}/i.test(body), "no payer address anywhere in the answer");

// --- booted half: operator route ---------------------------------------------
const TOKEN = "operator-test-secret-mpp";
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;
// The server reads the ledger at its own clock, so the route's fixture lands
// in the real current week: two outside agents (one paying twice), plus a
// blank and a missing payer that are payments but never agents.
const D = "0xdddd0000000000000000000000000000000000d1", E = "0xeeee0000000000000000000000000000000000e1";
recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: D, tx: "n1", wire: "mpp-tempo" });
recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: D, tx: "n2", wire: "mpp" });
recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: E, tx: "n3", wire: "mpp-tempo" });
recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "tempo", payer: null, tx: "n4", wire: "mpp-tempo" });
insertRaw.run(Date.now(), "", "n5");
raw.close();
ok(mppAgentsThisWeek() === 2 && mppAgentsWeekly({ weeks: 1 }).weeks[0].distinctAgents === 2, `the current week holds two agents in the series and the count (got ${mppAgentsThisWeek()})`);
// The sales page's count must not run the weekly series' whole-history
// first-payment scans. A preload counts every execution of those statements in
// the server process; the series route is the live control that it counts.
const SCAN_LOG = join(dir, "history-scans.log");
const PRELOAD = join(dir, "count-history-scans.mjs");
writeFileSync(PRELOAD, `import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
const Database = createRequire(${JSON.stringify(fileURLToPath(new URL("../package.json", import.meta.url)))})("better-sqlite3");
const prepare = Database.prototype.prepare;
let patched = false;
Database.prototype.prepare = function (sql) {
  const st = prepare.call(this, sql);
  if (!patched) {
    patched = true;
    const proto = Object.getPrototypeOf(st);
    for (const m of ["all", "get", "iterate"]) {
      const f = proto[m];
      proto[m] = function (...a) { if (/MIN\\(ts\\) AS first_ts/.test(this.source)) appendFileSync(${JSON.stringify(SCAN_LOG)}, "scan\\n"); return f.apply(this, a); };
    }
  }
  return st;
};
`);
const scans = () => (existsSync(SCAN_LOG) ? readFileSync(SCAN_LOG, "utf8").split("\n").filter(Boolean).length : 0);
const child = spawn(process.execPath, ["--import", PRELOAD, "src/server.js"], {
  env: { ...process.env, ...ownStoreEnv("mppagents"), FREE_MODE: "true", PORT: String(PORT), AGENT402_OPERATOR_TOKEN: TOKEN, SALES_LEDGER_DB: DB, X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const finish = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } console.log(`\n${passed} passed, ${failed} failed`); process.exit(code); };
let up = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* */ }
  await new Promise((res) => setTimeout(res, 500));
}
ok(up, "server booted");
if (!up) { console.error(log.slice(-800)); finish(1); }
const scansBeforeSales = scans();
const sales = await fetch(`${base}/__operator/sales.json`, { headers: { "x-operator-token": TOKEN } });
const sj = await sales.json().catch(() => null);
const scansAfterSales = scans();
ok(sales.status === 200 && sj?.mppAgentsThisWeek === 2, `sales.json returns this week's MPP agent count, blank and missing payers excluded (got ${sj?.mppAgentsThisWeek})`);
ok(sj?.mppAgentsThisWeek === mppAgentsWeekly({ weeks: 1 }).weeks[0].distinctAgents, "sales.json's count equals the weekly series' current week");
ok(scansAfterSales === scansBeforeSales, `sales.json runs none of the series' history scans (${scansAfterSales - scansBeforeSales} ran)`);
const anon = await fetch(`${base}/__operator/mpp-agents.json`);
ok(anon.status === 404, `no token -> 404 (got ${anon.status})`);
const bad = await fetch(`${base}/__operator/mpp-agents.json`, { headers: { "x-operator-token": "wrong" } });
ok(bad.status === 404, `wrong token -> 404 (got ${bad.status})`);
const good = await fetch(`${base}/__operator/mpp-agents.json`, { headers: { "x-operator-token": TOKEN } });
const gj = await good.json().catch(() => null);
ok(good.status === 200 && Array.isArray(gj?.weeks) && gj.weeks.length === 12 && Array.isArray(gj?.allRails?.weeks), "operator gets the weekly series");
ok(scans() > scansAfterSales, `control: the preload counts the series route's history scans (${scans() - scansAfterSales})`);
ok(gj?.weeks?.[11]?.distinctAgents === 2, "the series route's current week holds the same two agents");
ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(gj)), "operator route carries no payer address");
finish(failed ? 1 : 0);
