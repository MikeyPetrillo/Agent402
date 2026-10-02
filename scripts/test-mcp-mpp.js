// Native MPP on the hosted MCP connector (/mcp) - end to end, offline.
//
// Boots the REAL server with the MPP shim mounted (MPP_SECRET_KEY) against a
// stub x402 facilitator, connects a stock @modelcontextprotocol/sdk client
// over Streamable HTTP, and proves:
//   1. an unpaid call to a wallet-only tool is a JSON-RPC error -32042 whose
//      data carries our HMAC-bound challenges (mppx's MCP wire);
//   2. mppx's McpClient.wrap() pays it out of the box - the result comes back
//      with a receipt in _meta, and the stub facilitator saw exactly ONE
//      verify + ONE settle (settlement authority = the real gates, via the
//      loopback to our own paid route);
//   3. the paid write is readable by the same wallet (payer attribution
//      survived the loopback);
//   4. a free tool is untouched (runs free, no challenge);
//   5. a tampered credential is a -32043 (verification failed) with an RFC 9457 `problem`.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpClient } from "mppx/mcp/client";
import { evm } from "mppx/client";
import { Credential } from "mppx";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { credentialHeaderFromMeta, challengesFromHeader, receiptFromHeader, MCP_PAYMENT_REQUIRED_CODE, MCP_CREDENTIAL_META } from "../src/mcp-mpp.js";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mcp-mpp-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;
const OP = "test-mcp-mpp-operator-token-0123456789";
const REFUND_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mcp-mpp-refunds-"));

let pass = 0;
let proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers first (no server) ----
ok(credentialHeaderFromMeta(null) === null && credentialHeaderFromMeta({}) === null && credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: { nope: 1 } }) === null, "credentialHeaderFromMeta: absent/unusable -> null (unpaid call)");
ok(credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: "Payment abc" }) === "Payment abc" && credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: "abc" }) === "Payment abc", "credentialHeaderFromMeta: string forms normalise to an Authorization value");
{
  // Cut-off text: "nothing was charged" only when no credential rode along.
  const { connectorCutoffText } = await import("../src/mcp-http.js");
  const paid = connectorCutoffText({ label: "Agent402 (x)", seconds: 27, paid: true, route: "POST /v1/x" });
  const unpaid = connectorCutoffText({ label: "Agent402 (x)", seconds: 27, paid: false, route: "POST /v1/x" });
  const paidErr = connectorCutoffText({ label: "Agent402 (x)", seconds: 27, paid: true, error: "socket hang up" });
  ok(/may still have completed and been charged/.test(paid) && /recorded as owed in our refund ledger and repaid after review/.test(paid) && /Do not retry blindly/.test(paid) && !/nothing was charged|not charged/.test(paid), "paid cut-off text: may have been charged, owed back after review, do not retry blindly");
  // Repayment on these rails runs through the reviewed refund job, so the text
  // must not promise that it happens by itself.
  ok(!/automatic|auto-refund/i.test(paid) && !/automatic|auto-refund/i.test(paidErr), "paid cut-off text says the charge is repaid after review, not automatically");
  ok(/nothing was charged/.test(unpaid) && !/may still have/.test(unpaid) && /Retry/.test(unpaid), "unpaid cut-off text: nothing was charged, retry is fine");
  ok(/could not be completed/.test(paidErr) && /may still have completed and been charged/.test(paidErr), "a paid loopback error is told the same money story");
}
ok(Array.isArray(challengesFromHeader(null)) && challengesFromHeader("garbage").length === 0 && receiptFromHeader("garbage") === null, "challenges/receipt parsers never throw on junk");
{
  // The loopback forwards our own signed probe marker (so a synthetic check over
  // the connector is booked as internal) and nothing a caller could not send.
  const { createMcpMppLoopback } = await import("../src/mcp-mpp.js");
  let seen = null;
  const loop = createMcpMppLoopback({ port: 1, fetchImpl: async (_u, init) => { seen = init.headers; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
  await loop({ def: { route: "GET /api/x" }, params: {}, heartbeatToken: "tok-123" });
  ok(seen?.["X-Heartbeat-Token"] === "tok-123", "the loopback forwards the heartbeat token");
  await loop({ def: { route: "GET /api/x" }, params: {}, heartbeatToken: "x".repeat(65) });
  ok(!("X-Heartbeat-Token" in seen), "an oversized token is not forwarded");
}

// ---- stub facilitator ----
const facCalls = { verify: 0, settle: 0 };
let slowVerifyMs = 0;   // flipped on to make a paid call outlive the connector's bounds
facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    if (req.url === "/verify" && slowVerifyMs) await sleep(slowVerifyMs);
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/verify") { facCalls.verify++; return reply({ isValid: true, payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    if (req.url === "/settle") { facCalls.settle++; return reply({ success: true, transaction: TX, network: "eip155:8453", payer: parsed.paymentPayload?.payload?.authorization?.from }); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    MPP_SECRET_KEY: SECRET,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
    // 6 s deadline -> the paid loopback is bounded at 3.5 s (case 6).
    AGENT402_MCP_REQ_DEADLINE_MS: "6000",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: REFUND_DIR,
  },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  const connect = async () => {
    const client = new Client({ name: "test-mcp-mpp", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`)));
    return client;
  };

  // 1. Unpaid call to a wallet-only tool -> -32042 with our challenges
  const plain = await connect();
  const pay = plain.getServerCapabilities()?.experimental?.payment;
  ok(pay?.methods?.evm?.intents?.includes("charge"), `initialize advertises experimental.payment with evm charge (${JSON.stringify(pay)})`);
  const key = `mcp-mpp-${Date.now()}`;
  // 1. A first ask gets a readable tool result
  //     (hosts that do not speak MPP show a bare error for -32042) carrying the
  //     challenges in _meta, which mppx's McpClient pays as well.
  const soft = await plain.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key, value: { hello: "mpp" } } } });
  const softText = JSON.stringify(soft.content || "");
  ok(soft.isError === true && /credits|agent402-mcp/.test(softText), "a first ask gets an isError result whose text names the ways to pay (not a bare -32042)");
  const challenges = soft._meta?.["org.paymentauth/payment-required"]?.challenges;
  ok(Array.isArray(challenges) && challenges.length >= 1 && challenges.some((c) => c.method === "evm" && c.intent === "charge") && soft._meta["org.paymentauth/payment-required"].httpStatus === 402, `the result carries _meta payment-required with httpStatus 402 + challenges (${(challenges || []).map((c) => c.method).join(",")})`);
  ok(challenges.every((c) => typeof c.id === "string" && c.realm && c.request?.amount), "each challenge is a full MPP challenge object (id, realm, request.amount)");
  // The loopback 402's body now mirrors the PAYMENT-REQUIRED offer; a plain
  // unpaid 402 is still not a problem document, so a first ask carries none.
  ok(soft._meta["org.paymentauth/payment-required"].problem === undefined, "a first ask's _meta carries no problem (a plain unpaid 402 is not a problem document)");

  // 4. Free tool untouched
  const free = await plain.callTool({ name: "catalog.call", arguments: { slug: "uuid", params: {} } });
  ok(!free.isError && JSON.stringify(free.content).includes("uuid"), "a free tool still runs free on the connector, no challenge");

  // 2. mppx McpClient pays it
  const account = privateKeyToAccount(generatePrivateKey());
  const payer = await connect();
  McpClient.wrap(payer, { methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
  const before = { ...facCalls };
  const paid = await payer.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key, value: { hello: "mpp" } } } });
  ok(!paid.isError, `mppx MCP client pays the challenge and the tool answers (isError=${paid.isError})`);
  ok(paid.structuredContent?.slug === "memory-write" && paid.structuredContent?.result, "result is the catalog.call envelope {slug, result}");
  ok(paid.receipt && paid._meta?.["org.paymentauth/receipt"], `receipt rides in _meta["org.paymentauth/receipt"] (and McpClient surfaces it as result.receipt: ${JSON.stringify(paid.receipt).slice(0, 80)})`);
  ok(facCalls.verify - before.verify === 1 && facCalls.settle - before.settle === 1, `the REAL gates settled it: facilitator verify +${facCalls.verify - before.verify}, settle +${facCalls.settle - before.settle} (loopback, settlement authority unchanged)`);

  // 3. Same wallet reads it back (payer attribution survived the loopback)
  const read = await payer.callTool({ name: "catalog.call", arguments: { slug: "memory-read", params: { key } } });
  ok(!read.isError && JSON.stringify(read.structuredContent?.result || read.content).includes("\"hello\""), `the paying wallet reads its own write back over MPP (${JSON.stringify(read.structuredContent?.result || "").slice(0, 80)})`);

  // 5. Tampered credential -> -32043 (spec: verification failed, mppx 0.9.1+) with RFC 9457 problem
  const evmCh = challenges.find((c) => c.method === "evm");
  const tampered = { challenge: { ...evmCh, id: "x".repeat(evmCh.id.length) }, payload: { from: account.address, to: TREASURY, value: evmCh.request.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${"77".repeat(32)}`, signature: `0x${"11".repeat(65)}`, type: "authorization" } };
  let rejected = null;
  try {
    await plain.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key: "k2", value: 1 } }, _meta: { [MCP_CREDENTIAL_META]: tampered } });
  } catch (e) { rejected = e; }
  ok(rejected && rejected.code === -32043 && rejected.data?.problem?.type === "https://paymentauth.org/problems/invalid-challenge" && Array.isArray(rejected.data.challenges) && rejected.data.challenges.length >= 1, `a tampered credential -> -32043 with problem invalid-challenge + fresh challenges (got ${rejected?.data?.problem?.type})`);
  // The 402's problem body also carries the mirrored PaymentRequired offer
  // (src/payment-required-body.js). The JSON-RPC error carries the RFC 9457
  // members only: the offer reaches an MPP client as the challenges beside it.
  {
    const p = rejected?.data?.problem || {};
    ok(typeof p.title === "string" && typeof p.detail === "string" && ["x402Version", "accepts", "resource", "extensions"].every((k) => !(k in p)), `-32043 data.problem holds RFC 9457 members only (keys: ${Object.keys(p).join(",")})`);
  }
  // sanity: the test's own serializer agrees with the wire
  ok(typeof Credential.serialize(tampered) === "string", "Credential.serialize round-trips the tampered object (test harness sanity)");

  // 6. "Error occurred during tool execution": a paid call that outlived the
  //    connector's request deadline surfaced as a JSON-RPC -32603, which MCP
  //    hosts render with no reason. The paid loopback is now bounded below the
  //    deadline, so the caller gets a tool RESULT that names what happened.
  slowVerifyMs = 5000;
  const settlesBeforeSlow = facCalls.settle;
  let slow = null, slowErr = null;
  try { slow = await payer.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key: `${key}-slow`, value: 1 } } }); }
  catch (e) { slowErr = e; }
  slowVerifyMs = 0;
  ok(!slowErr, `a slow paid call is NOT a JSON-RPC error (got ${slowErr?.code} ${slowErr?.message || ""})`);
  const slowText = JSON.stringify(slow?.content || "");
  ok(slow?.isError === true && /did not finish within \d+s/.test(slowText), `it is an isError tool result naming the timeout (${slowText.slice(0, 120)})`);
  // A credential was presented, and a close that lands while the settle call
  // itself is in flight is still charged (then booked as owed), so the
  // connector cannot promise "not charged" at the moment it stops waiting.
  ok(!/not charged|nothing was charged/i.test(slowText) && /may still have completed and been charged/.test(slowText) && /recorded as owed in our refund ledger and repaid after review/.test(slowText) && !/automatic/i.test(slowText) && /Do not retry blindly/.test(slowText),
    `a PAID cut-off says it may have been charged, that a charge is owed back, and not to retry blindly (${slowText.slice(0, 200)})`);
  // Here the loopback closed while the payment was still being VERIFIED, i.e.
  // before the first byte (src/hangup-settlement.js): once verify returns the
  // dispatcher refuses to start the handler, nothing settles, and nothing is
  // owed - the buyer was never charged for an answer that could not arrive.
  await sleep(3_000);
  ok(facCalls.settle === settlesBeforeSlow, `the cut-off paid call whose loopback closed before the first byte is NOT settled (settles +${facCalls.settle - settlesBeforeSlow})`);
  const owed = await (await fetch(`${B}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}` } })).json();
  const rows = (owed.refunds || []).filter((r) => r.slug === "memory-write");
  ok(rows.length === 0, `and nothing is owed for it, because nothing was charged (${JSON.stringify(rows)})`);

  // 7. The transport deadline itself, for a tools/call, is a result too. A
  //    second server whose deadline is shorter than the loopback bound makes
  //    the deadline win.
  proc.kill("SIGKILL");
  const { getFreePort } = await import("./lib/free-port.js");
  const port2 = await getFreePort();
  proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port2), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
      MPP_SECRET_KEY: SECRET,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
      AGENT402_MCP_REQ_DEADLINE_MS: "800", REFUND_DB_DIR: REFUND_DIR,
    },
    stdio: "ignore",
  });
  const B2 = `http://127.0.0.1:${port2}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B2}/health`)).ok) break; } catch {} await sleep(500); }
  const c2 = new Client({ name: "test-mcp-mpp-deadline", version: "0.0.0" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${B2}/mcp`)));
  McpClient.wrap(c2, { methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
  slowVerifyMs = 3000;
  let dl = null, dlErr = null;
  try { dl = await c2.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key: `${key}-dl`, value: 1 } } }); }
  catch (e) { dlErr = e; }
  slowVerifyMs = 0;
  ok(!dlErr, `the transport deadline on a tools/call is NOT a JSON-RPC error (got ${dlErr?.code} ${dlErr?.message || ""})`);
  ok(dl?.isError === true && /did not finish within \d+s on this connector/.test(JSON.stringify(dl.content)), `it is an isError tool result naming the deadline (${JSON.stringify(dl?.content || "").slice(0, 120)})`);
  ok(/may still have completed and been charged/.test(JSON.stringify(dl.content)) && !/nothing was charged/.test(JSON.stringify(dl.content)), "the transport deadline on a PAID call also says it may have been charged");
  await sleep(3500);   // let the stopped call's slow verify drain before teardown

  console.log(`\nPASS - ${pass} checks (native MPP on /mcp)`);
  proc.kill("SIGKILL");
  facilitator.close();
  (await import("node:fs")).rmSync(REFUND_DIR, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
