#!/usr/bin/env node
// onchain-sql-range on a booted server, paid on x402 against a stub
// facilitator that counts every settle, with the query service stubbed
// (scripts/lib/cdp-sql-stub-preload.js: a query marked walk_days answers the
// service's 408 for its whole range and two rows for each day it is read).
// Asserted:
//   - the 402 quotes the route's list price on EVM exact only, recommends a
//     job (X-Async-Recommended, the async block) and names its run budget;
//   - a paid call with neither Prefer header is answered 400 before any
//     payment is taken: no query, no settle;
//   - Prefer: wait walks every day of a 31-day range in one call, merged in
//     order, one whole-range query and one a day, settled exactly once;
//   - Prefer: respond-async answers 202, the job replays the call, and the
//     delivered answer is settled exactly once (the 202 settles nothing);
//   - a walk that ends with no rows read answers the uncharged 422: nothing
//     settled;
//   - onchain-sql's walk that its query limit ended points to the range
//     route in a field, settled once;
//   - the onchain-sql query histogram does not count the range route's calls;
//   - in FREE_MODE the published example answers with rows.
//
//   node scripts/test-onchain-sql-range-paid.js     (offline)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(50); } return fn(); };
const OP_TOKEN = "onchain-sql-range-test-operator-token-0123456789";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const NET = "eip155:8453";
const RANGE = "/api/onchain-sql-range";
const DAYS = 31;

let settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = "0x0000000000000000000000000000000000000000"; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* ignore */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") { settles++; return reply(200, { success: true, transaction: "0x" + settles.toString(16).padStart(64, "0"), network: NET, payer }); }
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(body || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply(200, { jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

// The job store is a file store: its own directory, so no other boot on the
// machine resolves this one's jobs.
const TMP = mkdtempSync(join(tmpdir(), "sql-range-"));
const commonEnv = {
  AGENT402_TASK_DATA_DIR: TMP,
  CDP_SQL_STUB: "1",
  CDP_API_KEY_ID: "organizations/test/apiKeys/test", CDP_API_KEY_SECRET: privateKey.export({ type: "pkcs8", format: "pem" }),
  CDP_SQL_API_KEY_ID: "", CDP_SQL_API_KEY_SECRET: "",
  AGENT402_OPERATOR_TOKEN: OP_TOKEN, TRUST_PROXY_HOPS: "1",
  X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
  SQL_QUERY_STATS_KEEP_DAYS: "", UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "",
  SLOW_SYNC_WINDOW_SECONDS: "", CDN_PROXY: "", UPSTREAM_HANDLER_BUDGET_MS: "",
};
const PRELOAD = ["--import", "./scripts/lib/cdp-sql-stub-preload.js"];
const stubQueries = (srv) => (srv.log().match(/\[cdp-sql-stub\] query walk/g) || []).length;
const walkSql = (marker, extra = "") => `SELECT block_slot, block_time FROM solana.instructions WHERE block_time > now() - INTERVAL ${DAYS} DAY AND executing_account = '${marker}'${extra}`;
// UTC days a range of DAYS days ending now spans: the midnights inside it, plus one.
const spansNow = () => { const DAY = 86_400_000, now = Date.now(); let n = 1; for (let t = Math.floor((now - DAYS * DAY) / DAY) * DAY + DAY; t < now; t += DAY) n++; return n; };
const sortedAsc = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].block_time <= r.block_time);

let paid = null, free = null;
try {
  paid = await bootServer({
    args: PRELOAD, stores: "sql-range-paid",
    env: {
      ...commonEnv, FREE_MODE: "", NETWORK: "base", PAYMENT_NETWORKS: "base",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      CDP_FACILITATOR_URL: FAC, FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, SOLVADOR_KEY: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYMENT_SETTLE_FALLBACK: "",
      AGENT402_BASE_RPC: `${FAC}/rpc`, MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", FIRST_CALL_ALLOWANCE: "",
    },
  });
  const B = paid.url;
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const row = pricing.endpoints.find((e) => e.slug === "onchain-sql-range");
  ok(row && /^\$\d+\.\d{2}$/.test(String(row.price)) && row.async?.recommended === true && row.async.maxSeconds > 0, `/api/pricing lists the range route with a cent price and its async block (${row?.price}, ${JSON.stringify(row?.async && { m: row.async.maxSeconds })})`);

  const offers = {};
  const offerOf = async (path, sql) => {
    if (offers[path]) return offers[path];
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }) });
    const offer = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    const body = await r.json().catch(() => ({}));
    offers[path] = { status: r.status, offer, body, advice: r.headers.get("x-async-recommended"), accepted: (offer.accepts || []).find((a) => a.network === NET && a.scheme === "exact") };
    return offers[path];
  };
  let nonceN = 0, payerN = 0;
  const credential = (accepted) => {
    const payer = "0x" + (0x7000 + ++payerN).toString(16).padStart(40, "0");
    return Buffer.from(JSON.stringify({
      x402Version: 2, resource: accepted.resource, accepted,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
    })).toString("base64");
  };
  const pay = async (path, sql, headers = {}) => {
    const { accepted } = await offerOf(path, sql);
    const q0 = stubQueries(paid), s0 = settles;
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": credential(accepted), ...headers }, body: JSON.stringify({ sql }) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    await sleep(200); // a settle runs after the answer's last byte
    return { status: r.status, json, text, queries: stubQueries(paid) - q0, settles: settles - s0 };
  };

  // ---- the quote ----
  const o = await offerOf(RANGE, walkSql("walk_days"));
  ok(o.status === 402 && o.accepted && Number(o.accepted.amount) === Math.round(Number(String(row.price).replace("$", "")) * 1e6), `the 402 quotes the list price on Base exact (${o.accepted?.amount})`);
  ok((o.offer.accepts || []).every((a) => a.network.startsWith("eip155:") && a.scheme === "exact"), "only EVM exact is offered (a run this long outlives other rails' credentials)");
  ok(/^respond-async; max-seconds=\d+$/.test(o.advice || "") && o.body?.async?.prefer === "respond-async", `the 402 recommends a job (${o.advice})`);

  // ---- neither header: refused before payment ----
  {
    const r = await pay(RANGE, walkSql("walk_days"));
    ok(r.status === 400 && r.queries === 0 && r.settles === 0, `a paid call with neither Prefer header is a 400 before any query or settle (${r.status}, ${r.queries}, ${r.settles})`);
  }

  // ---- Prefer: wait: a 31-day walk in one call, settled once ----
  {
    const n = spansNow();
    const r = await pay(RANGE, walkSql("walk_days"), { prefer: `wait=${row.async.maxSeconds}` });
    const rows = r.json?.rows || [];
    ok(r.status === 200 && rows.length === n * 2 && sortedAsc(rows) && r.json.complete === true && r.json.windowed?.daysRead === n, `a ${DAYS}-day walk answers every day in order (${r.status}, ${rows.length} rows, ${r.json?.windowed?.daysRead} days)`);
    ok(r.queries === 1 + n && r.settles === 1, `one whole-range query and one a day (${r.queries}), settled exactly once (${r.settles})`);
  }

  // ---- Prefer: respond-async: the job settles once, the 202 nothing ----
  {
    const { accepted } = await offerOf(RANGE, walkSql("walk_days"));
    const s0 = settles;
    const r = await fetch(`${B}${RANGE}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": credential(accepted), prefer: "respond-async", "x-forwarded-for": "10.9.7.1" }, body: JSON.stringify({ sql: walkSql("walk_days", " ORDER BY block_time DESC") }) });
    const j = await r.json();
    ok(r.status === 202 && typeof j.statusUrl === "string", `Prefer: respond-async answers 202 with a job link (${r.status})`);
    ok(settles === s0, "the 202 settles nothing");
    let doc = null;
    await until(async () => { doc = await (await fetch(`${B}${j.statusUrl}`)).json(); return doc.state === "succeeded" || doc.state === "failed"; });
    const body = typeof doc?.result?.body === "string" ? JSON.parse(doc.result.body) : doc?.result?.body;
    ok(doc?.state === "succeeded" && doc.result?.httpStatus === 200 && body?.windowed?.order === "desc" && body.complete === true, `the job delivers the walk (${doc?.state}, ${doc?.result?.httpStatus}${doc?.state === "succeeded" ? "" : `: ${JSON.stringify(doc).slice(0, 400)}`})`);
    await sleep(200);
    ok(settles - s0 === 1, `the delivered job is settled exactly once (${settles - s0})`);
  }

  // ---- nothing read: the uncharged 422 ----
  {
    const r = await pay(RANGE, walkSql("walk_empty").replace(`INTERVAL ${DAYS} DAY`, `INTERVAL ${DAYS + 5} DAY`), { prefer: `wait=${row.async.maxSeconds}` });
    ok(r.status === 422 && r.settles === 0 && r.queries === 1, `a range past ${DAYS} days is not split: the uncharged 422, nothing settled (${r.status}, ${r.queries}, ${r.settles})`);
  }

  // ---- onchain-sql's partial walk names the range route ----
  {
    const r = await pay("/api/onchain-sql", walkSql("walk_days"));
    ok(r.status === 200 && r.json?.complete === false && (r.json.longerRange || []).map((x) => x.path).join(",") === RANGE && r.queries === 3 && r.settles === 1, `onchain-sql's walk ends at its query limit and names the range route, the only one whose days cover 31 (${r.status}, ${JSON.stringify(r.json?.longerRange)}, ${r.queries} queries, ${r.settles} settle)`);
  }

  // ---- the onchain-sql histogram counts onchain-sql only ----
  {
    const rep = await (await fetch(`${B}/__operator/onchain-sql-queries.json`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } })).json();
    const t = rep.totals?.outside || {};
    const calls = ["charged", "free", "uncharged"].reduce((n, k) => n + ["q0", "q1", "q2", "q3"].reduce((m, b) => m + (Number(t?.[k]?.[b]) || 0), 0), 0);
    ok(calls === 1 && Number(t.charged?.q3) === 1, `the onchain-sql histogram holds its one call and none of the range route's (${calls})`);
  }
  await paid.stop(); paid = null;

  // ---- FREE_MODE: the published example answers with rows ----
  free = await bootServer({ args: PRELOAD, stores: "sql-range-free", env: { ...commonEnv, FREE_MODE: "true" } });
  const spec = await (await fetch(`${free.url}/openapi.json`)).json();
  const exSql = spec.paths?.[RANGE]?.post?.requestBody?.content?.["application/json"]?.example?.sql;
  ok(typeof exSql === "string" && /solana\.instructions/.test(exSql), `the published example is a solana.instructions select (${String(exSql).slice(0, 60)})`);
  const fr = await fetch(`${free.url}${RANGE}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: exSql }) });
  const fj = await fr.json();
  ok(fr.status === 200 && Array.isArray(fj.rows) && fj.rows.length > 0, `the published example answers with rows on a local boot (${fr.status}, ${fj.rows?.length})`);
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  for (const srv of [paid, free]) if (srv) console.error(srv.log().split("\n").filter((l) => !/cdp-sql-stub/.test(l)).slice(-25).join("\n"));
} finally {
  await paid?.stop(); await free?.stop();
  await new Promise((r) => facilitator.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
