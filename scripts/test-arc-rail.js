#!/usr/bin/env node
// Arc mainnet rail (eip155:5042) through Circle's facilitator, fully offline.
//
//   node scripts/test-arc-rail.js
//
// Part 1 drives src/circle-facilitator.js against a stubbed fetch: the paths
// and the auth header, the Arc-only /supported filter, defensive parsing
// (JSON only, byte cap, schema), error reduction (a status and a reason code,
// never the upstream body or the key), the local preflight (an authorization
// signed for another chain, token, payTo or amount is refused before Circle
// sees it), and settlement_pending reconciliation.
//
// Part 2 boots the real server with the x402 paywall active. Circle's base URL
// is a constant in the source, so a preload rewrites requests for it to a
// local stub (the only way a test reaches it). Legs: key unset (Arc absent, no
// errors), /supported listing Arc (offered, bound to Arc USDC + treasury +
// amount; a paid call settles; cross-chain and tampered payments refused
// without reaching Circle), /supported without Arc, Circle failing with the
// key echoed in an HTML body, every facilitator failing (the guard fails open
// for the other rails, Arc still fails closed), malformed /supported. Every
// leg asserts the key and the upstream body never appear in a response or a
// log line.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getFreePorts } from "./lib/free-port.js";
import {
  ARC_CAIP2, ARC_USDC, CIRCLE_FACILITATOR_BASE, CircleFacilitatorClient,
  arcKindsFromSupported, preflightArcPayment, safeReason,
} from "../src/circle-facilitator.js";

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const SECRET = `testsecret${randomBytes(12).toString("hex")}`;
const KEY = `LIVE_API_KEY:${SECRET}`;
const MARKER = `UPSTREAMBODY${randomBytes(6).toString("hex")}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const leaks = (text) => {
  const s = String(text);
  return s.includes(SECRET) || s.includes(MARKER);
};

// ---------------------------------------------------------------- part 1
const acct = privateKeyToAccount(generatePrivateKey());
const now = () => Math.floor(Date.now() / 1000);
const nonce = () => `0x${randomBytes(32).toString("hex")}`;
const arcReq = (over = {}) => ({ scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, amount: "1000", payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, ...over });
async function signed({ chainId = 5042, verifyingContract = ARC_USDC.asset, to = TREASURY, value = "1000", req = arcReq() } = {}) {
  const authorization = { from: acct.address, to, value, validAfter: "0", validBefore: String(now() + 600), nonce: nonce() };
  const signature = await acct.signTypedData({
    domain: { name: "USDC", version: "2", chainId, verifyingContract },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, accepted: req, payload: { authorization, signature } };
}

/** A fetch stub: routes by path, records every call. */
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url).slice(CIRCLE_FACILITATOR_BASE.length);
    const h = routes[path.split("?")[0]] || routes[path.replace(/\/[0-9a-f-]{36}$/i, "/:id")];
    if (!h) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    const r = await h(init, calls.length);
    return r;
  };
  fn.calls = calls;
  return fn;
}
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

const SUPPORTED_FULL = {
  x402Version: 2,
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" } },
    { x402Version: 2, scheme: "upto", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USDC", version: "2" } },
    { x402Version: 2, scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USDC", version: "2" } },
    { x402Version: 2, scheme: "exact", network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", extra: { name: "USD Coin", version: "2" } },
  ],
  extensions: ["payment-identifier", "settlement-status"],
  signers: { [ARC_CAIP2]: ["0x2240278661b83f55d31b2506f77266f6ffd21d55"], "eip155:8453": ["0x2240278661b83f55d31b2506f77266f6ffd21d55"] },
};
const SUPPORTED_NO_ARC = { ...SUPPORTED_FULL, kinds: SUPPORTED_FULL.kinds.filter((k) => k.network !== ARC_CAIP2) };

console.log("part 1: the Circle client");

await check("constant base URL on Circle's documented facilitator path", () => {
  assert.equal(CIRCLE_FACILITATOR_BASE, "https://api.circle.com/v1/facilitator/x402");
});

await check("/supported: GET on the documented path, keyless, redirects refused; only Arc exact survives the filter", async () => {
  const f = stubFetch({ "/supported": () => json(200, SUPPORTED_FULL) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const s = await c.getSupported();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${CIRCLE_FACILITATOR_BASE}/supported`);
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.ok(!f.calls[0].init.headers.Authorization, "/supported is keyless; the key is not sent where it is not needed");
  assert.deepEqual(s.kinds.map((k) => `${k.scheme}:${k.network}`), [`exact:${ARC_CAIP2}`], "Base, Polygon and upto are filtered out");
  assert.deepEqual(Object.keys(s.signers), [ARC_CAIP2]);
});

await check("/supported without Arc yields no kind (the boot check then drops Arc)", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/supported": () => json(200, SUPPORTED_NO_ARC) }) });
  assert.deepEqual((await c.getSupported()).kinds, []);
});

await check("/supported listing Arc exact on another asset or domain is not accepted", () => {
  assert.deepEqual(arcKindsFromSupported({ kinds: [{ scheme: "exact", network: ARC_CAIP2, asset: "0x0000000000000000000000000000000000000001" }] }).kinds, []);
  assert.deepEqual(arcKindsFromSupported({ kinds: [{ scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USD Coin", version: "2" } }] }).kinds, []);
});

for (const [label, resp] of [
  ["HTML 200", () => new Response(`<html>${MARKER} ${KEY}</html>`, { status: 200, headers: { "content-type": "text/html" } })],
  ["JSON with kinds not an array", () => json(200, { kinds: MARKER })],
  ["a kind without a network", () => json(200, { kinds: [{ scheme: "exact" }] })],
  ["invalid JSON under a JSON type", () => new Response(`{"kinds": [${MARKER}`, { status: 200, headers: { "content-type": "application/json" } })],
  ["an oversized body", () => new Response(JSON.stringify({ kinds: [], pad: "x".repeat(70_000) + MARKER }), { status: 200, headers: { "content-type": "application/json" } })],
  ["HTTP 500 HTML echoing the key", () => new Response(`<h1>${MARKER}</h1> Authorization: Bearer ${KEY}`, { status: 500, headers: { "content-type": "text/html" } })],
  ["HTTP 401 JSON echoing the key", () => json(401, { code: 401, message: `bad key ${KEY} ${MARKER}`, errors: [{ reason: `${MARKER} <script>` }] })],
  ["a 302 redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })],
]) {
  await check(`malformed or failing /supported (${label}) throws a reduced error`, async () => {
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/supported": resp }) });
    let err = null;
    try { await c.getSupported(); } catch (e) { err = e; }
    assert.ok(err, "it must throw so Arc fails closed");
    const shown = `${err.message} ${err.stack} ${inspect(err)} ${JSON.stringify(err)}`;
    assert.ok(!leaks(shown), `the error carries no upstream body or key: ${err.message}`);
    assert.match(err.message, /^Circle facilitator supported failed \(\d+\): [a-z0-9_]+$/);
  });
}

await check("the key never serializes with the client", () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({}) });
  assert.ok(!leaks(JSON.stringify(c)) && !leaks(inspect(c, { depth: 5, showHidden: true })), "JSON and inspect of the client omit the key");
  assert.equal(c.url, undefined, "no `url` property, so the facilitator diagnostics never quote its error bodies");
});

await check("verify and settle: POST on the documented paths with the Bearer key and the stock x402 body", async () => {
  const p = await signed();
  const f = stubFetch({
    "/verify": () => json(200, { isValid: true, payer: acct.address }),
    "/settle": () => json(200, { success: true, payer: acct.address, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2 }),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const v = await c.verify(p, arcReq());
  assert.equal(v.isValid, true);
  const s = await c.settle(p, arcReq());
  assert.equal(s.success, true);
  assert.equal(s.network, ARC_CAIP2);
  assert.deepEqual(f.calls.map((x) => [x.url, x.init.method]), [[`${CIRCLE_FACILITATOR_BASE}/verify`, "POST"], [`${CIRCLE_FACILITATOR_BASE}/settle`, "POST"]]);
  for (const x of f.calls) {
    assert.equal(x.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(x.init.redirect, "error");
    const body = JSON.parse(x.init.body);
    assert.equal(body.x402Version, 2);
    assert.equal(body.paymentRequirements.network, ARC_CAIP2);
    assert.equal(body.paymentPayload.payload.signature, p.payload.signature);
  }
});

// The cross-chain and tamper refusals: each is refused locally, Circle is never called.
for (const [label, make, reason] of [
  ["signed for Base (chainId 8453)", () => signed({ chainId: 8453 }), "invalid_exact_evm_payload_signature"],
  ["signed for another token contract", () => signed({ verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), "invalid_exact_evm_payload_signature"],
  ["paying another address", () => signed({ to: "0x0000000000000000000000000000000000000bad" }), "invalid_exact_evm_payload_recipient_mismatch"],
  ["for another amount", () => signed({ value: "999" }), "invalid_exact_evm_payload_authorization_value_mismatch"],
]) {
  await check(`a payment ${label} is refused before Circle sees it`, async () => {
    const f = stubFetch({ "/verify": () => json(200, { isValid: true }), "/settle": () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2, payer: acct.address }) });
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
    const p = await make();
    const v = await c.verify(p, arcReq());
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, reason);
    const s = await c.settle(p, arcReq());
    assert.equal(s.success, false);
    assert.equal(s.errorReason, reason);
    assert.equal(f.calls.length, 0, "Circle was never called");
  });
}

for (const [label, req] of [
  ["a Base requirement", arcReq({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })],
  ["an Arc requirement on another asset", arcReq({ asset: "0x0000000000000000000000000000000000000001" })],
  ["an upto requirement", arcReq({ scheme: "upto" })],
]) {
  await check(`the Circle client refuses ${label} without calling Circle (an Arc client never serves another chain)`, async () => {
    const f = stubFetch({ "/verify": () => json(200, { isValid: true }) });
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
    const v = await c.verify(await signed(), req);
    assert.equal(v.isValid, false);
    assert.equal(f.calls.length, 0);
  });
}

await check("an expired or not-yet-valid authorization is refused locally", async () => {
  const p = await signed();
  assert.equal((await preflightArcPayment(p, arcReq(), now() + 10_000)).reason, "invalid_exact_evm_payload_authorization_valid_before");
  const q = await signed();
  q.payload.authorization.validAfter = String(now() + 1000);
  assert.equal((await preflightArcPayment(q, arcReq(), now())).reason, "invalid_exact_evm_payload_authorization_valid_after");
});

await check("a contract-wallet signature (not 65-byte EOA form) is left to Circle's on-chain check", async () => {
  const p = await signed();
  p.payload.signature = `0x${"11".repeat(200)}`;
  assert.equal(await preflightArcPayment(p, arcReq()), null);
});

for (const [label, resp, wantReason] of [
  ["HTTP 500 HTML echoing the key", () => new Response(`<b>${MARKER}</b> ${KEY}`, { status: 500, headers: { "content-type": "text/html" } }), "non_json_response"],
  ["HTTP 403 JSON with a message echoing the key", () => json(403, { code: 403, message: `${KEY} ${MARKER}`, errors: [{ reason: "registration_required" }] }), "registration_required"],
  ["HTTP 409 JSON with an unsafe reason", () => json(409, { code: 409, message: MARKER, errors: [{ reason: `${MARKER}<img>` }] }), "circle_http_409"],
  ["HTTP 502 JSON without a reason", () => json(502, { code: 502, message: `${MARKER} ${KEY}` }), "circle_http_502"],
  ["HTTP 200 success without a transaction", () => json(200, { success: true, transaction: MARKER, network: ARC_CAIP2, payer: acct.address }), "invalid_settle_response"],
  ["HTTP 200 success naming another network", () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: acct.address }), "invalid_settle_response"],
]) {
  await check(`settle error (${label}) is reduced to a status and '${wantReason}'`, async () => {
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/settle": resp }) });
    let err = null;
    try { await c.settle(await signed(), arcReq()); } catch (e) { err = e; }
    assert.ok(err, "a non-2xx or unprovable settle throws");
    assert.equal(err.errorReason, wantReason);
    const shown = `${err.message} ${err.stack} ${inspect(err)} ${JSON.stringify(err)}`;
    assert.ok(!leaks(shown), `no upstream body or key in the error: ${err.message}`);
  });
}

await check("a verify 5xx is reduced too", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/verify": () => new Response(`${MARKER} ${KEY}`, { status: 503, headers: { "content-type": "text/plain" } }) }) });
  let err = null;
  try { await c.verify(await signed(), arcReq()); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!leaks(`${err.message} ${inspect(err)}`));
});

await check("a 200 {success:false} reason from Circle is passed only when it is a safe code", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/settle": () => json(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: ARC_CAIP2, payer: acct.address }) }) });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.errorReason, "insufficient_funds");
  assert.equal(safeReason(`x ${MARKER}`), "circle_unrecognized_reason");
});

await check("settlement_pending is reconciled through /status until completed", async () => {
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3aa";
  let polls = 0;
  const f = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, payer: acct.address, extensions: { "settlement-status": { status: "pending", paymentId: id } } }),
    "/status/:id": () => (++polls < 2 ? json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }) : json(200, { paymentId: id, status: "completed", network: ARC_CAIP2, transaction: `0x${"cd".repeat(32)}` })),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 2000 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, true);
  assert.equal(s.transaction, `0x${"cd".repeat(32)}`);
  const statusCall = f.calls.find((x) => x.url.includes("/status/"));
  assert.equal(statusCall.url, `${CIRCLE_FACILITATOR_BASE}/status/${id}`);
  assert.equal(statusCall.init.headers.Authorization, `Bearer ${KEY}`);
});

await check("a pending answer with a non-UUID paymentId is never interpolated into a path", async () => {
  const f = stubFetch({ "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: "../../v1/w3s/wallets" } } }) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 50 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "settlement_pending");
  assert.equal(f.calls.length, 1, "no /status call");
});

await check("a pending payment that stays pending is reported unsettled, never as settled", async () => {
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3ab";
  const f = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: id } } }),
    "/status/:id": () => json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 60 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, false);
});

await check("a timeout and a network error keep the 'may have broadcast' shape (no settle fallback)", async () => {
  const { isPreBroadcastSettleRejection, fallbackCandidatesFor } = await import("../src/payments.js");
  const slow = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  let e1 = null; try { await slow.settle(await signed(), arcReq()); } catch (e) { e1 = e; }
  assert.ok(e1 && !isPreBroadcastSettleRejection(e1));
  const down = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: async () => { throw new TypeError(`fetch failed ${MARKER}`); } });
  let e2 = null; try { await down.settle(await signed(), arcReq()); } catch (e) { e2 = e; }
  assert.ok(e2 && !isPreBroadcastSettleRejection(e2) && !leaks(e2.message));
  assert.deepEqual(fallbackCandidatesFor(ARC_CAIP2, { settle() {} }, { settle() {} }, { [ARC_CAIP2]: [] }), [], "Arc names no fallback facilitator");
});

// ---------------------------------------------------------------- part 2
console.log("part 2: the paid server");

const [P_PAYAI, P_CIRCLE, ...SERVER_PORTS] = await getFreePorts(9);
const st = { payai: "ok", circle: "full", circleHits: [], payaiHits: [] };
const rawJson = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const payaiStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.payaiHits.push({ url: req.url, body });
  if (req.url === "/supported") {
    if (st.payai === "die") { res.writeHead(500, { Connection: "close" }); return res.end("down"); }
    return rawJson(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
  }
  if (req.url === "/verify") return rawJson(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
  return rawJson(res, 404, {});
});
const circleStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.circleHits.push({ url: req.url, auth: req.headers.authorization || "", body });
  if (req.url === "/supported") {
    if (st.circle === "die") { res.writeHead(500, { "Content-Type": "text/html", Connection: "close" }); return res.end(`<html>${MARKER} key=${KEY}</html>`); }
    if (st.circle === "malformed") return rawJson(res, 200, { kinds: `${MARKER}` });
    return rawJson(res, 200, st.circle === "noarc" ? SUPPORTED_NO_ARC : SUPPORTED_FULL);
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return rawJson(res, 401, { code: 401, message: "missing key" });
  if (req.url === "/verify") return rawJson(res, 200, { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from });
  if (req.url === "/settle") {
    if (st.settle === "html500") { res.writeHead(500, { "Content-Type": "text/html", Connection: "close" }); return res.end(`<html>${MARKER} ${KEY}</html>`); }
    return rawJson(res, 200, { success: true, transaction: `0x${"ef".repeat(32)}`, network: ARC_CAIP2, payer: body?.paymentPayload?.payload?.authorization?.from });
  }
  return rawJson(res, 404, {});
});
await Promise.all([[payaiStub, P_PAYAI], [circleStub, P_CIRCLE]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));

const tmp = mkdtempSync(join(tmpdir(), "a402-arc-rail-"));
const preload = join(tmp, "circle-redirect.mjs");
writeFileSync(preload, `
const BASE = ${JSON.stringify(CIRCLE_FACILITATOR_BASE)};
const STUB = process.env.ARC_TEST_CIRCLE_STUB;
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (STUB && typeof u === "string" && u.startsWith(BASE)) return real(STUB + u.slice(BASE.length), init);
  return real(input, init);
};
`);

let portIdx = 0;
async function boot(extraEnv) {
  const port = SERVER_PORTS[portIdx++];
  const env = { ...process.env };
  delete env.STATE_DATABASE_URL;
  delete env.CIRCLE_FACILITATOR_API_KEY;
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,arc",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_PAYAI}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      ARC_TEST_CIRCLE_STUB: `http://127.0.0.1:${P_CIRCLE}`,
      SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "", MPP_SECRET_KEY: "",
      SALES_LEDGER_DB: join(tmp, `sales-${port}.db`), INFLIGHT_COVER: "off",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { text: "" };
  proc.stdout.on("data", (c) => { log.text += c; });
  proc.stderr.on("data", (c) => { log.text += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, log, proc }; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill("SIGKILL");
  throw new Error(`server never became healthy: ${log.text.slice(-600)}`);
}
const PATH = "/api/demand-radar?limit=1";
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
async function surfaces(base) {
  const out = [];
  for (const p of ["/health", "/api/rails", "/.well-known/x402", "/api/gateway-status", "/api/pricing", PATH]) {
    const r = await fetch(`${base}${p}`);
    out.push(`${p} ${r.status} ${JSON.stringify(Object.fromEntries(r.headers))} ${await r.text()}`);
    const pr = r.headers.get("payment-required");
    if (pr) out.push(JSON.stringify(decode(pr)));
  }
  return out.join("\n");
}
async function offeredNets(base) {
  const r = await fetch(`${base}${PATH}`);
  assert.equal(r.status, 402, `unpaid paid route answers 402 (got ${r.status})`);
  return { nets: new Set(decode(r.headers.get("payment-required")).accepts.map((a) => a.network)), env: decode(r.headers.get("payment-required")) };
}
const noLeak = async (leg, base, log) => {
  const all = `${await surfaces(base)}\n${log.text}`;
  assert.ok(!leaks(all), `${leg}: the key or an upstream body appeared in a response or log line`);
};

// Leg A: no key. Arc absent, the server serves, nothing errors.
await check("key unset: Arc is absent, the 402 still serves, a warning names the drop, no Circle call", async () => {
  st.circle = "full"; st.circleHits = [];
  const { base, log, proc } = await boot({});
  try {
    const { nets } = await offeredNets(base);
    assert.ok(nets.has("eip155:8453") && !nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
    assert.match(log.text, /CIRCLE_FACILITATOR_API_KEY is unset - dropping Arc/);
    assert.equal(st.circleHits.length, 0, "no request to Circle without a key");
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.ok(!/RouteConfigurationError|Unhandled|TypeError/.test(log.text), "no errors in the boot log");
  } finally { proc.kill("SIGKILL"); }
});

// Leg B: key set, Circle lists Arc.
await check("key set + Arc listed: the Arc accept is offered, bound to Arc USDC, the treasury and the Base amount", async () => {
  st.circle = "full"; st.circleHits = []; st.settle = "ok";
  const { base, log, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY });
  try {
    const { env } = await offeredNets(base);
    const arc = env.accepts.find((a) => a.network === ARC_CAIP2 && a.scheme === "exact");
    const baseAcc = env.accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    assert.ok(arc, "an Arc exact accept");
    assert.equal(arc.asset.toLowerCase(), ARC_USDC.asset.toLowerCase());
    assert.equal(arc.payTo.toLowerCase(), TREASURY.toLowerCase());
    assert.equal(arc.amount, baseAcc.amount, "same price as the Base accept");
    assert.equal(arc.extra?.name, "USDC");
    assert.equal(arc.extra?.version, "2");
    const supportedHits = st.circleHits.filter((h) => h.url === "/supported");
    assert.ok(supportedHits.length >= 1 && supportedHits.every((h) => h.auth === ""), "/supported was probed without the key");

    const rails = await (await fetch(`${base}/api/rails`)).json();
    assert.ok(JSON.stringify(rails).includes("arc"), "/api/rails lists the Arc rail");

    // A correctly signed Arc payment verifies and settles through Circle.
    const pay = async (p) => fetch(`${base}${PATH}`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ ...p, resource: env.resource })).toString("base64") } });
    const good = await signed({ req: arc, value: arc.amount });
    const r = await pay(good);
    await r.text();
    assert.equal(r.status, 200, `a valid Arc payment is served (got ${r.status})`);
    const v = st.circleHits.find((h) => h.url === "/verify");
    const s = st.circleHits.find((h) => h.url === "/settle");
    assert.ok(v && s, "Circle verified and settled");
    for (const h of [v, s]) {
      assert.equal(h.auth, `Bearer ${KEY}`);
      assert.equal(h.body.paymentRequirements.network, ARC_CAIP2);
      assert.equal(h.body.paymentRequirements.asset.toLowerCase(), ARC_USDC.asset.toLowerCase());
      assert.equal(h.body.paymentRequirements.payTo.toLowerCase(), TREASURY.toLowerCase());
      assert.equal(h.body.paymentRequirements.amount, arc.amount);
    }
    const receipt = decode(r.headers.get("payment-response"));
    assert.equal(receipt.network, ARC_CAIP2);

    // Cross-chain replay and tampering: refused, Circle never sees them.
    const hitsBefore = st.circleHits.length;
    for (const bad of [
      await signed({ req: arc, value: arc.amount, chainId: 8453 }),
      await signed({ req: arc, value: arc.amount, chainId: 5042002 }),
      await signed({ req: arc, value: String(BigInt(arc.amount) - 1n) }),
      await signed({ req: arc, value: arc.amount, to: "0x0000000000000000000000000000000000000bad" }),
    ]) {
      const rr = await pay(bad);
      await rr.text();
      assert.equal(rr.status, 402, `a tampered or cross-chain Arc payment is refused (got ${rr.status})`);
    }
    assert.equal(st.circleHits.length, hitsBefore, "none of them reached Circle");

    // An Arc-signed authorization presented against the BASE requirement goes
    // to the Base facilitator, never to Circle, and is not served.
    const asBase = await signed({ req: baseAcc, value: baseAcc.amount });
    const rb = await pay(asBase);
    await rb.text();
    assert.equal(rb.status, 402);
    assert.equal(st.circleHits.length, hitsBefore, "a Base requirement never reaches Circle");
    assert.ok(st.payaiHits.some((h) => h.url === "/verify" && h.body?.paymentRequirements?.network === "eip155:8453"), "it was judged by the Base facilitator");

    // Circle failing at settle with the key echoed in HTML: not served, not leaked.
    st.settle = "html500";
    const rf = await pay(await signed({ req: arc, value: arc.amount }));
    const rfText = await rf.text();
    assert.equal(rf.status, 402);
    assert.ok(!leaks(`${rfText} ${JSON.stringify(Object.fromEntries(rf.headers))}`), "the buyer's 402 carries no upstream body or key");
    await new Promise((r2) => setTimeout(r2, 300));
    await noLeak("key set", base, log);
  } finally { proc.kill("SIGKILL"); }
});

await check("key set: Arc joins a multi-chain list without an `arc` entry in PAYMENT_NETWORKS", async () => {
  st.circle = "full";
  const { base, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY, PAYMENT_NETWORKS: "base,polygon" });
  try {
    const { nets } = await offeredNets(base);
    assert.ok(nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
  } finally { proc.kill("SIGKILL"); }
});

for (const [label, circleMode, payaiMode] of [
  ["Circle's /supported lacks Arc", "noarc", "ok"],
  ["Circle's /supported fails with the key echoed in HTML", "die", "ok"],
  ["Circle's /supported is malformed", "malformed", "ok"],
  ["EVERY facilitator fails (others fail open, Arc fails closed)", "die", "die"],
]) {
  await check(`${label}: Arc is dropped, nothing else is, nothing leaks`, async () => {
    st.circle = circleMode; st.payai = payaiMode;
    const { base, log, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY });
    try {
      if (payaiMode === "ok") {
        const { nets } = await offeredNets(base);
        assert.ok(nets.has("eip155:8453") && !nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
      } else {
        // Fail-open shape for the other rails: the paywall answers as before
        // (a 500 until a facilitator is reachable), and the offer never names Arc.
        const r = await fetch(`${base}${PATH}`);
        const pr = r.headers.get("payment-required");
        if (pr) assert.ok(!decode(pr).accepts.some((a) => a.network === ARC_CAIP2));
        await r.text();
      }
      assert.match(log.text, /dropping eip155:5042\b/);
      await noLeak(label, base, log);
    } finally { proc.kill("SIGKILL"); st.payai = "ok"; }
  });
}

payaiStub.close(); circleStub.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
