// A receipt check made on one container finds a sale another container just
// recorded (2026-10-15). With two replicas the attest and feedback routes read
// the local mirror of the sales table, which pulls other containers' writes
// on a timer; a buyer whose purchase landed on the other replica was told
// "No sale of yours settled". saleByTxFresh pulls once on a miss.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-sale-lookup-crosscontainer-pg.js
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-sale-lookup-crosscontainer-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "sale-xc-"));
process.env.SALES_LEDGER_DB = join(DIR, "a.db");
// A long refresh interval, so only the on-miss pull can explain a hit.
process.env.LEDGER_MIRROR_REFRESH_MS = "3600000";
const BUYER = "0x3333333333333333333333333333333333333333";
const TX = "0x" + "c4".repeat(32);

const sl = await import("../src/sales-ledger.js");
const { closeStateDb, __dropStateSchema } = await import("../src/state-db.js");
try {
  await sl.salesLedgerReady();
  ok(sl.saleByTx(TX) === null, "the sale is not in this container's mirror yet");
  // The other container records the purchase and exits.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    const sl = await import(${JSON.stringify(new URL("../src/sales-ledger.js", import.meta.url).href)});
    await sl.salesLedgerReady();
    await sl.recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: "${BUYER}", tx: "${TX}", synthetic: false, wire: "x402" });
    await sl.salesLedgerFlush();
    const { closeStateDb } = await import(${JSON.stringify(new URL("../src/state-db.js", import.meta.url).href)});
    await closeStateDb();
  `], { env: { ...process.env, SALES_LEDGER_DB: join(DIR, "b.db") }, stdio: "inherit", timeout: 60_000 });
  ok(sl.saleByTx(TX) === null, "...and the mirror alone still misses it right after the purchase (the old behavior)");
  const fresh = await sl.saleByTxFresh(TX);
  ok(fresh && fresh.payer?.toLowerCase() === BUYER && fresh.slug === "uuid", `saleByTxFresh finds the other container's sale on a miss (${JSON.stringify(fresh && { slug: fresh.slug, payer: fresh.payer })})`);
  ok((await sl.saleByTxFresh("0x" + "d5".repeat(32))) === null, "a transaction nobody recorded is still a miss");
  for (const f of ["src/tools/attest-kit.js", "src/tools/feedback-kit.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(/deps\.saleByTx \|\| saleByTxFresh/.test(src) && /const sale = await lookup\(tx\)/.test(src), `${f.split("/").pop()} looks sales up with saleByTxFresh`);
  }
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await __dropStateSchema?.().catch(() => {});
  await closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-sale-lookup-crosscontainer-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
