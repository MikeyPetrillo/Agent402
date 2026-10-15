#!/usr/bin/env node
// A facilitator that broadcasts a transferWithAuthorization and then answers
// the same /settle "authorization nonce already submitted; transaction already
// on-chain" leaves a buyer who paid holding a 402. src/settle-onchain-proof.js
// recovers that settlement, and only with chain proof: the AuthorizationUsed
// (payer, nonce) log on the asset, in a successful transaction that moved at
// least the price from the payer to our payTo.
//
// Boots a PAID server against a stub facilitator and a stub RPC, and sends
// real paid requests through the middleware:
//   proof found                         -> 200 + PAYMENT-RESPONSE naming the tx
//   the same, thrown as a non-2xx       -> 200
//   log indexed only on a later poll    -> 200
//   nonce spent paying someone else     -> 402
//   short transfer                      -> 402
//   reverted transaction                -> 402
//   RPC down                            -> 402 inside the bound
//   any other settle error              -> 402, the chain is never read
// and every request settles exactly once: a recovery never settles again.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x00000000000000000000000000000000000000ee";
const TX = "0x" + "ab".repeat(32);
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ON_CHAIN = "authorization nonce already submitted; transaction already on-chain";

let pass = 0, facilitator = null, proc = null;
const serverLog = [];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// Stub state, set per case.
let settleMode = "on-chain";      // on-chain | on-chain-thrown | other
let rpcMode = "proof";            // proof | late | elsewhere | short | reverted | down
let settles = 0, rpcCalls = 0, logCalls = 0;
let current = null;               // { payer, nonce, asset, amount }

const rpcAnswer = (method, params) => {
  if (method === "eth_blockNumber") return "0x1000";
  if (method === "eth_getLogs") {
    logCalls++;
    const f = params[0];
    const match = current && f.topics?.[0] === AUTH_USED && f.topics?.[1] === topic(current.payer) && f.topics?.[2] === current.nonce.toLowerCase();
    if (!match || (rpcMode === "late" && logCalls < 2)) return [];
    return [{ address: current.asset, topics: [AUTH_USED, topic(current.payer), current.nonce], transactionHash: TX, data: "0x" }];
  }
  if (method === "eth_getTransactionReceipt") {
    const to = rpcMode === "elsewhere" ? OTHER : PAY_TO;
    const value = rpcMode === "short" ? BigInt(current.amount) - 1n : BigInt(current.amount);
    return {
      status: rpcMode === "reverted" ? "0x0" : "0x1",
      transactionHash: TX,
      logs: [
        { address: current.asset, topics: [AUTH_USED, topic(current.payer), current.nonce], data: "0x" },
        { address: current.asset, topics: [TRANSFER, topic(current.payer), topic(to)], data: word(value) },
      ],
    };
  }
  return null;
};

facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch { /* */ }
    const payer = parsed?.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") {
      settles++;
      if (settleMode === "other") return reply(200, { success: false, errorReason: "invalid_payload", errorMessage: "authorization signature invalid", transaction: "", network: "eip155:8453", payer });
      if (settleMode === "on-chain-thrown") return reply(400, { success: false, errorReason: "invalid_payload", errorMessage: ON_CHAIN, transaction: "", network: "eip155:8453", payer });
      return reply(200, { success: false, errorReason: "invalid_payload", errorMessage: ON_CHAIN, transaction: "", network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") {
      rpcCalls++;
      if (rpcMode === "down") return reply(503, { error: "down" });
      return reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, result: rpcAnswer(parsed.method, parsed.params || []) });
    }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: PAY_TO, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    EVM_RPC_8453: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 80) serverLog.splice(0, serverLog.length - 80); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

const TOOL = { path: "/api/hash", body: JSON.stringify({ text: "x" }) };
let accepted = null, n = 0;
async function pay(label) {
  if (!accepted) {
    const r = await fetch(`${B}${TOOL.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: TOOL.body });
    ok(r.status === 402, `unpaid ${TOOL.path} -> 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    ok(!!accepted, "offers exact on Base");
  }
  n++;
  current = { payer: "0x" + (0xa0 + n).toString(16).padStart(40, "0"), nonce: word(1000 + n), asset: accepted.asset, amount: accepted.amount };
  const cred = Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: current.payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: current.nonce } },
  })).toString("base64");
  const before = settles; logCalls = 0; rpcCalls = 0;
  const t0 = Date.now();
  const r = await fetch(`${B}${TOOL.path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred }, body: TOOL.body });
  const ms = Date.now() - t0;
  await r.arrayBuffer();
  ok(settles === before + 1, `${label}: settled exactly once (${settles - before})`);
  let receipt = null;
  const hdr = r.headers.get("payment-response");
  if (hdr) { try { receipt = JSON.parse(Buffer.from(hdr, "base64").toString("utf-8")); } catch { /* */ } }
  return { status: r.status, receipt, ms };
}

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

  settleMode = "on-chain"; rpcMode = "proof";
  let r = await pay("proof");
  ok(r.status === 200 && r.receipt?.success === true && r.receipt?.transaction === TX, `proof found -> 200 with PAYMENT-RESPONSE naming the tx (status ${r.status}, tx ${r.receipt?.transaction})`);
  ok(serverLog.some((l) => l.includes(`recovered eip155:8453 settlement from chain proof: tx ${TX}`)), "the recovery is logged with its tx");

  settleMode = "on-chain-thrown"; rpcMode = "proof";
  r = await pay("proof, thrown");
  ok(r.status === 200 && r.receipt?.transaction === TX, `the same error as a non-2xx settle answer -> 200 (status ${r.status})`);

  settleMode = "on-chain"; rpcMode = "late";
  r = await pay("late index");
  ok(r.status === 200 && r.receipt?.transaction === TX && logCalls >= 2, `log indexed only on a later poll -> 200 (status ${r.status}, getLogs ${logCalls})`);

  rpcMode = "elsewhere";
  r = await pay("nonce spent elsewhere");
  ok(r.status === 402, `nonce spent by a transfer to someone else -> 402 (status ${r.status})`);

  rpcMode = "short";
  r = await pay("short");
  ok(r.status === 402, `transfer short of the price -> 402 (status ${r.status})`);

  rpcMode = "reverted";
  r = await pay("reverted");
  ok(r.status === 402, `reverted transaction -> 402 (status ${r.status})`);

  rpcMode = "down";
  r = await pay("rpc down");
  ok(r.status === 402 && r.ms < 20_000 && rpcCalls >= 2, `RPC down -> 402 inside the bound (status ${r.status}, ${r.ms} ms, ${rpcCalls} RPC tries)`);

  settleMode = "other"; rpcMode = "proof";
  r = await pay("other error");
  ok(r.status === 402 && rpcCalls === 0, `another settle error -> 402 and the chain is never read (status ${r.status}, RPC calls ${rpcCalls})`);

  console.log(`\nOK: ${pass} passed, 0 failed`);
} catch (e) {
  fail(`unexpected: ${e.stack || e}`);
} finally {
  proc?.kill("SIGKILL");
  facilitator?.close();
}
process.exit(0);
