// The per-chain daily spend ceiling (src/external-spend-guard.js) on the state
// database: the ledger file is imported once at the first boot with the
// database on, a booking reaches the row before the buy, a ceiling check reads
// the row first so the OTHER container's spend counts, and a write merges
// rather than overwrites the other container's rows. The other container is a
// real second process. Requires STATE_DATABASE_URL (CI fails without it).
import { spawn, spawnSync } from "node:child_process";
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

  // ---- 5. check-and-book is one step ------------------------------------------
  {
    // Two calls in one container at once: one $1 ceiling, two $0.60 reservations.
    const both = await Promise.all([G.reserveSpend(P, 0.6, { chain: "solana", walletDailyMaxUsd: 1, maxUnsettledUsd: 10 }), G.reserveSpend(P, 0.6, { chain: "solana", walletDailyMaxUsd: 1, maxUnsettledUsd: 10 })]);
    ok(both.filter((d) => d.ok).length === 1 && both.find((d) => d.ok)?.handle?.chain === "solana", `two concurrent reservations against room for one: one is booked (${both.map((d) => d.ok).join(",")})`);
    // Two containers (two module instances, each its own process tag and memory)
    // at once: the ledger row is locked from the read to the write.
    const GA = await import("../src/external-spend-guard.js?container-a");
    const GB = await import("../src/external-spend-guard.js?container-b");
    await GA.__ready(); await GB.__ready();
    const pause = () => new Promise((r) => setTimeout(r, 150));
    GA.__onReserveRead(pause); GB.__onReserveRead(pause);
    const two = await Promise.all([GA.reserveSpend(null, 0.6, { chain: "algorand", walletDailyMaxUsd: 1 }), GB.reserveSpend(null, 0.6, { chain: "algorand", walletDailyMaxUsd: 1 })]);
    GA.__onReserveRead(null); GB.__onReserveRead(null);
    const rowAlg = (await documents.get(DOC)).body.chains.algorand || [];
    ok(two.filter((d) => d.ok).length === 1 && rowAlg.length === 1, `two containers reserving at once against room for one: one booked, one refused, one row (${two.map((d) => d.ok).join(",")}; ${rowAlg.length} row)`);
    ok(two.find((d) => !d.ok)?.code === "wallet_daily_ceiling", "the refused one names the wallet ceiling");
    // The same with no row yet (the first bookings ever): the row is created before it is locked.
    const saved = (await documents.get(DOC)).body;
    await documents.del(DOC);
    GA.__onReserveRead(pause); GB.__onReserveRead(pause);
    const first = await Promise.all([GA.reserveSpend(null, 0.6, { chain: "algorand", walletDailyMaxUsd: 1, now: Date.now() + 2 * 864e5 }), GB.reserveSpend(null, 0.6, { chain: "algorand", walletDailyMaxUsd: 1, now: Date.now() + 2 * 864e5 })]);
    GA.__onReserveRead(null); GB.__onReserveRead(null);
    ok(first.filter((d) => d.ok).length === 1, `two first-ever reservations at once against room for one: one booked (${first.map((d) => d.ok).join(",")})`);
    await documents.put(DOC, saved);
    // Bookings (noteSpend) from both containers at once: the merge runs under
    // the row lock, so neither write drops the other's rows.
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? GA : GB).noteSpend(null, 0.01, { chain: "tempo" })));
    await GA.__flush(); await GB.__flush();
    const rowTempo = (await documents.get(DOC)).body.chains.tempo || [];
    ok(rowTempo.length === 6, `six bookings from two containers at once all reach the row (${rowTempo.length})`);
  }

  // ---- 6. a boot during an outage refuses chain spends until the ledger is read ----
  {
    const { startPgRelay } = await import("./lib/pg-relay.js");
    const relay = await startPgRelay(process.env.STATE_DATABASE_URL);
    relay.cut();
    const childFile = join(TMP, "child", "wallet-daily-spend.json"); // same document name, a file that does not exist
    const code = `
      const G = await import(${JSON.stringify(new URL("../src/external-spend-guard.js", import.meta.url).href)});
      await G.__ready();
      const out = { first: await G.reserveSpend(null, 0.1, { chain: "base" }), may: await G.maySpend(null, 0.1, { chain: "base" }), payerOnly: (await G.reserveSpend("0x9999999999999999999999999999999999999999", 0.1, {})).ok };
      const t0 = Date.now();
      let later = null;
      while (Date.now() - t0 < 20000) { later = await G.reserveSpend(null, 0.1, { chain: "base", walletDailyMaxUsd: 1.4 }); if (later.code !== "spend_ledger_unreadable") break; await new Promise((r) => setTimeout(r, 250)); }
      out.later = { ok: later.ok, code: later.code || null, spent: G.walletDailySpentUsd("base") };
      const { closeStateDb } = await import(${JSON.stringify(new URL("../src/state-db.js", import.meta.url).href)});
      await closeStateDb();
      console.log(JSON.stringify(out));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, STATE_DATABASE_URL: relay.url, WALLET_DAILY_LEDGER_FILE: childFile }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    setTimeout(() => relay.heal(), 7000);
    const status = await new Promise((r) => child.on("exit", r));
    await relay.close();
    let out = null; try { out = JSON.parse(stdout.trim().split("\n").pop()); } catch { /* reported below */ }
    ok(status === 0 && out, `the outage boot ran (${status}; ${stderr.slice(-200)})`);
    ok(out?.first?.ok === false && out.first.code === "spend_ledger_unreadable" && out.may?.code === "spend_ledger_unreadable", "a container whose first ledger read failed (no file either) refuses chain spends instead of starting at zero");
    ok(out?.payerOnly === true, "a spend with no chain wallet is not held by the chain ledger");
    ok(out?.later?.code === "wallet_daily_ceiling" && near(out.later.spent, 1.34), `once the database answers, the stored day counts (${JSON.stringify(out?.later)})`);
    // With the written-through file present, an outage boot reads the day from it.
    (await import("node:fs")).mkdirSync(join(TMP, "child"), { recursive: true });
    writeFileSync(childFile, JSON.stringify({ chains: { base: [{ id: 9, usd: 0.9, at: Date.now() - 1000, o: "x" }] }, at: Date.now() }));
    const r2 = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const G = await import(${JSON.stringify(new URL("../src/external-spend-guard.js", import.meta.url).href)});
      await G.__ready();
      const d = await G.reserveSpend(null, 0.2, { chain: "base", walletDailyMaxUsd: 1 });
      console.log(JSON.stringify({ ok: d.ok, code: d.code || null, spent: G.walletDailySpentUsd("base") }));
      process.exit(0);
    `], { env: { ...process.env, STATE_DATABASE_URL: "postgres://postgres@127.0.0.1:1/none?sslmode=disable", WALLET_DAILY_LEDGER_FILE: childFile }, encoding: "utf8", timeout: 60_000 });
    let o2 = null; try { o2 = JSON.parse(r2.stdout.trim().split("\n").pop()); } catch { /* reported below */ }
    ok(o2?.code === "wallet_daily_ceiling" && near(o2.spent, 0.9), `an outage boot with the ledger file present decides on the file's day (${JSON.stringify(o2)})`);
  }

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
