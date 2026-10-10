// Prepaid credits on a REAL Postgres (src/credits.js with STATE_DATABASE_URL):
// the key directory is imported once at the first boot and never again, every
// write lands in the records table (and in the key's file while the directory
// exists), a session is claimed by exactly one of two concurrent claims, two
// concurrent holds on a balance that covers one leave exactly one holder, a
// hold becomes spend only on a final 200 and comes back on anything else.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-credits-pg" });
const sdb = await import("../src/state-db.js");
const { createCredits, hashKey, usdToMicro } = await import("../src/credits.js");

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
writeFileSync(join(DIR, `k_${OLD_HASH}.json`), JSON.stringify({ keyId: OLD_HASH.slice(0, 12), balanceMicro: 1_000_000, loadedMicro: 1_000_000, spentMicro: 0, calls: 0, createdAt: "2026-01-01T00:00:00.000Z", email: null, sessions: ["cs_old"], paymentIntents: ["pi_old"], pack: "credits-20", lastUsedAt: null }));
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

  // ---- (5) operator reads and the clawback ---------------------------------
  const st = await B.status();
  ok(st.keys === 2 && st.rows.every((r) => r.keyId && !r.key && !r.hash) && st.spentUsd === 0.005, "status reads every row: counts and key ids only");
  ok((await A.setDisabled(minted.keyId, true)) === true && (await B.authorize(KEY, 0.001)).reason === "disabled", "setDisabled lands on the row: the other instance refuses the key");
  ok((await A.setDisabled(minted.keyId, false)) === true && (await A.disableByPaymentIntent("pi_new", "refunded")) === minted.keyId && (await B.balance(KEY)).disabled === true, "a refunded pack payment disables its key");
  ok((await B.balanceById(minted.keyId)) === 19.995 && (await B.balanceById("nope")) === null, "balanceById reads the row by key id");

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
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-credits-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
