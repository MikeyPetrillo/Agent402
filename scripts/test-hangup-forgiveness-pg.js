// The hang-up forgiveness budget (src/hangup-forgiveness.js) on the state
// database: the abandoned records are one JSON document, the file is imported
// once at the first boot with the database on, persists write the row (and
// the file through), and the budget survives a restart: the same wallet is
// still past its budget after the records are reloaded from the row.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-hangup-forgiveness-pg" });
const { documents, imports, __dropStateSchema, closeStateDb } = await import("../src/state-db.js");
const H = await import("../src/hangup-forgiveness.js");
const { reserveHangupForgiveness, settleHangupTicket, hangupForgiven, hangupForgivenessStatus, hangupKeyDigest, loadHangupForgiveness, persistNow, flushHangupForgiveness, _resetHangupForgiveness, HANGUP_DOCUMENT_NAME } = H;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "hangup-pg-"));
const file = join(TMP, "hangup-forgiveness.json");
process.env.HANGUP_FORGIVE_FILE = file;
process.env.HANGUP_FORGIVE_SALT = "unit-salt";
process.env.HANGUP_FORGIVE_KEY_USD = "0.25";
process.env.HANGUP_FORGIVE_GLOBAL_USD = "2";
const now = Date.now();
const spend = (keys, price) => { const req = {}; reserveHangupForgiveness(req, { keys, priceUsd: price, now }); settleHangupTicket(req, { abandoned: true, now }); return req; };

try {
  // ---- 1. the file is imported once ----------------------------------------
  const K = hangupKeyDigest("0xpersist");
  writeFileSync(file, JSON.stringify({ v: 1, savedAt: now, global: [[now - 1_000, 200_000]], keys: [[K, [[now - 1_000, 200_000]]]] }));
  _resetHangupForgiveness();
  const r1 = loadHangupForgiveness(now);
  ok(r1.loaded === false && typeof r1.ready?.then === "function", "with the database on, loadHangupForgiveness returns at once with a ready promise (the server awaits it)");
  const got = await r1.ready;
  ok(got.loaded && got.global === 1 && got.keys === 1, `the file is imported into the row and applied (${JSON.stringify(got)})`);
  ok(hangupForgivenessStatus(now).abandonedInWindow === 1 && hangupForgivenessStatus(now).persisted === true, "the status shows the imported record and reads as persisted");
  const mark = await imports.done(HANGUP_DOCUMENT_NAME);
  ok(mark && mark.source === file, "the import is marked under the document's name");
  const row = await documents.get(HANGUP_DOCUMENT_NAME);
  ok(row?.body?.global?.length === 1, "the row holds the imported body");
  ok(!JSON.stringify(row.body).includes("0xpersist"), "the row holds no wallet address (digests only)");

  // A second boot does not re-import: the file is changed, the row is what loads.
  writeFileSync(file, JSON.stringify({ v: 1, savedAt: now, global: [[now - 1_000, 200_000], [now - 900, 200_000], [now - 800, 200_000]], keys: [] }));
  _resetHangupForgiveness();
  const r2 = await loadHangupForgiveness(now).ready;
  ok(r2.loaded && r2.global === 1, `a second boot reads the row, not the changed file (${JSON.stringify(r2)})`);

  // ---- 2. a persist writes the row; a fresh load sees it -----------------
  spend(["0xother", "ip:203.0.113.8"], 0.03);
  ok(await persistNow() === true, "persistNow resolves true once the row is written");
  const row2 = await documents.get(HANGUP_DOCUMENT_NAME);
  ok(row2?.body?.global?.length === 2 && row2.body.keys.length === 3, "the row now holds both abandoned records and every key");
  ok(existsSync(file) && JSON.parse(readFileSync(file, "utf8")).global.length === 2, "the file is written through (a rollback reads a current file)");
  ok(!readFileSync(file, "utf8").includes("203.0.113"), "and holds no client IP");

  // ---- 3. the budget survives a restart --------------------------------------
  _resetHangupForgiveness();
  ok(hangupForgivenessStatus(now).abandonedInWindow === 0, "(the in-memory record is empty before the load)");
  const r3 = await loadHangupForgiveness(now).ready;
  ok(r3.loaded && r3.global === 2 && r3.keys === 3, `after a restart the records come back from the row (${JSON.stringify(r3)})`);
  const again = {}; reserveHangupForgiveness(again, { keys: ["0xpersist", "ip:203.0.113.99"], priceUsd: 0.1, now });
  ok(!hangupForgiven(again) && again.__a402HangupTicket.reason === "payer budget", `the same wallet is still past its budget after the restart (${again.__a402HangupTicket.reason})`);
  const fresh = {}; reserveHangupForgiveness(fresh, { keys: ["0xnew", "ip:203.0.113.50"], priceUsd: 0.1, now });
  ok(hangupForgiven(fresh), "a wallet with no abandoned record is still forgiven");
  settleHangupTicket(fresh, { abandoned: true, now });
  // The shutdown flush starts the row write and writes the file synchronously.
  ok(flushHangupForgiveness() === true, "the shutdown flush reports the write started");
  ok(JSON.parse(readFileSync(file, "utf8")).global.length === 3, "the file carries the flushed record at once");
  await H.persistNow();
  const row3 = await documents.get(HANGUP_DOCUMENT_NAME);
  ok(row3?.body?.global?.length === 3, "the row carries it too");

  // ---- 4. two containers persist at once: neither drops the other's records ----
  {
    const HA = await import("../src/hangup-forgiveness.js?container-a");
    const HB = await import("../src/hangup-forgiveness.js?container-b");
    _resetHangupForgiveness(); // the first instance's pending persist must not add its records here
    process.env.HANGUP_FORGIVE_FILE = "off"; // no file to import: the row is the only store here
    HA._resetHangupForgiveness(); HB._resetHangupForgiveness();
    await documents.del(HANGUP_DOCUMENT_NAME);
    const spendOn = (M, keys, price, t) => { const req = {}; M.reserveHangupForgiveness(req, { keys, priceUsd: price, now: t }); M.settleHangupTicket(req, { abandoned: true, now: t }); };
    spendOn(HA, ["0xaaaa", "ip:198.51.100.1"], 0.02, now - 3_000);
    spendOn(HB, ["0xbbbb", "ip:198.51.100.2"], 0.03, now - 2_000);
    await Promise.all([HA.persistNow(), HB.persistNow()]);
    const both = (await documents.get(HANGUP_DOCUMENT_NAME))?.body;
    const has = (body, raw) => (body?.keys || []).some((r) => r[0] === HA.hangupKeyDigest(raw));
    ok(both?.global?.length === 2 && has(both, "0xaaaa") && has(both, "0xbbbb") && both.keys.length === 4, `both containers' records are in the row (${both?.global?.length} service-wide, ${both?.keys?.length} keys)`);
    spendOn(HA, ["0xaaaa", "ip:198.51.100.1"], 0.01, now - 1_000);
    await HA.persistNow();
    const after = (await documents.get(HANGUP_DOCUMENT_NAME))?.body;
    ok(after.global.length === 3 && after.keys.find((r) => r[0] === HA.hangupKeyDigest("0xbbbb"))?.[1]?.length === 1, "a later persist from one container keeps the other's records");
    process.env.HANGUP_FORGIVE_FILE = file;
  }

  // A load from an unreadable row body is strict, like the file.
  await documents.put(HANGUP_DOCUMENT_NAME, { v: 99, global: [[now - 1, 5_000]] });
  _resetHangupForgiveness();
  const r4 = await loadHangupForgiveness(now).ready;
  ok(r4.loaded === false && hangupForgivenessStatus(now).abandonedInWindow === 0, "a document of another version is not read");
} catch (e) {
  fail++;
  console.error("FAIL - threw:", e?.stack || e);
} finally {
  _resetHangupForgiveness();
  await __dropStateSchema().catch(() => {});
  await closeStateDb();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\ntest-hangup-forgiveness-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
