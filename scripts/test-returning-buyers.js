#!/usr/bin/env node
// The returning-buyer baseline (returningBuyers in src/sales-ledger.js and the
// operator route /__operator/returning-buyers.json), offline:
//   - paid days per outside wallet over 30 and 60 days, bucketed 1, 2, 3-7
//     and 8 or more, with the one-day share and the median;
//   - the day-1 to day-2 return rate: new wallets (first paid day in the scan)
//     whose 7 follow-up days have ended, returned when they paid again on a
//     later UTC day inside them; per rail of the first sale;
//   - our own traffic (internal rows, our wallets by address) never counts,
//     and the organic figures leave out a wallet that walked the catalog;
//   - weekly cohorts by the UTC week of the first day;
//   - the route answers the operator only, with counts and no address.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "returning-buyers-"));
process.env.SALES_LEDGER_DB = join(TMP, "sales.db");
const sl = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12); // a Wednesday, noon UTC
const T = Math.floor(NOW / DAY);
const at = (day, hour = 10) => day * DAY + hour * 3_600_000;
const addr = (n) => `0x${String(n).padStart(40, "0")}`;
const raw = new Database(process.env.SALES_LEDGER_DB);
const ins = raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
let txn = 0;
const sale = (payer, day, { slug = "hash", network = "base", internal = 0, hour = 10 } = {}) => ins.run(at(day, hour), slug, 0.002, "usdc", network, payer, `0xtx${++txn}`, internal);

const A = addr(1), B = addr(2), C = addr(3), D = addr(4), E = addr(5), F = addr(6), G = addr(7), H = addr(8), J = addr(10);
sale(A, T - 20); sale(A, T - 18);                    // new, back on day 3: returned
sale(B, T - 20);                                     // new, never back
sale(C, T - 20); sale(C, T - 10);                    // new, back after 10 days: not inside the 7
sale(D, T - 3);                                      // new, follow-up not over
sale(E, T - 100); sale(E, T - 25); sale(E, T - 24);  // first day before both windows: not new
sale(F, T - 45, { network: "solana" }); sale(F, T - 44, { network: "solana" }); // new in 60 only, returned
for (let i = 0; i < 40; i++) sale(G, T - 15, { slug: `tool-${i}` }); // walked the catalog
sale(G, T - 14);
for (let d = T - 29; d <= T - 20; d++) sale(J, d);   // ten paid days
sale(H, T - 20, { internal: 1 }); sale(H, T - 19, { internal: 1 }); // our own traffic
const ours = [...OUR_EVM_WALLETS][0];
sale(String(ours).toLowerCase(), T - 20); sale(String(ours).toLowerCase(), T - 19); // our wallet, recorded as outside

const out = sl.returningBuyers({ now: NOW });
const w30 = out.windows["30"], w60 = out.windows["60"];
ok(out.scanDays === 120 && out.followUpDays === 7, `scan and follow-up spans (${out.scanDays}, ${out.followUpDays})`);
ok(w30.all.wallets === 7 && JSON.stringify(w30.all.paidDays) === JSON.stringify({ "1": 2, "2": 4, "3-7": 0, "8+": 1 }), `30 days: 7 outside wallets bucketed by paid days (${w30.all.wallets} ${JSON.stringify(w30.all.paidDays)})`);
ok(w30.all.oneDayShare === 0.286 && w30.all.medianPaidDays === 2, `30 days: one-day share and median (${w30.all.oneDayShare}, ${w30.all.medianPaidDays})`);
ok(w30.all.newWallets === 6 && w30.all.followedUp === 5 && w30.all.returned === 3 && w30.all.dayOneToDayTwoRate === 0.6,
  `30 days: 6 new, 5 followed up, 3 back inside 7 days (${w30.all.newWallets} ${w30.all.followedUp} ${w30.all.returned} ${w30.all.dayOneToDayTwoRate})`);
ok(w30.organic.wallets === 6 && w30.organic.followedUp === 4 && w30.organic.returned === 2 && w30.organic.dayOneToDayTwoRate === 0.5,
  `30 days organic: the catalog walker is left out (${w30.organic.wallets} ${w30.organic.followedUp} ${w30.organic.returned})`);
ok(w60.all.wallets === 8 && w60.all.newWallets === 7 && w60.all.followedUp === 6 && w60.all.returned === 4 && w60.all.dayOneToDayTwoRate === 0.667,
  `60 days: the wallet first seen 45 days ago joins (${w60.all.wallets} ${w60.all.newWallets} ${w60.all.followedUp} ${w60.all.returned} ${w60.all.dayOneToDayTwoRate})`);
ok(w60.all.byRail.base?.followedUp === 5 && w60.all.byRail.base?.returned === 3 && w60.all.byRail.solana?.followedUp === 1 && w60.all.byRail.solana?.rate === 1,
  `60 days: per rail of the first sale (${JSON.stringify(w60.all.byRail)})`);
const wk = out.weekly.find((r) => r.weekStart === "2026-10-26");
ok(wk && wk.all.newWallets === 3 && wk.all.returned === 1 && wk.all.rate === 0.333, `weekly: the week of 10-26 holds the three wallets first seen on 10-29, one back (${JSON.stringify(wk)})`);
ok(!out.weekly.some((r) => r.weekStart >= "2026-11-09"), "weekly: a week whose follow-up has not ended is not listed");
ok(!/0x[0-9a-f]{6}/i.test(JSON.stringify(out)), "the answer carries no address");
raw.close();

// The route: operator only, the same figures, no address.
const OP = "op-returning-" + "7".repeat(24);
const srv = await bootServer({ stores: "returning-buyers", env: { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: OP, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off" } });
try {
  const none = await fetch(`${srv.url}/__operator/returning-buyers.json`);
  ok(none.status === 404, `without the operator token the route is 404 (${none.status})`);
  const r = await fetch(`${srv.url}/__operator/returning-buyers.json`, { headers: { "x-operator-token": OP } });
  const j = await r.json().catch(() => ({}));
  ok(r.status === 200 && j.windows?.["30"]?.all && j.windows?.["60"]?.organic && Array.isArray(j.weekly) && /no-store/.test(r.headers.get("cache-control") || ""),
    `the operator reads the baseline, no-store (${r.status} ${Object.keys(j.windows || {}).join(",")})`);
} finally {
  await srv.stop();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
