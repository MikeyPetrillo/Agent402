#!/usr/bin/env node
// The AgentCore payments recipe (examples/agentcore-x402-buyer/direct_buy.py),
// run for real against our own 402, with no AWS account and no payment.
//
// 1. Boots src/server.js in paid mode against a stub facilitator and reads the
//    real unpaid 402 that POST /api/hash answers.
// 2. Serves that 402 from a local stand-in seller, which answers 200 with the
//    hash tool's own output (its handler, called here) once the retry carries
//    the payment header the payment service returned.
// 3. Runs the recipe with python3, with stub boto3 and
//    bedrock_agentcore.payments modules on PYTHONPATH: the stub PaymentManager
//    records what the recipe hands it and returns a payment header.
//
// It proves the recipe's caller path end to end: the 402 it reads is ours, the
// payment service receives it whole (status, the PAYMENT-REQUIRED header, the
// body), the retry carries the returned header, and the digest it verifies is
// the field the tool answers. A control without the payment header must fail.
// A missing python3 fails under CI (a skipped integration test is not coverage).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootPaidServer } from "./lib/paid-boot.js";
import { KIT } from "../src/tools/kit.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECIPE = join(ROOT, "examples/agentcore-x402-buyer/direct_buy.py");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (py.status !== 0) {
  if (process.env.CI) { console.log("FAIL - python3 is not available to run the recipe"); process.exit(1); }
  console.log("note - python3 not found; the recipe run is skipped outside CI");
  process.exit(0);
}

const BODY = { text: "hello world", algo: "sha256" };
const hashTool = KIT.find((t) => t.slug === "hash");
ok(Boolean(hashTool), "the hash tool is in the catalog kit");
const answer = await hashTool.handler(BODY);
ok(answer && /^[0-9a-f]{64}$/.test(answer.hex || ""), `the hash tool answers a hex digest (${Object.keys(answer || {}).join(", ")})`);

// --- 1. our real 402 -------------------------------------------------------------
const srv = await bootPaidServer({ label: "agentcore-recipe" });
let real;
try {
  const r = await fetch(`${srv.url}/api/hash`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(BODY) });
  real = { status: r.status, header: r.headers.get("payment-required") || "", body: await r.text() };
} finally { await srv.stop(); }
ok(real.status === 402 && real.header.length > 100, `our POST /api/hash answers 402 with a PAYMENT-REQUIRED header (${real.status})`);

// --- 2. the stand-in seller ------------------------------------------------------
const PROOF = "stub-signed-payment";
const seen = [];
const seller = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const paid = req.headers["payment-signature"] === PROOF;
    seen.push({ method: req.method, url: req.url, paid, body: raw });
    if (!paid) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": real.header });
      return res.end(real.body);
    }
    res.writeHead(200, { "content-type": "application/json", "payment-response": "stub-settlement" });
    res.end(JSON.stringify(answer));
  });
});
await new Promise((r) => seller.listen(0, "127.0.0.1", r));
const target = `http://127.0.0.1:${seller.address().port}/api/hash`;

// --- 3. the recipe, with stub AWS modules ----------------------------------------
const stubs = mkdtempSync(join(tmpdir(), "agentcore-stubs-"));
const record = join(stubs, "calls.json");
mkdirSync(join(stubs, "bedrock_agentcore", "payments"), { recursive: true });
writeFileSync(join(stubs, "boto3.py"), "def setup_default_session(**kwargs):\n    return None\n");
writeFileSync(join(stubs, "bedrock_agentcore", "__init__.py"), "");
writeFileSync(join(stubs, "bedrock_agentcore", "payments", "__init__.py"), `import json, os
class PaymentManager:
    def __init__(self, payment_manager_arn=None, region_name=None):
        self.arn = payment_manager_arn
    def generate_payment_header(self, **kwargs):
        with open(os.environ["STUB_RECORD"], "w") as f:
            json.dump(kwargs, f)
        return json.loads(os.environ["STUB_PROOF_HEADERS"])
`);

const ENV = {
  PATH: process.env.PATH,
  STUB_RECORD: record,
  PAYMENT_MANAGER_ARN: "arn:aws:bedrock-agentcore:us-west-2:000000000000:payment-manager/pm-test",
  PAYMENT_INSTRUMENT_ID: "pi-test",
  PAYMENT_SESSION_ID: "ps-test",
  TARGET_URL: target,
  TARGET_METHOD: "POST",
  TARGET_BODY: JSON.stringify(BODY),
};
// The stubs go first on sys.path; the recipe runs as __main__, as a reader runs
// it. Asynchronous: the stand-in seller answers from this same process.
const run = (headers) => new Promise((resolve) => {
  const child = spawn("python3", ["-c", `import sys, runpy; sys.path.insert(0, ${JSON.stringify(stubs)}); sys.argv = [${JSON.stringify(RECIPE)}]; runpy.run_path(${JSON.stringify(RECIPE)}, run_name="__main__")`], {
    cwd: stubs, env: { ...ENV, STUB_PROOF_HEADERS: JSON.stringify(headers) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

try {
  const good = await run({ "PAYMENT-SIGNATURE": PROOF });
  ok(good.status === 0, `the recipe exits 0 against our 402 (${good.status}): ${(good.stderr || "").trim().split("\n").slice(-2).join(" | ")}`);
  ok(/VERIFIED: sha256\('hello world'\)/.test(good.stdout) && !/NOT VERIFIED/.test(good.stdout), "the recipe verifies the digest the hash tool answers (its hex field)");
  ok(/Settlement receipt present/.test(good.stdout), "the recipe reads the settlement header whatever its case");
  const call = JSON.parse(readFileSync(record, "utf8"));
  const req = call.payment_required_request || {};
  const hdrs = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  ok(req.statusCode === 402 && hdrs["payment-required"] === real.header && req.body === real.body, "the payment service is handed our 402 whole: status, PAYMENT-REQUIRED header and body");
  ok(call.payment_instrument_id === "pi-test" && call.payment_session_id === "ps-test" && typeof call.client_token === "string" && call.client_token.length >= 32, "the recipe names its instrument and session and sends a fresh client token");
  ok(seen.length === 2 && !seen[0].paid && seen[1].paid && JSON.parse(seen[1].body).text === "hello world", "one unpaid call, then one retry carrying the returned payment header and the same body");

  // Control: a payment service that returns no usable header leaves the seller unpaid.
  seen.length = 0;
  const bad = await run({ "PAYMENT-SIGNATURE": "not-the-proof" });
  ok(bad.status !== 0 && /payment did not settle/.test(bad.stdout), "control: a retry the seller does not accept fails the recipe");
} finally {
  await new Promise((r) => { seller.closeAllConnections?.(); seller.close(() => r()); });
  rmSync(stubs, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
