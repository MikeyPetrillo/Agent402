// Two containers attesting the same sale at once write ONE attestation
// (2026-10-15): the send runs under the attest-wallet lease and the sale is
// read again from Postgres inside it, so the second container answers with
// the first one's UID. Before, each container's mirror still showed no UID
// and both paid gas for an attestation.
//   STATE_DATABASE_URL=postgres://... node scripts/test-attest-crosscontainer-pg.js
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-attest-crosscontainer-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "attest-xc-"));
process.env.SALES_LEDGER_DB = join(DIR, "parent.db");
process.env.LEDGER_MIRROR_REFRESH_MS = "3600000";
const BUYER = "0x4444444444444444444444444444444444444444";
const TX = "0x" + "e7".repeat(32);
const SENDS = join(DIR, "sends.log");

const sl = await import("../src/sales-ledger.js");
const { closeStateDb, __dropStateSchema } = await import("../src/state-db.js");
const child = (label) => new Promise((resolve) => {
  // The child's source is constant; everything it varies on comes from env.
  const code = `
    import { appendFileSync } from "node:fs";
    const E = process.env;
    const sl = await import(new URL("../src/sales-ledger.js", E.T_BASE).href);
    await sl.salesLedgerReady();
    const { makeAttestHandler } = await import(new URL("../src/tools/attest-kit.js", E.T_BASE).href);
    const chain = {
      address: "0x77065d81e18ad403BCD6e9A0616b288e16744121",
      ensureSchema: async () => {},
      estimateUsd: async () => 0.001,
      attest: async () => { appendFileSync(E.T_SENDS, E.T_LABEL + "\\n"); await new Promise((r) => setTimeout(r, 1500)); return { uid: "0x" + (E.T_LABEL === "A" ? "a1" : "b2").repeat(32), attestTx: "0x" + "33".repeat(32), block: "1" }; },
    };
    const spend = { maySpend: () => ({ ok: true }), noteSpend: () => ({ id: 1 }), adjustSpend: () => {}, reserveSpend: async () => ({ ok: true, handle: null }) };
    const h = makeAttestHandler({ chain, spend, payerOf: () => E.T_BUYER });
    let out;
    try { out = await h({ tx: E.T_TX }); } catch (e) { out = { error: e.statusCode + " " + e.message }; }
    await sl.salesLedgerFlush();
    const { closeStateDb } = await import(new URL("../src/state-db.js", E.T_BASE).href);
    await closeStateDb();
    console.log(JSON.stringify({ uid: out.uid, existing: out.existing, error: out.error }));
  `;

  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, SALES_LEDGER_DB: join(DIR, `${label}.db`), T_BASE: import.meta.url, T_SENDS: SENDS, T_LABEL: label, T_BUYER: BUYER, T_TX: TX }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; p.stdout.on("data", (d) => { out += d; });
  p.on("exit", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ error: out.slice(-200) }); } });
});
try {
  await sl.salesLedgerReady();
  await sl.recordSale({ slug: "crypto-price", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: BUYER, tx: TX, synthetic: false, wire: "x402", responseSha256: "ab".repeat(32) });
  await sl.salesLedgerFlush();
  const [a, b] = await Promise.all([child("A"), child("B")]);
  const sends = existsSync(SENDS) ? readFileSync(SENDS, "utf8").trim().split("\n").filter(Boolean) : [];
  ok(sends.length === 1, `exactly one container sent an attestation (sends: ${JSON.stringify(sends)})`);
  ok(a.uid && a.uid === b.uid, `both containers answer the same UID (${a.uid?.slice(0, 10)} / ${b.uid?.slice(0, 10)}; errors ${a.error || "-"} / ${b.error || "-"})`);
  ok([a.existing, b.existing].filter(Boolean).length === 1, "one answer is the new attestation and the other reports it as existing");
  const row = await sl.saleByTxFresh(TX, { force: true });
  ok(row?.attestUid === a.uid, "the ledger keeps the one UID both containers answered");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await __dropStateSchema?.().catch(() => {});
  await closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-attest-crosscontainer-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
