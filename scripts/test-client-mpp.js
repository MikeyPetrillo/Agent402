// agent402-client pays over MPP: the SDK takes any payment-aware fetch, so an
// mppx `Fetch.from(...)` (the MPP reference client) drops in where an
// @x402/fetch wrapper would. Offline: boots the real server with the MPP shim
// + a stub facilitator (same harness as test-mpp-shim.js), then buys a
// wallet-only tool through the SDK over the native MPP wire and asserts the
// SDK's own accounting (spend reservation/settle) and result caching hold on
// that path exactly as on x402.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Fetch as MppFetch, evm } from "mppx/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Agent402 } from "../client/index.js";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;
let pass = 0; let proc = null; let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const facCalls = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
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
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, MPP_SECRET_KEY: "client-mpp-test", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    PAYMENT_NETWORKS: "base", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  // An mppx fetch IS the SDK's `fetch:` - nothing MPP-specific in the SDK.
  const account = privateKeyToAccount(generatePrivateKey());
  const mppFetch = MppFetch.from({ methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
  const a = new Agent402({ baseUrl: B, fetch: mppFetch, maxPerCallUsd: 0.05 });

  // Pick a wallet-only slug from the live pricing surface, so the choice is
  // honest about the booted server's config rather than assumed.
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const list = Array.isArray(pricing?.endpoints) ? pricing.endpoints : [];
  // sql-guard is wallet-only, pure-CPU (no upstream) and takes a plain string;
  // the SDK's paid path is only exercised by a NON compute-payable tool (free
  // tools would be solved by proof-of-work instead).
  const paid = list.find((t) => t.slug === "sql-guard" && !t.computePayable);
  ok(!!paid, `found a wallet-only tool to buy (${paid?.slug})`);
  const before = { ...facCalls };
  const input = { sql: "UPDATE users SET plan = 'pro' WHERE id = 42" };
  const out = await a.call(paid.slug, input);
  ok(out && typeof out === "object", "SDK call over MPP returned the tool result");
  ok(facCalls.verify === before.verify + 1 && facCalls.settle === before.settle + 1, `one verify + one settle for the SDK's MPP buy (got +${facCalls.verify - before.verify}/+${facCalls.settle - before.settle})`);
  const spent = a.spendingSummary();
  ok(spent.calls === 1 && spent.dailyUsd > 0, `SDK spend accounting recorded the MPP settle (calls=${spent.calls}, $${spent.dailyUsd})`);
  const again = await a.call(paid.slug, input, { cache: false });
  ok(again && facCalls.settle === before.settle + 2, "a repeat call (cache off) settles again - the MPP path is not short-circuited by the SDK");
} finally {
  proc.kill("SIGKILL"); facilitator.close();
}
console.log(`\nAll ${pass} assertions passed`);
process.exit(0);
