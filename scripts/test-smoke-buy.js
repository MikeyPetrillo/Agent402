#!/usr/bin/env node
// The manual buyer may spend real USDC against a third-party seller. An
// explicit external target therefore needs a response expectation before the
// script reads a key, initializes the payment client, or makes a request.
//
// Run every case in a child process with an absent key file: rejected cases
// must stop at the expectation preflight, while accepted cases must reach the
// existing key guard without getting far enough to import or use the client.
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
const BUYER = join(ROOT, "scripts", "smoke-buy.js");
const TEMP_DIR = mkdtempSync(join(tmpdir(), "a402-smoke-buy-"));
const MISSING_KEY = join(TEMP_DIR, "missing-key");
const EXISTING_RECEIPT = join(TEMP_DIR, "existing-receipt.json");
const EXPECT_ERROR = "smoke-buy: SMOKE_EXPECT is required when SMOKE_TARGET selects an external target";
const KEY_ERROR = "smoke-buy: no BURNER_KEY / KEY_FILE — cannot run the paid check";

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`ok - ${message}`); }
  else { fail++; console.error(`FAIL - ${message}`); }
};

const baseEnv = {
  ...process.env,
  KEY_FILE: MISSING_KEY,
  SMOKE_ROUTE: "/api/external-canary",
};
for (const name of ["BURNER_KEY", "SMOKE_EXPECT", "SMOKE_TARGET", "TARGET_URL"]) delete baseEnv[name];

const cases = [
  {
    name: "external target with unset expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with blank expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with whitespace expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: " \t  " },
    error: EXPECT_ERROR,
  },
  {
    name: "trailing-slash external target",
    env: { SMOKE_TARGET: "https://samedaydesk.example///", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "explicit agent402.tools target",
    env: { SMOKE_TARGET: "https://agent402.tools", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with a nonempty expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: "  requested outcome  " },
    error: KEY_ERROR,
  },
  {
    name: "empty target with empty expectation",
    env: { SMOKE_TARGET: "", SMOKE_EXPECT: "" },
    error: KEY_ERROR,
  },
  {
    name: "TARGET_URL alone with empty expectation",
    env: { TARGET_URL: "https://samedaydesk.example", SMOKE_EXPECT: "" },
    error: KEY_ERROR,
  },
];

try {
  ok(!existsSync(MISSING_KEY), "child key file is absent");
  for (const testCase of cases) {
    const run = spawnSync(process.execPath, [BUYER], {
      cwd: ROOT,
      env: { ...baseEnv, ...testCase.env },
      encoding: "utf8",
      timeout: 10_000,
    });
    ok(!run.error, `${testCase.name}: child process runs`);
    ok(run.status === 2, `${testCase.name}: exits 2 (got ${run.status})`);
    ok(run.stdout === "", `${testCase.name}: emits no stdout before the guard`);
    ok(run.stderr === `${testCase.error}\n`, `${testCase.name}: stops at the expected guard`);
  }

  writeFileSync(EXISTING_RECEIPT, "keep");
  const existingRun = spawnSync(process.execPath, [BUYER], {
    cwd: ROOT,
    env: { ...baseEnv, SMOKE_RECEIPT_OUT: EXISTING_RECEIPT },
    encoding: "utf8",
    timeout: 10_000,
  });
  ok(existingRun.status === 2, "existing receipt output is refused before key access");
  ok(existingRun.stdout === "", "receipt preflight refusal emits no stdout");
  ok(existingRun.stderr === `smoke-buy: SMOKE_RECEIPT_OUT already exists: ${EXISTING_RECEIPT}\n`,
    "receipt capture never overwrites prior evidence");
  ok(readFileSync(EXISTING_RECEIPT, "utf8") === "keep", "prior receipt evidence is unchanged");

  const missingParent = join(TEMP_DIR, "missing", "receipt.json");
  const missingParentRun = spawnSync(process.execPath, [BUYER], {
    cwd: ROOT,
    env: { ...baseEnv, SMOKE_RECEIPT_OUT: missingParent },
    encoding: "utf8",
    timeout: 10_000,
  });
  ok(missingParentRun.status === 2, "missing receipt parent is refused before key access");
  ok(missingParentRun.stderr === `smoke-buy: SMOKE_RECEIPT_OUT parent directory does not exist: ${join(TEMP_DIR, "missing")}\n`,
    "receipt capture names the missing parent");

  const signedReceipt = {
    format: "jws",
    payload: "eyJyZXNvdXJjZVVybCI6Imh0dHBzOi8vc2VsbGVyLmV4YW1wbGUvYXVkaXQifQ",
    signature: "signed-evidence",
  };
  const settlement = {
    success: true,
    network: "eip155:8453",
    transaction: "0xabc",
    extensions: { "offer-receipt": { info: { receipt: signedReceipt } } },
  };
  const encoded = Buffer.from(JSON.stringify(settlement)).toString("base64");
  ok(JSON.stringify(decodeSettlementHeader(encoded)) === JSON.stringify(settlement),
    "settlement response header decodes without dropping extensions");
  ok(signedOfferReceiptFromSettlement(settlement) === signedReceipt,
    "complete signed offer receipt is selected from the standard extension");
  ok(decodeSettlementHeader("not-base64-json") === null, "malformed settlement header is not evidence");
  ok(signedOfferReceiptFromSettlement({ extensions: {} }) === null, "missing offer receipt is not fabricated");

  const output = join(TEMP_DIR, "captured-receipt.json");
  ok(receiptOutputPath(`  ${output}  `) === output, "receipt output path is normalized before payment");
  ok(writeSignedOfferReceipt(output, signedReceipt), "signed offer receipt is written when requested");
  ok(JSON.parse(readFileSync(output, "utf8")).signature === "signed-evidence",
    "captured artifact preserves the complete signed receipt");
  ok((statSync(output).mode & 0o777) === 0o600, "captured receipt artifact is mode 0600");
  let overwriteRefused = false;
  try { writeSignedOfferReceipt(output, signedReceipt); } catch (error) { overwriteRefused = error?.code === "EEXIST"; }
  ok(overwriteRefused, "receipt writer itself fails closed on overwrite");
  ok(receiptOutputPath("") === "", "receipt capture remains opt-in");
} finally {
  rmSync(TEMP_DIR, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
