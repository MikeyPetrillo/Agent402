#!/usr/bin/env node
// Paid smoke buyer, end to end against a stub seller on a loopback port with a
// throwaway key (offline, no real payment): the settlement line, signed offer
// receipt capture into a new 0600 file, and the failure verdicts when a
// requested receipt is missing or the expected text is absent.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = mkdtempSync(join(tmpdir(), "a402-cleanroom-receipt-"));
let pass = 0, fail = 0;
const check = (cond, label) => {
  if (cond) { pass++; console.log(`ok - ${label}`); } else { fail++; console.error(`FAIL - ${label}`); }
};

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const challenge = {
  x402Version: 2,
  resource: { url: "http://stub/paid" },
  accepts: [{
    scheme: "exact", network: "eip155:8453", asset: BASE_USDC,
    payTo: "0x000000000000000000000000000000000000dEaD", amount: "1000",
    maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
  }],
};
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const receipt = { format: "jws", payload: "cGF5bG9hZA", signature: "stub-signature" };

// settle: object placed in the settlement header of the paid answer, or null for none.
function buyOnce({ settle, answer, receiptOut, expect }) {
  return new Promise((resolve) => {
    const seller = http.createServer((req, res) => {
      const paid = req.headers["payment-signature"] || req.headers["x-payment"];
      if (!paid) {
        res.writeHead(402, { "content-type": "application/json", "payment-required": b64(challenge) });
        return res.end(JSON.stringify(challenge));
      }
      const headers = { "content-type": "application/json" };
      if (settle) headers["payment-response"] = b64(settle);
      res.writeHead(200, headers);
      res.end(JSON.stringify(answer));
    });
    seller.listen(0, "127.0.0.1", () => {
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SMOKE_TARGET: `http://127.0.0.1:${seller.address().port}`,
        SMOKE_ROUTE: "/paid", SMOKE_EXPECT: expect,
        BURNER_KEY: generatePrivateKey(), SMOKE_MAX_USD: "0.05",
      };
      if (receiptOut) env.SMOKE_RECEIPT_OUT = receiptOut;
      const child = spawn(process.execPath,
        ["--import", join(ROOT, "scripts/lib/loopback-only-preload.js"), join(ROOT, "scripts/smoke-buy.js")],
        { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("exit", (code) => { clearTimeout(timer); seller.close(); resolve({ code, stdout, stderr }); });
    });
  });
}

try {
  // 1. Receipt returned and requested: captured, exit 0.
  const out1 = join(WORK, "captured.json");
  const r1 = await buyOnce({
    settle: { success: true, network: "eip155:8453", transaction: "0xfeed", extensions: { "offer-receipt": { info: { receipt } } } },
    answer: { result: "MARKER-ONE" }, receiptOut: out1, expect: "MARKER-ONE",
  });
  check(r1.code === 0, `capture run exits 0 (got ${r1.code}; ${r1.stderr.trim().split("\n").pop()})`);
  check(r1.stdout.includes("  settle: network=eip155:8453 tx=0xfeed payer=?"), "settlement line names network and tx, ? for a missing payer");
  check(r1.stdout.includes("  signed offer receipt: captured"), "capture is reported");
  check(existsSync(out1), "receipt file is written");
  if (existsSync(out1)) {
    const text = readFileSync(out1, "utf8");
    check(JSON.stringify(JSON.parse(text)) === JSON.stringify(receipt), "receipt file holds the seller's receipt unchanged");
    check(text.endsWith("}\n") && text.includes('\n  "format"'), "receipt file is two-space JSON ending in one newline");
    check((statSync(out1).mode & 0o777) === 0o600, "receipt file is mode 0600");
  }
  check(r1.stdout.includes("SMOKE OK: /paid"), "capture run reports SMOKE OK");

  // 2. Receipt requested but the settlement carries none: warning, exit 1, no file.
  const out2 = join(WORK, "none.json");
  const r2 = await buyOnce({
    settle: { success: true, network: "eip155:8453", transaction: "0xbeef", payer: "0xabc" },
    answer: { result: "MARKER-TWO" }, receiptOut: out2, expect: "MARKER-TWO",
  });
  check(r2.code === 1, `missing receipt fails the run (got ${r2.code})`);
  check(r2.stderr.includes("WARN  signed offer receipt: capture requested but the seller returned none"), "missing receipt warns");
  check(r2.stderr.includes("SMOKE FAIL: /paid did not return a healthy 200 JSON with the requested signed offer receipt."), "failure names the requested receipt");
  check(!existsSync(out2), "no receipt file is created when none was returned");

  // 3. No capture requested, expectation not met: exit 1 naming the expectation.
  const r3 = await buyOnce({ settle: null, answer: { result: "something else" }, expect: "MARKER-THREE" });
  check(r3.code === 1, `unmet expectation fails the run (got ${r3.code})`);
  check(r3.stderr.includes('SMOKE FAIL: /paid did not return a healthy 200 JSON containing "MARKER-THREE".'), "failure names the expectation");
  check(!r3.stdout.includes("settle") && !r3.stdout.includes("signed offer receipt"), "no settlement or receipt lines without a header or capture");
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
