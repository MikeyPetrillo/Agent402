#!/usr/bin/env node
// The daily canary's order of calls on the real request path, with the state
// database on: a booted paid server, a stub facilitator, and the stock x402
// client. The buyer pays for /api/hash, reads the settle transaction from the
// receipt header, and at once asks /api/attest for that transaction. The sale
// is booked on the final response and its Postgres write is queued, so the
// attest call can arrive before the row is readable; here the write is held
// by a table lock (inserts wait, reads pass) until the attest call is in.
//
//   - the buyer is not answered "no sale of yours" while the write is queued;
//   - once it lands the lookup finds the buyer's sale (this boot holds no
//     attesting wallet, so the answer is the 503 that names it: reached only
//     after the sale was found and its payer matched);
//   - another wallet asking for the same transaction is refused 403.
// No request leaves the machine.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-attest-after-buy-pg.js
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { requireTestPg } from "./lib/test-pg.js";
import { bootServer } from "./lib/boot-server.js";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
const { url, schema } = requireTestPg({ label: "test-attest-after-buy-pg" });

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`NOT OK - ${m}`); } };

const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* not a payment body */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, auth ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" });
    if (req.url === "/settle") return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(String(auth?.nonce)).digest("hex"), network: "eip155:8453", payer });
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

const locker = new pg.Client({ connectionString: url });
async function until(test, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const insertWaiting = async () => (await locker.query(
  "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relname = 'sales' AND NOT l.granted", [schema])).rows[0].n > 0;
const txOf = (r) => { try { return JSON.parse(Buffer.from(r.headers.get("payment-response") || r.headers.get("x-payment-response") || "", "base64").toString("utf8")).transaction || null; } catch { return null; } };
const payer = (account) => {
  const client = disableVendorSpendControls(new x402Client());
  registerExactEvmScheme(client, { signer: account });
  return wrapFetchWithPayment(fetch, client);
};
const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let srv = null, locked = false;
try {
  await locker.connect();
  srv = await bootServer({
    stores: "attest-after-buy",
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
      // The state database on (after the own stores, which turn it off), in
      // this run's own schema; no attesting wallet.
      REDIS_URL: "", STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, DATABASE_URL: "", ANALYTICS_DATABASE_URL: "",
      X402_UPSTREAM_BUYER_KEY: "",
      OPENROUTER_API_KEY: "", OPENROUTER_MANAGEMENT_KEY: "", OPENAI_API_KEY: "",
      FIRST_CALL_ALLOWANCE: "", TRIAL_MODE: "",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
      FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true", NODE_ENV: "test",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
    },
  });
  const B = srv.url;
  const buyer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const tableThere = await until(async () => (await locker.query("SELECT to_regclass($1) AS t", [`"${schema}".sales`])).rows[0].t !== null);
  ok(tableThere, "the booted server's sales table is in this run's schema");

  // Inserts into the sales table wait from here; reads pass.
  await locker.query("BEGIN");
  await locker.query(`LOCK TABLE "${schema}".sales IN SHARE MODE`);
  locked = true;

  const bought = await payer(buyer)(`${B}/api/hash`, post({ text: "hello world" }));
  const hash = await bought.json().catch(() => ({}));
  const tx = txOf(bought);
  ok(bought.status === 200 && String(hash.hex || "").startsWith("b94d27b9") && /^0x[0-9a-f]{64}$/.test(tx || ""), `the buyer's /api/hash call settled and its receipt carries a transaction (HTTP ${bought.status})`);

  // The canary's next call: attest that transaction, at once.
  let answered = null;
  const attest = payer(buyer)(`${B}/api/attest`, post({ tx })).then(async (r) => (answered = { status: r.status, receipt: r.headers.get("payment-response") || r.headers.get("x-payment-response"), body: await r.json().catch(() => ({})) }));
  attest.catch(() => {});
  ok(await until(insertWaiting), "the sale's insert is waiting in Postgres");
  // The attest call has passed the paywall once the server holds its payment in flight; an answer that does not wait arrives well inside this.
  await until(() => answered !== null, 1500);
  ok(answered === null, `the buyer is not answered while the sale's write is queued (answered: ${JSON.stringify(answered && { status: answered.status, error: String(answered.body?.error || "").slice(0, 60) })})`);
  await locker.query("COMMIT"); locked = false;
  const a = await attest.catch((e) => ({ status: 0, body: { error: String(e?.message || e) } }));
  ok(a.status !== 403 && !/No sale of yours/.test(String(a.body?.error || "")), `the buyer is not refused its own sale (HTTP ${a.status})`);
  ok(a.status === 503 && /spending wallet/.test(String(a.body?.error || "")), `the lookup found the buyer's sale: the answer is the one past the payer check on a boot with no attesting wallet (HTTP ${a.status} ${String(a.body?.error || "").slice(0, 70)})`);
  ok(!a.receipt, "the unserved attest call carries no settle receipt");

  // Control: the same transaction, asked by another wallet, with the row landed.
  const o = await payer(other)(`${B}/api/attest`, post({ tx }));
  const ob = await o.json().catch(() => ({}));
  ok(o.status === 403 && /No sale of yours/.test(String(ob.error || "")), `another wallet is refused the buyer's sale (HTTP ${o.status})`);
  ok(await until(() => /\[attest\] refused \(other_payer\)/.test(srv.log())), "the server log names the refusing check");
  ok(!srv.log().includes(other.address) && !srv.log().toLowerCase().includes(`payer=${other.address.toLowerCase()}`), "the refusal line carries no full address");
} catch (e) {
  failed++; console.error("NOT OK - threw:", e?.stack || e, srv ? `\nserver log tail:\n${srv.log().slice(-1500)}` : "");
} finally {
  if (locked) await locker.query("ROLLBACK").catch(() => {});
  if (srv) await srv.stop();
  await locker.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await locker.end().catch(() => {});
  await new Promise((r) => facilitator.close(r));
}
console.log(`\ntest-attest-after-buy-pg: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
