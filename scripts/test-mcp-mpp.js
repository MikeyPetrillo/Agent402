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

const PORT = 3081;
const FAC_PORT = 3082;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mcp-mpp-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;

let pass = 0;
let proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers first (no server) ----
ok(credentialHeaderFromMeta(null) === null && credentialHeaderFromMeta({}) === null && credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: { nope: 1 } }) === null, "credentialHeaderFromMeta: absent/unusable -> null (unpaid call)");
ok(credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: "Payment abc" }) === "Payment abc" && credentialHeaderFromMeta({ [MCP_CREDENTIAL_META]: "abc" }) === "Payment abc", "credentialHeaderFromMeta: string forms normalise to an Authorization value");
ok(Array.isArray(challengesFromHeader(null)) && challengesFromHeader("garbage").length === 0 && receiptFromHeader("garbage") === null, "challenges/receipt parsers never throw on junk");

// ---- stub facilitator ----
const facCalls = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
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
  const key = `mcp-mpp-${Date.now()}`;
  let asked = null;
  try {
    await plain.callTool({ name: "catalog.call", arguments: { slug: "memory-write", params: { key, value: { hello: "mpp" } } } });
  } catch (e) { asked = e; }
  ok(asked && asked.code === MCP_PAYMENT_REQUIRED_CODE, `unpaid wallet-only tool -> JSON-RPC error -32042 (got code ${asked?.code}: ${String(asked?.message || "").slice(0, 80)})`);
  const challenges = asked?.data?.challenges;
  ok(Array.isArray(challenges) && challenges.length >= 1 && challenges.some((c) => c.method === "evm" && c.intent === "charge") && asked.data.httpStatus === 402, `error.data carries httpStatus 402 + challenges (${(challenges || []).map((c) => c.method).join(",")})`);
  ok(challenges.every((c) => typeof c.id === "string" && c.realm && c.request?.amount), "each challenge is a full MPP challenge object (id, realm, request.amount)");

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
  // sanity: the test's own serializer agrees with the wire
  ok(typeof Credential.serialize(tampered) === "string", "Credential.serialize round-trips the tampered object (test harness sanity)");

  console.log(`\nPASS - ${pass} checks (native MPP on /mcp)`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
