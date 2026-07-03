// Wallet birth-to-first-purchase E2E — the complete onboarding flow a new
// agent walks, executed for real, with a leak audit at the end:
//
//   1. A brand-new keypair is generated IN THIS PROCESS (viem). The private
//      key lives only in this process's memory; the ONLY thing ever printed,
//      logged, or sent anywhere is the public address. A second fresh
//      keypair's address plays the seller.
//   2. The CDP faucet tool funds the buyer with 1 testnet USDC on
//      Base Sepolia (the exact `testnet-fund` handler users call).
//   3. A real Agent402 server boots in PAID mode on base-sepolia
//      (x402.org facilitator — free, testnet-only), payTo = the fresh seller.
//   4. The fresh buyer pays it: wrapFetchWithPayment → 402 → sign → settle.
//      Gasless (ERC-3009): the buyer needs ONLY the faucet USDC, no ETH.
//   5. LEAK AUDIT: every byte of our stdout/stderr AND the server's full
//      log is scanned for both private keys (with and without 0x). Any hit
//      fails the run. Nothing is written to disk except the server log,
//      which is scanned and deleted.
//
// Without CDP keys (or FULL_E2E unset) it runs the offline part only:
// keygen + the leak audit of its own output — CI-safe everywhere.
//
//   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… FULL_E2E=1 node scripts/test-wallet-e2e.js
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3777;
const BASE = `http://localhost:${PORT}`;

// --- capture everything we print so the leak audit can scan it ---------------
let emitted = "";
const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
console.log = (...a) => { emitted += a.join(" ") + "\n"; rawLog(...a); };
console.error = (...a) => { emitted += a.join(" ") + "\n"; rawErr(...a); };

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. wallet birth ----------------------------------------------------------
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const buyerPk = generatePrivateKey();
const buyer = privateKeyToAccount(buyerPk);
const sellerPk = generatePrivateKey();
const seller = privateKeyToAccount(sellerPk);
console.log(`buyer  (fresh): ${buyer.address}`);
console.log(`seller (fresh): ${seller.address}`);
ok(/^0x[0-9a-fA-F]{40}$/.test(buyer.address) && buyer.address !== seller.address, "two distinct fresh wallets generated in-process");

// The audit scans for the key in every casing/prefix form that could leak.
const leakForms = (pk) => [pk, pk.toLowerCase(), pk.toUpperCase(), pk.slice(2), pk.slice(2).toLowerCase()];
function leakAudit(haystack, label) {
  for (const pk of [buyerPk, sellerPk]) {
    for (const form of leakForms(pk)) {
      if (haystack.includes(form)) { ok(false, `LEAK: a private key appears in ${label}`); return; }
    }
  }
  ok(true, `leak audit clean: no private key material in ${label} (${haystack.length} bytes scanned)`);
}

const FULL = process.env.FULL_E2E === "1" && (process.env.CDP_API_KEY_ID || "").trim() && (process.env.CDP_API_KEY_SECRET || "").trim();
if (!FULL) {
  leakAudit(emitted, "this run's output");
  console.log("\n(offline mode — set CDP_API_KEY_ID/SECRET + FULL_E2E=1 for the funded on-chain flow)");
  console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// --- 2. faucet-fund the newborn buyer (the real testnet-fund handler) ---------
const { CDP_TOOLS } = await import("../src/tools/cdp-kit.js");
const fund = await CDP_TOOLS.find((t) => t.slug === "testnet-fund").handler({ address: buyer.address, token: "usdc" });
ok(fund.funded === true && fund.network === "base-sepolia", `faucet dripped 1 testnet USDC → ${fund.explorer}`);

// Wait for the drip to land (public RPC read, no indexer lag).
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
async function usdcBalance(addr) {
  const res = await fetch("https://sepolia.base.org", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_SEPOLIA, data: "0x70a08231" + "0".repeat(24) + addr.slice(2) }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json());
  return Number(BigInt(res.result && res.result !== "0x" ? res.result : "0x0")) / 1e6;
}
let bal = 0;
for (let i = 0; i < 30 && bal < 0.9; i++) { await sleep(4000); bal = await usdcBalance(buyer.address).catch(() => 0); }
ok(bal >= 0.9, `drip confirmed on-chain: buyer holds $${bal} testnet USDC`);

// --- 3. boot a REAL paid-mode seller on base-sepolia ---------------------------
const logDir = mkdtempSync(join(tmpdir(), "a402-e2e-"));
const logPath = join(logDir, "server.log");
const { openSync, closeSync } = await import("node:fs");
const logFd = openSync(logPath, "w");
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    // Explicitly NOT forwarding: FREE_MODE. Paid mode, testnet chain, fresh payTo.
    NETWORK: "base-sepolia",
    WALLET_ADDRESS: seller.address,
    PORT: String(PORT),
    X402_SYNC_ON_START: "false",
    STATS_ALLOW_EPHEMERAL: "true",
    FREE_MODE: "",
    PAYMENT_NETWORKS: "",
    CDP_API_KEY_ID: "",       // force the default x402.org testnet facilitator
    CDP_API_KEY_SECRET: "",
  },
  stdio: ["ignore", logFd, logFd],
});
let booted = false;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { booted = true; break; } } catch {} await sleep(500); }
ok(booted, "paid-mode base-sepolia seller booted (x402.org facilitator)");

// --- 4. the newborn wallet's first purchase ------------------------------------
try {
  const [{ x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: buyer });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const res = await payFetch(`${BASE}/api/hash`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from a wallet born one minute ago" }),
  });
  const body = await res.json().catch(() => ({}));
  ok(res.status === 200 && typeof body.hex === "string" && body.hex.length === 64, `paid call succeeded (HTTP ${res.status}, sha256 returned)`);
  if (res.status !== 200) console.error(`   response body: ${JSON.stringify(body).slice(0, 400)}`);
  const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  let receipt = null;
  try { receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); } catch { /* asserted below */ }
  ok(Boolean(receipt?.transaction), `settle receipt carries the on-chain tx: https://sepolia.basescan.org/tx/${receipt?.transaction}`);
  ok(String(receipt?.network || "").includes("84532"), `settled on base-sepolia (${receipt?.network})`);
} catch (e) {
  ok(false, `paid flow failed: ${String(e?.message || e).slice(0, 160)}`);
}

// --- 5. leak audit over EVERYTHING ---------------------------------------------
proc.kill("SIGKILL");
closeSync(logFd);
await sleep(300);
const serverLog = readFileSync(logPath, "utf8");
const auditFailedBefore = failed;
leakAudit(serverLog, "the server's full log");
leakAudit(emitted, "this run's output");
ok(!serverLog.includes(buyerPk.slice(2, 34)), "not even a key fragment reached the server log");
// On a functional failure, show the server log tail for diagnosis — but only
// when the leak audit passed, so a hypothetical leak is never re-printed.
if (failed > 0 && failed === auditFailedBefore) {
  console.error("--- server log tail (leak-audited) ---");
  console.error(serverLog.split("\n").slice(-30).join("\n"));
}
rmSync(logDir, { recursive: true, force: true });

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
