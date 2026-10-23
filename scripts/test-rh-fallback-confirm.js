// A listed Robinhood settle fallback is tried only after its /supported has
// confirmed exact on eip155:4663. The server boots with RH1 (reverts every
// settle) and RH2 (settles, but /supported answers 503 until switched on):
// while RH2 is unconfirmed a reverted settle is not sent to it and the buyer
// gets 402; once it answers and the background recheck confirms it, the same
// flow settles once through RH2 (paid-mode boot vs stub facilitators, offline).
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { getFreePorts } = await import(root + "/scripts/lib/free-port.js");
const { createServer } = await import("node:http");
const { spawn } = await import("node:child_process");
const { mkdtempSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
const RH = "eip155:4663";
const REVERTED = 'The contract function "transferWithAuthorization" reverted.';
const [PORT, BASE_FAC, RH1, RH2] = await getFreePorts(4);
const st = { rh2Settles: 0, rh2Up: false, rh2Supported: 0 };
const json = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const stub = (h) => createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch {} h(req, res, body); }); });
const kinds = { kinds: [{ x402Version: 2, scheme: "exact", network: RH }], extensions: [], signers: {} };
const payerOf = (b) => b?.paymentPayload?.payload?.authorization?.from;
const servers = [
  [stub((q, r) => q.url === "/supported" ? json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }) : q.url === "/rpc" ? json(r, 200, { jsonrpc: "2.0", id: 1, result: "0x0" }) : json(r, 404, {})), BASE_FAC],
  [stub((q, r, b) => q.url === "/supported" ? json(r, 200, kinds) : q.url === "/verify" ? json(r, 200, { isValid: true, payer: payerOf(b) }) : q.url === "/settle" ? json(r, 200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: RH }) : json(r, 404, {})), RH1],
  [stub((q, r, b) => { if (q.url === "/supported") { st.rh2Supported++; return st.rh2Up ? json(r, 200, kinds) : json(r, 503, { error: "down" }); } if (q.url === "/settle") { st.rh2Settles++; return json(r, 200, { success: true, transaction: "0x" + "4b".repeat(32), network: RH, payer: payerOf(b) }); } return json(r, 404, {}); }), RH2],
];
await Promise.all(servers.map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
const tmp = mkdtempSync(join(tmpdir(), "a402-unconf-"));
const env = { ...process.env }; delete env.STATE_DATABASE_URL; delete env.REDIS_URL; delete env.SOLVADOR_KEY;
const proc = spawn(process.execPath, ["src/server.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PORT: String(PORT), FREE_MODE: "",
  WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "", PAYMENT_NETWORKS: "base,robinhood",
  ROBINHOOD_FACILITATOR_URL: `http://127.0.0.1:${RH1},http://127.0.0.1:${RH2}`, ROBINHOOD_FALLBACK_RECHECK_MS: "1500",
  PAYMENT_SETTLE_FALLBACK: "true", SALES_LEDGER_DB: join(tmp, "sales.db"), REFUND_DB_DIR: tmp, FACILITATOR_GAS_CHECK: "off",
  X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
const log = []; proc.stdout.on("data", (c) => log.push(String(c))); proc.stderr.on("data", (c) => log.push(String(c)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = `http://127.0.0.1:${PORT}`; const PATH = "/api/demand-radar?limit=1";
let up = false; for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
const r402 = await fetch(`${B}${PATH}`);
const accepted = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString()).accepts.find((a) => a.network === RH);
let n = 0;
const cred = () => Buffer.from(JSON.stringify({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from: `0x${(0xe00 + ++n).toString(16).padStart(40, "0")}`, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x9900 + n).toString(16).padStart(64, "0") } } })).toString("base64");
const a = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred() } }); await a.text();
const whileDown = { status: a.status, rh2Settles: st.rh2Settles, rh2SupportedAsks: st.rh2Supported };
st.rh2Up = true; await sleep(4000);
const b = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred() } }); await b.text();
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`ok - ${msg}`); else { failed++; console.log(`FAIL - ${msg}`); } };
try {
  check(up, "the paid-mode server booted with two listed Robinhood facilitators");
  check(whileDown.status === 402 && whileDown.rh2Settles === 0, `while the second is unconfirmed a reverted settle never reaches it: the buyer gets 402 (${JSON.stringify(whileDown)})`);
  check(log.join("").includes("confirmed for the settle fallback"), "the background recheck confirms it once its /supported answers");
  check(b.status === 200 && st.rh2Settles === 1, `then the same flow settles once through it: 200 (status ${b.status}, ${st.rh2Settles} settle)`);
} finally {
  proc.kill("SIGKILL"); for (const [srv] of servers) srv.close();
}
if (failed) console.log(log.join("").slice(-2000));
console.log(`test-rh-fallback-confirm: ${failed ? `FAILED (${failed})` : "all passed"}`);
process.exit(failed ? 1 : 0);
