// RugCheck-backed tools pause themselves while RugCheck is not answering
// (src/rugcheck-pause.js). Offline: a stub clock and an in-process express app.
// Booted: the real server in paid mode (stub facilitator, RugCheck stubbed
// in-process by scripts/lib/rugcheck-outcome-preload.mjs) proves the kit's
// RugCheck reads feed the pause and that src/server.js answers the pause
// before any payment gate.
//
//   node scripts/test-rugcheck-pause.js
import "./lib/file-mode.js";
import express from "express";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { createRugcheckPause, isRugcheckOutage, rugcheckFailureKind, rugcheckInputKey, rugcheckPauseMiddleware } from "../src/rugcheck-pause.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- the state machine -------------------------------------------------------
const D = (key) => ({ key, kind: "deadline" });
{
  let t = 1_000_000;
  const logs = [];
  const p = createRugcheckPause({ now: () => t, env: {}, log: (m) => logs.push(m) });
  p.noteFailure("deadline", D("A")); p.noteFailure("deadline", D("B"));
  ok(!p.state().paused, "two consecutive failures do not pause");
  p.noteSuccess(); p.noteFailure("deadline", D("A")); p.noteFailure("deadline", D("B"));
  ok(!p.state().paused, "a success in between resets the count");
  p.noteFailure("deadline", D("C"));
  const s = p.state();
  ok(s.paused && s.retryAfterSeconds === 300, `three consecutive failures on distinct mints pause for 5 minutes (${s.retryAfterSeconds} s)`);
  ok(logs.length === 1 && /paused for 300 s/.test(logs[0]), "the pause is logged once");
  t += 120_000;
  ok(p.state().paused && p.state().retryAfterSeconds === 180, "the Retry-After counts down");
  t += 180_001;
  ok(!p.state().paused, "after the cool-down the tools are offered again (fail open)");
  p.noteFailure("deadline", D("A"));
  ok(!p.state().paused, "one input-bound failure after a cool-down does not pause again");
  p.noteFailure("deadline", D("B"));
  ok(p.state().paused, "a second mint failing after a cool-down pauses again");
  t += 300_001;
  ok(!p.state().paused, "the second cool-down ends");
  p.noteFailure("unreachable", { key: "A", kind: "unreachable" });
  ok(p.state().paused, "an unreachable host on the first read after a cool-down pauses again");
  t += 300_001;
  ok(!p.state().paused, "the third cool-down ends");
  p.noteSuccess(); p.noteFailure("deadline", D("A"));
  ok(!p.state().paused && p.failures() === 1, "a success after a cool-down clears probation");
}
{
  // The reviewer's attack: one mint RugCheck reliably fails on, sent over and over.
  let t = 0;
  const p = createRugcheckPause({ now: () => t, env: {}, log: () => {} });
  for (let i = 0; i < 50; i++) p.noteFailure("deadline", D("BADMINT"));
  ok(!p.state().paused, "the same failing mint repeated 50 times never pauses");
  for (let i = 0; i < 50; i++) p.noteFailure("5xx", { key: "BADMINT", kind: "upstream" });
  ok(!p.state().paused, "the same mint answering 5xx 50 times never pauses");
  p.noteSuccess();
  p.noteFailure("deadline", D("M1")); p.noteFailure("deadline", D("M2")); p.noteFailure("deadline", D("M3"));
  ok(p.state().paused, "three distinct mints timing out do pause");
  const q = createRugcheckPause({ now: () => t, env: {}, log: () => {} });
  for (let i = 0; i < 3; i++) q.noteFailure("unreachable", { key: "SAME", kind: "unreachable" });
  ok(q.state().paused, "an unreachable host pauses whatever the input");
}
{
  let t = 0;
  const p = createRugcheckPause({ now: () => t, env: { RUGCHECK_PAUSE_AFTER: "2", RUGCHECK_PAUSE_MS: "60000" }, log: () => {} });
  p.noteFailure("x", D("A")); p.noteFailure("x", D("B"));
  ok(p.state().paused && p.state().retryAfterSeconds === 60, "RUGCHECK_PAUSE_AFTER and RUGCHECK_PAUSE_MS size the pause");
  const off = createRugcheckPause({ now: () => t, env: { RUGCHECK_PAUSE: "off" }, log: () => {} });
  for (let i = 0; i < 10; i++) off.noteFailure("x", D(`M${i}`));
  ok(!off.state().paused, "RUGCHECK_PAUSE=off never pauses");
}

// --- what counts as an outage ------------------------------------------------
ok(isRugcheckOutage({ statusCode: 503, upstreamFailure: "deadline" }), "a deadline on the read's own cap is an outage");
ok(!isRugcheckOutage({ statusCode: 503, upstreamFailure: "deadline" }, { budgetShortened: true }), "a deadline the handler budget cut short (or had spent) is not");
ok(isRugcheckOutage({ statusCode: 503, upstreamFailure: "unreachable" }), "an unreachable host is an outage");
ok(isRugcheckOutage({ statusCode: 502 }), "a RugCheck 5xx is an outage");
ok(!isRugcheckOutage({ statusCode: 503, rugcheckNoReport: true }), "\"unable to generate\" for a mint is that mint's answer, not an outage");
ok(rugcheckFailureKind({ statusCode: 503, rugcheckNoReport: true }) === "neutral", "and it does not reset the count either");
ok(!isRugcheckOutage({ statusCode: 422 }), "a refusal of the input is an answer, not an outage");
ok(rugcheckInputKey("https://api.rugcheck.xyz/v1/tokens/MINTA/report/summary") === "MINTA" && rugcheckInputKey("https://api.rugcheck.xyz/v1/tokens/MINTA/report") === "MINTA", "the summary and the report of one mint are one input");

// --- the middleware answers before any payment gate ----------------------------
{
  let t = 0;
  const p = createRugcheckPause({ now: () => t, env: {}, log: () => {} });
  const app = express();
  let reachedGate = 0;
  app.use(rugcheckPauseMiddleware(["POST /api/sol-token-report", "POST /api/sol-token-holders"], p));
  app.use((req, res) => { reachedGate++; res.status(402).json({ error: "payment required" }); });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (path, method = "POST") => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });

  let r = await call("/api/sol-token-report");
  ok(r.status === 402 && reachedGate === 1, "not paused: the call reaches the payment gate");
  p.noteFailure("x", D("A")); p.noteFailure("x", D("B")); p.noteFailure("x", D("C"));
  r = await call("/api/sol-token-report");
  const body = await r.json();
  ok(r.status === 503 && reachedGate === 1, "paused: the call answers 503 before the payment gate");
  ok(r.headers.get("retry-after") === "300" && body.retryAfterSeconds === 300, `the 503 carries Retry-After (${r.headers.get("retry-after")})`);
  ok(/Not charged - retry in about 300 s/.test(body.error) && body.attribution === "upstream", `the 503 says not charged and when to retry (${body.error})`);
  r = await call("/api/sol-token-holders", "GET");
  ok(r.status === 503, "the GET twin of a POST tool is paused too");
  r = await call("/api/sol-price");
  ok(r.status === 402 && reachedGate === 2, "a tool that does not read RugCheck is never paused");
  t += 300_001;
  r = await call("/api/sol-token-report");
  ok(r.status === 402, "after the cool-down the tool is offered again");
  srv.close();
}

// --- booted: the real server, paid mode ---------------------------------------
{
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const PRELOAD = fileURLToPath(new URL("./lib/rugcheck-outcome-preload.mjs", import.meta.url));
  const TMP = mkdtempSync(join(tmpdir(), "rugcheck-pause-"));
  const [PORT, FAC_PORT] = await getFreePorts(2);
  const nowS = () => Math.floor(Date.now() / 1000);
  const fac = { verify: 0, settle: 0 };
  const facilitator = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
      if (req.url === "/rpc") {
        const balanceOf = parsed.method === "eth_call" && String(parsed.params?.[0]?.data || "").startsWith("0x70a08231");
        return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (10n ** 12n).toString(16).padStart(64, "0") : "0x0" });
      }
      const payer = parsed.paymentPayload?.payload?.authorization?.from;
      if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
      if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer }); }
      reply({});
    });
  });
  await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
  const child = spawn(process.execPath, ["--import", PRELOAD, "src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", OPENROUTER_API_KEY: "",
      RUGCHECK_TOOLS: "on", RUGCHECK_PAUSE: "", RUGCHECK_PAUSE_AFTER: "3", RUGCHECK_PAUSE_MS: "300000", SOLANA_RPC_URL: "", JUPITER_API_BASE: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", HANGUP_FORGIVE_FILE: "off",
      REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d))); child.stderr.on("data", (d) => logs.push(String(d)));
  const B = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
    ok(up, "the paid-mode server booted");
    const mint = (prefix, c) => `${prefix}${"1".repeat(28)}${c}`;
    const post = (path, body, headers = {}) => fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    let accept = null, nonce = 0;
    const credential = (payer) => Buffer.from(JSON.stringify({
      x402Version: 2, resource: accept.resource, accepted: accept,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: String(nowS() + 299), nonce: "0x" + (0x5000 + ++nonce).toString(16).padStart(64, "0") } },
    })).toString("base64");
    const paid = (m) => post("/api/sol-token-report", { mint: m }, { "payment-signature": credential(`0x${(0x7000 + nonce).toString(16).padStart(40, "0")}`), "x-forwarded-for": `10.9.0.${nonce % 250}` });

    // The payment gate answers once the facilitator's supported kinds are read.
    let r;
    for (let i = 0; i < 60; i++) { r = await post("/api/sol-token-report", { mint: mint("Bad", "A") }); if (r.status === 402) break; await new Promise((res) => setTimeout(res, 500)); }
    ok(r.status === 402, `control: unpaid, the RugCheck route reaches the payment gate (${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    accept = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    ok(!!accept, "the 402 offers exact on Base");

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await paid(mint("Bad", "A"))).status);
    ok(statuses.every((s) => s >= 500 && s !== 503), `a paid read of one failing mint answers its 5xx (${statuses.join(",")})`);
    r = await post("/api/sol-token-report", { mint: mint("Bad", "A") });
    ok(r.status === 402, `the same failing mint five times does not pause the tools (${r.status})`);
    const gen = [];
    for (const c of ["A", "B", "C"]) gen.push((await paid(mint("Gen", c))).status);
    ok(gen.every((s) => s === 503), `"unable to generate" answers a retryable 503 (${gen.join(",")})`);
    r = await post("/api/sol-token-report", { mint: mint("Bad", "A") });
    ok(r.status === 402, `"unable to generate" on three mints does not pause the tools (${r.status})`);

    r = await paid(mint("Bad", "B"));
    ok(r.status >= 500, `a second mint failing (${r.status})...`);
    const verifiesBefore = fac.verify;
    r = await post("/api/sol-token-report", { mint: mint("Bad", "C") });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 503 && /paused/.test(body.error || "") && Number(r.headers.get("retry-after")) > 0, `...pauses the tools: unpaid, the route answers the pause 503 instead of a 402 (${r.status} ${body.error || ""})`);
    r = await paid(mint("Bad", "C"));
    ok(r.status === 503 && fac.verify === verifiesBefore, `a paid call while paused answers 503 before the payment gate verifies anything (verify ${verifiesBefore} -> ${fac.verify})`);
    r = await post("/api/sol-token-holders", { mint: mint("Bad", "C") });
    ok(r.status === 503, `the other RugCheck tools are paused too (${r.status})`);
    r = await post("/api/sol-price", { mint: mint("Bad", "C") });
    ok(r.status === 402, `a tool that does not read RugCheck still reaches the payment gate (${r.status})`);
    ok(fac.settle === 0, `no failed read was settled (settle calls ${fac.settle})`);
    ok(logs.join("").includes("[rugcheck-pause]"), "the server logged the pause");
  } finally {
    child.kill("SIGKILL");
    facilitator.close();
    rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
