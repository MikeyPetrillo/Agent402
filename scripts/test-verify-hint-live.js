#!/usr/bin/env node
// The 402 hint on the REAL gate chain (review 2026-08-28): @x402/core has two
// verify-failure shapes - a facilitator that THROWS (non-2xx, CDP's shape)
// reaches onVerifyFailure; one that answers 200 {isValid:false} takes the
// graceful path, which has no failure hook at all. The unit test stubs the
// module and could not see that the graceful path produced NO hint. This boots
// a paid server against a stub facilitator that answers BOTH shapes and asserts
// the buyer's 402 carries hint + retry either way, that the hint goes only to
// the exact credential that failed, and that a bare 402 stays untouched.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, facilitator = null, proc = null;
const fail = (m) => {
  console.error("FAIL:", m);
  if (typeof serverLog !== "undefined" && serverLog.length) { console.error("--- server output (last lines) ---"); for (const l of serverLog) console.error(l); console.error("--- end server output ---"); }
  proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAYER = "0x00000000000000000000000000000000000000a1";
let verifyMode = "graceful"; let verifies = 0; let rpcReads = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") {
      verifies++;
      if (verifyMode === "graceful") return reply(200, { isValid: false, invalidReason: "insufficient_funds", payer: PAYER });
      return reply(400, { isValid: false, invalidReason: "invalid_payload: contract call failed: execution reverted", payer: PAYER });
    }
    if (req.url === "/rpc") { rpcReads++; return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" }); }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  // Keep the server's own output: a one-off in CI (run 33579827783, 2026-09-02)
  // answered 402 to the first paid request with the stub facilitator seeing
  // ZERO verifies, and with stdio ignored the reason the paywall logged was
  // gone with the runner. The last lines are printed on failure only.
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 80) serverLog.splice(0, serverLog.length - 80); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

const credential = (accepted, nonce) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce } },
})).toString("base64");

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  const bare = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  ok(bare.status === 402, `unpaid POST /api/hash -> 402 (got ${bare.status})`);
  const req402 = JSON.parse(Buffer.from(bare.headers.get("payment-required"), "base64").toString("utf-8"));
  const accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453");
  ok(!!accepted, "the 402 offers exact on Base");
  const bareBody = await bare.json();
  ok(bareBody.hint === undefined && bareBody.retry === undefined, "a bare 402 carries no hint");

  const pay = (header) => fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: JSON.stringify({ text: "x" }) });

  // graceful {isValid:false}: no failure hook fires in @x402/core - the afterVerify hook must catch it
  const H1 = credential(accepted, "0x" + "aa".repeat(32));
  const first = await pay(H1);
  if (!(first.status === 402 && verifies === 1)) console.error("first paid response body:", (await first.text().catch(() => "(unreadable)")).slice(0, 600));
  ok(first.status === 402 && verifies === 1, `graceful isValid:false -> 402 after one facilitator verify (got ${first.status}, verifies ${verifies})`);
  const retry = await pay(H1);
  const rb = await retry.json();
  ok(retry.status === 402 && typeof rb.hint === "string" && rb.retry === "fund-wallet" && rb.payerUsdcOnBase === 0 && retry.headers.get("retry-after") === "60", `the SAME credential retried gets the hint on its 402 (retry=${rb.retry}, balance=${rb.payerUsdcOnBase}, Retry-After=${retry.headers.get("retry-after")})`);
  console.log("   hinted 402 keys:", Object.keys(rb).join(","), "payment-required:", !!retry.headers.get("payment-required"));
  ok(!!retry.headers.get("payment-required"), "the hinted 402 keeps its PAYMENT-REQUIRED challenge");
  ok(rpcReads === 1, `the balance was read once for one credential (rpc reads ${rpcReads})`);

  // a different credential naming the same payer is verified on its OWN merits
  // (one more facilitator verify, one more balance read) and never inherits the
  // first credential's stored hint before that verify has happened
  const forged = credential(accepted, "0x" + "bb".repeat(32));
  const before = verifies;
  const forgedRes = await pay(forged);
  ok(forgedRes.status === 402 && verifies === before + 1, `a fresh credential for the same payer goes to the facilitator again (verifies ${verifies})`);
  // thrown shape (non-2xx verify, CDP's): the classic onVerifyFailure path still hints
  verifyMode = "throw";
  const H3 = credential(accepted, "0x" + "cc".repeat(32));
  await pay(H3);
  const r3 = await pay(H3);
  const b3 = await r3.json();
  ok(r3.status === 402 && b3.retry === "fund-wallet" && /holds \$0\.0000/.test(b3.hint), `non-2xx verify (thrown) -> the hint still reaches the retried credential (retry=${b3.retry})`);

  console.log(`\nPASS - ${pass} checks (402 hint on both verify-failure shapes, bound to the credential)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
