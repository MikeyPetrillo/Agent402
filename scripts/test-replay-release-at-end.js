#!/usr/bin/env node
// When the payment replay claim (server.js replayGuardEnd / finishGuard) is
// let go, on a booted paid server against a stub facilitator.
//
// "finish" waits for the socket write to complete. A refused payment (402)
// is never settled, so its claim is released when the answer is ended: a
// buyer that resends the same credential as soon as the 402 arrives is
// answered as a refusal again, never 409 "inflight". A granted 200 is marked
// consumed on "finish" and holds its claim until then. On loopback the write
// completes before any resend can land, so the window is opened here by
// holding back "finish" and "close" (scripts/lib/hold-finish-preload.js) until
// the resend has been answered.
//
// Each resend changes the request body, so the idempotency layer (keyed on
// payment, route and body; its own release is pinned by
// scripts/test-idempotency-inflight.js case 10) never answers it: only the
// replay guard can refuse it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";

const PAYER = "0x00000000000000000000000000000000000000b7";
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 10_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (cond()) return true; await sleep(20); } return cond(); };

// Nonces the stub refuses at verify; every other nonce verifies and settles.
const refused = new Set();
let verifies = 0, settles = 0;
const AGG3 = [{ type: "function", name: "aggregate3", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const nonceOf = (body) => { try { return String(JSON.parse(body).paymentPayload?.payload?.authorization?.nonce || ""); } catch { return ""; } };
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") {
      verifies++;
      if (refused.has(nonceOf(body))) return reply({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER });
      return reply({ isValid: true, payer: PAYER });
    }
    if (req.url === "/settle") { settles++; return reply({ success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: "eip155:8453", payer: PAYER }); }
    if (req.url === "/rpc") {
      const { args } = decodeFunctionData({ abi: AGG3, data: JSON.parse(body).params[0].data });
      return reply({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: args[0].map(() => ({ success: true, returnData: "0x" + "0".repeat(64) })) }) });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC_PORT = facilitator.address().port;

let srv = null, B = "";
const serverLog = () => (srv ? srv.log() : "").split("\n").filter((l) => l.trim());
const bootFailed = (e) => { failed++; console.error("FAIL - the paid server did not boot:", e?.message || String(e)); facilitator.close(); process.exit(1); };
srv = await bootServer({
  stores: "replay-release-at-end",
  args: ["--import", "./scripts/lib/hold-finish-preload.js"],
  env: {
    FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", HOLD_FINISH_TEST: "1",
  },
}).catch(bootFailed);
B = srv.url;

const credential = (accepted, nonce) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce } },
})).toString("base64");
// One connection per request (no agent): a held "finish" keeps the first
// connection busy, so a reused one would queue the resend behind it.
const pay = (cred, text, extra = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ text });
  const r = httpRequest(`${B}/api/hash`, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "payment-signature": cred, ...extra } }, (res) => {
    let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => resolve({ status: res.statusCode, replay: res.headers["x-payment-replay"] || null, body: out }));
  });
  r.on("error", reject);
  r.end(body);
});
const flushHeld = (id) => fetch(`${B}/health`, { headers: { "x-test-flush-held": id } }).then((r) => r.text());

try {
  ok(true, "paid server booted with the hold-finish preload");
  const unpaid = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  const accepted = (() => { try { return (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf8")).accepts || []).find((a) => a.network === "eip155:8453") || null; } catch { return null; } })();
  ok(unpaid.status === 402 && !!accepted, `unpaid POST /api/hash quotes a Base payment (${unpaid.status})`);
  if (!accepted) throw new Error("no Base accept to pay");

  // 1. A refused payment: its claim is released when the 402 is ended.
  {
    const nonce = "0x" + randomBytes(32).toString("hex");
    refused.add(nonce);
    const cred = credential(accepted, nonce);
    const v0 = verifies;
    const first = await pay(cred, "a", { "x-test-hold-finish": "refused" });
    ok(first.status === 402 && verifies === v0 + 1, `a refused credential is answered 402 after one verify (${first.status}, verifies +${verifies - v0})`);
    ok(await waitFor(() => serverLog().some((l) => l.includes("[hold-finish] holding POST /api/hash (refused) at 402"))), "the 402's \"finish\" is held back");
    const again = await pay(cred, "b");
    ok(again.status === 402 && again.replay === null && verifies === v0 + 2, `resent while "finish" is held, the same credential is refused again (402), not held as a replay (${again.status}, X-Payment-Replay ${again.replay}, verifies +${verifies - v0})`);
    await flushHeld("refused");
  }

  // 2. A granted payment: its claim stays until "finish", which marks it consumed.
  {
    const nonce = "0x" + randomBytes(32).toString("hex");
    const cred = credential(accepted, nonce);
    const s0 = settles;
    const first = await pay(cred, "c", { "x-test-hold-finish": "granted" });
    ok(first.status === 200 && settles === s0 + 1, `a valid credential is served and settled once (${first.status}, settles +${settles - s0})`);
    ok(await waitFor(() => serverLog().some((l) => l.includes("[hold-finish] holding POST /api/hash (granted) at 200"))), "the 200's \"finish\" is held back");
    const during = await pay(cred, "d");
    ok(during.status === 409 && during.replay === "inflight" && settles === s0 + 1, `resent while "finish" is held, the claim is still in flight: 409 inflight, nothing settled again (${during.status}, X-Payment-Replay ${during.replay}, settles +${settles - s0})`);
    await flushHeld("granted");
    // The consumed mark is written from the "finish" listener; wait for it with a deadline.
    let after = null;
    for (const t0 = Date.now(); Date.now() - t0 < 10_000;) { after = await pay(cred, "e"); if (after.replay === "consumed") break; await sleep(50); }
    ok(after?.status === 409 && after.replay === "consumed" && settles === s0 + 1, `once "finish" fires the payment is marked consumed (${after?.status}, X-Payment-Replay ${after?.replay}, settles +${settles - s0})`);
  }
} catch (e) {
  failed++; console.error("FAIL -", e?.stack || String(e));
} finally {
  await srv.stop();
  facilitator.close();
}
if (failed) for (const l of serverLog().slice(-30)) console.error("  server:", l);
console.log(`\ntest-replay-release-at-end: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
