#!/usr/bin/env node
// The Stripe Link canary (scripts/stripe-link-canary.mjs) against a stubbed
// Link CLI and a stub target: no Link account, no card, no production.
//
// Run 44658841204 (2026-11-19) created a spend request, the operator approved
// it, and the canary's own poll never read a status ("final status=?" after
// 720 s), so it never paid and never said why. The CLI's JSON answer takes
// more than one shape (an array of results, the same array spread into an
// object beside a notice, an { ok, data } envelope, an error object on a
// non-zero exit). This drives the real script, end to end, through each:
//   - every answer shape the CLI writes is read, and an approved request pays;
//   - a poll that reads no status prints the CLI's exit code and its output
//     (redacted) and fails fast with the reason, never waiting out the window;
//   - an error the CLI marks as not retryable ends the wait at once;
//   - a preset spend request goes straight to pay once it reads approved,
//     with no create call;
//   - a denied request fails and never pays.
//   node scripts/test-stripe-link-canary.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CANARY = fileURLToPath(new URL("./stripe-link-canary.mjs", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The stub target: the paid route answers 402 with a stripe challenge, the
// revenue surface counts stripe settles, and the stub CLI's pay bumps it.
let settled = 0;
const target = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/premium/chat/completions") {
    res.writeHead(402, { "www-authenticate": 'Payment id="c1", realm="stub", method="stripe", intent="charge", request="e30"', "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (req.url === "/api/revenue/mpp") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ byNetwork: { stripe: { count: settled } } })); return; }
  if (req.method === "POST" && req.url === "/__stub/paid") { settled++; res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const TARGET = `http://127.0.0.1:${target.address().port}`;

// The stub CLI, found first on PATH as `npx`: it reads its scenario from the
// file beside it (the canary hands the CLI a minimal environment) and logs
// every call there.
const dir = mkdtempSync(join(tmpdir(), "a402-link-canary-"));
writeFileSync(join(dir, "npx"), `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const here = __dirname;
const sc = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
const args = process.argv.slice(2).filter((a) => a !== "-y" && !a.startsWith("@stripe/link-cli@"));
const cmd = args.slice(0, 2).join(" ");
appendFileSync(join(here, "calls.log"), cmd + "\\n");
const out = (o) => { process.stdout.write(o.stdout); process.exit(o.code || 0); };
if (cmd === "spend-request create") out(sc.create);
if (cmd === "spend-request retrieve") {
  const n = readFileSync(join(here, "calls.log"), "utf8").split("\\n").filter((l) => l === "spend-request retrieve").length;
  out(sc.retrieve[Math.min(n, sc.retrieve.length) - 1]);
}
if (cmd === "mpp pay") {
  fetch(sc.target + "/__stub/paid", { method: "POST" }).then(() => out(sc.pay));
} else { process.stderr.write("unknown " + cmd); process.exit(2); }
`);
chmodSync(join(dir, "npx"), 0o755);

const SR = "lsrq_test_0001";
const sr = (status, extra = {}) => ({ id: SR, object: "spend_request", status, amount: 50, ...extra });
const arr = (o) => JSON.stringify([o]);
const PAID = { stdout: arr({ status: 200, headers: { "payment-receipt": "rcpt" }, body: JSON.stringify({ choices: [{ message: { content: "settled" } }] }) }), code: 0 };
const CREATED = { stdout: arr(sr("pending_approval", { approval_url: "https://app.link.com/approve/x" })), code: 0 };

async function runCanary(scenario, env = {}) {
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ target: TARGET, pay: PAID, create: CREATED, ...scenario }));
  writeFileSync(join(dir, "calls.log"), "");
  const t0 = Date.now();
  const child = spawn(process.execPath, [CANARY], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "/tmp", TARGET_URL: TARGET,
      LINK_ACCESS_TOKEN: "stub-access", LINK_REFRESH_TOKEN: "stub-refresh", STRIPE_PROFILE_ID: "profile_stub", POW_SECRET: "stub-pow-secret",
      STRIPE_CANARY_APPROVAL_WAIT_S: "30", STRIPE_CANARY_POLL_S: "0.05", STRIPE_CANARY_LEDGER_POLL_MS: "20", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  const calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
  return { code, out, calls, ms: Date.now() - t0 };
}
const pays = (r) => r.calls.filter((c) => c === "mpp pay").length;

try {
  // 1. The CLI's array answer: pending, then approved.
  {
    const before = settled;
    const r = await runCanary({ retrieve: [{ stdout: arr(sr("pending_approval")), code: 0 }, { stdout: arr(sr("approved")), code: 0 }] });
    ok(r.code === 0 && pays(r) === 1 && settled === before + 1, `an array answer is read: pending, then approved, then one pay and the ledger moves by one (exit ${r.code})\n${r.code ? r.out : ""}`);
  }
  // 2. The same result spread into an object beside a notice ({"0": ..., "cta": ...}).
  {
    const spread = JSON.stringify({ 0: sr("approved"), cta: { description: "Update available", commands: [] } });
    const r = await runCanary({ retrieve: [{ stdout: spread, code: 0 }] });
    ok(r.code === 0 && pays(r) === 1, `the array spread into an object beside a notice is read (exit ${r.code})\n${r.code ? r.out : ""}`);
  }
  // 3. The { ok, data, meta } envelope, with a log line before it.
  {
    const env = `note: refreshed credentials\n${JSON.stringify({ ok: true, data: [sr("approved")], meta: { command: "spend-request retrieve" } })}`;
    const r = await runCanary({ retrieve: [{ stdout: env, code: 0 }] });
    ok(r.code === 0 && pays(r) === 1, `an { ok, data } envelope after a log line is read (exit ${r.code})\n${r.code ? r.out : ""}`);
  }
  // 4. No status ever read: fails fast, with the CLI's exit code and its
  //    output, a long token in it redacted.
  {
    const leak = "x".repeat(8) + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const r = await runCanary({ retrieve: [{ stdout: `unexpected output ${leak}`, code: 0 }] });
    ok(r.code !== 0 && pays(r) === 0, `a poll that reads no status fails and never pays (exit ${r.code})`);
    ok(/retrieve exit=0/.test(r.out) && /unexpected output/.test(r.out), "the failure prints the poll's exit code and its output");
    ok(!r.out.includes(leak) && /<redacted>/.test(r.out), "a token-length string in the CLI's output is redacted");
    ok(r.calls.filter((c) => c === "spend-request retrieve").length <= 3 && r.ms < 15_000, `it fails fast, after at most three unreadable polls (${r.calls.filter((c) => c === "spend-request retrieve").length} polls, ${r.ms} ms of a 30 s window)`);
    ok(/no status/i.test(r.out) && /FAIL - /.test(r.out), "the failure names its reason");
  }
  // 5. An error the CLI marks as not retryable ends the wait at once.
  {
    const r = await runCanary({ retrieve: [{ stdout: JSON.stringify({ code: "NOT_AUTHENTICATED", message: "Link session expired; log in again" }), code: 1 }] });
    ok(r.code !== 0 && pays(r) === 0 && r.calls.filter((c) => c === "spend-request retrieve").length === 1, `a CLI error that will not clear on a retry fails on the first poll (exit ${r.code}, ${r.calls.length} calls)`);
    ok(/NOT_AUTHENTICATED/.test(r.out) && /retrieve exit=1/.test(r.out), "it prints the CLI's error code and exit code");
  }
  // 6. A preset spend request: no create, one read, then pay.
  {
    const r = await runCanary({ retrieve: [{ stdout: arr(sr("approved")), code: 0 }] }, { STRIPE_CANARY_SPEND_REQUEST_ID: SR });
    ok(r.code === 0 && !r.calls.includes("spend-request create") && r.calls.filter((c) => c === "spend-request retrieve").length === 1 && pays(r) === 1,
      `a preset spend request reads approved once and pays, with no create call (calls: ${r.calls.join(", ")})`);
  }
  // 7. Denied: fails, never pays.
  {
    const r = await runCanary({ retrieve: [{ stdout: arr(sr("denied")), code: 0 }] });
    ok(r.code !== 0 && pays(r) === 0 && /denied/.test(r.out), `a denied request fails with its status and never pays (exit ${r.code})`);
  }
} finally {
  target.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
