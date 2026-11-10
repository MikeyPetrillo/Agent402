#!/usr/bin/env node
// Upstream queries per onchain-sql call, on a booted server
// (src/sql-query-stats.js, /__operator/onchain-sql-queries.json).
//
// Boots the real server with its paywall on against a stub facilitator
// (verify says valid; settle succeeds or refuses, as the test sets it) and a
// stubbed query service (scripts/lib/cdp-sql-stub-preload.js), pays with
// x402 credentials, and reads the operator route after each call:
//   - a settled one-query call is charged/1;
//   - the row-size recovery is charged with its true count (3);
//   - a query the service rejects is uncharged/1 (a 422, nothing settled);
//   - a statement refused before any query is uncharged/0;
//   - a handler 200 whose settlement then fails is uncharged/1: the count
//     follows the FINAL response, never the handler's status.
// The operator route answers only with the operator token (the same request
// without it is the negative; with it, the control), is private, no-store,
// and carries no query text. A second boot in FREE_MODE records a call as
// free. The stub prints one line per query it answered, so the recorded
// count is checked against what reached the service.
//
//   node scripts/test-onchain-sql-queries-route.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_TOKEN = "onchain-sql-queries-test-operator-token-0123456789";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const NET = "eip155:8453";

let settleMode = "ok", settles = 0;
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = "0x0000000000000000000000000000000000000000"; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* ignore */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") {
      settles++;
      if (settleMode === "fail") return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: NET, payer });
      return reply(200, { success: true, transaction: "0x" + settles.toString(16).padStart(64, "0"), network: NET, payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

const commonEnv = {
  CDP_SQL_STUB: "1",
  CDP_API_KEY_ID: "organizations/test/apiKeys/test", CDP_API_KEY_SECRET: privateKey.export({ type: "pkcs8", format: "pem" }),
  AGENT402_OPERATOR_TOKEN: OP_TOKEN,
  X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
  SQL_QUERY_STATS_KEEP_DAYS: "", UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "",
};
const PRELOAD = ["--import", "./scripts/lib/cdp-sql-stub-preload.js"];
const SQL_ROUTE = "/api/onchain-sql";
const H = (h) => ["q0", "q1", "q2", "q3"].map((b) => h?.[b]).join("/");
const stubQueries = (srv) => (srv.log().match(/\[cdp-sql-stub\] query/g) || []).length;
const reportOf = async (srv) => {
  const r = await fetch(`${srv.url}/__operator/onchain-sql-queries.json`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } });
  return { status: r.status, cache: r.headers.get("cache-control"), text: await r.text() };
};
const callsIn = (t) => ["charged", "free", "uncharged"].reduce((n, k) => n + ["q0", "q1", "q2", "q3"].reduce((m, b) => m + (Number(t?.[k]?.[b]) || 0), 0), 0);
// A call is counted once its response has ended, which is after the client
// has read it: wait for the report to hold `calls` calls (never a fixed
// pause), and fail by name when it never does.
const totalsOf = async (srv, calls) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const t = JSON.parse((await reportOf(srv)).text).totals.outside;
    if (callsIn(t) >= calls) return t;
    if (Date.now() > deadline) throw new Error(`the report never counted ${calls} call(s): ${JSON.stringify(t)}`);
    await sleep(25);
  }
};

let paid = null, free = null;
try {
  // --- paid boot ---------------------------------------------------------------
  paid = await bootServer({
    args: PRELOAD, stores: "sql-queries-paid",
    env: {
      ...commonEnv, FREE_MODE: "", NETWORK: "base", PAYMENT_NETWORKS: "base",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      CDP_FACILITATOR_URL: FAC, FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, SOLVADOR_KEY: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYMENT_SETTLE_FALLBACK: "",
      AGENT402_BASE_RPC: `${FAC}/rpc`, MPP_SECRET_KEY: "", FIRST_CALL_ALLOWANCE: "",
    },
  });
  const B = paid.url;
  let nonceN = 0, payerN = 0, paidCalls = 0;
  let accepted = null;
  const pay = async (sql) => {
    const body = JSON.stringify({ sql });
    if (!accepted) {
      const r = await fetch(`${B}${SQL_ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      ok(r.status === 402, `an unpaid onchain-sql call is a 402 (${r.status})`);
      const offer = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
      accepted = (offer.accepts || []).find((a) => a.network === NET && a.scheme === "exact");
      ok(!!accepted, "the 402 offers exact on Base");
    }
    // A wallet per call, so no per-wallet bound decides an outcome here.
    const payer = "0x" + (++payerN).toString(16).padStart(40, "0");
    const credential = Buffer.from(JSON.stringify({
      x402Version: 2, resource: accepted.resource, accepted,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
    })).toString("base64");
    const q0 = stubQueries(paid), s0 = settles;
    const r = await fetch(`${B}${SQL_ROUTE}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": credential }, body });
    const text = await r.text();
    // Counted once the response ended; the stub's lines were written before it.
    const totals = await totalsOf(paid, ++paidCalls);
    return { status: r.status, text, totals, queries: stubQueries(paid) - q0, settles: settles - s0 };
  };

  // The unpaid read above ran no handler: nothing is recorded for it.
  const first = await pay("SELECT 1 AS n FROM base.blocks");
  ok(first.status === 200 && first.queries === 1 && first.settles === 1, `a paid one-query call settles and answers 200 (${first.status}, ${first.queries} queries, ${first.settles} settles)`);
  let t = first.totals;
  ok(H(t.charged) === "0/1/0/0" && H(t.uncharged) === "0/0/0/0" && H(t.free) === "0/0/0/0", `recorded charged/1, and the unpaid 402 before it recorded nothing (${JSON.stringify(t)})`);

  const rec = await pay("SELECT ix, sk AS rowsize_a FROM base.blocks");
  ok(rec.status === 200 && rec.queries === 3 && /"recovered":"row-size"/.test(rec.text), `the row-size recovery answers 200 on three queries (${rec.status}, ${rec.queries})`);
  t = rec.totals;
  ok(H(t.charged) === "0/1/0/1", `recorded charged with its true count, 3 (${H(t.charged)})`);

  const rej = await pay("SELECT nope_column FROM base.blocks");
  ok(rej.status === 422 && rej.queries === 1 && rej.settles === 0, `a rejected query is a 422 after one query, nothing settled (${rej.status}, ${rej.queries}, ${rej.settles})`);
  t = rej.totals;
  ok(H(t.uncharged) === "0/1/0/0" && H(t.charged) === "0/1/0/1", `recorded uncharged/1 (${H(t.uncharged)})`);

  const refused = await pay("DROP TABLE base.blocks");
  ok(refused.status === 400 && refused.queries === 0 && refused.settles === 0, `a statement that is not a SELECT is refused before any query (${refused.status}, ${refused.queries})`);
  t = refused.totals;
  ok(H(t.uncharged) === "1/1/0/0", `recorded uncharged/0 (${H(t.uncharged)})`);

  // The handler answers 200, then the settlement fails: the final response is a 402.
  settleMode = "fail";
  const unsettled = await pay("SELECT 1 AS n FROM base.blocks");
  settleMode = "ok";
  ok(unsettled.status === 402 && unsettled.queries === 1 && unsettled.settles === 1, `a handler 200 whose settlement fails is a final 402 (${unsettled.status}, ${unsettled.queries} queries, ${unsettled.settles} settle tried)`);
  t = unsettled.totals;
  ok(H(t.uncharged) === "1/2/0/0" && H(t.charged) === "0/1/0/1", `recorded uncharged/1, never charged (${JSON.stringify(t)})`);

  // The report: totals, the ratio, days, and nothing of any request.
  const rep = await reportOf(paid);
  const j = JSON.parse(rep.text);
  ok(rep.status === 200 && j.queriesPerChargedCall === 2 && j.summary.outside.calls.charged === 2 && j.summary.outside.queries.uncharged === 2 && j.summary.outside.allQueriesPerChargedCall === 3, `queries per charged call is (1 + 3) / 2, and every query sent (6) over 2 (${j.queriesPerChargedCall}, ${j.summary?.outside?.allQueriesPerChargedCall})`);
  ok(Array.isArray(j.days) && j.days.length === 1 && j.days[0].day === new Date().toISOString().slice(0, 10) && j.keepDays === 35, `one UTC day, 35 kept (${j.days?.length}, ${j.keepDays})`);
  ok(!/base\.blocks|SELECT|DROP|nope_column|rowsize_|0x[0-9a-f]{6}|organizations/i.test(rep.text) && !/\$|usd/i.test(rep.text), "the answer carries counts only: no query text, no payer, no key, no dollar figure");
  ok(/private/.test(rep.cache || "") && /no-store/.test(rep.cache || ""), `the answer is private, no-store (${rep.cache})`);

  // Operator only. The same request with the token is the control beside each refusal.
  const anon = await fetch(`${B}/__operator/onchain-sql-queries.json`);
  const anonText = await anon.text();
  ok(anon.status === 404 && !/charged|q1|days/.test(anonText), `without the token the route answers 404 and no counts (${anon.status})`);
  const wrong = await fetch(`${B}/__operator/onchain-sql-queries.json`, { headers: { Authorization: "Bearer not-the-operator-token" } });
  const wrongText = await wrong.text();
  ok(wrong.status === 404 && !/charged|q1|days/.test(wrongText), `a wrong token answers 404 and no counts (${wrong.status})`);
  const control = await reportOf(paid);
  ok(control.status === 200 && /"charged"/.test(control.text), `control: the valid token still reads it (${control.status})`);
  // No public surface carries the counts.
  const status = await (await fetch(`${B}/api/gateway-status`)).text();
  ok(!/onchainSql|queriesPerChargedCall/.test(status), "the public status answer carries none of it");
  await paid.stop(); paid = null;

  // --- FREE_MODE boot: a call nothing is asked for is free ------------------------
  free = await bootServer({ args: PRELOAD, stores: "sql-queries-free", env: { ...commonEnv, FREE_MODE: "true" } });
  const q0 = stubQueries(free);
  const fr = await fetch(`${free.url}${SQL_ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1 AS n FROM base.blocks" }) });
  await fr.text();
  ok(fr.status === 200 && stubQueries(free) - q0 === 1, `a FREE_MODE call answers 200 on one query (${fr.status})`);
  const ft = await totalsOf(free, 1);
  ok(H(ft.free) === "0/1/0/0" && H(ft.charged) === "0/0/0/0" && H(ft.uncharged) === "0/0/0/0", `recorded free/1, never charged (${JSON.stringify(ft)})`);
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  for (const srv of [paid, free]) if (srv) console.error(srv.log().split("\n").filter((l) => !/cdp-sql-stub/.test(l)).slice(-25).join("\n"));
} finally {
  await paid?.stop(); await free?.stop();
  await new Promise((r) => facilitator.close(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
