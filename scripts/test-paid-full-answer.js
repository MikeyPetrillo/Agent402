#!/usr/bin/env node
// A catalog tool call is answered in full whatever conditional or range
// header the request carries (src/full-answer.js, mounted before every gate
// in src/server.js). Boots the real server in paid mode against a local stub
// facilitator (no request leaves the machine) and pays x402 exact:
//   - a paid GET with If-None-Match: * answers 200 with the body, settles
//     once, books one sale and no debt; the same through the POST alias of a
//     GET tool; the same for the other conditional and range headers;
//   - a control without the header is the same answer;
//   - a re-sent payment replays the stored answer in full;
//   - a free document (/openapi.json) still answers 304 to a matching
//     If-None-Match, and 200 without one.
// Then a FREE_MODE boot: a free tool call with If-None-Match: * is a full 200.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";
import { CONDITIONAL_REQUEST_HEADERS, fullAnswerMiddleware } from "../src/full-answer.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`NOT OK - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the middleware alone ----
{
  const mw = fullAnswerMiddleware((path) => path === "/api/tool");
  const headers = () => Object.fromEntries([...CONDITIONAL_REQUEST_HEADERS.map((h) => [h, "x"]), ["accept", "application/json"]]);
  const tool = { path: "/api/tool", headers: headers() };
  const doc = { path: "/openapi.json", headers: headers() };
  let nexts = 0;
  mw(tool, {}, () => nexts++); mw(doc, {}, () => nexts++);
  ok(nexts === 2 && Object.keys(tool.headers).join(",") === "accept", "unit: every conditional and range header is removed on a tool path, other headers stay");
  ok(CONDITIONAL_REQUEST_HEADERS.every((h) => doc.headers[h] === "x"), "unit: a path that is not a tool route keeps its conditional headers");
  const boom = { path: "/api/tool", headers: headers() };
  fullAnswerMiddleware(() => { throw new Error("x"); })(boom, {}, () => nexts++);
  ok(nexts === 3 && boom.headers["if-none-match"] === "x", "unit: a predicate that throws changes nothing and the request goes on");
}

const OP_TOKEN = "full-answer-operator-token-0123456789abcdef";
const st = { settles: 0, settled: new Set() };
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* not a payment body */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, auth ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" });
    if (req.url === "/settle") {
      st.settles++;
      const nonce = String(auth?.nonce || "").toLowerCase();
      if (!auth || st.settled.has(nonce)) return reply(200, { success: false, errorReason: "nonce already used", transaction: "", network: "eip155:8453", payer });
      st.settled.add(nonce);
      return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(nonce).digest("hex"), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${facilitator.address().port}`;

const QUIET = {
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
  MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
  REDIS_URL: "", STATE_DATABASE_URL: "", DATABASE_URL: "", ANALYTICS_DATABASE_URL: "",
  FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
  FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true", NODE_ENV: "test",
};
// node:http, not fetch: fetch adds Cache-Control: no-cache to a request that
// carries a conditional header, which hides the server's conditional answer.
const raw = (base, path, headers = {}, method = "GET", body) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});

let paid = null, free = null;
try {
  [paid, free] = await Promise.all([
    bootServer({ stores: "full-answer-paid", env: { ...QUIET, FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: STUB, AGENT402_BASE_RPC: `${STUB}/rpc`, AGENT402_OPERATOR_TOKEN: OP_TOKEN } }),
    bootServer({ stores: "full-answer-free", env: { ...QUIET, FREE_MODE: "true" } }),
  ]);
  const B = paid.url;
  const TOOL = "/api/demand-radar?limit=1";
  const opJson = async (path) => (await fetch(`${B}${path}`, { headers: { "X-Operator-Token": OP_TOKEN, Authorization: `Bearer ${OP_TOKEN}` } })).json();
  const unpaid = await raw(B, TOOL);
  ok(unpaid.status === 402, `an unpaid call is a 402 (${unpaid.status})`);
  const accept = (JSON.parse(Buffer.from(unpaid.headers["payment-required"], "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  if (!accept) throw new Error("no Base exact accept on the 402");
  let nonceN = Date.now() % 100000;
  const credential = (nonce = "0x" + (++nonceN).toString(16).padStart(64, "0")) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x00000000000000000000000000000000000000a1", to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce } },
  })).toString("base64");
  const books = async () => {
    await sleep(600); // the sale and any debt are written when the response ends
    const refunds = await opJson("/__operator/refunds.json");
    const sales = await opJson("/__operator/sales.json");
    return { owed: refunds?.totals?.owed?.n, sales: sales?.totals?.external?.sales };
  };
  const full = (r) => { try { return r.status === 200 && r.body.length > 2 && typeof JSON.parse(r.body) === "object"; } catch { return false; } };

  // Control: no conditional header.
  const control = await raw(B, TOOL, { "payment-signature": credential() });
  let b = await books();
  ok(full(control) && st.settles === 1 && b.sales === 1 && b.owed === 0, `control: a paid GET is a full 200, one settle, one sale, no debt (status ${control.status}, settles ${st.settles}, books ${JSON.stringify(b)})`);

  // The case: If-None-Match: * on a paid GET.
  const inm = await raw(B, TOOL, { "payment-signature": credential(), "if-none-match": "*" });
  b = await books();
  ok(full(inm), `a paid GET with If-None-Match: * answers 200 with the body (status ${inm.status}, ${inm.body.length} bytes)`);
  ok(st.settles === 2, `it settles once (${st.settles - 1})`);
  ok(b.sales === 2 && b.owed === 0, `it books a sale and no debt (${JSON.stringify(b)})`);
  ok(Boolean(inm.headers.etag) === Boolean(control.headers.etag), "the answer carries an ETag exactly when the control does");

  // The POST alias of a GET tool.
  const alias = await raw(B, TOOL, { "payment-signature": credential(), "if-none-match": "*", "content-type": "application/json", "content-length": "2" }, "POST", "{}");
  b = await books();
  ok(full(alias) && st.settles === 3 && b.sales === 3 && b.owed === 0, `the POST alias with If-None-Match: * is a full 200, one settle, one sale, no debt (status ${alias.status}, settles ${st.settles}, books ${JSON.stringify(b)})`);

  // The answer's own ETag and date, and a range, sent back.
  const again = await raw(B, TOOL, {
    "payment-signature": credential(), ...(control.headers.etag ? { "if-none-match": control.headers.etag } : { "if-none-match": "*" }),
    "if-modified-since": new Date(Date.now() + 86_400_000).toUTCString(), range: "bytes=0-1", "if-range": "*",
  });
  b = await books();
  ok(full(again) && st.settles === 4 && b.sales === 4 && b.owed === 0, `the answer's own ETag, If-Modified-Since and Range sent back: a full 200, settled and booked once (status ${again.status}, books ${JSON.stringify(b)})`);

  // A re-sent payment replays the stored answer, in full.
  const first = credential();
  const one = await raw(B, TOOL, { "payment-signature": first });
  await sleep(400);
  const replay = await raw(B, TOOL, { "payment-signature": first, "if-none-match": "*" });
  b = await books();
  ok(full(one) && full(replay) && replay.headers["x-replayed-answer"] === "1" && replay.body === one.body && st.settles === 5 && b.sales === 5 && b.owed === 0,
    `a re-sent payment with If-None-Match: * replays the first answer in full, with no second settle or sale (status ${replay.status}, replayed ${replay.headers["x-replayed-answer"]}, settles ${st.settles}, books ${JSON.stringify(b)})`);

  // A free document keeps its conditional answer.
  const doc = await raw(B, "/openapi.json");
  ok(doc.status === 200 && Boolean(doc.headers.etag) && doc.body.length > 1000, "control: /openapi.json answers 200 with an ETag");
  const doc304 = await raw(B, "/openapi.json", { "if-none-match": doc.headers.etag });
  ok(doc304.status === 304 && doc304.body.length === 0, `/openapi.json still answers 304 to its own ETag (${doc304.status})`);

  // Free mode: the same seam, no payment.
  const F = free.url;
  const freeControl = await raw(F, TOOL);
  const freeInm = await raw(F, TOOL, { "if-none-match": "*" });
  ok(full(freeControl) && full(freeInm), `free mode: a tool call with If-None-Match: * is a full 200 (control ${freeControl.status}, case ${freeInm.status})`);
  const freeDoc = await raw(F, "/openapi.json");
  const freeDoc304 = await raw(F, "/openapi.json", { "if-none-match": freeDoc.headers.etag });
  ok(freeDoc304.status === 304, `free mode: /openapi.json still answers 304 to its own ETag (${freeDoc304.status})`);
} catch (err) {
  failed++;
  console.error(`NOT OK - ${err?.stack || err}`);
  if (paid) console.error(paid.log().slice(-1500));
} finally {
  await Promise.all([paid, free].map((s) => s?.stop().catch(() => {})));
  facilitator.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
