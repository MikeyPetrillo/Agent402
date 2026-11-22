#!/usr/bin/env node
// What a restart costs in EVM chain reads: two boots of the server against
// one stub chain set (scripts/lib/evm-rpc-stub-preload.mjs, which answers and
// counts every EVM RPC by caller), the second on the first one's stores, each
// with the chain pages viewed once. The second boot must resume every scan
// from what the first stored instead of reading chain history again:
//
//   * each chain page's 30-day activity chart: one page of transfers (the
//     blocks after the stored state), not the whole window
//   * the live revenue view's window scans (a rail the revenue ledger holds
//     no rows for): the blocks after the stored head, not the whole window
//   * the revenue ledger: no start-block search (its cursors are stored)
//   * the Base seller board: no rebuild while its stored board is current
//
// File stores by default; scripts/test-evm-boot-resume-pg.js runs the same
// against a real state database. Prints both boots' calls by caller.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPaidServer } from "./lib/paid-boot.js";

// The -pg suite names its database here (the pin above clears the variable).
const PG = globalThis.__evmBootResumePg || null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const guard = setTimeout(() => { console.error("FAIL - the suite did not finish in time"); process.exit(1); }, 300_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "evm-boot-resume-"));
const T0 = String(Date.now());
// Chain heads the stub starts from (its HEAD0 table): the revenue ledger
// starts a few thousand blocks below, so its first boot is short.
const HEADS = { base: 40_000_000, arbitrum: 300_000_000, polygon: 70_000_000, monad: 40_000_000, celo: 40_000_000, avalanche: 60_000_000, sei: 160_000_000, optimism: 140_000_000, arc: 30_000_000, ink: 62_000_000, robinhood: 50_000_000 };
const CHART_CHAINS = ["base", "polygon", "arbitrum", "optimism", "avalanche", "celo", "monad", "arc", "ink", "sei"];
const files = {
  REVENUE_LEDGER_DB: join(dir, "revenue-ledger.db"),
  REVENUE_WINDOW_SCAN_FILE: join(dir, "revenue-window-scan.json"),
  EVM_ACTIVITY_FILE: join(dir, "evm-activity.json"),
  LEADERBOARD_SNAPSHOT_FILE: join(dir, "leaderboard-snapshot.json"),
  LEADERBOARD_HISTORY_FILE: join(dir, "leaderboard-history.json"),
  LEADERBOARD_FUNDING_FILE: join(dir, "leaderboard-funding.json"),
  LEADERBOARD_LOG_CACHE_DIR: join(dir, "leaderboard-logs"),
};

async function boot(n) {
  const log = join(dir, `calls-${n}.jsonl`);
  const srv = await bootPaidServer({
    label: `evm-boot-${n}`,
    args: ["--import", "./scripts/lib/evm-rpc-stub-preload.mjs"],
    env: {
      EVM_STUB_LOG: log, EVM_STUB_T0: T0, EVM_STUB_STEP: "50000",
      ALCHEMY_API_KEY: "stubkey",
      ...(PG ? { STATE_DATABASE_URL: PG.url, STATE_DB_SCHEMA: PG.schema } : {}),
      REVENUE_WARMUP: "", REVENUE_LEDGER: "true", X402_INDEX_CRAWL: "", MPP_INDEX_CRAWL: "off",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "1000", LEADERBOARD_REFRESH_MS: "",
      SOLANA_WALLET_ADDRESS: "", STELLAR_WALLET_ADDRESS: "", ALGORAND_WALLET_ADDRESS: "",
      EVM_ACTIVITY_STORE_FLUSH_MS: "1000", SQL_SCAN_DAILY_BUDGET: "0",
      ...files,
      ...Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [`REVENUE_LEDGER_FROM_${k.toUpperCase()}`, String(h - 3000)])),
    },
  });
  try {
    // The revenue view's boot scan, then every chain page once.
    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${srv.url}/api/revenue`).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => null) : null;
      if (Array.isArray(j?.rails) && j.rails.length >= 11) break;
      await sleep(500);
    }
    const pages = await Promise.all(CHART_CHAINS.map((c) => fetch(`${srv.url}/api/market/${c}/panel`).then((r) => r.status).catch(() => 0)));
    ok(pages.every((s) => s === 200), `boot ${n}: every chain panel answers (${pages.join(",")})`);
    // The scans finish behind the panels; the store's timer writes them.
    await sleep(4000);
    if (!PG) {
      for (let i = 0; i < 40; i++) {
        const body = existsSync(files.EVM_ACTIVITY_FILE) ? JSON.parse(readFileSync(files.EVM_ACTIVITY_FILE, "utf8") || "{}") : {};
        if (Object.keys(body.wallets || {}).length >= CHART_CHAINS.length) break;
        await sleep(250);
      }
    }
    // A Base board rebuild started at boot finishes before the stop.
    await sleep(2000);
  } finally {
    await srv.stop();
  }
  const rows = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return rows.filter((r) => r.chain);
}

const plumbing = /egress|evm-rpc-stub|drain-abort|request-timing|facilitator-diagnostics|active-jobs|state-db/;
const own = (r) => r.callers.filter((f) => !plumbing.test(f));
const caller = (r) => {
  const s = own(r);
  if (s.includes("src/server.js") && r.method === "alchemy_getAssetTransfers") return "activity chart (revenue-live.js evmActivity)";
  if (s.includes("src/revenue-ledger.js")) return s.includes("src/chain-block-time.js") ? "revenue-ledger.js block time" : s.includes("src/block-clock.js") ? "revenue-ledger.js start-block search" : "revenue-ledger.js sync";
  if (s.includes("src/leaderboard.js")) return s.includes("src/seller-funding.js") ? "leaderboard.js seller funding" : s.includes("src/block-clock.js") ? "leaderboard.js window start" : "leaderboard.js board";
  if (s.includes("src/tools/x402-kit.js")) return "tools/x402-kit.js";
  if (s[0] === "src/revenue-live.js") return r.method === "eth_getLogs" ? "revenue-live.js window scan" : "revenue-live.js head reads";
  return s[0] || "?";
};
function table(rows, label) {
  const by = new Map();
  for (const r of rows) { const k = `${caller(r)} | ${r.method}`; by.set(k, (by.get(k) || 0) + 1); }
  console.log(`# ${label}: ${rows.length} EVM RPC calls (Base ${rows.filter((r) => r.chain === "base").length})`);
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1])) console.log(`#   ${String(v).padStart(5)}  ${k}`);
}
const count = (rows, name, method = null) => rows.filter((r) => caller(r) === name && (!method || r.method === method)).length;

const first = await boot(1);
table(first, `boot 1 (${PG ? "state database" : "file stores"}, empty)`);
const second = await boot(2);
table(second, `boot 2 (${PG ? "state database" : "file stores"}, a restart)`);

ok(count(first, "activity chart (revenue-live.js evmActivity)") >= CHART_CHAINS.length * 5, `boot 1 reads each chart's window (${count(first, "activity chart (revenue-live.js evmActivity)")} pages)`);
const charts2 = count(second, "activity chart (revenue-live.js evmActivity)");
ok(charts2 <= CHART_CHAINS.length, `boot 2: the charts resume, ${charts2} page(s) for ${CHART_CHAINS.length} charts (boot 1: ${count(first, "activity chart (revenue-live.js evmActivity)")})`);
const win1 = count(first, "revenue-live.js window scan"), win2 = count(second, "revenue-live.js window scan");
if (!PG) {
  ok(win1 >= 40, `boot 1 reads the revenue windows (${win1} ranges)`);
  ok(win2 <= Object.keys(HEADS).length * 2, `boot 2: the revenue window scans resume, ${win2} range(s) (boot 1: ${win1})`);
} else {
  ok(win2 === 0, `boot 2 adopts the stored revenue snapshot (${win2} window ranges read)`);
}
ok(count(second, "revenue-ledger.js start-block search") === 0, "boot 2: the revenue ledger resumes from its cursors (no start-block search)");
ok(count(second, "leaderboard.js board") === 0, "boot 2: the Base board is not rebuilt while its stored board is current");
const base1 = first.filter((r) => r.chain === "base").length, base2 = second.filter((r) => r.chain === "base").length;
ok(base2 < base1 / 3, `boot 2 reads Base ${base2} time(s), boot 1 ${base1}`);

clearTimeout(guard);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
