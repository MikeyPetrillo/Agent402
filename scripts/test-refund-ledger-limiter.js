#!/usr/bin/env node
// The refund ledger's operator routes and the refund runner's ledger writes.
//
// Run 37541505396 sent a refund and then had its mark-paid refused with a 429:
// the ledger routes shared the 30/min operator diagnostics budget, and a run
// makes one list call plus a claim and a mark-paid per row back to back. The
// row was stranded in `sending` until a human resolved it.
//
// What is pinned:
//  - a 40-row run's exact call pattern (list, then claim + paid per row) is
//    never refused, and leaves every row paid;
//  - the ledger routes are still rate limited, with Retry-After;
//  - the runner's ledgerUpdate resends only on 429 (refused before any write),
//    honours Retry-After, gives up after its attempts, and never resends a 5xx.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

const dir = mkdtempSync(join(tmpdir(), "refund-limiter-"));
process.env.REFUND_DB_DIR = dir;
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
const TOKEN = "test-operator-token-refund-limiter";
process.env.AGENT402_OPERATOR_TOKEN = TOKEN;
const { recordRefundOwed } = await import("../src/refund-ledger.js");
const { ledgerUpdate } = await import("./refund-run.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

// ---- ledgerUpdate: 429-only resend (no server)
const fakeRes = (status, retryAfter) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => (h === "retry-after" ? retryAfter ?? null : null) } });
const scripted = (statuses) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); const s = statuses[Math.min(calls.length - 1, statuses.length - 1)]; return fakeRes(s, "7"); };
  return { calls, fetchImpl };
};
const quiet = console.warn; console.warn = () => {};
{
  const { calls, fetchImpl } = scripted([429, 429, 200]);
  const waits = [];
  const res = await ledgerUpdate({ id: 1, action: "paid", tx: "0xabc" }, { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  ok(res.status === 200 && calls.length === 3, "a 429 is resent until the write lands");
  ok(waits.join() === "7000,7000", "the resend waits for Retry-After");
  ok(calls.every((b) => b.id === 1 && b.action === "paid" && b.tx === "0xabc"), "every resend carries the same body");
}
{
  const { calls, fetchImpl } = scripted([429]);
  const res = await ledgerUpdate({ id: 2, action: "claim" }, { fetchImpl, sleep: async () => {} });
  ok(res.status === 429 && calls.length === 4, "a persistent 429 gives up after its attempts and returns the 429");
}
for (const s of [500, 502, 409, 400]) {
  const { calls, fetchImpl } = scripted([s, 200]);
  const res = await ledgerUpdate({ id: 3, action: "paid", tx: "0xdef" }, { fetchImpl, sleep: async () => {} });
  ok(res.status === s && calls.length === 1, `an HTTP ${s} is never resent (it may have landed, or is a real answer)`);
}
console.warn = quiet;

// ---- the routes, booted
const ROWS = 40;
for (let i = 0; i < ROWS; i++) {
  recordRefundOwed({ slug: "limiter-tool", network: "eip155:8453", payer: `0x${"a".repeat(39)}${i % 10}`, priceUsd: 0.01, tx: `0x${(i + 1).toString(16).padStart(64, "0")}`, httpStatus: 502 });
}
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", REVENUE_LEDGER_DB: join(dir, "rev.db"), POSTHOG_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; proc.stdout.on("data", (d) => { log += d; }); proc.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
const update = (body) => fetch(`${base}/__operator/refunds/update`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");

  const list = await fetch(`${base}/__operator/refunds.json?status=owed`, { headers: auth });
  const owed = list.ok ? (await list.json()).refunds : [];
  ok(owed.length === ROWS, `the run's list call sees all ${ROWS} owed rows`);
  const refused = [];
  for (const row of owed) {
    const c = await update({ id: row.id, action: "claim", note: "test claim" });
    if (c.status !== 200) refused.push(`claim #${row.id}: ${c.status}`);
    const p = await update({ id: row.id, action: "paid", tx: `0x${"f".repeat(62)}${String(row.id).padStart(2, "0")}` });
    if (p.status !== 200) refused.push(`paid #${row.id}: ${p.status}`);
  }
  ok(refused.length === 0, `a ${ROWS}-row run (${1 + 2 * ROWS} calls in a burst) is never refused${refused.length ? ` - ${refused.slice(0, 3).join(", ")}` : ""}`);
  const after = await (await fetch(`${base}/__operator/refunds.json?status=paid`, { headers: auth })).json();
  ok(after.totals?.paid?.n === ROWS && after.totals?.sending?.n === 0, "every row ends paid, none stranded in sending");

  let limited = null;
  for (let i = 0; i < 300 && !limited; i++) { const r = await update({ id: 999999, action: "claim" }); if (r.status === 429) limited = r; }
  ok(limited && limited.headers.get("retry-after") === "60", "the ledger routes are still rate limited, with Retry-After");
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (fail) console.log(log.slice(-2000));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
