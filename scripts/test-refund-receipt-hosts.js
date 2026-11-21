#!/usr/bin/env node
// Where the refund job reads the receipt that proves a payment, and what it
// never prints.
//
//   node scripts/test-refund-receipt-hosts.js      (offline: local stubs only)
//
// A public Celo node answered receipts older than a few days only some of the
// time, and the job read each receipt once from one host, so a Celo debt read
// empty and was held. Pinned here:
//   - the inbound proof (src/payment-verify.js) reads an empty receipt again
//     after each retry delay, then reads the next host, and reads the token's
//     decimals from the host that held the receipt; an unreadable host is
//     passed over; a caller that names one URL and no delays (every serving
//     path) reads once, as before;
//   - the job's hosts for a chain are REFUND_RPC_<id> first, then the public
//     host, and refund.yml passes REFUND_RPC_42220 from a secret;
//   - no reason, hold line, failure line or release note carries a URL (an
//     RPC URL can hold a provider key, and a cut-off copy is not masked);
//   - the real job, with refund.yml's Celo host, proves a receipt its host
//     answered empty twice, and never prints that host.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

process.env.AGENT402_OPERATOR_TOKEN ||= "test-operator-token";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rr = await import("./refund-run.js");
const { verifyInboundPayment } = await import("../src/payment-verify.js");
const { EVM_RPCS } = await import("../src/evm-rpcs.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const nopause = async () => {};

const CELO = "eip155:42220";
const USDC_CELO = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const PAYTO = "0x1111111111111111111111111111111111111111";
const BUYER = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const hex64 = (c) => `0x${c.repeat(64)}`;
const topic = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const amt = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const receiptFor = (from, to, v) => ({ status: "0x1", logs: [{ address: USDC_CELO, topics: [TRANSFER, topic(from), topic(to)], data: amt(v) }] });
const TX = hex64("c");

// ---- one stub, several "hosts" by path ---------------------------------------
// /flaky answers no receipt for its first `flakyEmpty` reads, then the receipt;
// /bare never holds it (a node that keeps no history); /hist always holds it;
// /broken answers a JSON-RPC error that quotes a keyed URL.
const reads = {};
let flakyEmpty = 2;
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  const host = url.pathname.slice(1);
  const { method, id } = JSON.parse((await readBody(req)) || "{}");
  reads[`${host}:${method}`] = (reads[`${host}:${method}`] || 0) + 1;
  const reply = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, ...body })); };
  if (host === "broken") return reply({ error: { code: -32005, message: `limit reached for ${base}/broken?apikey=keykeykeykeykeykeykey` } });
  if (method === "eth_getTransactionReceipt") {
    if (host === "hist") return reply({ result: receiptFor(BUYER, PAYTO, 10_000) });
    if (host === "flaky") return reply({ result: reads[`${host}:${method}`] > flakyEmpty ? receiptFor(BUYER, PAYTO, 10_000) : null });
    return reply({ result: null });
  }
  if (method === "eth_call") return host === "flaky" || host === "hist" ? reply({ result: amt(6) }) : reply({ error: { code: -32000, message: "decimals read from the wrong host" } });
  reply({ error: { code: -32601, message: "not in stub" } });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const at = (h) => `${base}/${h}`;
const resetReads = () => { for (const k of Object.keys(reads)) delete reads[k]; };
const verify = (rpcFor, extra = {}) => verifyInboundPayment({
  network: CELO, payer: BUYER, amountUsd: 0.01, tx: TX,
  acceptsFor: () => ({ payTo: PAYTO, asset: USDC_CELO }), rpcFor, pause: nopause, ...extra,
});

try {
  // ---- the inbound proof ------------------------------------------------------
  {
    resetReads(); flakyEmpty = 2;
    const v = await verify(() => at("flaky"), { receiptRetryDelaysMs: [5, 5, 5] });
    ok(v.verified === true && reads["flaky:eth_getTransactionReceipt"] === 3, `an empty receipt is read again on the same host until it is answered (${reads["flaky:eth_getTransactionReceipt"]} reads, ${v.reason || "verified"})`);

    resetReads();
    const two = await verify(() => [at("bare"), at("hist")], { receiptRetryDelaysMs: [5, 5] });
    ok(two.verified === true && reads["bare:eth_getTransactionReceipt"] === 3 && reads["hist:eth_getTransactionReceipt"] === 1, `a host that never holds it is read 1 + retries times, then the next host proves it (${JSON.stringify(reads)})`);
    ok(!reads["bare:eth_call"] && reads["hist:eth_call"] === 1, "the token's decimals are read from the host that held the receipt");

    resetReads();
    const passOver = await verify(() => [at("broken"), at("hist")], { receiptRetryDelaysMs: [5] });
    ok(passOver.verified === true && reads["broken:eth_getTransactionReceipt"] === 1, "a host that cannot be read is passed over for the next one");

    resetReads();
    const none = await verify(() => [at("bare"), `${at("bare")}?second`], { receiptRetryDelaysMs: [5] });
    ok(none.verified === false && none.reason === "transaction not found on chain" && reads["bare:eth_getTransactionReceipt"] === 4, `every host empty: held as not found, after reading each (${reads["bare:eth_getTransactionReceipt"]} reads)`);

    resetReads(); flakyEmpty = 2;
    const once = await verify(() => at("flaky"));
    ok(once.verified === false && reads["flaky:eth_getTransactionReceipt"] === 1, "control: one URL and no delays (a serving path) reads once, as before");
    ok((await verify(() => [])).reason === `no RPC configured for ${CELO}` && (await verify(() => null)).reason === `no RPC configured for ${CELO}`, "no host: held, never guessed");

    // Tempo reads through the same reader.
    resetReads(); flakyEmpty = 1;
    const tempo = await verifyInboundPayment({ network: "eip155:4217", payer: BUYER, amountUsd: 0.01, tx: TX, acceptsFor: () => ({ payTo: PAYTO, assets: [USDC_CELO] }), rpcFor: () => [at("flaky")], receiptRetryDelaysMs: [5], pause: nopause });
    ok(tempo.verified === true && reads["flaky:eth_getTransactionReceipt"] === 2, "the Tempo proof reads an empty receipt again too");
  }

  // ---- no URL in any reason --------------------------------------------------------
  {
    const KEY = "keykeykeykeykeykeykey";
    const broken = await verify(() => at("broken"));
    ok(broken.verified === false && /could not read the transaction/.test(broken.reason) && !broken.reason.includes(KEY) && !broken.reason.includes(base) && broken.reason.includes("<url>"), `a node's error that quotes its keyed URL reaches the reason without it (${broken.reason})`);
    // fetch cannot parse a host with a space, and quotes the whole value back.
    const malformed = await verify(() => `https://rpc example.invalid/v1/${KEY}`);
    ok(malformed.verified === false && /could not read the transaction/.test(malformed.reason) && !malformed.reason.includes(KEY) && !malformed.reason.includes("example.invalid"), `a URL fetch cannot parse (it quotes all of it back) is not in the reason (${malformed.reason})`);
    ok(rr.withoutUrls(`HTTP request failed. URL: https://celo.example.invalid/v2/${KEY} Status: 429`) === "HTTP request failed. URL: <url> Status: 429", "the job's own redaction drops a URL wherever it sits");

    // The executor's lines and the release note it writes back.
    const lines = [];
    const capture = { log: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
    const longUrl = `https://celo.example.invalid/v2/${KEY}${"x".repeat(200)}`;
    const notes = [];
    const rowA = { id: 1, network: CELO, payer: BUYER, priceUsd: 0.01, evidence: TX };
    const rowB = { ...rowA, id: 2, evidence: hex64("d") };
    await rr.executeRefunds([rowA, rowB], {
      verifyInbound: async (row) => (row.id === 1 ? { verified: false, reason: `could not read the transaction: ${longUrl}` } : { verified: true }),
      claim: async () => true,
      send: async () => { throw Object.assign(new Error(`HTTP request failed. URL: ${longUrl}`), { preBroadcast: true }); },
      release: async (id, note) => { notes.push(note); return true; },
      markPaid: async () => {}, pause: nopause, log: capture,
    });
    ok(lines.some((l) => /HOLD\s+#1/.test(l)) && lines.some((l) => /FAIL\s+#2/.test(l)), "setup: a hold line and a failure line were printed");
    ok(!lines.some((l) => l.includes(KEY) || /https?:\/\//.test(l)) && notes.length === 1 && !notes[0].includes(KEY) && !/https?:\/\//.test(notes[0]), `no printed line and no release note carries the URL or a piece of it (${notes[0]})`);
  }

  // ---- the job's hosts, and the workflow that names them ------------------------------
  {
    const env = { REFUND_RPC_42220: " https://celo-history.example.invalid/key " };
    ok(JSON.stringify(rr.proofRpcsFor(CELO, env)) === JSON.stringify(["https://celo-history.example.invalid/key", EVM_RPCS[CELO]]), "Celo: the job's own host first, then the public host");
    ok(JSON.stringify(rr.proofRpcsFor(CELO, {})) === JSON.stringify([EVM_RPCS[CELO]]), "unset: the public host alone");
    ok(JSON.stringify(rr.proofRpcsFor(CELO, { REFUND_RPC_42220: EVM_RPCS[CELO] })) === JSON.stringify([EVM_RPCS[CELO]]), "the same host twice is read as one");
    ok(rr.proofRpcsFor("eip155:4217", {}).length === 1 && rr.proofRpcsFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", {}).length === 0, "Tempo reads its one RPC; a non-EVM chain names none here");
    ok(rr.RECEIPT_RETRY_DELAYS_MS.length >= 3 && rr.RECEIPT_RETRY_DELAYS_MS.every((d) => d > 0), `the job reads an empty receipt again ${rr.RECEIPT_RETRY_DELAYS_MS.length} times per host`);
    const src = readFileSync(join(root, "scripts/refund-run.js"), "utf8");
    ok(/const rpcFor = \(n\) => proofRpcsFor\(n\);/.test(src) && /receiptRetryDelaysMs: RECEIPT_RETRY_DELAYS_MS,/.test(src), "main proves inbound payments through those hosts with those retries");
    const wf = load(readFileSync(join(root, ".github/workflows/refund.yml"), "utf8"));
    const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((s) => s.name === "Run refunds");
    ok(String(step?.env?.REFUND_RPC_42220 || "").replace(/\s+/g, "") === "${{secrets.REFUND_RPC_42220}}", "refund.yml passes REFUND_RPC_42220 from a secret (a keyed URL is a secret, and the log masks it)");
    ok(!/echo|printenv|set -x/.test(String(step?.run || "")), "the step's run line prints nothing of its env");
  }

  // ---- the real job, with refund.yml's Celo host ------------------------------------------
  {
    const KEY = "keykeykeykeykeykeykey";
    const seen = { claims: 0, receiptReads: 0 };
    const job = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://stub");
      const body = await readBody(req);
      const json = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/__operator/refunds.json") return json(200, { refunds: [{ id: 41, slug: "chat", network: "celo", payer: BUYER, priceUsd: 0.003, evidence: TX, status: "owed", synthetic: 0, createdAt: Date.now() - 12 * 86_400_000, httpStatus: 200, wire: "x402" }], totals: {} });
      if (url.pathname === "/__operator/refunds/update") { seen.claims++; return json(409, { ok: false }); } // never let a send begin
      if (url.pathname === "/api/hash" || url.pathname === "/api/solidity-scan") {
        const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: CELO, payTo: PAYTO, asset: USDC_CELO, amount: "1000" }] })).toString("base64");
        return json(402, {}, { "payment-required": hdr });
      }
      if (url.pathname === "/sdn") return json(503, {});
      if (url.pathname === `/celo-history/${KEY}`) {
        const { method, id } = JSON.parse(body || "{}");
        const ans = (result) => json(200, { jsonrpc: "2.0", id, result });
        if (method === "eth_getTransactionReceipt") { seen.receiptReads++; return ans(seen.receiptReads > 2 ? receiptFor(BUYER, PAYTO, 3_000) : null); }
        if (method === "eth_call") return ans(amt(6));
        if (method === "eth_estimateGas") return ans("0xea60");
        if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return ans("0x3b9aca00");
        if (method === "eth_getBlockByNumber") return ans({ number: "0x1", hash: hex64("1"), parentHash: hex64("0"), baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [] });
        if (method === "eth_getBalance") return ans(amt(10n ** 18n));
        if (method === "eth_chainId") return ans("0xa4ec");
        return json(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "not in stub" } });
      }
      json(404, {});
    });
    await new Promise((r) => job.listen(0, "127.0.0.1", r));
    const jb = `http://127.0.0.1:${job.address().port}`;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(root, "scripts/refund-run.js")], {
        cwd: root,
        env: {
          PATH: process.env.PATH, TARGET_URL: jb, AGENT402_OPERATOR_TOKEN: "test-operator-token", REFUND_LIVE: "true",
          REFUND_RPC_42220: `${jb}/celo-history/${KEY}`, REFUND_EVM_KEY: "0x" + "11".repeat(32), SANCTIONS_LIST_URL: `${jb}/sdn`,
        },
      });
      let s = ""; child.stdout.on("data", (d) => { s += d; }); child.stderr.on("data", (d) => { s += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, s }); });
    });
    job.close();
    ok(/#41 inbound payment confirmed on-chain/.test(out.s) && seen.receiptReads === 3, `the job proves a Celo receipt its host answered empty twice, on its third read and before any other host (${seen.receiptReads} reads)${/#41 inbound/.test(out.s) ? "" : `: ${out.s.slice(-400)}`}`);
    ok(!out.s.includes(KEY) && !out.s.includes("celo-history"), "and never prints that host");
    ok(seen.claims <= 1, `it claims at most once and sends nothing (the stub refuses the claim; claims ${seen.claims})`);
  }
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
