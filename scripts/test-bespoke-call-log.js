#!/usr/bin/env node
// The seventeen tool routes served outside the kit binder (extract, meta, dns,
// render, screenshot, pdf and the eleven memory tools) write the same
// call-log row every other tool writes: one recordToolCall row per call that
// reached the handler, with the route's slug and the FINAL response status.
//
// Rows are read through the recorder's test sink (ANALYTICS_TEST_CAPTURE=1,
// src/analytics-db.js): the server prints each row it would insert. Two boots,
// both with outbound fetches held to loopback:
//   - free mode: one call to each of the seventeen routes, 2xx and 4xx alike,
//     gives exactly one row; a kit tool beside them still gives exactly one;
//   - paid mode (x402 exact, stub facilitator): an unpaid 402 gives no row
//     (kit control: none either), a settled call gives one row with 200, and
//     a call whose settlement fails gives one row with the final 402.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`NOT OK - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUIET = {
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
  MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
  REDIS_URL: "", STATE_DATABASE_URL: "", DATABASE_URL: "", ANALYTICS_DATABASE_URL: "", BROWSER_WORKER_URL: "",
  FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
  FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true", NODE_ENV: "test",
  ANALYTICS_TEST_CAPTURE: "1",
};
const POW_SECRET = "test-bespoke-call-log-secret";
const PRELOAD = ["--import", "./scripts/lib/loopback-only-preload.js"];
const rowsOf = (srv) => srv.log().split("\n").filter((l) => l.startsWith("[tool-call-test] ")).map((l) => JSON.parse(l.slice("[tool-call-test] ".length)));
// One request, then the rows it added: waits for the first, then long enough
// for a second to show if one were written.
async function call(srv, method, path, { body, headers = {} } = {}) {
  const before = rowsOf(srv).length;
  const res = await fetch(`${srv.url}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  for (let i = 0; i < 40 && rowsOf(srv).length === before; i++) await sleep(50);
  await sleep(250);
  let json = null; try { json = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: res.status, json, headers: res.headers, rows: rowsOf(srv).slice(before) };
}
const oneRow = (r, slug) => r.rows.length === 1 && r.rows[0].slug === slug && r.rows[0].status === r.status && r.rows[0].errored === (r.status >= 400) && r.rows[0].cached === false && r.rows[0].synthetic === false && r.rows[0].prePayment === false && Number.isInteger(r.rows[0].latencyMs);
const show = (r) => `HTTP ${r.status}, rows ${JSON.stringify(r.rows)}`;

let free = null, paid = null, facilitator = null;
try {
  // ---------------------------------------------------------------- free mode
  free = await bootServer({ stores: "call-log-free", args: PRELOAD, env: { ...QUIET, FREE_MODE: "true", POW_SECRET } });
  const NS = "?ns=calllog";
  const REFUSED_URL = "http://127.0.0.1:9/"; // a loopback address: refused by the fetch guard, nothing is fetched

  // The control first: a kit tool writes exactly one row (2xx and 4xx).
  const kit = await call(free, "GET", "/api/uuid");
  ok(kit.status === 200 && oneRow(kit, "uuid"), `control: a kit tool's 200 writes exactly one row (${show(kit)})`);
  const kit4 = await call(free, "POST", "/api/hash", { body: {} });
  ok(kit4.status >= 400 && kit4.status < 500 && oneRow(kit4, "hash"), `control: a kit tool's 4xx writes exactly one row (${show(kit4)})`);

  // The six URL tools. No page is fetched: a missing input or a refused address.
  const urlCalls = [
    ["extract", "POST", "/api/extract", { body: { url: REFUSED_URL } }],
    ["meta", "GET", `/api/meta?url=${encodeURIComponent(REFUSED_URL)}`, {}],
    ["dns", "GET", "/api/dns", {}],
    ["render", "POST", "/api/render", { body: {} }],
    ["screenshot", "GET", "/api/screenshot", {}],
    ["pdf", "POST", "/api/pdf", { body: { url: REFUSED_URL } }],
  ];
  const seen = new Set();
  let fourXx = 0;
  for (const [slug, method, path, opts] of urlCalls) {
    const r = await call(free, method, path, opts);
    if (r.status >= 400 && r.status < 500) fourXx++;
    seen.add(slug);
    ok(r.status >= 400 && oneRow(r, slug), `${slug}: one call writes exactly one row with its slug and final status (${show(r)})`);
  }
  // The probe flag follows the kit binder's rule: a 4xx that named no declared key.
  const bare = await call(free, "GET", "/api/dns");
  const keyed = await call(free, "GET", `/api/meta?url=${encodeURIComponent(REFUSED_URL)}`);
  ok(bare.status === 400 && bare.rows[0]?.probe === true, `a 4xx with no input is marked probe (${show(bare)})`);
  ok(keyed.status >= 400 && keyed.status < 500 && keyed.rows[0]?.probe === false, `a 4xx that named a declared key is not (${show(keyed)})`);
  ok(kit4.rows[0]?.probe === true, "control: the kit tool's empty-input 4xx is marked probe by the same rule");

  // The eleven memory tools (free mode: a demo namespace is the identity).
  const GRANTEE = "0x00000000000000000000000000000000000000b2";
  const memCalls = [
    ["memory-write", "POST", `/api/memory${NS}`, { body: { key: "k", value: "v1" } }],
    ["memory-read", "GET", `/api/memory${NS}&key=k`, {}],
    ["memory-incr", "POST", `/api/memory/incr${NS}`, { body: { key: "n", by: 2 } }],
    ["memory-cas", "POST", `/api/memory/cas${NS}`, { body: { key: "k", expected: "v1", value: "v2" } }],
    ["memory-grant", "POST", `/api/memory/grant${NS}`, { body: { grantee: GRANTEE, mode: "read" } }],
    ["memory-revoke", "POST", `/api/memory/revoke${NS}`, { body: { grantee: GRANTEE } }],
    ["memory-grants", "GET", `/api/memory/grants${NS}`, {}],
    ["memory-log", "GET", `/api/memory/log${NS}`, {}],
    ["memory-remember", "POST", `/api/memory/remember${NS}`, { body: { text: "the call log has a row for every tool" } }],
    ["memory-recall", "POST", `/api/memory/recall${NS}`, { body: { query: "call log row" } }],
    ["memory-forget", "POST", `/api/memory/forget${NS}`, { body: { id: "no-such-id" } }],
  ];
  let twoXx = 0;
  for (const [slug, method, path, opts] of memCalls) {
    const r = await call(free, method, path, opts);
    if (r.status === 200) twoXx++;
    if (r.status >= 400 && r.status < 500) fourXx++;
    seen.add(slug);
    ok(oneRow(r, slug), `${slug}: one call writes exactly one row with its slug and final status (${show(r)})`);
  }
  ok(seen.size === 17, `all seventeen routes were called (${seen.size})`);
  ok(twoXx >= 6 && fourXx >= 6, `the calls covered 200s and 4xx (${twoXx} x 200, ${fourXx} x 4xx)`);
  // A memory call with no identity is the handler's own 400: one row.
  const noId = await call(free, "GET", "/api/memory?key=k");
  ok(noId.status === 400 && oneRow(noId, "memory-read"), `memory-read with no namespace: the 400 writes one row (${show(noId)})`);
  // Our own signed probe is marked synthetic, as on a kit tool.
  process.env.POW_SECRET = POW_SECRET;
  const { issueHeartbeatToken } = await import("../src/pow.js");
  const token = issueHeartbeatToken(Date.now());
  const synth = await call(free, "GET", `/api/memory${NS}&key=k`, { headers: { "x-heartbeat-token": token } });
  const synthKit = await call(free, "GET", "/api/uuid", { headers: { "x-heartbeat-token": token } });
  ok(synth.status === 200 && synth.rows.length === 1 && synth.rows[0].slug === "memory-read" && synth.rows[0].synthetic === true, `a signed probe's memory call is one row marked synthetic (${show(synth)})`);
  ok(synthKit.rows.length === 1 && synthKit.rows[0].synthetic === true, `control: so is its kit call (${show(synthKit)})`);
  // What the routes answer is what they answered before.
  const back = await call(free, "GET", `/api/memory${NS}&key=k`);
  ok(back.status === 200 && back.json?.value === "v2", `the memory answer is unchanged (value ${JSON.stringify(back.json?.value)})`);
  await free.stop(); free = null;

  // ---------------------------------------------------------------- paid mode
  const st = { settles: 0, failSettle: false };
  facilitator = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* not a payment body */ }
      const payer = auth?.from || "0x0000000000000000000000000000000000000000";
      if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (req.url === "/verify") return reply(200, auth ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" });
      if (req.url === "/settle") {
        st.settles++;
        if (st.failSettle || !auth) return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer });
        return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(String(auth.nonce)).digest("hex"), network: "eip155:8453", payer });
      }
      if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
      return reply(404, {});
    });
  });
  await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
  const STUB = `http://127.0.0.1:${facilitator.address().port}`;
  paid = await bootServer({ stores: "call-log-paid", args: PRELOAD, env: { ...QUIET, FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base", FACILITATOR_URL: STUB, AGENT402_BASE_RPC: `${STUB}/rpc`, PAYMENT_SETTLE_FALLBACK: "" } });

  const unpaid = await call(paid, "POST", "/api/memory", { body: { key: "k", value: "v" } });
  const unpaidKit = await call(paid, "GET", "/api/whois?domain=example.com");
  ok(unpaid.status === 402 && unpaid.rows.length === 0, `an unpaid memory call is a 402 and writes no row (${show(unpaid)})`);
  ok(unpaidKit.status === 402 && unpaidKit.rows.length === 0, `control: an unpaid kit call writes no row either (${show(unpaidKit)})`);
  const accept = (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  if (!accept) throw new Error("no Base exact accept on the memory 402");
  let nonceN = Date.now() % 100000;
  const credential = () => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000a1", to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
  })).toString("base64");

  const settled = await call(paid, "POST", "/api/memory", { body: { key: "k", value: "v" }, headers: { "payment-signature": credential() } });
  ok(settled.status === 200 && st.settles === 1 && oneRow(settled, "memory-write"), `a settled memory call writes exactly one row with 200 (${show(settled)}, settles ${st.settles})`);
  st.failSettle = true;
  const unsettled = await call(paid, "POST", "/api/memory", { body: { key: "k2", value: "v" }, headers: { "payment-signature": credential() } });
  ok(unsettled.status === 402 && st.settles >= 2 && oneRow(unsettled, "memory-write") && unsettled.rows[0].probe === false, `a memory call whose settlement fails writes one row with the final 402, not the handler's 200 (${show(unsettled)}, settles ${st.settles})`);
} catch (err) {
  failed++;
  console.error(`NOT OK - ${err?.stack || err}`);
  for (const s of [free, paid]) if (s) console.error(s.log().slice(-1200));
} finally {
  await Promise.all([free, paid].map((s) => s?.stop().catch(() => {})));
  facilitator?.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
