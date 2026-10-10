// Stats on the state database count a served call ONCE when a flush's COMMIT
// landed but its reply was lost. A TCP relay forwards the COMMIT to Postgres,
// waits for Postgres to answer (so the write is durable), then drops the
// reply and closes the client's socket: the flush sees an error for a write
// that landed. The retry carries the same batch id, finds it recorded, and
// adds nothing. A control batch whose transaction really failed is applied
// by its retry. Requires STATE_DATABASE_URL (CI fails without it).
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-stats-ack-loss-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = new URL(url);
let dropReplyTo = null; // the reply to the next client message matching this is dropped
let failNext = null;    // the next client message matching this has its connection cut BEFORE it reaches Postgres
let dropped = 0, cutBefore = 0;
const live = new Set();
const relay = createServer((client) => {
  const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
  live.add(client); live.add(up);
  let swallow = false;
  client.on("data", (buf) => {
    const text = buf.toString("latin1");
    if (failNext && failNext.test(text)) { failNext = null; cutBefore++; client.destroy(); up.destroy(); return; }
    if (dropReplyTo && dropReplyTo.test(text)) { swallow = true; dropReplyTo = null; }
    up.write(buf);
  });
  up.on("data", (buf) => {
    if (swallow) { dropped++; client.destroy(); up.destroy(); return; } // Postgres answered: the write is done
    client.write(buf);
  });
  const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
  client.on("error", drop); up.on("error", drop); client.on("close", drop); up.on("close", drop);
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const relayUrl = `${target.protocol}//${target.username ? `${target.username}@` : ""}127.0.0.1:${relay.address().port}${target.pathname}${target.search}`;

const DIR = mkdtempSync(join(tmpdir(), "stats-ackloss-"));
process.env.STATE_DATABASE_URL = relayUrl;
process.env.STATS_DB_DIR = DIR;
process.env.FREE_MODE = "true";
const sdb = await import("../src/state-db.js");
// A checked-out client whose socket is cut emits an 'error' event of its own
// (state-db's to handle); it is absorbed here so the counting can be read.
process.on("uncaughtException", () => {});
const T = (t) => `${schema}.stats_${t}`;
try {
  const stats = await import("../src/stats.js");
  await stats.statsReady();
  const n = async (slug) => Number((await sdb.stateQuery(`SELECT coalesce(max(n), 0)::bigint AS n FROM ${T("tool_counts")} WHERE slug = $1`, [slug])).rows[0].n);
  const rc = async (slug) => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${T("recent_calls")} WHERE slug = $1`, [slug])).rows[0].n);

  // ---- the commit lands, its reply is lost ----------------------------------
  stats.recordServedCall("acktest", "pow");
  dropReplyTo = /COMMIT\0/;
  const first = await stats.statsFlush();
  ok(dropped === 1 && first === false, `the relay dropped the reply to the COMMIT and the flush saw a failure (dropped=${dropped}, flush=${first})`);
  ok((await n("acktest")) === 1, "the COMMIT landed: the counter is 1 after the 'failed' flush");
  await sleep(5_600); // the queue's retry (FLUSH_RETRY_MS = 5 s)
  ok((await stats.statsFlush()) === true, "the retry flush reports success");
  ok((await n("acktest")) === 1, `ONE served call counts once after the retry (tool_counts = ${await n("acktest")})`);
  ok((await rc("acktest")) === 1, `ONE served call is one recent_calls row after the retry (rows = ${await rc("acktest")})`);
  ok(stats.dbHealthy() === true, "/health's probe reads healthy again after the retry landed");

  // ---- control: a transaction that really failed is applied by its retry ----
  stats.recordServedCall("ctltest", "pow");
  failNext = /COMMIT\0/;
  const ctl = await stats.statsFlush();
  ok(cutBefore === 1 && ctl === false && (await n("ctltest")) === 0, `control: a COMMIT that never reached Postgres leaves nothing (flush=${ctl})`);
  stats.recordServedCall("ctltest", "pow"); // a newer write while the batch waits
  await sleep(5_600);
  await stats.statsFlush();
  ok((await n("ctltest")) === 2 && (await rc("ctltest")) === 2, `control: the retry applies the failed batch, then the newer write (n = ${await n("ctltest")})`);

  const ids = Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${T("flushes")}`)).rows[0].n);
  ok(ids >= 3, `every applied batch left its id (${ids})`);
} finally {
  relay.close(); for (const s of live) s.destroy();
  process.env.STATE_DATABASE_URL = url;
  await sdb.closeStateDb().catch(() => {});
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await c.end();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-stats-ack-loss-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
