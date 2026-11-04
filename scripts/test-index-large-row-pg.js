// A seller row of tens of megabytes is written and read back under a statement
// limit it outlasts. The persist's one-row upsert runs under a limit scaled to
// the row's size (largeRowTimeoutMs, src/state-db.js), and a warm-start page
// that times out is read again one row at a time under the large-row limit, so
// the boot passes the row instead of stopping at it. The default limit is set
// low here so a ~60 MB row outlasts it, as the largest seller's row outlasts
// the production default.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-large-row-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";

requireTestPg({ label: "test-index-large-row-pg" });
const STATEMENT_MS = 250;
process.env.STATE_DB_STATEMENT_TIMEOUT_MS = String(STATEMENT_MS);
process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-large-row-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "absent", "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function seller(i, tools) {
  const list = new Array(tools);
  for (let k = 0; k < tools; k++) {
    list[k] = {
      route: `/api/item/${k}`, method: "GET", name: `item tool ${k}`,
      description: `Returns item ${k} of seller ${i} with pagination, filters, sorting and documented error codes for an agent. `.repeat(6),
      price: "$0.001", network: "eip155:8453", payTo: "0x" + i.toString(16).padStart(8, "0").repeat(5),
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tags: ["item", "x402"], mimeType: "application/json", maxTimeoutSeconds: 60,
    };
  }
  return [`https://seller-${i}.example`, { manifest: { name: `Seller ${i}`, x402Version: 2, network: "base" }, tools: list, fetchedAt: 1_000_000 + i, error: null, source: "crawl", history: [{ at: 1, ok: true }], paywall: null, discoveryPath: "/.well-known/x402" }];
}

try {
  // Units: the scaled limit and the timeout test.
  ok(sdb.largeRowTimeoutMs(500_000) === STATEMENT_MS, "a row under a megabyte keeps the default limit");
  ok(sdb.largeRowTimeoutMs(84 * 1_048_576) === STATEMENT_MS + 83 * 500, "an 84 MB row gets 500 ms per megabyte past the first");
  ok(sdb.largeRowTimeoutMs(Infinity) === 120_000, "an unknown size gets the large-row ceiling");
  ok(sdb.isStatementTimeout(new Error("canceling statement due to statement timeout")) && sdb.isStatementTimeout(new Error("Query read timeout")),
    "the server's and the client's timeout messages both read as a timeout");
  ok(!sdb.isStatementTimeout(new Error("connection terminated")), "another database error does not");

  // stateQuery under a raised limit runs a statement the default limit cancels.
  let plain = null;
  try { await sdb.stateQuery("SELECT pg_sleep(0.6)"); } catch (e) { plain = e; }
  ok(sdb.isStatementTimeout(plain), `a 600 ms statement outlasts the ${STATEMENT_MS} ms default (${String(plain?.message || "no error").slice(0, 60)})`);
  let raised = null;
  try { await sdb.stateQuery("SELECT pg_sleep(0.6)", [], { timeoutMs: 3000 }); } catch (e) { raised = e; }
  ok(!raised, `the same statement completes under timeoutMs 3000 (${raised ? raised.message : "ok"})`);

  const idx = await import("../src/x402-index.js");

  // The warm start's page read: a timed-out page is read again as one row
  // under the large-row limit; any other error is not retried.
  const calls = [];
  const r = await idx._readWarmPageForTests("a", async (o) => { calls.push(o); if (o.limit > 1) throw new Error("canceling statement due to statement timeout"); return [{ id: "b", body: {} }]; });
  ok(r.single && r.page.length === 1 && calls.length === 2 && calls[1].limit === 1 && calls[1].after === "a" && calls[1].timeoutMs === 120_000,
    "a timed-out page is read again as one row after the same id under the large-row limit");
  let other = null;
  try { await idx._readWarmPageForTests("a", async () => { throw new Error("connection terminated"); }); } catch (e) { other = e; }
  ok(other?.message === "connection terminated", "another error is thrown, not retried");

  // Production's shape: small rows on both sides of one very large row.
  const entries = [seller(1, 3), seller(2, 60_000), seller(3, 3), seller(4, 3)];
  const big = JSON.stringify(entries[1]).length;
  ok(big > 50 * 1_048_576, `the large row is ${Math.round(big / 1_048_576)} MB`);
  const wrote = await idx.__testPersistToStateDb(entries);
  ok(wrote === true, "the persist writes every row, the large one included");
  const { rows } = await sdb.stateQuery(`SELECT id FROM ${process.env.STATE_DB_SCHEMA}.records WHERE collection = 'x402-index' ORDER BY id`);
  ok(rows.length === 4, `four rows stored (${rows.map((x) => x.id).join(", ")})`);

  // A fresh boot's warm start reads past the large row.
  idx._cacheForTests().clear();
  const n = await idx.warmStartIndexFromStateDb();
  const held = [...idx._cacheForTests().keys()].sort();
  ok(n === 4 && held.length === 4, `the warm start loads all four sellers (${n}: ${held.join(", ")})`);
  ok(idx._cacheForTests().get("https://seller-2.example")?.tools?.length === 60_000, "the large seller comes back whole");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-large-row-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
