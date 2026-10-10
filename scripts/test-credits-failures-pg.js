// Prepaid credits on a REAL Postgres when a reply is lost or two containers
// share the key rows:
//   - a settle whose COMMIT lands but whose reply is lost is retried; the
//     retry moves no money again and books the sale at what the first settle
//     took (not $0), and the call is counted once;
//   - a hold sweep on another container never returns a hold a running
//     request still holds: the request refreshes its hold while it runs.
// Two credits instances in one process stand in for two containers (each
// has its own set of live holds). Requires STATE_DATABASE_URL (CI fails
// without it).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { requireTestPg } from "./lib/test-pg.js";

requireTestPg({ label: "test-credits-failures-pg" });
process.env.CREDITS_ABANDONED_HOLD_MS = "1500";
const sdb = await import("../src/state-db.js");
const { createCredits, hashKey } = await import("../src/credits.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RT = () => `${sdb.stateDbSchema()}.records`;
const KEY = "a402_" + "B".repeat(40), HASH = hashKey(KEY);
const seed = (balanceMicro) => sdb.stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ('credits', $1, $2::jsonb) ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [`k_${HASH}`, JSON.stringify({ keyId: HASH.slice(0, 12), balanceMicro, loadedMicro: balanceMicro, spentMicro: 0, calls: 0, heldMicro: 0, holds: {} })]);
const row = async () => (await sdb.stateQuery(`SELECT body FROM ${RT()} WHERE collection = 'credits' AND id = $1`, [`k_${HASH}`])).rows[0].body;

// The COMMIT of the next transaction that wrote the key's row lands, and its reply is lost.
const pool = await sdb.stateDb();
const origConnect = pool.connect.bind(pool);
let armCommit = 0;
pool.connect = (...a) => {
  if (typeof a[0] === "function") return origConnect(...a);
  return origConnect().then((c) => {
    const oq = c.query; let wrote = false;
    c.query = function (cfg, v, cb) {
      const text = String(cfg?.text ?? cfg);
      const p = oq.call(this, cfg, v, cb);
      if (/^UPDATE .*records SET body/.test(text)) wrote = true;
      if (/^COMMIT/i.test(text) && wrote && armCommit > 0) { armCommit--; wrote = false; return Promise.resolve(p).then(() => { throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }); }); }
      return p;
    };
    const rel = c.release.bind(c);
    c.release = (e) => { c.query = oq; return rel(e); };
    return c;
  });
};

const mkReqRes = () => {
  const req = { method: "POST", path: "/api/t", headers: { authorization: `Bearer ${KEY}` } };
  const res = new EventEmitter(); const hdr = {};
  res.statusCode = 200; res.setHeader = (k, v) => { hdr[k.toLowerCase()] = v; }; res.getHeader = (k) => hdr[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; }; res.json = () => res; res.end = () => res;
  return { req, res };
};

try {
  await seed(5_000_000);
  // ---- a settle whose reply was lost ----
  {
    const sales = [];
    const credits = createCredits({ stripe: null, baseUrl: "http://x", storeDir: mkdtempSync(join(tmpdir(), "credits-fail-a-")), log: () => {}, onDebit: (s) => sales.push(s.priceUsd) });
    await credits.ready();
    const gate = credits.gate(() => ({ priceUsd: 1, slug: "t" }));
    const { req, res } = mkReqRes();
    await gate(req, res, () => {});
    armCommit = 1;
    res.emit("finish");
    for (let i = 0; i < 60 && req.creditsCharged == null; i++) await wait(50);
    const b = await row();
    ok(b.spentMicro === 1_000_000 && b.balanceMicro === 4_000_000 && b.heldMicro === 0, `the debit moved once (spent ${b.spentMicro}, balance ${b.balanceMicro}, held ${b.heldMicro})`);
    ok(b.calls === 1, `the call is counted once (${b.calls})`);
    ok(sales.length === 1 && sales[0] === 1, `one $1 sale is booked for it (${JSON.stringify(sales)})`);
    ok(req.creditsCharged === 1, `the request reads what it was charged (${req.creditsCharged})`);
  }

  // ---- a sweep on another container while a request runs ----
  {
    await seed(5_000_000);
    const dirA = mkdtempSync(join(tmpdir(), "credits-fail-a-"));
    const A = createCredits({ stripe: null, baseUrl: "http://x", storeDir: dirA, log: () => {} });
    const B = createCredits({ stripe: null, baseUrl: "http://x", storeDir: mkdtempSync(join(tmpdir(), "credits-fail-b-")), log: () => {} });
    await A.ready(); await B.ready();
    const gate = A.gate(() => ({ priceUsd: 1, slug: "t" }));
    const { req, res } = mkReqRes();
    await gate(req, res, () => {});
    await wait(2500); // past the abandoned-hold window
    const swept = await B.sweepAbandonedHolds();
    const mid = await row();
    ok(swept.released === 0 && mid.heldMicro === 1_000_000, `another container's sweep leaves the running request's hold (released ${swept.released}, held ${mid.heldMicro})`);
    res.emit("finish");
    for (let i = 0; i < 60 && req.creditsCharged == null; i++) await wait(50);
    const fin = await row();
    ok(fin.spentMicro === 1_000_000 && fin.heldMicro === 0 && fin.balanceMicro === 4_000_000, `the delivered 200 is charged $1 (spent ${fin.spentMicro}, held ${fin.heldMicro})`);
    // An abandoned hold (no request holds it) is still returned by a sweep.
    const a = await A.authorize(KEY, 1);
    await wait(1700);
    const back = await B.sweepAbandonedHolds();
    const end = await row();
    ok(a.ok && back.released === 1 && end.heldMicro === 0 && end.balanceMicro === 4_000_000, `a hold no request holds is still returned (released ${back.released}, balance ${end.balanceMicro})`);
  }
} finally {
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch (e) { console.error("drop failed", e.message); }
  await sdb.closeStateDb();
}
console.log(`\ntest-credits-failures-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
