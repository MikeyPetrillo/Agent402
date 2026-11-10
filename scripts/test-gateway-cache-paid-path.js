#!/usr/bin/env node
// The gateway response cache on the real request path, paid the way a buyer
// pays: a booted paid server, a stub facilitator, stubbed model upstreams,
// and the stock x402 client (@x402/fetch with the exact EVM scheme) signing
// with throwaway keys. That client signs validAfter "0" and validBefore =
// now + the accept's maxTimeoutSeconds; a read that asks for a short validity
// window reads none of its payments, and every repeat is generated and
// charged again (the daily canary's cache legs, which pay the same way).
//
// For chat (cache: true), embeddings and rerank (cache on by default):
//   - a paid call runs the handler and settles once;
//   - the identical body unpaid is a 402;
//   - the identical body with a NEW payment from the same wallet answers 200,
//     X-Cache: hit, the same body, no upstream call and no settle;
//   - the identical body with a new payment from ANOTHER wallet is generated
//     and settled as any other call (the entry is its payer's alone);
//   - a header naming the payer without its signature reads nothing;
//   - a call whose settle the facilitator refuses stores nothing.
// scripts/test-gateway-cache-scope.js drives the gate and the writer alone,
// with hand-built windows; this suite is the client and the path between
// them (the gates, the paywall, the route binder's finish hook).
// No request leaves the machine.
//
//   node scripts/test-gateway-cache-paid-path.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { bootServer } from "./lib/boot-server.js";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`NOT OK - ${m}`); } };

// ---- stub facilitator ------------------------------------------------------
const fac = { settles: 0, refuse: false };
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* not a payment body */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, auth ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" });
    if (req.url === "/settle") {
      fac.settles++;
      if (fac.refuse) return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer });
      return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(String(auth?.nonce)).digest("hex"), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});

// ---- stub upstream (chat and rerank, on the OpenRouter origin) ---------------
const up = { chat: 0, rerank: 0, other: [] };
const upstream = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let j = {}; try { j = JSON.parse(b || "{}"); } catch { /* empty */ }
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      const n = ++up.chat;
      return send(200, { id: `gen-${n}-${randomBytes(4).toString("hex")}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: j.model || "deepseek/deepseek-chat",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7, cost: 0.000001 } });
    }
    if (req.method === "POST" && url === "/api/v1/rerank") {
      const n = ++up.rerank;
      const docs = Array.isArray(j.documents) ? j.documents : [];
      return send(200, { id: `rerank-${n}`, model: j.model, results: docs.map((_, index) => ({ index, relevance_score: 1 / (index + 1 + n) })), usage: { total_tokens: 10, cost: 0.000001 } });
    }
    up.other.push(`${req.method} ${url}`);
    send(404, { error: { message: "not stubbed" } });
  });
});
await Promise.all([facilitator, upstream].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
const UP = `http://127.0.0.1:${upstream.address().port}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
// A hand-built x402 v2 exact payment for `accept`, for the cases the stock
// client cannot make (no signature; a settle the test refuses on purpose).
async function payment(account, accept, { sign = true } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: accept.payTo, value: String(accept.amount), validAfter: String(t - 600), validBefore: String(t + Number(accept.maxTimeoutSeconds || 300)), nonce: `0x${randomBytes(32).toString("hex")}` };
  const signature = sign ? await account.signTypedData({
    domain: { name: accept.extra.name, version: accept.extra.version, chainId: Number(accept.network.split(":")[1]), verifyingContract: accept.asset },
    types: TYPES, primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  }) : "0x" + "11".repeat(65);
  return b64({ x402Version: 2, resource: accept.resource, accepted: accept, payload: { signature, authorization } });
}

let srv = null;
try {
  srv = await bootServer({
    stores: "gateway-cache-paid-path",
    // Chat and rerank go to the stub below; embeddings get the canned answer
    // of upstream-stub-preload.js (no counter: its leg reads the settle count).
    args: ["--import", "./scripts/lib/openrouter-stub-preload.js", "--import", "./scripts/lib/upstream-stub-preload.js"],
    env: {
      FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", DATABASE_URL: "", ANALYTICS_DATABASE_URL: "",
      OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_FLEX: "off", OPENAI_API_KEY: "test-key-never-used",
      OPENROUTER_STUB_URL: UP, MODEL_CATALOG_URL: `${UP}/api/v1/models`,
      DIRECT_UPSTREAM_URL: "", DIRECT_UPSTREAM_KEY: "", DIRECT_UPSTREAM_MODELS: "",
      FIRST_CALL_ALLOWANCE: "", TRIAL_MODE: "",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
      FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true", NODE_ENV: "test",
      // The committed placeholder table: the suite runs the same with or
      // without the private one and never depends on a real rate.
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
    },
  });
  const B = srv.url;
  const tag = randomBytes(5).toString("hex");
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());

  const LEGS = [
    { name: "chat", path: "/v1/nano/chat/completions", counter: "chat",
      body: { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: `Reply with exactly: OK ${tag}` }], max_tokens: 5, cache: true },
      same: (a, b) => typeof a.id === "string" && a.id === b.id },
    { name: "embeddings", path: "/v1/embeddings", counter: null,
      body: { input: `cache paid path ${tag}`, model: "text-embedding-3-small" },
      same: (a, b) => Array.isArray(a.data?.[0]?.embedding) && JSON.stringify(a.data) === JSON.stringify(b.data) },
    { name: "rerank", path: "/v1/rerank", counter: "rerank",
      body: { query: `cache paid path ${tag}`, documents: ["first document", "second document"] },
      same: (a, b) => Array.isArray(a.results) && JSON.stringify(a.results) === JSON.stringify(b.results) },
  ];

  for (const leg of LEGS) {
    const init = (headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(leg.body) });
    const call = async (headers) => {
      const r = await fetch(B + leg.path, init(headers));
      const text = await r.text();
      let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, xCache: r.headers.get("x-cache"), settled: Boolean(r.headers.get("payment-response") || r.headers.get("x-payment-response")), required: r.headers.get("payment-required") };
    };
    // The stock client: an unpaid request, the 402, a signed payment, the
    // paid request. `sent` is the authorization it signed.
    const payCall = async (account) => {
      const client = disableVendorSpendControls(new x402Client());
      registerExactEvmScheme(client, { signer: account });
      let sent = null;
      const spy = (input, i) => {
        const rq = new Request(input, i);
        const h = rq.headers.get("payment-signature") || rq.headers.get("x-payment");
        if (h) { try { sent = JSON.parse(Buffer.from(h, "base64").toString("utf8")).payload?.authorization || null; } catch { /* unread */ } }
        return fetch(rq);
      };
      const r = await wrapFetchWithPayment(spy, client)(B + leg.path, init());
      const text = await r.text();
      let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, sent, xCache: r.headers.get("x-cache"), settled: Boolean(r.headers.get("payment-response") || r.headers.get("x-payment-response")) };
    };
    // A leg with no upstream counter reads its settles for both.
    const n = () => ({ up: leg.counter ? up[leg.counter] : fac.settles, settles: fac.settles });

    const first402 = await call();
    ok(first402.status === 402 && first402.required, `${leg.name}: an unpaid call is a 402 (${first402.status})`);
    if (!first402.required) { console.error(JSON.stringify(first402.json).slice(0, 300)); continue; }
    const accept = (JSON.parse(Buffer.from(first402.required, "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    if (!accept) { ok(false, `${leg.name}: the 402 offers exact on Base`); continue; }

    // A call whose settle is refused stores nothing.
    fac.refuse = true;
    let before = n();
    const refused = await call({ "payment-signature": await payment(alice, accept) });
    fac.refuse = false;
    ok(refused.status === 402 && n().settles === before.settles + 1, `${leg.name}: a call whose settle is refused is a 402 (${refused.status})`);

    // 1. The paid call: generated, settled once. (Also the control that the
    // refused call above stored nothing: this one is not a hit.)
    before = n();
    const paid = await payCall(alice);
    ok(paid.sent?.validAfter === "0" && Number(paid.sent?.validBefore) > Date.now() / 1000, `${leg.name}: the stock client signed a window open from the epoch (validAfter ${paid.sent?.validAfter})`);
    ok(paid.status === 200 && paid.settled && paid.xCache !== "hit" && n().up === before.up + 1 && n().settles === before.settles + 1,
      `${leg.name}: a paid call is generated and settled once, and an unsettled answer was never stored (status ${paid.status}, X-Cache ${paid.xCache}, upstream +${n().up - before.up}, settles +${n().settles - before.settles}) ${paid.status === 200 ? "" : JSON.stringify(paid.json).slice(0, 300)}`);

    // 2. The identical body, unpaid.
    before = n();
    const unpaid = await call();
    ok(unpaid.status === 402 && unpaid.xCache !== "hit" && n().up === before.up, `${leg.name}: the unpaid repeat is a 402 (${unpaid.status})`);

    // An unsigned header that names the payer proves nothing: the paywall
    // answers it (the stub facilitator verifies anything, so it is generated
    // and settled as a call of its own, never read from the cache).
    before = n();
    const forged = await call({ "payment-signature": await payment(alice, accept, { sign: false }) });
    ok(forged.xCache !== "hit" && (forged.status !== 200 || n().settles === before.settles + 1), `${leg.name}: a header naming the payer without its signature reads no entry (status ${forged.status}, X-Cache ${forged.xCache})`);

    // Another wallet's valid payment: its own call, generated and settled.
    before = n();
    const other = await payCall(bob);
    ok(other.status === 200 && other.xCache !== "hit" && other.settled && n().up === before.up + 1 && n().settles === before.settles + 1,
      `${leg.name}: another wallet's repeat is generated and settled, never read from the first payer's entry (status ${other.status}, X-Cache ${other.xCache})`);

    // 3. The identical body with a new payment from the paying wallet.
    before = n();
    const repeat = await payCall(alice);
    ok(repeat.status === 200 && repeat.xCache === "hit", `${leg.name}: the payer's paid repeat is answered from the cache (status ${repeat.status}, X-Cache ${repeat.xCache})`);
    ok(leg.same(repeat.json, paid.json), `${leg.name}: the repeat is the answer the payer paid for`);
    ok(!repeat.settled && n().settles === before.settles && n().up === before.up, `${leg.name}: the repeat is not settled and calls no upstream (receipt ${repeat.settled}, settles +${n().settles - before.settles}, upstream +${n().up - before.up})`);
  }
  if (up.other.length) console.log(`note: unstubbed upstream paths asked: ${[...new Set(up.other)].join(", ")}`);
  if (failed && srv) console.error(srv.log().slice(-3000));
} catch (err) {
  failed++;
  console.error(`NOT OK - ${err?.stack || err}`);
  if (srv) console.error(srv.log().slice(-2000));
} finally {
  await srv?.stop().catch(() => {});
  facilitator.close(); upstream.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
