// The paged Tempo read (src/sales-ledger.js externalTempoPayments: each wire
// walked a page at a time on a (ts, id) cursor, the two wires merged) against
// the one-query read it replaced, used here as the oracle:
//   SELECT ... WHERE internal = 0 AND rail IN <paying> AND wire IN (<tempo>) ORDER BY ts
// On a ledger built to break a cursor: both wires past 2,000 rows each, 7-way
// timestamp ties that straddle every page boundary, ties across the two wires,
// a 2,000-row block on one timestamp that spans several pages, internal and
// free rows, rows with no payer or tx, and other wires' rows on the same
// timestamps. The rows must be the same multiset (every row once, none
// twice), with the same count and USD sum, in (ts, id) order. A cursor that
// re-reads its last row (>= for >) counts it twice; one that pages on ts alone
// drops the rest of a tie; both fail here. Offline.
import "./lib/offline-stores.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "a402-tempo-oracle-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
const sales = await import("../src/sales-ledger.js");
const { PAYING_RAILS_SQL } = await import("../src/paid-rails.js");

let pass = 0, failed = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`ok - ${msg}`); } else { failed++; console.error(`FAIL - ${msg}`); } };

const db = new Database(process.env.SALES_LEDGER_DB);
const ins = db.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const T0 = Date.UTC(2026, 9, 1);
const PAGE = 1000; // TEMPO_PAGE_ROWS in the ledger (no wire here is an exact multiple of it)
let txn = 0;
const row = (ts, wire, { internal = rnd() < 0.15 ? 1 : 0, rail = rnd() < 0.1 ? "pow" : "usdc", bare = rnd() < 0.05 } = {}) => {
  txn++;
  ins.run(ts, "x", 0.01 + (txn % 7) / 100, rail, "tempo", bare ? null : `0x${(txn % 97).toString(16).padStart(40, "0")}`, bare ? null : `0xtempo${txn}`, internal, wire);
};
db.transaction(() => {
  // mpp-tempo: 7-way ties from the start, so page ends (every 1,000 index
  // rows) land inside a tie; a 2,000-row block on one timestamp inserted
  // after 1,500 rows, so it starts mid-page and spans two page boundaries.
  for (let i = 0; i < 1500; i++) row(T0 + Math.floor(i / 7) * 1000, "mpp-tempo");
  for (let i = 0; i < 2000; i++) row(T0 + 9_000_000, "mpp-tempo", { internal: i % 50 === 0 ? 1 : 0, rail: "usdc", bare: false });
  for (let i = 1500; i < 3300; i++) row(T0 + Math.floor(i / 7) * 1000 + 20_000_000, "mpp-tempo");
  // mpp-tempo-subscription: ties on the same timestamps as the other wire.
  for (let i = 0; i < 2600; i++) row(T0 + Math.floor(i / 5) * 1000, "mpp-tempo-subscription");
  // Other wires on the same timestamps never count.
  for (let i = 0; i < 1200; i++) ins.run(T0 + Math.floor(i / 7) * 1000, "y", 0.02, "usdc", "eip155:8453", "0xabc", `0xbase${i}`, 0, i % 2 ? "x402" : null);
})();

const perWire = db.prepare("SELECT wire, COUNT(*) AS n FROM sales WHERE wire IN ('mpp-tempo', 'mpp-tempo-subscription') GROUP BY wire").all();
const tieBlock = db.prepare("SELECT COUNT(*) AS n FROM sales WHERE wire = 'mpp-tempo' AND ts = ?").get(T0 + 9_000_000).n;
ok(perWire.length === 2 && perWire.every((w) => w.n > 2 * PAGE) && tieBlock === 2000, `fixture: both wires past ${2 * PAGE} rows (${perWire.map((w) => `${w.wire} ${w.n}`).join(", ")}), a ${tieBlock}-row tie block`);
// A page boundary inside a tie: the 1,000th and 1,001st rows of the wire in (ts, id) order share a timestamp.
const walk = db.prepare("SELECT ts FROM sales WHERE wire = 'mpp-tempo' ORDER BY ts, id").all().map((r) => r.ts);
const boundaryTies = [PAGE, 2 * PAGE, 3 * PAGE].filter((k) => walk[k - 1] === walk[k]).length;
ok(boundaryTies === 3, `fixture: the first three page boundaries of a wire fall inside a timestamp tie (${boundaryTies} of 3)`);

// The oracle: the one-query read, with the id kept so a row read twice shows.
const oracle = db.prepare(`SELECT id, ts, payer, tx, price_usd FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND wire IN ('mpp-tempo', 'mpp-tempo-subscription') ORDER BY ts`).all();
const got = sales.externalTempoPayments();
const key = (r) => `${r.ts}|${r.payer ?? ""}|${r.tx ?? ""}|${Number(r.usd ?? r.price_usd).toFixed(6)}`;
const bag = (rows) => { const m = new Map(); for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); } return m; };
const sameBag = (a, b) => a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);
const usd = (rows) => rows.reduce((s, r) => s + Number(r.usd ?? r.price_usd), 0);
ok(oracle.length > 4000, `oracle: ${oracle.length} outside paid Tempo rows`);
ok(got.length === oracle.length, `paged read: the same row count as the one-query read (${got.length} vs ${oracle.length})`);
ok(Math.abs(usd(got) - usd(oracle)) < 1e-9, `paged read: the same USD sum (${usd(got).toFixed(4)} vs ${usd(oracle).toFixed(4)})`);
ok(sameBag(bag(got), bag(oracle)), "paged read: the same rows, each exactly once (multiset equal)");
const txs = got.filter((r) => r.tx).map((r) => r.tx);
ok(new Set(txs).size === txs.length, "paged read: no settlement tx appears twice");
// Order: ascending ts, and inside a tie the ledger's id order (the oracle's ids, by key).
const idOf = new Map(oracle.map((r) => [key(r), r.id]));
let ordered = true;
for (let i = 1; i < got.length; i++) {
  const a = got[i - 1], b = got[i];
  if (a.ts > b.ts || (a.ts === b.ts && a.tx && b.tx && idOf.get(key(a)) > idOf.get(key(b)))) { ordered = false; break; }
}
ok(ordered, "paged read: rows come in (ts, id) order across both wires");
// The steps the revenue ledger slices: the same rows, read a page at a time.
// The walk yields after every full page of a wire (a page is PAGE index rows,
// whatever they hold), once after each wire, and every PAGE rows of the
// merge, so the count is exact: a read that took a wire in one query, or ran
// as one step, yields fewer times and fails here.
const steps = sales.externalTempoPaymentsSteps();
let yields = 0, r = steps.next();
while (!r.done) { yields++; r = steps.next(); }
const pageYields = perWire.reduce((n, w) => n + Math.floor(w.n / PAGE), 0);
const expected = pageYields + perWire.length + Math.floor(oracle.length / PAGE);
ok(JSON.stringify(r.value) === JSON.stringify(got), "the sliced steps give the same rows as the one-call read");
ok(yields === expected, `the sliced steps yield once per ${PAGE}-row page of each wire, after each wire and every ${PAGE} merged rows (${yields} yields, expected ${expected}: ${pageYields} pages)`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\ntest-tempo-paging-oracle: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
