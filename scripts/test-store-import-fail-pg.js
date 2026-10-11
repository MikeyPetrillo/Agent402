// The stores that import their volume files through state-db's importOnce
// must treat a failed import as a failed load, never as "nothing to import":
// the traffic rollups, the MCP task records and the x402 index warm start
// each keep retrying until the import lands, and the data the file held
// reaches memory once the database answers. (A first-boot import that timed
// out used to leave the store running cold for the container's life.)
//
// The import is made to fail by holding an uncommitted insert of the import's
// own mark in another session: the import's rows go in, and the mark's
// INSERT ... ON CONFLICT waits on the held row until the statement limit.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";

const { url, schema } = requireTestPg({ label: "test-store-import-fail-pg" });
const ROOT = mkdtempSync(join(tmpdir(), "store-import-fail-"));
process.env.STATE_DB_STATEMENT_TIMEOUT_MS = "600";
process.env.STATE_STORE_RETRY_MS = "200";
process.env.STATE_STORE_RETRY_MAX_MS = "400";
process.env.X402_INDEX_CRAWL = "off";
process.env.INDEX_CACHE_FILE = join(ROOT, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(ROOT, "removed-origins.json");
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(50); } return false; };
const quiet = () => {};

await sdb.stateQuery("SELECT 1"); // the schema is in place
const blocker = new pg.Client({ connectionString: url });
await blocker.connect();
/** Hold an uncommitted import mark for `name`: the import's own mark waits on it. */
async function holdMark(name) {
  await blocker.query("BEGIN");
  await blocker.query(`INSERT INTO ${schema}.imports (name, source) VALUES ($1, 'held')`, [name]);
}
const release = () => blocker.query("ROLLBACK");

try {
  // ---- traffic rollups -----------------------------------------------------
  {
    const { createTrafficStore } = await import("../src/traffic-classifier.js");
    const dir = join(ROOT, "traffic");
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, `${day}.json`), JSON.stringify({ day, total: 41, classes: { paid: 41 }, byClass: {}, discovery: {}, indexers: {}, crawlers: {}, distinctIps: 3 }));
    writeFileSync(join(dir, "payers.json"), JSON.stringify({ deadbeef0001: 5 }));
    await holdMark(basename(dir));
    const lines = [];
    const store = createTrafficStore({ dir, salt: "t", log: (m) => lines.push(m) });
    const first = store.load();
    await Promise.race([first, wait(1500)]);
    ok(sdb.unloadedStateStores().some((n) => /traffic/.test(n)), `the store whose import failed is listed as unloaded (${JSON.stringify(sdb.unloadedStateStores())})`);
    await release();
    ok(await until(() => store._days.get(day)?.total === 41 && store._payers.get("deadbeef0001") === 5), `the retried load imports the file once the database answers (total ${store._days.get(day)?.total})`);
    ok((await sdb.imports.done(basename(dir)))?.source === dir, "the import is marked once it landed");
    ok(!sdb.unloadedStateStores().some((n) => /traffic/.test(n)), "the store leaves the unloaded list");
    ok(!lines.some((l) => /starting cold/.test(l)), "the store never starts cold over an import it did not finish");
  }

  // ---- MCP task records ---------------------------------------------------
  {
    const { createTaskStore, newTaskId } = await import("../src/mcp-tasks.js");
    const dir = join(ROOT, "mcp-tasks");
    mkdirSync(dir, { recursive: true });
    const now = Date.now(), iso = new Date(now).toISOString();
    const rec = { taskId: newTaskId(), status: "completed", statusMessage: "done", createdAt: iso, lastUpdatedAt: iso, createdAtMs: now, ttlMs: 3_600_000, pollIntervalMs: 5000, slug: "research", owner: "earlier-boot", pid: 1, result: { content: [{ type: "text", text: "kept" }] } };
    writeFileSync(join(dir, `${rec.taskId}.json`), JSON.stringify(rec));
    await holdMark(basename(dir));
    const store = createTaskStore({ dir, log: quiet, bootId: "import-fail-boot" });
    await wait(900); // the first import attempt has timed out
    ok(sdb.unloadedStateStores().some((n) => /mcp-tasks/.test(n)), `the task store whose import failed is listed as unloaded (${JSON.stringify(sdb.unloadedStateStores())})`);
    await release();
    ok(await until(async () => (await sdb.imports.done(basename(dir)))?.source === dir), "the import is retried and marked once the database answers");
    ok((await store.get(rec.taskId))?.result?.content?.[0]?.text === "kept", "the imported task answers from the store");
    ok(await until(() => !sdb.unloadedStateStores().some((n) => /mcp-tasks/.test(n))), "the task store leaves the unloaded list");
    store.close?.();
  }

  // ---- x402 index warm start ------------------------------------------------
  {
    const nd = join(ROOT, "x402-index-cache.ndjson");
    const entry = (route) => ({ manifest: { x402Version: 1, name: route }, tools: [{ route, price: "$0.001" }], fetchedAt: 1700000000000, error: null, source: "crawl", history: [], paywall: null, discoveryPath: null });
    writeFileSync(nd, JSON.stringify({ savedAt: 1700000000000, format: "ndjson-v1", origins: 1 }) + "\n" + JSON.stringify(["https://warm-seller.example", entry("/w")]) + "\n");
    await holdMark(basename(nd));
    const xi = await import("../src/x402-index.js");
    const loader = xi.startStateDbWarmStart();
    await wait(900);
    const listed = () => xi.indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "t" }).sellers.some((s) => s.origin === "https://warm-seller.example");
    ok(sdb.unloadedStateStores().some((n) => /x402-index/.test(n)), `the warm start whose import failed is listed as unloaded (${JSON.stringify(sdb.unloadedStateStores())})`);
    await release();
    ok(await until(() => loader.isLoaded() && listed()), "the warm start is retried and the file's seller is in the index once the database answers");
    ok((await sdb.imports.done(basename(nd)))?.source === nd, "the import is marked once it landed");
  }
} finally {
  try { await blocker.query("ROLLBACK"); } catch { /* not in a transaction */ }
  await blocker.end().catch(() => {});
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
