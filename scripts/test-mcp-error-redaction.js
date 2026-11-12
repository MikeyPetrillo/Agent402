// test-mcp-error-redaction - error text the hosted connector (/mcp) and the
// revenue view answer with is scrubbed of configured secret values and of
// credentials inside a URL, and keeps the rest of the reason readable.
// Offline: a bare express app + mountMcp over a stub catalog, and the
// revenue JSON handlers over a snapshot that throws.
//
// What this pins:
//  - a free tool whose handler throws text quoting a configured key and a
//    database URL with a password answers the reason without either;
//  - a transport failure on tools/call (the tool-result text) and on another
//    method (the JSON-RPC error message) is scrubbed the same way;
//  - the revenue snapshot's failure body is scrubbed;
//  - the shapes a secret reaches text in without matching it byte for byte:
//    broken across lines (inside its known prefix too), cut short by the
//    upstream, a hex key in the other case or without 0x, an unconfigured
//    64-hex run that is bare or named as a key; a 0x transaction hash, a named
//    digest and ordinary text stay readable;
//  - every read of an error's message in src/mcp-http.js that can reach an
//    answer goes through mcpErrorText (a source scan, so a new answer site
//    that quotes err.message raw fails here).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.FREE_MODE = "true";
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";
// A configured key: its value must never reach an answer.
const FAKE_KEY = "sk-test-redact0123456789abcdefFAKEKEY";
process.env.FAKE_UPSTREAM_API_KEY = FAKE_KEY;
const PG_PASSWORD = "hunter2pgSecretPass";
const PG_URL = `postgres://agent:${PG_PASSWORD}@db.internal.example:5432/state`;
const LEAKY = `upstream refused the call (key ${FAKE_KEY}) while reading ${PG_URL}`;
// A configured hex signing key (mixed case, with 0x).
const HEX_KEY = "AbCdEf0123456789".repeat(4);
process.env.FAKE_SIGNER_PRIVATE_KEY = `0x${HEX_KEY}`;

import express from "express";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "a402-mcp-redact-"));
process.env.REFUND_DB_DIR = TMP;

const { mountMcp } = await import("../src/mcp-http.js");
const { revenueApiHandlers } = await import("../src/revenue-live.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${msg}`); } };
const clean = (text, where) => {
  const t = String(text ?? "");
  ok(t.length > 0, `${where}: an answer text is present`);
  ok(!t.includes(FAKE_KEY), `${where}: the configured key is not in the answer`);
  ok(!t.includes(PG_PASSWORD), `${where}: the database password is not in the answer`);
};

// ----------------------------------------------------------------- connector
const def = (slug, handler) => ({
  route: `GET /api/${slug}`, slug, name: slug, category: "test", price: "$0.001", description: `${slug} redaction test tool`,
  tags: ["redact"], discovery: { inputSchema: { properties: { q: { type: "string" } } }, input: { q: "x" } }, handler,
});
const CATALOG = {
  "GET /api/leaky": def("leaky", async () => { throw Object.assign(new Error(LEAKY), { statusCode: 502 }); }),
  "GET /api/fine": def("fine", async () => ({ ok: true })),
};

// A transport failure: handleRequest rejects with the leaky text while armed.
let transportFails = false;
const realHandle = StreamableHTTPServerTransport.prototype.handleRequest;
StreamableHTTPServerTransport.prototype.handleRequest = function (...args) {
  if (transportFails) return Promise.reject(new Error(LEAKY));
  return realHandle.apply(this, args);
};

const app = express();
app.use(express.json({ limit: "1mb" }));
mountMcp(app, CATALOG, { baseUrl: "http://localhost", isComputePayable: () => true, taskStoreDir: join(TMP, "store") });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("event-stream")) {
    return JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5).trim());
  }
  return JSON.parse(text);
}

try {
  const leaky = (await rpc("tools/call", { name: "catalog.call", arguments: { slug: "leaky", params: { q: "x" } } })).result;
  const text = leaky?.content?.[0]?.text || "";
  ok(leaky?.isError === true, "a throwing tool answers isError");
  clean(text, "catalog.call handler error");
  let hint = null;
  try { hint = JSON.parse(text); } catch { /* asserted below */ }
  ok(typeof hint?.error === "string" && hint.error.includes("upstream refused the call") && hint.error.includes("db.internal.example"), "the reason and the host stay readable in the error field");

  transportFails = true;
  const cut = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "fine", params: {} } });
  const cutText = cut?.result?.content?.[0]?.text || "";
  ok(cut?.result?.isError === true && cutText.includes("internal error"), "a transport failure on tools/call answers a tool result naming an internal error");
  clean(cutText, "tools/call transport failure");
  const listed = await rpc("tools/list", {});
  ok(listed?.error?.code === -32603, "a transport failure on another method answers a JSON-RPC error");
  clean(listed?.error?.message, "tools/list transport failure");
  ok(String(listed?.error?.message || "").includes("upstream refused the call"), "the JSON-RPC error keeps the reason");
  transportFails = false;
} finally {
  StreamableHTTPServerTransport.prototype.handleRequest = realHandle;
  server.close();
  server.closeAllConnections?.();
}

// ------------------------------------------------------------- revenue view
{
  const api = revenueApiHandlers({ snapshot: async () => { throw new Error(LEAKY); }, ledger: async () => ({}), authed: () => true });
  const sent = {};
  const res = { status(c) { sent.status = c; return this; }, set() { return this; }, json(b) { sent.body = b; return this; } };
  await api.publicHandler({ headers: {} }, res);
  ok(sent.status === 500 && sent.body?.error === "revenue snapshot failed", "the revenue view answers 500 on a failed snapshot");
  clean(sent.body?.detail, "revenue public failure");
  ok(String(sent.body?.detail || "").includes("upstream refused the call"), "the revenue failure detail keeps the reason");
  const sent2 = {};
  const res2 = { status(c) { sent2.status = c; return this; }, set() { return this; }, json(b) { sent2.body = b; return this; } };
  await api.operatorHandler({ headers: {} }, res2);
  ok(sent2.status === 500, "the operator revenue view answers 500 on a failed snapshot");
  clean(sent2.body?.detail, "revenue operator failure");
}

// ------------------------------------------- shapes that are not byte-equal
{
  const { mcpErrorText } = await import("../src/mcp-http.js");
  const hexOf = (pair) => pair.repeat(32);
  const OTHER = hexOf("9e"); // an unconfigured 64-hex run
  const gone = (text, secretBits, where) => {
    const t = mcpErrorText(new Error(text));
    ok(t.includes("[redacted]") && secretBits.every((b) => !t.includes(b)), `${where}: redacted (got ${JSON.stringify(t.slice(0, 160))})`);
    return t;
  };
  const kept = (text, where) => {
    const t = mcpErrorText(new Error(text));
    ok(t === text, `${where}: kept as is (got ${JSON.stringify(t.slice(0, 160))})`);
  };
  // Broken across lines: mid-value with indentation, CRLF, and inside the sk- prefix.
  gone(`upstream said: ${FAKE_KEY.slice(0, 19)}\n    ${FAKE_KEY.slice(19)} is invalid`, [FAKE_KEY.slice(0, 19), FAKE_KEY.slice(19)], "a key split across lines");
  gone(`bad key ${FAKE_KEY.slice(0, 25)}\r\n${FAKE_KEY.slice(25)}`, [FAKE_KEY.slice(0, 25), FAKE_KEY.slice(25)], "a key split by CRLF");
  gone(`bad key s\nk${FAKE_KEY.slice(2)}`, [FAKE_KEY.slice(2)], "a key split inside its known prefix");
  // Cut short by the upstream.
  gone(`Incorrect API key provided: ${FAKE_KEY.slice(0, 22)}... You can find your key in the dashboard`, [FAKE_KEY.slice(0, 22)], "a key the upstream truncated with ...");
  gone(`key "${FAKE_KEY.slice(0, 18)}"`, [FAKE_KEY.slice(0, 18)], "a key truncated before a quote");
  gone(`key ${FAKE_KEY.slice(0, 30)}`, [FAKE_KEY.slice(0, 30)], "a key truncated at the end of the text");
  // The configured hex key in the other case and without 0x.
  gone(`signer 0x${HEX_KEY.toLowerCase()} rejected`, [HEX_KEY.toLowerCase()], "the configured hex key lowercased");
  gone(`signer 0x${HEX_KEY.toUpperCase()} rejected`, [HEX_KEY.toUpperCase()], "the configured hex key uppercased");
  gone(`signer ${HEX_KEY.toLowerCase()} rejected`, [HEX_KEY.toLowerCase()], "the configured hex key with 0x stripped");
  gone(`signer 0x${HEX_KEY.toLowerCase().slice(0, 30)}\n${HEX_KEY.toLowerCase().slice(30)} rejected`, [HEX_KEY.toLowerCase().slice(0, 30), HEX_KEY.toLowerCase().slice(30)], "the configured hex key lowercased and split across lines");
  // Unconfigured 64-hex runs: bare, or named as a key, in any case.
  gone(`could not sign with ${OTHER}`, [OTHER], "a bare 64-hex run");
  gone(`could not sign with ${OTHER.toUpperCase()}`, [OTHER.toUpperCase()], "a bare uppercase 64-hex run");
  gone(`PRIVATE_KEY=0x${OTHER} is malformed`, [OTHER], "a 0x run named as a private key");
  gone(`{"secret":"0x${OTHER.toUpperCase()}"}`, [OTHER.toUpperCase()], "a 0x run named as a secret");
  gone(`mnemonic seed 0x${OTHER}`, [OTHER], "a 0x run named as a seed");
  gone(`private key: 0x${OTHER.slice(0, 40)}\n  ${OTHER.slice(40)}`, [OTHER.slice(0, 40), OTHER.slice(40)], "a named 0x key split across lines");
  // Controls: a transaction hash, a named digest, longer hex and plain text stay.
  kept(`settle failed for 0x${OTHER}`, "a 0x transaction hash");
  kept(`settle failed for 0x${OTHER.toUpperCase()}: execution reverted`, "an uppercase 0x transaction hash");
  kept(`sha256 ${OTHER} does not match`, "a bare digest named sha256");
  kept(`txid: ${OTHER} not found`, "a bare txid");
  kept(`signature 0x${hexOf("ab")}${hexOf("cd")}1b is invalid`, "a 65-byte signature");
  kept(`address 0x${"ab".repeat(20)} has no funds`, "an address");
  kept("upstream refused the call: model not found\nRetry with another model", "ordinary text across lines");
  kept(`the key ${FAKE_KEY.slice(0, 10)} prefix is fine`, "a run shorter than a cut-short key");
  kept("Invalid input: sk-test-somethingelse is not a model", "text sharing only the key's public prefix");
  // A run named as a hash by the word just before it stays; a key word only
  // counts when it names the run itself, and a nearer hash name wins.
  kept(`{"txHash":"${OTHER}"}`, "a bare run named by a camelCase hash field");
  kept(`{"tx_hash":"${OTHER}"}`, "a bare run named by a snake_case hash field");
  kept(`blockHash ${OTHER} unknown`, "a bare run named as a block hash");
  kept(`block ${OTHER} not found`, "a bare run named as a block");
  kept(`idempotency key reused; settled 0x${OTHER}`, "a 0x hash after a sentence that mentions a key");
  kept(`{"privateKeyHash":"${OTHER}"}`, "a run whose name ends in hash after a key word");
  // Controls: a run the name before it calls a key is still redacted.
  gone(`private key: ${OTHER}`, [OTHER], "a bare run named as a private key");
  gone(`{"privateKey":"${OTHER}"}`, [OTHER], "a bare run in a camelCase privateKey field");
  gone(`{"privateKey":"0x${OTHER}"}`, [OTHER], "a 0x run in a camelCase privateKey field");
  gone(`Private Key Hex: 0x${OTHER}`, [OTHER], "a 0x run after a spaced name whose key word is not the last word");
  gone(`wallet private key hex 0x${OTHER}`, [OTHER], "a 0x run after a lowercase spaced key name");
  kept(`idempotency key reused; settled 0x${OTHER}`, "a key word in an earlier clause does not reach the run");
  gone(`PRIVATE_KEY_HEX=0x${OTHER}`, [OTHER], "a 0x run named by a key name with a suffix");
}

// ------------------------------------------- a cut-short key, many times over
{
  const { redactSecrets } = await import("../src/tools/redact.js");
  // A megabyte holding the configured key's first characters some 55k times:
  // one pass over the text, not one rebuild of it per match.
  const head = FAKE_KEY.slice(0, 19);
  const big = `${head} `.repeat(Math.ceil((1 << 20) / (head.length + 1)));
  redactSecrets("warm up"); // the secret list is built once, outside the timing
  const t0 = performance.now();
  const out = redactSecrets(big);
  const ms = performance.now() - t0;
  ok(!out.includes(head) && out.startsWith("[redacted] [redacted]"), "every cut-short copy of the key in a megabyte is redacted");
  // Runs in about 20 ms here; the bound leaves room for a loaded CI host and
  // still fails a per-match rebuild (seconds on this input).
  ok(ms < 1000, `a megabyte of cut-short keys is redacted in under a second (took ${ms.toFixed(0)} ms)`);
}

// --------------------------------------------------------------- source scan
{
  const src = readFileSync(join(ROOT, "src/mcp-http.js"), "utf8");
  const lines = src.split("\n");
  const raw = [];
  lines.forEach((line, i) => {
    // An error's message read directly: err.message, err?.message, handlerErr.message.
    if (!/\b(err|e|error|handlerErr)\??\.message\b/.test(line)) return;
    if (/mcpErrorText/.test(line)) return;
    // The definition of mcpErrorText itself.
    if (/"message" in err \? err\.message/.test(line)) return;
    // onServed's errorMessage reaches logToolError, which scrubs it; it is never answered.
    if (/^\s*errorMessage: handlerErr\.message,$/.test(line)) return;
    // The loopback failure is handed to connectorCutoffText, which scrubs it.
    if (/error: timedOut \? null : \(err\?\.message \|\| err\)/.test(line)) return;
    raw.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  ok(raw.length === 0, `every error message src/mcp-http.js reads goes through mcpErrorText${raw.length ? `:\n    ${raw.join("\n    ")}` : ""}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-mcp-error-redaction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
