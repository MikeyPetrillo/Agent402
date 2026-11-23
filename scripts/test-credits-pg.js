// Prepaid credits on a REAL Postgres (src/credits.js with STATE_DATABASE_URL):
// the key directory is imported once at the first boot and never again, every
// write lands in the records table (and in the key's file while the directory
// exists), a session is claimed by exactly one of two concurrent claims, two
// concurrent holds on a balance that covers one leave exactly one holder, a
// hold becomes spend only on a final 200 and comes back on anything else;
// while signed receipts are served, a final 200 is debited before its answer
// ends and the history names the debit's id.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { looseCreditsChecks } from "./lib/credits-loose-checks.js"; // wide purchase checks (see the file)
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-credits-pg" });
const sdb = await import("../src/state-db.js");
const { createCredits, hashKey, usdToMicro, emailKeyOf, ensureCreditsIndexes, CREDITS_INDEXES, CREDITS_LOOKUP_SQL } = await import("../src/credits.js");
const { reserveHangupForgiveness, hangupForgiven } = await import("../src/hangup-forgiveness.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "credits-pg-"));
const quiet = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(25); } return fn(); };

// The directory a previous build left on the volume: one key with $1.00 and
// the session that bought it.
const OLD_KEY = "a402_" + "o".repeat(40);
const OLD_HASH = hashKey(OLD_KEY);
writeFileSync(join(DIR, `k_${OLD_HASH}.json`), JSON.stringify({ keyId: OLD_HASH.slice(0, 12), balanceMicro: 1_000_000, loadedMicro: 1_000_000, spentMicro: 0, calls: 0, createdAt: "2026-01-01T00:00:00.000Z", email: null, sessions: ["cs_old"], paymentIntents: ["pi_old", "pi_old_b"], pack: "credits-20", lastUsedAt: null }));
writeFileSync(join(DIR, "_sessions.json"), JSON.stringify({ cs_old: OLD_HASH }));

const sessions = {
  cs_old: { id: "cs_old", mode: "payment", payment_status: "paid", payment_intent: "pi_old", metadata: { credits_pack: "credits-20" } },
  cs_new: { id: "cs_new", mode: "payment", payment_status: "paid", payment_intent: "pi_new", customer_details: { email: null }, metadata: { credits_pack: "credits-20" } },
};
const stripe = { checkout: { sessions: { retrieve: async (id) => { await wait(20); const s = sessions[id]; if (!s) throw new Error("no"); return s; } } } };
const debits = [], loads = [];
const mk = () => createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, onDebit: (d) => debits.push(d), onLoad: (l) => loads.push(l), log: quiet });
const fileRec = (hash) => JSON.parse(readFileSync(join(DIR, `k_${hash}.json`), "utf8"));
const rowRec = async (hash) => (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id = $1`, [`k_${hash}`])).rows[0]?.body ?? null;

try {
  // ---- (1) import once ------------------------------------------------------
  const A = mk();
  ok(A.backend === "pg", "the store is on the database");
  await A.ready();
  ok(!!(await sdb.imports.done(basename(DIR))), "the directory import is marked under its basename");
  ok((await A.balance(OLD_KEY))?.balanceUsd === 1 && (await A.keyIdOf(OLD_KEY)) === OLD_HASH.slice(0, 12), "the key file was imported: the key is known with its balance");
  ok((await A.claim("cs_old")).status === "claimed", "the sessions index was imported: the old session is claimed");
  // A key file added after the import is not picked up by a second boot.
  const LATE = hashKey("a402_" + "l".repeat(40));
  writeFileSync(join(DIR, `k_${LATE}.json`), JSON.stringify({ keyId: "late", balanceMicro: 5, loadedMicro: 5, spentMicro: 0, calls: 0, createdAt: "2026-01-01T00:00:00.000Z" }));
  const B = mk();
  await B.ready();
  ok((await B.balance("a402_" + "l".repeat(40))) === null && (await rowRec(LATE)) === null, "a second boot does not import again");

  // ---- (2) claim once across two instances ---------------------------------
  const [c1, c2] = await Promise.all([A.claim("cs_new"), B.claim("cs_new")]);
  const minted = [c1, c2].find((c) => c.status === "minted");
  const claimed = [c1, c2].find((c) => c.status === "claimed");
  ok(minted && claimed && claimed.keyId === minted.keyId && !claimed.key && loads.length === 1, `two concurrent claims of one session: one mints, the other is told it is claimed (${c1.status}, ${c2.status})`);
  const KEY = minted.key;
  const HASH = hashKey(KEY);
  ok((await rowRec(HASH))?.balanceMicro === 20_000_000 && (await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id LIKE 'k\\_%' ESCAPE '\\'`)).rows[0].n === 2, "the minted key is one row; the losing claim left no orphan row");
  ok(JSON.parse(readFileSync(join(DIR, "_sessions.json"), "utf8")).cs_new === HASH && fileRec(HASH).balanceMicro === 20_000_000, "the claim is written through to the directory (index and key file)");
  ok((await B.balance(KEY))?.balanceUsd === 20, "the other instance reads the row, not a cache");

  // ---- (3) holds: two concurrent, one balance ------------------------------
  const [h1, h2] = await Promise.all([A.authorize(KEY, 19.5), B.authorize(KEY, 19.5)]);
  ok([h1, h2].filter((h) => h.ok).length === 1 && [h1, h2].find((h) => !h.ok)?.reason === "insufficient", "two concurrent holds on a balance that covers one: exactly one is placed");
  const win = [h1, h2].find((h) => h.ok);
  ok((await rowRec(HASH)).heldMicro === usdToMicro(19.5) && (await B.balance(KEY)).balanceUsd === 0.5, "the hold is on the row");
  await A.release(win.hash, win.heldMicro);
  ok((await B.balance(KEY)).balanceUsd === 20 && (await B.balance(KEY)).heldUsd === 0, "a release returns the hold");
  const h3 = await A.authorize(KEY, 0.01);
  const s3 = await B.settle(h3.hash, h3.heldMicro, "whois", 0.004);
  ok(s3.chargedUsd === 0.004 && s3.returnedUsd === 0.006 && (await A.balance(KEY)).balanceUsd === 19.996 && debits.length === 1 && debits[0].priceUsd === 0.004, "a metered settle takes the reported amount, never more than the hold, and fires the accounting hook once");
  ok(fileRec(HASH).spentMicro === 4000 && fileRec(HASH).balanceMicro === 19_996_000, "the debit is written through to the key's file");

  // ---- (4) the gate: debit on a final 200, release otherwise ----------------
  const priceFor = (method, path) => (path === "/api/whois" ? { priceUsd: 0.001, slug: "whois" } : null);
  const gate = A.gate(priceFor);
  function fakeRes() { const r = new EventEmitter(); r.statusCode = 200; r.headersSent = false; r.end = () => r; r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v; }; r.getHeader = (k) => r.headers[k]; r.status = (c) => { r.statusCode = c; return r; }; r.json = (j) => { r.body = j; r.emit("finish"); return r; }; return r; }
  let nexted = false; let res = fakeRes();
  await gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
  ok(nexted && res.headers["X-Credits-Balance"] === "19.995", "gate: the hold is placed before next() (async middleware)");
  res.statusCode = 200; res.emit("finish");
  ok(await until(async () => (await B.balance(KEY)).balanceUsd === 19.995 && (await B.balance(KEY)).heldUsd === 0), "gate: a 200 is debited on finish (the row shows it)");
  nexted = false; res = fakeRes();
  await gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
  res.statusCode = 502; res.emit("finish");
  ok(await until(async () => (await B.balance(KEY)).balanceUsd === 19.995 && (await B.balance(KEY)).heldUsd === 0), "gate: a 502 releases the hold");
  res = fakeRes(); nexted = false;
  await gate({ method: "GET", path: "/api/whois", headers: { authorization: "Bearer a402_" + "u".repeat(40) } }, res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 402 && res.body.reason === "unknown", "gate: an unknown key is refused with a 402");
  res = fakeRes(); nexted = false;
  await gate({ method: "GET", path: "/api/other", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
  ok(nexted && res.statusCode === 200 && !res.headers["X-Credits-Balance"], "gate: an unpriced route passes through untouched");
  // While signed receipts are served (settleBeforeEnd), a final 200 is
  // debited BEFORE its answer ends: the row holds the debit, the history
  // names its id, and the finish that follows takes nothing more.
  {
    // A key of its own, so the balances the checks below read are untouched.
    const RKEY = "a402_" + "r".repeat(40), RHASH = hashKey(RKEY);
    await sdb.stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body) VALUES ('credits', $1, $2::jsonb)`, [`k_${RHASH}`, JSON.stringify({ keyId: "rcptkey00001", balanceMicro: 1_000_000, loadedMicro: 1_000_000, spentMicro: 0, heldMicro: 0, calls: 0, createdAt: "2026-11-01T00:00:00.000Z", history: [] })]);
    const gateR = A.gate(priceFor, { settleBeforeEnd: () => true });
    const before = (await B.balance(RKEY)).balanceUsd;
    const debitsBefore = debits.length;
    const r = fakeRes(); const req = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${RKEY}` } };
    let ended = null; r.end = (...args) => { ended = { args, balance: null }; return r; };
    await gateR(req, r, () => {});
    r.statusCode = 200;
    r.end("body");
    ok(await until(async () => ended !== null), "pg receipts: the answer ends once the debit settled");
    const row = await rowRec(RHASH);
    ok(typeof req.creditsDebitId === "string" && /^cd_/.test(req.creditsDebitId) && row.history.some((e) => e.k === "charge" && e.d === req.creditsDebitId) && ended.args[0] === "body", `pg receipts: the debit landed before the end and the history names its id (${req.creditsDebitId})`);
    ok((await B.balance(RKEY)).balanceUsd === Math.round((before - 0.001) * 1e6) / 1e6 && (await B.balance(RKEY)).heldUsd === 0, "pg receipts: one price taken, nothing held");
    r.emit("finish");
    await wait(100);
    ok(debits.length === debitsBefore + 1 && (await B.balance(RKEY)).balanceUsd === Math.round((before - 0.001) * 1e6) / 1e6, "pg receipts: the finish takes nothing more");
    // A debit that cannot land in CREDITS_DEBIT_WAIT_MS ends the answer
    // without a debit id, and the retry still takes the hold once.
    process.env.CREDITS_DEBIT_WAIT_MS = "100";
    const slow = A.gate(priceFor, { settleBeforeEnd: () => true });
    const r2 = fakeRes(); const req2 = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${RKEY}` } };
    let ended2 = false; r2.end = () => { ended2 = true; return r2; };
    await slow(req2, r2, () => {});
    // Hold the row so the settle waits behind it.
    const lockDone = sdb.withStateTx(async (c) => { await c.query(`SELECT 1 FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id = $1 FOR UPDATE`, [`k_${RHASH}`]); await wait(400); });
    await wait(30);
    r2.statusCode = 200; r2.end();
    ok(await until(async () => ended2, 2000) && !req2.creditsDebitId, "pg receipts: a debit held up past the wait ends the answer with no debit id (no receipt)");
    await lockDone.catch(() => {});
    ok(await until(async () => (await B.balance(RKEY)).balanceUsd === Math.round((before - 0.002) * 1e6) / 1e6 && (await B.balance(RKEY)).heldUsd === 0, 5000), "pg receipts: the retried debit takes the hold once");
    delete process.env.CREDITS_DEBIT_WAIT_MS;
    // A buyer who hangs up while the debit is in flight: the debit left while
    // the buyer was connected, so it stands once and the hang-up hook is told
    // what it took (creditsChargedOnClose), so the undelivered answer is
    // booked as owed. Nothing is left held.
    {
      const b0 = (await B.balance(RKEY)).balanceUsd;
      const g = A.gate(priceFor, { settleBeforeEnd: () => true });
      const r3 = fakeRes(); const req3 = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${RKEY}` } };
      let ended3 = false; r3.end = () => { ended3 = true; return r3; };
      await g(req3, r3, () => {});
      const lock3 = sdb.withStateTx(async (c) => { await c.query(`SELECT 1 FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id = $1 FOR UPDATE`, [`k_${RHASH}`]); await wait(500); });
      await wait(30);
      r3.statusCode = 200; r3.end("answer");
      await wait(50); r3.emit("close");
      await lock3.catch(() => {});
      ok(await until(async () => ended3, 4000), "pg receipts hang-up: the answer still ends after the debit");
      ok(req3.creditsChargedOnClose === 0.001, `pg receipts hang-up: a close during the debit wait is noted for the hang-up hook (${req3.creditsChargedOnClose})`);
      ok(await until(async () => (await B.balance(RKEY)).balanceUsd === Math.round((b0 - 0.001) * 1e6) / 1e6 && (await B.balance(RKEY)).heldUsd === 0, 3000), "pg receipts hang-up: the debit is taken once and nothing stays held");
      // A buyer already gone when the answer ends, holding a granted
      // forgiveness ticket: the hold is released and nothing is debited.
      const b1 = (await B.balance(RKEY)).balanceUsd;
      const r4 = fakeRes(); const req4 = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${RKEY}` } };
      let ended4 = false; r4.end = () => { ended4 = true; return r4; };
      await g(req4, r4, () => {});
      // Awaited as the server awaits it: on a shared store (REDIS_URL set) the
      // reservation is a promise, and the ticket is on the request only once
      // it settles. The key is this run's own, so no other run's figures on
      // that store decide it.
      await reserveHangupForgiveness(req4, { keys: [`credits-pg-test-${basename(DIR)}`], priceUsd: 0.001, slug: "whois" });
      ok(hangupForgiven(req4), "pg receipts hang-up: the run holds a granted ticket");
      req4.__a402ClientGoneAt = Date.now();
      r4.statusCode = 200; r4.end("answer");
      ok(ended4 && !req4.creditsDebitId && !req4.creditsChargedOnClose, "pg receipts hang-up: a forgiven buyer already gone is not debited");
      ok(await until(async () => (await B.balance(RKEY)).balanceUsd === b1 && (await B.balance(RKEY)).heldUsd === 0, 3000), "pg receipts hang-up: the forgiven hold is released, the balance untouched");
    }
    await sdb.stateQuery(`DELETE FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id = $1`, [`k_${RHASH}`]);
  }

  // ---- (5) operator reads and the clawback ---------------------------------
  const st = await B.status();
  ok(st.keys === 2 && st.rows.every((r) => r.keyId && !r.key && !r.hash) && st.spentUsd === 0.005, "status reads every row: counts and key ids only");
  ok((await A.setDisabled(minted.keyId, true)) === true && (await B.authorize(KEY, 0.001)).reason === "disabled", "setDisabled lands on the row: the other instance refuses the key");
  ok((await A.setDisabled(minted.keyId, false)) === true && (await A.disableByPaymentIntent("pi_new", "refunded")) === minted.keyId && (await B.balance(KEY)).disabled === true, "a refunded pack payment disables its key");
  ok((await B.balanceById(minted.keyId)) === 19.995 && (await B.balanceById("nope")) === null, "balanceById reads the row by key id");
  // A dispute disables the key; the dispute closing in our favor on the
  // other container enables it again, and a key disabled for a refund stays
  // disabled whatever a dispute on its payment did.
  // Disable causes rank operator over refund over dispute on the row, so a
  // dispute closing in our favor on the other container lifts a key only
  // when that dispute was its sole cause; the operator view names the cause.
  const reasonOf = async (inst) => (await inst.status()).rows.find((x) => x.keyId === minted.keyId)?.disabledReason;
  ok((await A.enableByPaymentIntent("pi_new", "disputed")) === null && (await B.balance(KEY)).disabled === true && (await reasonOf(B)) === "refunded", "a dispute closing enables nothing on a key disabled because its payment was refunded");
  ok((await A.disableByPaymentIntent("pi_new", "disputed")) === minted.keyId && (await reasonOf(B)) === "refunded" && (await B.enableByPaymentIntent("pi_new", "disputed")) === null && (await A.balance(KEY)).disabled === true, "a dispute after a full refund keeps the refund as the cause: the win never re-enables");
  ok((await A.setDisabled(minted.keyId, false)) === true && (await A.disableByPaymentIntent("pi_new", "disputed")) === minted.keyId && (await reasonOf(B)) === "disputed" && (await B.enableByPaymentIntent("pi_new", "disputed")) === minted.keyId && (await A.balance(KEY)).disabled === false, "dispute-disabled, then won on the other container: the key is enabled again");
  ok((await A.setDisabled(minted.keyId, true)) === true && (await reasonOf(B)) === "operator" && (await B.disableByPaymentIntent("pi_new", "disputed")) === minted.keyId && (await reasonOf(A)) === "operator" && (await B.enableByPaymentIntent("pi_new", "disputed")) === null && (await A.balance(KEY)).disabled === true, "operator-disabled, then disputed, then won: stays disabled for the operator");
  ok((await A.setDisabled(minted.keyId, false)) === true && (await A.disableByPaymentIntent("pi_new", "disputed")) === minted.keyId && (await B.setDisabled(minted.keyId, true)) === true && (await reasonOf(A)) === "operator" && (await B.enableByPaymentIntent("pi_new", "disputed")) === null && (await A.balance(KEY)).disabled === true, "disputed, then operator-disabled, then won: stays disabled (and the key is disabled for the sections below)");
  // A key paid by two payments (the imported record lists both): a dispute on
  // one marks the key with that payment; a win on the other, read on the
  // other container, lifts nothing, and the disputed payment's own win does.
  const OLD_ID = OLD_HASH.slice(0, 12);
  ok((await A.disableByPaymentIntent("pi_old_b", "disputed")) === OLD_ID && (await B.balance(OLD_KEY)).disabled === true, "setup: a dispute on the imported key's second payment disables it");
  ok((await B.enableByPaymentIntent("pi_old", "disputed")) === null && (await A.balance(OLD_KEY)).disabled === true, "a dispute won on another payment of the same key lifts nothing: the key stays disabled for the payment still disputed");
  ok((await B.enableByPaymentIntent("pi_old_b", "disputed")) === OLD_ID && (await A.balance(OLD_KEY)).disabled === false, "the disputed payment's own win lifts it on the other container");

  // ---- (6) roll-forward: files written in a rollback window win per id -----
  const keyFile = join(DIR, `k_${HASH}.json`);
  const rolledRec = { ...fileRec(HASH), balanceMicro: 500_000, spentMicro: 19_500_000, disabled: false };
  writeFileSync(keyFile, JSON.stringify(rolledRec));
  const C = mk();
  await C.ready();
  ok((await C.balance(KEY)).balanceUsd === 19.995 && (await C.balance(KEY)).disabled === true, "a key file written within the write-through grace is not re-read (the row stays)");
  const future = (Date.now() + 120_000) / 1000;
  utimesSync(keyFile, future, future);
  writeFileSync(join(DIR, "_sessions.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(DIR, "_sessions.json"), "utf8")), cs_rolled: HASH }));
  utimesSync(join(DIR, "_sessions.json"), future, future);
  const D = mk();
  await D.ready();
  ok((await D.balance(KEY)).balanceUsd === 0.5 && (await D.balance(KEY)).disabled === false && (await rowRec(HASH)).spentMicro === 19_500_000, "roll-forward: the key file dated past the grace wins over the row");
  ok((await D.claim("cs_rolled")).status === "claimed" && (await rowRec(HASH)) !== null, "roll-forward: the sessions index written in the window is the index");

  // ---- (7) a hold nothing ever settled or released is returned by the sweep --
  const past = (Date.now() - 3600_000) / 1000; // the files of (6) are no longer newer than the rows
  for (const f of [keyFile, join(DIR, "_sessions.json")]) utimesSync(f, past, past);
  const logs = [];
  const E = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: (m) => logs.push(m) });
  await E.ready();
  const RT = `${sdb.stateDbSchema()}.records`;
  const age = (holdId) => sdb.stateQuery(`UPDATE ${RT} SET body = jsonb_set(body, ARRAY['holds', $2::text, 'at'], to_jsonb($3::bigint)) WHERE collection = 'credits' AND id = $1`, [`k_${HASH}`, holdId, Date.now() - 20 * 60_000]);
  const bal = async () => { const b = await E.balance(KEY); return [b.balanceUsd, b.heldUsd]; };
  const young = await E.authorize(KEY, 0.1);
  const stuck = await E.authorize(KEY, 0.2);
  ok(young.holdId && stuck.holdId && (await rowRec(HASH)).holds[stuck.holdId]?.m === 200_000, "each hold on the database is an entry on the row");
  await age(stuck.holdId);
  const sw = await E.sweepAbandonedHolds();
  ok(sw.released === 1 && JSON.stringify(await bal()) === JSON.stringify([0.4, 0.1]), `the sweep returns the hold older than CREDITS_ABANDONED_HOLD_MS and keeps the young one (${JSON.stringify(sw)}, ${JSON.stringify(await bal())})`);
  ok(logs.some((l) => /released 1 abandoned hold\(s\) on key/.test(l)), "the return is logged");
  const late = await E.settle(stuck.hash, stuck.heldMicro, "whois", null, stuck.holdId);
  ok(late.chargedUsd === 0 && JSON.stringify(await bal()) === JSON.stringify([0.4, 0.1]), "a settle that arrives for a swept hold moves no money");
  const s2 = await E.settle(young.hash, young.heldMicro, "whois", null, young.holdId);
  ok(s2.chargedUsd === 0.1 && JSON.stringify(await bal()) === JSON.stringify([0.4, 0]), "the young hold settles as usual");
  // A hold a request in flight here still holds is never swept, whatever its age.
  const gateE = E.gate((m, p) => (p === "/api/whois" ? { priceUsd: 0.05, slug: "whois" } : null));
  const resE = fakeRes();
  ok(Object.keys((await rowRec(HASH)).holds).length === 0, "a settle or release that names no hold ends its entry too (no entry is left to sweep twice)");
  await gateE({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, resE, () => {});
  const liveId = Object.keys((await rowRec(HASH)).holds)[0];
  await age(liveId);
  { const sw2 = await E.sweepAbandonedHolds(); ok(sw2.released === 0 && JSON.stringify(await bal()) === JSON.stringify([0.35, 0.05]), `a hold of a request still in flight here is not swept (${JSON.stringify(sw2)} ${JSON.stringify(await bal())})`); }
  resE.statusCode = 200; resE.emit("finish");
  ok(await until(async () => JSON.stringify(await bal()) === JSON.stringify([0.35, 0])), "and settles when its response finishes");
  // The first load of a new instance sweeps too.
  const h4 = await E.authorize(KEY, 0.05);
  await age(h4.holdId);
  const F = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: (m) => logs.push(m) });
  await F.ready();
  ok(JSON.stringify(await bal()) === JSON.stringify([0.35, 0]), `a boot sweeps: the old hold is back on the balance after the first load (${JSON.stringify(await bal())} ${logs.slice(-2).join(" | ")})`);
  // Held money with no entry (a build without entries placed it) comes back once the row is quiet.
  await sdb.stateQuery(`UPDATE ${RT} SET body = jsonb_set(body, '{heldMicro}', to_jsonb(30000)), updated_at = now() - interval '1 hour' WHERE collection = 'credits' AND id = $1`, [`k_${HASH}`]);
  ok((await E.sweepAbandonedHolds()).released === 1 && JSON.stringify(await bal()) === JSON.stringify([0.38, 0]), "held money no entry accounts for is returned once the row has been quiet for the window");
  // ---- (8) a delivered 200 whose settle cannot land at once (a database
  // failover): the settle is retried with backoff; a hold marked settling
  // that no settle reached is debited by the sweep, never returned.
  {
    const { hookStatements } = await import("./lib/pg-statement-hook.js");
    const sales = [];
    const mkS = () => createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, onDebit: (d) => sales.push(d), log: quiet });
    const G = mkS(), H = mkS(); // two containers
    await G.ready(); await H.ready();
    const gateG = G.gate((m, p) => (p === "/api/whois" ? { priceUsd: 0.01, slug: "whois" } : null));
    let target = null, failSettles = 0, failed = 0;
    const isSettleOf = (sql, values) => {
      if (!target || !/^\s*UPDATE/i.test(sql)) return false;
      try { const b = JSON.parse(values[2]); return !!b?.settledHolds?.[target] && !b.settledHolds[target].booked && !b?.holds?.[target]; } catch { return false; }
    };
    const unhook = hookStatements(await sdb.stateDb(), async (sql, values, run) => {
      if (failSettles > 0 && isSettleOf(sql, values)) { failSettles--; failed++; throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }); }
      return run();
    });
    try {
      // (a) the settle throws three times, then lands.
      const before = await rowRec(HASH);
      const r1 = fakeRes();
      await gateG({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, r1, () => {});
      target = Object.keys((await rowRec(HASH)).holds)[0];
      failSettles = 3;
      r1.statusCode = 200; r1.end(); r1.emit("finish");
      await until(async () => (await rowRec(HASH)).heldMicro === 0, 10_000);
      const a1 = await rowRec(HASH);
      ok(failed === 3 && a1.heldMicro === 0 && a1.spentMicro === before.spentMicro + 10_000 && a1.balanceMicro === before.balanceMicro - 10_000, `a settle that throws three times still debits the key (failed ${failed}, held ${a1.heldMicro}, spent +${a1.spentMicro - before.spentMicro}, balance ${a1.balanceMicro - before.balanceMicro})`);
      ok(sales.length === 1 && sales[0].priceUsd === 0.01, `and books the sale once (${JSON.stringify(sales.map((s) => s.priceUsd))})`);

      // (b) the settle never lands before its retries end: the hold was marked
      // settling as the response ended, and another container's sweep turns
      // it into spend and books it; a settle that lands afterwards books nothing.
      process.env.CREDITS_ABANDONED_HOLD_MS = "1500";
      const b0 = await rowRec(HASH);
      const r2 = fakeRes();
      await gateG({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, r2, () => {});
      target = Object.keys((await rowRec(HASH)).holds)[0];
      failSettles = Infinity; failed = 0;
      r2.statusCode = 200; r2.end();
      ok(await until(async () => !!(await rowRec(HASH)).holds?.[target]?.s), "a final 200 marks its hold settling as the response ends");
      r2.emit("finish");
      await wait(3_500); // the settle's retries end inside the window; the hold ages past it
      const mid = await rowRec(HASH);
      ok(failed >= 1 && mid.heldMicro === 10_000 && mid.balanceMicro === b0.balanceMicro - 10_000, `the settle gave up and the hold is still held, not returned (failed ${failed}, held ${mid.heldMicro})`);
      const sw = await H.sweepAbandonedHolds();
      const b1 = await rowRec(HASH);
      ok(sw.settled === 1 && sw.released === 0 && b1.heldMicro === 0 && b1.balanceMicro === b0.balanceMicro - 10_000 && b1.spentMicro === b0.spentMicro + 10_000 && b1.calls === b0.calls + 1, `the sweep debits the settling hold: nothing returns to the balance (${JSON.stringify(sw)}, balance ${b1.balanceMicro - b0.balanceMicro}, spent +${b1.spentMicro - b0.spentMicro})`);
      ok(sales.length === 2 && sales[1].priceUsd === 0.01 && sales[1].slug === "whois", `the sweep books the sale once (${JSON.stringify(sales.map((s) => s.priceUsd))})`);
      failSettles = 0;
      const lateS = await G.settle(HASH, 10_000, "whois", null, target);
      const b2 = await rowRec(HASH);
      ok(lateS.chargedUsd === 0.01 && b2.spentMicro === b1.spentMicro && b2.balanceMicro === b1.balanceMicro && sales.length === 2, `a settle that lands after the sweep moves nothing and books nothing (${sales.length} sales)`);
    } finally {
      unhook();
      delete process.env.CREDITS_ABANDONED_HOLD_MS;
    }
  }
  // ---- refusals on the database: the claim-once marker, its refund outcome
  // (regexp_replace keeps the kind), stuck pending, and the daily limit
  // across two instances sharing the rows.
  {
    process.env.CREDITS_DAILY_MAX_USD = "50";
    const refunds = [];
    const fps = {};
    const ls = {};
    const lstripe = {
      checkout: { sessions: { retrieve: async (id) => { await wait(5); if (!ls[id]) throw new Error("no"); return ls[id]; } } },
      paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { amount_refunded: refundedCents[id] || 0, payment_method_details: { card: { fingerprint: fps[id] || null } } } }) },
      refunds: { create: async (x) => { refunds.push(x); return { id: "re_" + refunds.length }; } },
    };
    const refundedCents = {};
    let t = Date.parse("2026-11-02T12:00:00Z");
    const A = createCredits({ stripe: lstripe, baseUrl: "https://agent402.tools", storeDir: DIR, now: () => t, log: quiet });
    const B = createCredits({ stripe: lstripe, baseUrl: "https://agent402.tools", storeDir: DIR, now: () => t, log: quiet });
    await A.ready(); await B.ready();
    const paid = (id, email, fp, extra = {}) => { ls[id] = { id, mode: "payment", payment_status: "paid", payment_intent: "pi_" + id, customer_details: { email, ...extra }, metadata: { credits_pack: "credits-20" } }; fps["pi_" + id] = fp; };
    for (let i = 0; i < 6; i++) paid(`cs_pgl${i}`, "pg@x.com", "fp_pg");
    const out = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? A : B).claim(`cs_pgl${i}`)));
    const minted = out.filter((x) => x.status === "minted").length;
    ok(minted <= 2 && out.every((x) => x.status === "minted" || x.status === "over_limit") && refunds.length === out.length - minted, `pg: six purchases across two instances never pass $50 (${minted} issued, ${refunds.length} refunded)`);
    // A re-claim of a refused session answers the same and refunds nothing more.
    const refused = out.findIndex((x) => x.status === "over_limit");
    const r0 = refunds.length;
    ok((await A.claim(`cs_pgl${refused}`)).status === "over_limit" && refunds.length === r0, "pg: a refused session re-claimed answers over_limit and refunds nothing");
    // A failed refund keeps its kind through regexp_replace and is listed as owed.
    lstripe.refunds.create = async () => { throw new Error("card closed"); };
    paid("cs_pgtax", "eu@x.com", "fp_eu", { address: { country: "FR" } });
    const tx = await A.claim("cs_pgtax");
    ok(tx.status === "tax_id_required" && tx.refunded === false, "pg: an EU purchase without a VAT number is refused; its failed refund is reported");
    ok((await B.refusalsToRefund()).includes("cs_pgtax") && (await B.claim("cs_pgtax")).status === "tax_id_required", "pg: the other instance lists it as owed and keeps its kind");
    await B.markRefusalRefunded("cs_pgtax");
    const after = await A.claim("cs_pgtax");
    ok(after.status === "tax_id_required" && after.refunded === true && !(await A.refusalsToRefund()).includes("cs_pgtax"), "pg: marking it refunded is seen by both instances");
    // A payment Stripe refunded in full before its claim is claimed with its
    // outcome in ONE statement (the claim-once insert carries the final
    // marker), so no failure between two writes can leave it pending and
    // listed as owed.
    {
      const { hookStatements } = await import("./lib/pg-statement-hook.js");
      paid("cs_pgrf", "rf@x.com", "fp_rf");
      refundedCents.pi_cs_pgrf = 2000;
      const writes = [];
      const unhook = hookStatements(await sdb.stateDb(), async (sql, values, run) => { if (/^\s*(INSERT|UPDATE)/i.test(sql) && values.includes("cs_pgrf")) writes.push(sql.replace(/\s+/g, " ").slice(0, 60)); return run(); });
      const rf = await A.claim("cs_pgrf");
      unhook();
      const marker = ((await sdb.stateQuery(`SELECT body ->> 'cs_pgrf' AS m FROM ${sdb.stateDbSchema()}.records WHERE collection = 'credits' AND id = '_sessions'`)).rows[0] || {}).m;
      ok(rf.status === "refunded" && marker === "refused-refunded:refunded", `pg: a pack refunded before its claim is marked refunded, never pending (${marker})`);
      ok(writes.length === 1 && /INSERT/i.test(writes[0]), `pg: the marker is written in one statement (${writes.length}: ${JSON.stringify(writes)})`);
      t += 6 * 60_000;
      ok(!(await B.refusalsToRefund()).includes("cs_pgrf") && (await B.claim("cs_pgrf")).status === "refunded", "pg: it is never listed as owed, and a re-claim answers the same");
    }
    // A refusal left pending (a crash before the refund outcome) becomes owed after five minutes.
    ok(await A._internals.refuseSession("cs_pgstuck", "refused"), "pg: setup, a refusal left pending");
    ok(!(await B.refusalsToRefund()).includes("cs_pgstuck"), "pg: a fresh pending refusal is not owed");
    t += 6 * 60_000;
    ok((await B.refusalsToRefund()).includes("cs_pgstuck"), "pg: pending past five minutes is owed");
    looseCreditsChecks();
  }
  // ---- refund on request, on the rows: two containers, one refund ---------
  {
    const charges = { pi_rr: { amount: 2000, amount_refunded: 0 } };
    const sends = [], done = {}, made = [];
    const rstripe = {
      checkout: { sessions: { retrieve: async (id) => (id === "cs_rr" ? { id, mode: "payment", payment_status: "paid", payment_intent: "pi_rr", customer_details: { email: "rr@x.com" }, metadata: { credits_pack: "credits-20" } } : (() => { throw new Error("no"); })()) } },
      paymentIntents: { retrieve: async (id) => ({ id, latest_charge: charges[id] ? { ...charges[id] } : null }) },
      // Stripe answers a repeated idempotency key with the first result.
      refunds: { create: async (a, o = {}) => { sends.push({ ...a, idem: o.idempotencyKey }); if (done[o.idempotencyKey]) return done[o.idempotencyKey]; const p = (async () => { await wait(30); const c = charges[a.payment_intent]; if (c.amount_refunded + a.amount > c.amount) throw new Error("over"); c.amount_refunded += a.amount; const r = { id: `re_${sends.length}`, amount: a.amount, status: "succeeded", payment_intent: a.payment_intent, metadata: a.metadata || {} }; made.push(r); return r; })(); done[o.idempotencyKey] = p; return p; },
        list: async ({ payment_intent }) => ({ data: made.filter((r) => r.payment_intent === payment_intent) }) },
    };
    const R1 = createCredits({ stripe: rstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const R2 = createCredits({ stripe: rstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const m = await R1.claim("cs_rr");
    const h = await R1.authorize(m.key, 2.5);
    await R1.settle(h.hash, h.heldMicro, "whois");
    const held = await R2.authorize(m.key, 1);
    ok((await R1.requestRefund(m.key)).status === "in_flight" && sends.length === 0, "pg: a request while a hold is on the row moves nothing");
    await R2.release(held.hash, held.heldMicro);
    const [x, y] = await Promise.all([R1.requestRefund(m.key), R2.requestRefund(m.key)]);
    ok(x.status === "refunded" && y.status === "refunded" && charges.pi_rr.amount_refunded === 1750, `pg: two containers asking at once refund the unspent $17.50 once (${x.status}, ${y.status}, ${charges.pi_rr.amount_refunded} cents)`);
    ok(new Set(sends.map((s) => s.idem)).size === 1, `pg: every send of that request carries one idempotency key (${sends.length} send(s))`);
    const row = await rowRec(hashKey(m.key));
    ok(row.balanceMicro === 0 && row.disabled === true && row.refundRequest?.state === "done" && row.refundedMicro === 17_500_000, "pg: the row is empty, disabled and records the refund");
    ok((await R2.authorize(m.key, 0.001)).reason === "disabled" && !(await R2.refundRequestsOwed()).includes(m.keyId), "pg: the key cannot spend and nothing is owed");
  }
  // ---- a refund Stripe holds as pending settles by its webhook, on the rows --
  {
    const made = [];
    const pstripe = {
      checkout: { sessions: { retrieve: async (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, customer_details: { email: `${id}@x.com` }, metadata: { credits_pack: "credits-20" } }) } },
      paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { amount: 2000, amount_refunded: 0 } }) },
      refunds: { create: async (a, o = {}) => { const r = { id: `re_p${made.length}`, amount: a.amount, status: "pending", payment_intent: a.payment_intent, metadata: a.metadata || {}, idem: o.idempotencyKey }; made.push(r); return { ...r }; },
        retrieve: async (id) => ({ ...made.find((r) => r.id === id) }), list: async () => ({ data: [] }) },
    };
    const P1 = createCredits({ stripe: pstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const P2 = createCredits({ stripe: pstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const k = await P1.claim("cs_pp");
    ok((await P1.requestRefund(k.key)).status === "pending" && (await rowRec(hashKey(k.key))).refundRequest?.state === "pending", "pg: a refund Stripe answers pending stays pending on the row");
    const ev = (status) => ({ ...made[0], status });
    ok((await P2.settleRefund(ev("failed"))) === k.keyId && (await rowRec(hashKey(k.key))).refundRequest?.state === "failed" && (await P1.refundRequestsOwed()).includes(k.keyId), "pg: refund.failed from another container makes it owed");
    ok((await P2.settleRefund(ev("failed"))) === null, "pg: a retried delivery changes nothing");
    const again = await P1.requestRefund(k.key);
    ok(again.status === "pending" && made.length === 2 && made[0].idem !== made[1].idem, "pg: asking again sends anew under a new idempotency key");
    ok((await P2.settleRefund({ ...made[1], status: "succeeded" })) === k.keyId && (await rowRec(hashKey(k.key))).refundRequest?.state === "done" && !(await P1.refundRequestsOwed()).includes(k.keyId), "pg: refund.updated succeeded marks it done and nothing is owed");
  }
  // ---- a top-up and a new key, on the rows (the balance page) ----------------
  {
    const ts = {
      cs_tp: { id: "cs_tp", mode: "payment", payment_status: "paid", payment_intent: "pi_tp", customer_details: { email: "tp@x.com" }, metadata: { credits_pack: "credits-20" } },
    };
    const tstripe = { checkout: { sessions: { retrieve: async (id) => { if (!ts[id]) throw new Error("no"); return ts[id]; } } }, paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { amount: 2000, amount_refunded: 0 } }) } };
    const T1 = createCredits({ stripe: tstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const T2 = createCredits({ stripe: tstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const k = await T1.claim("cs_tp");
    ts.cs_tq = { id: "cs_tq", mode: "payment", payment_status: "paid", payment_intent: "pi_tq", customer_details: { email: "tp@x.com" }, metadata: { credits_pack: "credits-20", credits_topup: k.keyId, credits_account: "tp@x.com" } };
    const [a, b] = await Promise.all([T1.claim("cs_tq"), T2.claim("cs_tq")]);
    ok(a.status === "topped_up" && b.status === "topped_up" && (await T1.balance(k.key)).balanceUsd === 40, `pg: one top-up claimed by two containers adds once ($${(await T1.balance(k.key)).balanceUsd})`);
    const held = await T2.authorize(k.key, 1);
    ok((await T1.issueNewKey(k.keyId, "tp@x.com")).status === "in_flight", "pg: a new key waits for the call in flight");
    await T2.release(held.hash, held.heldMicro);
    const n = await T1.issueNewKey(k.keyId, "tp@x.com");
    ok(n.status === "issued" && (await rowRec(hashKey(k.key))) === null && (await rowRec(hashKey(n.key)))?.keyId === k.keyId, "pg: the record moves to the new key's row in one step");
    ok((await T2.authorize(k.key, 0.001)).reason === "unknown" && (await T2.balance(n.key)).balanceUsd === 40, "pg: another container refuses the old key and spends the new one");
    ok((await T2.claim("cs_tp")).keyId === k.keyId && (await T2.claim("cs_tq")).status === "topped_up", "pg: the claim index follows the record");
  }
  // ---- fraud warnings and disputes on the rows, across containers -------------
  {
    const ws = {}, wch = {}, wref = [];
    const pay = (id, pi, email, meta = {}) => { ws[id] = { id, mode: "payment", payment_status: "paid", payment_intent: pi, customer_details: { email }, metadata: { credits_pack: "credits-20", ...meta } }; wch[pi] = { amount: 2000, amount_refunded: 0 }; };
    const wstripe = {
      checkout: { sessions: { retrieve: async (id) => { if (!ws[id]) throw new Error("no"); return ws[id]; } } },
      paymentIntents: { retrieve: async (pi) => ({ id: pi, latest_charge: wch[pi] ? { amount: wch[pi].amount, amount_refunded: wch[pi].amount_refunded, outcome: { type: "authorized", risk_level: "normal" }, payment_method_details: { card: { fingerprint: `fp_${pi}` } } } : null }) },
      refunds: { create: async (a) => { const c = wch[a.payment_intent]; const amt = a.amount ?? (c.amount - c.amount_refunded); c.amount_refunded += amt; const r = { id: `re_w${wref.length}`, amount: amt, status: "succeeded", payment_intent: a.payment_intent, metadata: a.metadata || {} }; wref.push(r); return { ...r }; },
        retrieve: async (id) => ({ ...wref.find((r) => r.id === id) }), list: async ({ payment_intent }) => ({ data: wref.filter((r) => r.payment_intent === payment_intent) }) },
    };
    const W1 = createCredits({ stripe: wstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    const W2 = createCredits({ stripe: wstripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    // A warning before the key: remembered on the database, refused on another container's claim.
    pay("cs_wpg", "pi_wpg", "wpg@x.com");
    ok((await W1.fraudWarning("pi_wpg")).remembered === true, "pg: a warning on a payment with no key yet is remembered");
    const wc = await W2.claim("cs_wpg");
    ok(wc.status === "not_completed" && !wc.key && wch.pi_wpg.amount_refunded === 2000 && (await W1.balancesForEmail("wpg@x.com")).length === 0, `pg: another container's claim on it issues no key and refunds it in full (${wc.status})`);
    ok((await W1.claim("cs_wpg")).status === "not_completed" && wref.filter((r) => r.payment_intent === "pi_wpg").length === 1, "pg: a second claim refunds nothing more");
    // A dispute on a top-up, lost: the purchase's share stays usable.
    pay("cs_lpa", "pi_lpa", "lp@x.com");
    const LK = await W1.claim("cs_lpa");
    pay("cs_lpb", "pi_lpb", "lp@x.com", { credits_topup: LK.keyId, credits_account: "lp@x.com" });
    ok((await W2.claim("cs_lpb")).status === "topped_up", "guard: pg: the balance was topped up");
    await W1.disableByPaymentIntent("pi_lpb", "disputed");
    ok((await W2.authorize(LK.key, 0.001)).reason === "frozen", "guard: pg: the dispute froze the key");
    ok((await W2.disputeClosed("pi_lpb", { won: false, status: "lost", amountCents: 2000 })) === LK.keyId, "pg: a dispute lost reaches the row");
    const lrow = await rowRec(hashKey(LK.key));
    ok(lrow.balanceMicro === 20_000_000 && lrow.disabled === false && lrow.payments.find((p) => p.pi === "pi_lpb")?.lostCents === 2000, `pg: the disputed payment leaves the balance once and the other payment's share is usable (${lrow.balanceMicro})`);
    ok((await W2.disputeClosed("pi_lpb", { won: false, status: "lost", amountCents: 2000 })) === null && (await rowRec(hashKey(LK.key))).balanceMicro === 20_000_000, "pg: the same outcome delivered again takes nothing more");
    // A warning, then a dispute, then the dispute won: the review is owed again.
    const keepAuto = process.env.CREDITS_EFW_AUTO_REFUND;
    process.env.CREDITS_EFW_AUTO_REFUND = "off";
    pay("cs_wwp", "pi_wwp", "wwp@x.com");
    const WK = await W1.claim("cs_wwp");
    ok((await W1.fraudWarning("pi_wwp")).owed === true, "guard: pg: the warning's refund is owed");
    await W2.disableByPaymentIntent("pi_wwp", "disputed");
    ok(!(await W1.refundRequestsOwed()).includes(WK.keyId), "pg: nothing is listed as owed while the dispute runs");
    ok((await W2.approveFraudRefund(WK.keyId)).status === "disputed" && (await rowRec(hashKey(WK.key))).fraudReview?.state === "disputed" && wch.pi_wwp.amount_refunded === 0, "pg: an approval during the dispute sends nothing and holds the review");
    await W1.enableByPaymentIntent("pi_wwp", "disputed");
    const wrow = await rowRec(hashKey(WK.key));
    ok(wrow.disputeClosedAt && wrow.disabledReason === "fraud-warning" && wrow.fraudReview?.state === "owed" && (await W2.refundRequestsOwed()).includes(WK.keyId), "pg: the dispute won is recorded, the key stays frozen for the warning and the refund is owed");
    ok((await W2.approveFraudRefund(WK.keyId)).status === "refunded" && wch.pi_wwp.amount_refunded === 2000, "pg: the approval then sends it");
    if (keepAuto === undefined) delete process.env.CREDITS_EFW_AUTO_REFUND; else process.env.CREDITS_EFW_AUTO_REFUND = keepAuto;
  }
  // The balance page's lookups find rows by email and key id in the
  // database (the history-free full walk stays for status and the owed word).
  {
    const L = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    await L.ready();
    const put = async (hash, body) => sdb.stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body) VALUES ('credits', $1, $2::jsonb)`, [`k_${hash}`, JSON.stringify(body)]);
    const rec = (keyId, email, extra = {}) => ({ keyId, email, balanceMicro: 5_000_000, loadedMicro: 5_000_000, spentMicro: 0, heldMicro: 0, calls: 0, createdAt: "2026-11-01T00:00:00.000Z", history: Array.from({ length: 300 }, (_, i) => ({ t: i, k: "charge", slug: "whois", m: 1000 })), ...extra });
    for (let i = 0; i < 40; i++) await put(`lk${String(i).padStart(4, "0")}`.padEnd(64, "0"), rec(`lk${String(i).padStart(10, "0")}`, `other${i}@x.com`));
    await put("lka".padEnd(64, "a"), rec("aaaaaaaaaaa1", "Mixed@Example.com"));
    await put("lkb".padEnd(64, "b"), rec("aaaaaaaaaaa2", "mixed@example.com", { createdAt: "2026-11-02T00:00:00.000Z" }));
    await put("lkc".padEnd(64, "c"), rec("aaaaaaaaaaa3", "someone@else.com"));
    const mine = await L.balancesForEmail("mixed@example.com");
    ok(mine.map((b) => b.keyId).join() === "aaaaaaaaaaa2,aaaaaaaaaaa1", `pg: balancesForEmail finds every row bought with the email, in any case, and only those (${mine.map((b) => b.keyId).join()})`);
    ok((await L.balancesForEmail("nobody@example.com")).length === 0, "pg: an email with no balance finds none");
    const h = await L.historyFor("aaaaaaaaaaa1", "MIXED@example.com");
    ok(h?.keyId === "aaaaaaaaaaa1" && h.rows.length === 300 && (await L.historyFor("aaaaaaaaaaa3", "mixed@example.com")) === null, "pg: historyFor reads the key id's row and only for its own email");
    ok((await L.setLowNotice("aaaaaaaaaaa3", false)) === true && (await rowRec("lkc".padEnd(64, "c"))).lowNoticeOff && (await L.setLowNotice("zzzzzzzzzzzz", false)) === false, "pg: a key id finds its row (and an unknown one none)");
    const st = await L.status();
    ok(st.keys >= 43 && st.rows.every((r) => !("history" in r)), `pg: the operator status still walks every key (${st.keys})`);

    // ONE NORMALIZED EMAIL FIELD. The email a key is found by is normalized
    // once, in JS (emailKeyOf), stored on the row (`emailKey`) and compared
    // as stored: Postgres lower() follows the database's locale and lowers
    // "İ" differently from JS, so a non-ASCII email was not found.
    ok(emailKeyOf(" İpek@X.COM ") === "i̇pek@x.com" && emailKeyOf("") === null && emailKeyOf(null) === null, `emailKeyOf trims and lowers once, in JS (${JSON.stringify(emailKeyOf(" İpek@X.COM "))})`);
    sessions.cs_tr = { id: "cs_tr", mode: "payment", payment_status: "paid", payment_intent: "pi_tr", customer_details: { email: "İpek@X.com" }, metadata: { credits_pack: "credits-20" } };
    const tr = await L.claim("cs_tr");
    const trRow = await rowRec(hashKey(tr.key));
    ok(tr.status === "minted" && trRow?.emailKey === "i̇pek@x.com" && trRow.email === "İpek@X.com", `pg: a minted key's row keeps the email as given and its normalized key (${JSON.stringify(trRow?.emailKey)})`);
    const trFound = await L.balancesForEmail("İPEK@x.com");
    ok(trFound.map((b) => b.keyId).join() === tr.keyId && (await L.historyFor(tr.keyId, "i̇pek@X.com"))?.keyId === tr.keyId, `pg: a non-ASCII email finds its balance whatever the database's locale (${trFound.map((b) => b.keyId).join() || "none"})`);
    // A row written before the field (an older build) is given it at the next load, computed in JS.
    await put("lkd".padEnd(64, "d"), rec("aaaaaaaaaaa4", "Ünïcode@Example.com"));
    ok(!("emailKey" in (await rowRec("lkd".padEnd(64, "d")))), "a row an older build wrote has no normalized email");
    const L2 = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: quiet });
    await L2.ready();
    ok((await rowRec("lkd".padEnd(64, "d")))?.emailKey === "ünïcode@example.com" && (await rowRec("lka".padEnd(64, "a")))?.emailKey === "mixed@example.com", "pg: the next load gives every older row its normalized email");
    ok((await L2.balancesForEmail("ÜNÏCODE@example.com")).map((b) => b.keyId).join() === "aaaaaaaaaaa4", "pg: and it is found by it");

    // EXPRESSION INDEXES, built CONCURRENTLY outside any transaction and
    // outside the boot's schema lock, once; an index a failed build left
    // INVALID is dropped and built again.
    const schemaName = sdb.stateDbSchema();
    const idx = async () => Object.fromEntries((await sdb.stateQuery(`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2)`, [schemaName, CREDITS_INDEXES.map((x) => x.name)])).rows.map((r) => [r.name, r.valid]));
    ok(Object.keys(await idx()).length === 0, "no credits index exists before the build runs");
    // A build that failed part way leaves an INVALID index under the name (a unique build over duplicate keys does).
    await sdb.stateStatementOutsideTx(`CREATE UNIQUE INDEX CONCURRENTLY ${CREDITS_INDEXES[1].name} ON ${schemaName}.records ((body->>'balanceMicro')) WHERE collection = 'credits'`).catch(() => {});
    ok((await idx())[CREDITS_INDEXES[1].name] === false, "a failed concurrent build leaves an invalid index (the case the build repairs)");
    const built = await ensureCreditsIndexes({ log: quiet });
    const after = await idx();
    ok(built.ran === true && CREDITS_INDEXES.every((x) => after[x.name] === true), `the build leaves every credits index valid (${JSON.stringify(after)})`);
    ok(built.result?.built?.length === 2 && built.result?.rebuilt?.join() === CREDITS_INDEXES[1].name, `the invalid one was dropped and built again (${JSON.stringify(built.result)})`);
    const again = await ensureCreditsIndexes({ log: quiet });
    ok(again.ran === true && again.result?.built?.length === 0, `a second run builds nothing (${JSON.stringify(again.result)})`);
    const plan = async (sql, params) => (await sdb.withStateTx(async (c) => { await c.query("SET LOCAL enable_seqscan = off"); return (await c.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n"); }));
    const emailPlan = await plan(CREDITS_LOOKUP_SQL.email(`${schemaName}.records`), ["mixed@example.com"]);
    const keyPlan = await plan(CREDITS_LOOKUP_SQL.keyId(`${schemaName}.records`), ["aaaaaaaaaaa1"]);
    ok(emailPlan.includes(CREDITS_INDEXES[0].name) && keyPlan.includes(CREDITS_INDEXES[1].name), `the balance page's two lookups can use their indexes (${emailPlan.split("\n")[0]} | ${keyPlan.split("\n")[0]})`);
    ok((await L2.balancesForEmail("mixed@example.com")).length === 2 && (await L2.historyFor("aaaaaaaaaaa1", "mixed@example.com"))?.keyId === "aaaaaaaaaaa1", "the lookups answer the same with the indexes in place");
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-credits-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
