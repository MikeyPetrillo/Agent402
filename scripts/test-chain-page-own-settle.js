// A chain page's proof row ("Our latest own settlement", the manifest's daily
// canary line and the OUR LATEST SETTLE card) is our own newest settle on the
// rail. On a busy rail the newest 8 ledger rows are all outside buyers, so the
// page must read our newest settle from the ledger directly. This drives the
// REAL ledger, withFreshRecent and marketPage together: a ledger holding only
// outside rows in its newest 8 plus an older canary row must render the
// canary, on every snapshot shape the cached revenue snapshot can carry.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-own-settle-"));
process.env.REVENUE_LEDGER_DB = join(dir, "rev.db");
process.env.SALES_LEDGER_DB = join(dir, "sales.db");

const { recordTransfer, ledgerRecent, ledgerNewestOwn } = await import("../src/revenue-ledger.js");
const { withFreshRecent, EVM } = await import("../src/revenue-live.js");
const { marketPage } = await import("../src/market-page.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const W = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const CANARY = "0xfeda7403aabe9a492ed70e810b396d8548a4a022";
const now = Math.floor(Date.now() / 1000);
const canaryTx = "0x" + "c1".repeat(32);
// Older canary row: block 100, two hours ago.
recordTransfer({ chain: "base", wallet: W, txid: `${canaryTx}:0`, tx_hash: canaryTx, block: 100, when_ts: now - 7200, payer: CANARY, usd: 0.001, asset: "USDC", external: false });
// Eight newer outside buyers fill the capped page.
for (let i = 0; i < 8; i++) {
  const h = "0x" + String(i).repeat(64);
  recordTransfer({ chain: "base", wallet: W, txid: `${h}:0`, tx_hash: h, block: 200 + i, when_ts: now - 600 + i, payer: "0x" + String(i + 1).repeat(40), usd: 0.002, asset: "USDC", external: true });
}

const page = ledgerRecent("base", W, { limit: 8 });
ok(page.length === 8 && page.every((t) => t.external), "the newest 8 ledger rows are all outside buyers (precondition)");

const shapes = {
  "ledger-backed snapshot": { rail: EVM.base.label, wallet: W, recentSource: "ledger", recent: [] },
  "chain-scan snapshot (built before the ledger had rows)": { rail: EVM.base.label, wallet: W, recentSource: "chain-scan", recent: [] },
  "snapshot whose rail scan errored": { rail: EVM.base.label, wallet: W, recent: [], error: "rpc down" },
};
for (const [label, rail] of Object.entries(shapes)) {
  const snap = withFreshRecent({ rails: [rail] }, ledgerRecent, ledgerNewestOwn);
  const r = snap.rails[0];
  ok(r.lastInbound?.internal === true && r.lastInbound.tx === EVM.base.tx(canaryTx), `${label}: lastInbound is our canary row`);
  const html = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [] }, rail: r, activity: null, wallet: W });
  ok(!html.includes("live receipts temporarily unavailable"), `${label}: the receipt line renders`);
  ok(html.includes(canaryTx), `${label}: the canary's on-chain receipt is linked`);
  ok(/OUR LATEST SETTLE<\/div><div[^>]*>\$0\.001/.test(html), `${label}: the OUR LATEST SETTLE card shows the canary amount`);
  ok(/settled \d+h ago/.test(html) && !/daily canary[^<]*<\/[^>]+>\s*<[^>]+>unavailable/.test(html), `${label}: the manifest canary row reads settled`);
  for (const t of page) ok(!html.includes(t.txHash), `${label}: outside buyer tx ${t.txHash.slice(0, 6)}… never rendered`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
