// The per-chain daily spend ceiling (src/external-spend-guard.js) on the state
// database: the ledger file is imported once at the first boot with the
// database on, a booking reaches the row before the buy, a ceiling check reads
// the row first so the OTHER container's spend counts, and a write merges
// rather than overwrites the other container's rows. The other container is a
// real second process. Requires STATE_DATABASE_URL (CI fails without it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-external-spend-guard-pg" });
const TMP = mkdtempSync(join(tmpdir(), "spend-guard-pg-"));
const file = join(TMP, "wallet-daily-spend.json");
process.env.WALLET_DAILY_LEDGER_FILE = file;
for (const k of Object.keys(process.env)) if (k.startsWith("SOR_WALLET_DAILY_MAX_USD")) delete process.env[k];
const now = Date.now();
// A spend from before the database: in the window, so it counts.
writeFileSync(file, JSON.stringify({ chains: { base: [{ id: 1, usd: 0.4, at: now - 60_000 }] }, at: now - 60_000 }));

const { documents, imports, __dropStateSchema, closeStateDb } = await import("../src/state-db.js");
const G = await import("../src/external-spend-guard.js");
const { maySpend, noteSpend, adjustSpend, walletDailySpentUsd, walletDailyStatus, __ready, __flush, __reset, __backend } = G;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const P = "0x7777777777777777777777777777777777777777";
const DOC = "wallet-daily-spend.json";
const near = (a, b) => Math.abs(a - b) < 1e-9;

/** The other container: a second process booking a spend on the same row. */
function otherContainer(usd, chain = "base") {
  const code = `
    const G = await import(${JSON.stringify(new URL("../src/external-spend-guard.js", import.meta.url).href)});
    await G.__ready();
    const h = await G.noteSpend("0x8888888888888888888888888888888888888888", ${usd}, { chain: ${JSON.stringify(chain)} });
    await G.__flush();
    const { closeStateDb } = await import(${JSON.stringify(new URL("../src/state-db.js", import.meta.url).href)});
    await closeStateDb();
    console.log(JSON.stringify({ booked: Boolean(h), spent: G.walletDailySpentUsd(${JSON.stringify(chain)}) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`other container failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

try {
  ok(__backend === "pg", "with STATE_DATABASE_URL set the ledger is on the database");
  await __ready();
  // ---- 1. the file is imported once ----------------------------------------
  const mark = await imports.done(DOC);
  ok(mark && mark.source === file, "the ledger file is imported and marked once under its basename");
  ok(near(walletDailySpentUsd("base", now), 0.4), "the imported spend counts toward the day");
  const row0 = await documents.get(DOC);
  ok(row0?.body?.chains?.base?.length === 1, "the row holds the imported body");

  // ---- 2. a booking reaches the row before the buy --------------------------
  const h = await noteSpend(P, 0.5, { chain: "base" });
  ok(h && h.chain === "base" && h.payer === P, "noteSpend resolves the handle once the row is written");
  const row1 = await documents.get(DOC);
  const rows1 = row1?.body?.chains?.base || [];
  ok(rows1.length === 2 && rows1.some((r) => r.usd === 0.5 && typeof r.o === "string"), "the row holds the imported row and this process's booking (tagged with its process)");
  ok(near(rows1.reduce((s, r) => s + r.usd, 0), 0.9), "the stored sum is both");
  adjustSpend(h, 0.3);
  await new Promise((r) => setTimeout(r, 2_300)); // the write-behind debounce
  await __flush();
  const row2 = await documents.get(DOC);
  ok(near((row2.body.chains.base || []).reduce((s, r) => s + r.usd, 0), 0.7), "a lowering reaches the row on the debounce");
  ok(near(JSON.parse(readFileSync(file, "utf8")).chains.base.reduce((s, r) => s + r.usd, 0), 0.7), "and is written through to the file");

  // ---- 3. the other container's spend counts, and is never overwritten ------
  const other = otherContainer(0.6);
  ok(other.booked && near(other.spent, 1.3), `the other container read our rows before deciding (${JSON.stringify(other)})`);
  ok(near(walletDailySpentUsd("base", Date.now()), 0.7), "(this process has not read the row again yet, so it still sees its own view)");
  const decision = await maySpend(P, 0.1, { chain: "base", walletDailyMaxUsd: 1.35, maxUnsettledUsd: 10 });
  ok(decision.ok === false && decision.code === "wallet_daily_ceiling" && near(decision.spentUsd, 1.3),
    `a ceiling check reads the row first: the other container's $0.60 counts (${JSON.stringify({ ok: decision.ok, code: decision.code, spentUsd: decision.spentUsd })})`);
  ok((await maySpend(P, 0.04, { chain: "base", walletDailyMaxUsd: 1.35, maxUnsettledUsd: 10 })).ok === true, "and under the ceiling the spend is allowed");
  const h2 = await noteSpend(P, 0.04, { chain: "base" });
  ok(Boolean(h2), "this container books again");
  const row3 = await documents.get(DOC);
  const sum3 = (row3.body.chains.base || []).reduce((s, r) => s + r.usd, 0);
  ok(near(sum3, 1.34) && row3.body.chains.base.length === 4, `our write merged into the row: the other container's row survived (${sum3.toFixed(2)} over ${row3.body.chains.base.length} rows)`);
  const st = walletDailyStatus(Date.now());
  ok(near(st.chains.base.spentUsd, 1.34), "the status view carries the merged total");

  // ---- 4. a restart reads the row (both containers' bookings) ----------------
  const restarted = otherContainer(0, "solana"); // a zero booking on another chain: just a boot + read
  ok(restarted.booked && near(restarted.spent, 0), "another chain starts at zero");
  const row4 = await documents.get(DOC);
  ok(near((row4.body.chains.base || []).reduce((s, r) => s + r.usd, 0), 1.34), "a boot elsewhere leaves the base rows intact");

  await __reset();
  ok((await documents.get(DOC)) === null, "__reset drops the row");
} catch (e) {
  fail++;
  console.error("FAIL - threw:", e?.stack || e);
} finally {
  await __dropStateSchema().catch(() => {});
  await closeStateDb();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\ntest-external-spend-guard-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
