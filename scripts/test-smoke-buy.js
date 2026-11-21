#!/usr/bin/env node
// Offline guard test for the paid smoke buyer: every refusal below must happen
// before a key is read, the payment client is imported or a request is made,
// and the signed offer receipt helpers behave as documented. No key, no
// network, no payment.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeSettlementHeader,
  receiptOutputPath,
  signedOfferReceiptFromSettlement,
  writeSignedOfferReceipt,
} from "./lib/smoke-receipt.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "smoke-buy.js");
const TMP = mkdtempSync(join(tmpdir(), "a402-smoke-buy-"));
const KEY_FILE = join(TMP, "no-such-key");

let passed = 0, failed = 0;
function check(cond, label, detail = "") {
  if (cond) { passed++; console.log(`ok   ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`); }
}

const EXPECT_REQUIRED = "smoke-buy: SMOKE_EXPECT is required when SMOKE_TARGET selects an external target";
const NO_KEY = "smoke-buy: no BURNER_KEY / KEY_FILE — cannot run the paid check";

function baseEnv() {
  const env = { ...process.env };
  for (const k of ["BURNER_KEY", "SMOKE_EXPECT", "SMOKE_TARGET", "TARGET_URL", "SMOKE_RECEIPT_OUT", "SMOKE_NETWORK"]) delete env[k];
  env.SMOKE_ROUTE = "/api/external-canary";
  env.KEY_FILE = KEY_FILE;
  return env;
}

function runCase(label, overrides, expectedStderr) {
  const env = baseEnv();
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
  check(!r.error, `${label}: child ran`, r.error && r.error.message);
  check(r.status === 2, `${label}: exit 2`, `got ${r.status}`);
  check(r.stdout === "", `${label}: stdout empty`, JSON.stringify(r.stdout));
  check(r.stderr === `${expectedStderr}\n`, `${label}: stderr`, JSON.stringify(r.stderr));
  return r;
}

try {
  check(!existsSync(KEY_FILE), "key file is absent before the runs");

  const EXT = "https://seller.example";
  // Preflight guards.
  runCase("external target, expectation unset", { SMOKE_TARGET: EXT, SMOKE_EXPECT: undefined }, EXPECT_REQUIRED);
  runCase("external target, expectation empty", { SMOKE_TARGET: EXT, SMOKE_EXPECT: "" }, EXPECT_REQUIRED);
  runCase("external target, expectation whitespace", { SMOKE_TARGET: EXT, SMOKE_EXPECT: "  \t " }, EXPECT_REQUIRED);
  runCase("external target with trailing slashes", { SMOKE_TARGET: `${EXT}///`, SMOKE_EXPECT: "" }, EXPECT_REQUIRED);
  runCase("own origin named as SMOKE_TARGET", { SMOKE_TARGET: "https://agent402.tools", SMOKE_EXPECT: "" }, EXPECT_REQUIRED);
  runCase("external target with an expectation", { SMOKE_TARGET: EXT, SMOKE_EXPECT: "  result  " }, NO_KEY);
  runCase("own service, no expectation", { SMOKE_TARGET: "", SMOKE_EXPECT: "" }, NO_KEY);
  const OTHER = "https://other.example";
  runCase("TARGET_URL names another origin", { TARGET_URL: OTHER, SMOKE_EXPECT: "" },
    `smoke-buy: refusing to pay "${OTHER}": not our service. Set ALLOW_EXTERNAL_PAID_TARGET=1 to pay another origin.`);
  runCase("TARGET_URL on loopback", { TARGET_URL: "http://127.0.0.1:9", SMOKE_EXPECT: "" }, NO_KEY);

  // The pay network: Base unless SMOKE_NETWORK names another EVM buyer chain
  // (a name or its CAIP-2 id); anything else is refused before a key is read.
  runCase("unknown pay network", { SMOKE_NETWORK: "solana", SMOKE_EXPECT: "" },
    'smoke-buy: SMOKE_NETWORK "solana" is not an EVM chain this check pays on (base, arc, celo, polygon, arbitrum, robinhood, or a CAIP-2 id of one); not paying');
  runCase("two pay networks", { SMOKE_NETWORK: "base,celo", SMOKE_EXPECT: "" },
    'smoke-buy: SMOKE_NETWORK "base,celo" is not an EVM chain this check pays on (base, arc, celo, polygon, arbitrum, robinhood, or a CAIP-2 id of one); not paying');
  runCase("pay network by name", { SMOKE_NETWORK: " Celo ", SMOKE_EXPECT: "" }, NO_KEY);
  runCase("pay network by CAIP-2 id", { SMOKE_NETWORK: "eip155:137", SMOKE_EXPECT: "" }, NO_KEY);
  {
    const { smokeNetwork } = await import("./lib/smoke-network.js");
    check(smokeNetwork("") === "eip155:8453" && smokeNetwork(undefined) === "eip155:8453", "no SMOKE_NETWORK pays on Base");
    check(smokeNetwork("celo") === "eip155:42220" && smokeNetwork("eip155:42161") === "eip155:42161" && smokeNetwork("Robinhood") === "eip155:4663", "a chain name or id maps to its one CAIP-2 network");
    check(smokeNetwork("eip155:1") === null && smokeNetwork("tempo") === null && smokeNetwork("base celo") === null, "a chain outside the buyer table maps to nothing");
    const src = readFileSync(SCRIPT, "utf8");
    check(/const SMOKE_NETWORKS = \[SMOKE_NETWORK\];/.test(src) && !/SMOKE_NETWORKS = \["eip155:8453"\]/.test(src), "the scheme and the signing guard are registered for that one network only");
  }

  // Receipt output preflight.
  const existing = join(TMP, "existing-receipt.json");
  const original = "{\"kept\":true}\n";
  writeFileSync(existing, original);
  runCase("receipt output already exists", { SMOKE_RECEIPT_OUT: existing },
    `smoke-buy: SMOKE_RECEIPT_OUT already exists: ${existing}`);
  check(readFileSync(existing, "utf8") === original, "existing receipt file is unchanged");
  const missingParent = join(TMP, "no-such-dir");
  runCase("receipt output parent missing", { SMOKE_RECEIPT_OUT: join(missingParent, "receipt.json") },
    `smoke-buy: SMOKE_RECEIPT_OUT parent directory does not exist: ${missingParent}`);

  // Helper units.
  const receipt = { format: "jws", payload: "eyJyZXNvdXJjZSI6Ii9hcGkveCJ9", signature: "c2lnbmF0dXJl" };
  const settlement = {
    success: true,
    network: "eip155:8453",
    transaction: "0x" + "ab".repeat(32),
    extensions: { "offer-receipt": { info: { receipt } } },
  };
  const decoded = decodeSettlementHeader(Buffer.from(JSON.stringify(settlement)).toString("base64"));
  check(JSON.stringify(decoded) === JSON.stringify(settlement), "settlement header decodes with extensions intact");
  check(signedOfferReceiptFromSettlement(settlement) === receipt, "receipt picker returns the same object");
  check(decodeSettlementHeader("not base64 json!") === null, "undecodable header is null");
  check(signedOfferReceiptFromSettlement({ success: true, extensions: {} }) === null, "no receipt in empty extensions");
  const fresh = join(TMP, "fresh-receipt.json");
  check(receiptOutputPath(`  ${fresh}  `) === fresh, "output path is trimmed");
  check(writeSignedOfferReceipt(fresh, receipt) === true, "receipt write returns true");
  const back = JSON.parse(readFileSync(fresh, "utf8"));
  check(back.signature === receipt.signature && JSON.stringify(back) === JSON.stringify(receipt), "written receipt parses back unchanged");
  check((statSync(fresh).mode & 0o777) === 0o600, "receipt file mode is 0600");
  let code = null;
  try { writeSignedOfferReceipt(fresh, receipt); } catch (err) { code = err.code; }
  check(code === "EEXIST", "second write fails closed with EEXIST", String(code));
  check(receiptOutputPath("") === "", "empty output path turns capture off");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
