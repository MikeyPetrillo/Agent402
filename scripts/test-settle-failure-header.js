// A settle that fails answers the buyer a PAYMENT-RESPONSE that carries a
// short reason code and a fixed message, never the facilitator's raw words or
// body (src/facilitator-diagnostics.js settleReceiptHeaderGuard, mounted by
// src/server.js before every payment gate); the raw text goes to the server
// log. Driven through the REAL paid server against a stub facilitator:
//   - settle answers 500 with an HTML page: header reads settlement_failed and
//     the generic message, the page text is absent, the log has it;
//   - settle answers success:false with a code and a raw message: the code is
//     kept, the message is not;
//   - a billing refusal keeps only the matched phrase, so the 402 still
//     explains it as the server's facilitator quota (the readers that classify
//     the receipt read the same verdict);
//   - control: a settled 200 receipt is untouched.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { sanitizeSettleReceiptHeader, GENERIC_SETTLE_FAILURE_MESSAGE } from "../src/facilitator-diagnostics.js";

let pass = 0, fail = 0, proc = null, facilitator = null;
const TMP = mkdtempSync(join(tmpdir(), "settle-hdr-"));
const serverLog = [];
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 120_000).unref();

const RAW_MARK = "ZQX-RAW-FACILITATOR-PAGE";
const MSG_MARK = "ZQX-RAW-MESSAGE-WORDS";
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const dec = (h) => { try { return JSON.parse(Buffer.from(String(h), "base64").toString("utf8")); } catch { return null; } };

// Unit: the pure transform.
{
  const s = sanitizeSettleReceiptHeader(enc({ success: false, errorReason: `[Label] settle failed (500): <html>${RAW_MARK}</html>`, errorMessage: `<html>${RAW_MARK}</html>`, network: "eip155:8453", payer: "0xabc", transaction: "" }));
  const r = dec(s.value);
  ok(s.changed && r.errorReason === "settlement_failed" && r.errorMessage === GENERIC_SETTLE_FAILURE_MESSAGE && r.network === "eip155:8453" && r.payer === "0xabc" && !JSON.stringify(r).includes(RAW_MARK), `unit: raw text replaced, receipt fields kept (${JSON.stringify(r)})`);
  const v = enc({ success: true, transaction: "0x1", network: "eip155:8453" });
  ok(sanitizeSettleReceiptHeader(v).value === v, "unit: a settled receipt is untouched");
  const c = enc({ success: false, errorReason: "insufficient_funds", errorMessage: "insufficient_funds" });
  ok(sanitizeSettleReceiptHeader(c).value === c, "unit: a receipt that is all code is untouched");
}

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const fac = { mode: "ok", settle: 0 };
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const payer = p.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") {
      fac.settle++;
      if (fac.mode === "html") { res.writeHead(500, { "Content-Type": "text/html" }); return res.end(`<html><body><h1>${RAW_MARK}</h1></body></html>`); }
      if (fac.mode === "code") return reply({ success: false, errorReason: "invalid_exact_evm_payload_signature", errorMessage: `${MSG_MARK} internal detail`, network: "eip155:8453", payer, transaction: "" });
      if (fac.mode === "billing") return reply({ success: false, errorReason: `${MSG_MARK} settle refused`, errorMessage: `Out of mainnet settlement funds for account ${MSG_MARK}`, network: "eip155:8453", payer, transaction: "" });
      return reply({ success: true, transaction: `0x${fac.settle.toString(16).padStart(64, "0")}`, network: "eip155:8453", payer });
    }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", STATE_DATABASE_URL: "", REDIS_URL: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 800)); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);

const PATH = "/api/hash";
let nonce = 0, accepted = null;
const credential = (payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7000 + ++nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const buy = (payer) => fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${payer}`, "payment-signature": credential(wallet(payer)) }, body: JSON.stringify({ text: "hello" }) });

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* booting */ } await sleep(500); }
  const r0 = await fetch(`${B}${PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
  const req402 = JSON.parse(Buffer.from(r0.headers.get("payment-required"), "base64").toString("utf8"));
  accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(r0.status === 402 && !!accepted, "the route offers exact on Base");

  // Control: settled 200, receipt untouched.
  fac.mode = "ok";
  const c = await buy(1);
  const cr = dec(c.headers.get("payment-response"));
  ok(c.status === 200 && cr?.success === true && /^0x0+1$/.test(cr.transaction || ""), `control: a settled 200 keeps its receipt (${JSON.stringify(cr)})`);

  fac.mode = "html";
  const h = await buy(2);
  const hb = await h.text();
  const hr = dec(h.headers.get("payment-response"));
  ok(h.status === 402 && hr?.success === false && hr.errorReason === "settlement_failed" && hr.errorMessage === GENERIC_SETTLE_FAILURE_MESSAGE,
    `a settle answered with an HTML 500: the header carries the code and the fixed message (${JSON.stringify(hr)})`);
  ok(!JSON.stringify(hr).includes(RAW_MARK) && !hb.includes(RAW_MARK), "...and neither the header nor the body carries the facilitator's page");
  await sleep(200);
  ok(serverLog.some((l) => l.includes("[settle-failure]") && l.includes(RAW_MARK)), "...while the raw text is in the server log");

  fac.mode = "code";
  const k = await buy(3);
  const kb = await k.text();
  const kr = dec(k.headers.get("payment-response"));
  ok(k.status === 402 && kr?.errorReason === "invalid_exact_evm_payload_signature" && !JSON.stringify(kr).includes(MSG_MARK) && !kb.includes(MSG_MARK),
    `a coded refusal keeps its code and drops the raw message (${JSON.stringify(kr)})`);

  fac.mode = "billing";
  const q = await buy(4);
  const qb = await q.json().catch(() => ({}));
  const qr = dec(q.headers.get("payment-response"));
  ok(q.status === 402 && qr?.errorReason === "settlement_failed" && /out of mainnet settlement funds/i.test(qr.errorMessage || "") && !JSON.stringify(qr).includes(MSG_MARK) && !JSON.stringify(qb).includes(MSG_MARK),
    `a billing refusal keeps only the matched phrase (${JSON.stringify(qr)})`);
  ok(JSON.stringify(qb).includes("facilitator-quota"), `...so the 402 still explains it as this server's facilitator quota (${JSON.stringify(qb).slice(0, 200)})`);
} finally {
  proc?.kill("SIGKILL");
  facilitator?.close();
}
if (fail) for (const l of serverLog.slice(-20)) console.error("  server:", l);
console.log(`\ntest-settle-failure-header: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
