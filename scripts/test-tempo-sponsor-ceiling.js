// The Tempo subscription sponsor's own 24 h ceiling (src/tempo-sponsor-ceiling.js),
// proven on the caller path: the subscription engine's real viem clients send
// locally signed, fee-sponsored transactions to a stub RPC on port 0, and a
// send past the ceiling never reaches that RPC. Offline; nothing is broadcast.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Transaction } from "viem/tempo";
import {
  sponsorCeilingLimits, sponsoredFeeBound, admitSponsoredSend, sponsorCeilingWord, _resetSponsorCeiling,
  SPONSOR_DAILY_MAX_TX_DEFAULT, SPONSOR_DAILY_MAX_USD_DEFAULT,
} from "../src/tempo-sponsor-ceiling.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Knobs: defaults, and a malformed value never lifts the ceiling.
{
  const d = sponsorCeilingLimits({});
  ok(d.maxTx === SPONSOR_DAILY_MAX_TX_DEFAULT && d.maxUsd === SPONSOR_DAILY_MAX_USD_DEFAULT, "defaults apply with no knob set");
  const bad = sponsorCeilingLimits({ MPP_SUB_SPONSOR_DAILY_MAX_TX: "lots", MPP_SUB_SPONSOR_DAILY_MAX_USD: "-5" });
  ok(bad.maxTx === SPONSOR_DAILY_MAX_TX_DEFAULT && bad.maxUsd === SPONSOR_DAILY_MAX_USD_DEFAULT, "a malformed or negative knob keeps the default");
  const set = sponsorCeilingLimits({ MPP_SUB_SPONSOR_DAILY_MAX_TX: "7", MPP_SUB_SPONSOR_DAILY_MAX_USD: "0.5" });
  ok(set.maxTx === 7 && set.maxUsd === 0.5, "the knobs are read");
}

const sender = privateKeyToAccount(generatePrivateKey());
const sponsor = privateKeyToAccount(generatePrivateKey());
let nonce = 0;
async function signed({ sponsored = true, gas = 100_000n, maxFeePerGas = 20_000_000_000n } = {}) {
  const tx = {
    type: "tempo", chainId: 4217, nonce: nonce++, nonceKey: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 1n,
    calls: [{ to: "0x20C000000000000000000000b9537d11c60E8b50", data: "0x" }],
    ...(sponsored ? { feePayer: sponsor } : {}),
  };
  return sender.signTransaction(tx, { serializer: Transaction.serialize });
}

// The fee bound is read from the bytes: gas x maxFeePerGas in attodollars.
{
  const raw = await signed({ gas: 100_000n, maxFeePerGas: 20_000_000_000n }); // 2e15 atto = $0.002
  const b = sponsoredFeeBound(raw);
  ok(b && b.sponsored === true, "a fee-payer-signed transaction reads as sponsored");
  ok(b.feeMicroUsd === 2000, `the fee bound is gas x maxFeePerGas in micro-dollars (got ${b.feeMicroUsd})`);
  const plain = sponsoredFeeBound(await signed({ sponsored: false }));
  ok(plain && plain.sponsored === false, "a transaction with no fee-payer signature is not sponsored");
  ok(sponsoredFeeBound("0xzz") === null && sponsoredFeeBound(null) === null, "undecodable input is null, not a throw");
}

// The caller path: the engine's own clients, a stub RPC that records sends.
const tmp = mkdtempSync(join(tmpdir(), "a402-sponsor-ceiling-"));
const received = [];
const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const j = JSON.parse(body);
    received.push(j.method);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: "0x" + "ab".repeat(32) }));
  });
});
await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
process.env.TEMPO_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.MPP_SECRET_KEY = "test-mpp-secret";
process.env.TEMPO_RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32);
process.env.MPP_SUB_SPONSOR_DAILY_MAX_TX = "2";
process.env.MPP_SUB_SPONSOR_DAILY_MAX_USD = "1";

const { createMppSubscriptions, isTransientChargeError, isSendPhaseAmbiguity, subscriptionFeePayerStatus } = await import("../src/mpp-subscriptions.js");
const logs = [];
const engine = createMppSubscriptions({ secretKey: "test-mpp-secret", realm: "agent402.test", storePath: join(tmp, "subs.json"), log: (l) => logs.push(String(l)) });
ok(engine, "the engine starts");
const renewal = await engine._renewalClient();
const activation = await engine._client();

try {
  await _resetSponsorCeiling();
  ok(await sponsorCeilingWord() === "ok", "the word reads ok on an empty window");
  const a = await signed();
  await renewal.request({ method: "eth_sendRawTransactionSync", params: [a] });
  await renewal.request({ method: "eth_sendRawTransactionSync", params: [a] });
  ok(received.length === 2, "a retried send of the same transaction is one entry and goes through");
  await activation.request({ method: "eth_sendRawTransaction", params: [await signed()] });
  ok(received.length === 3, "the activation client's send is admitted under the ceiling");
  ok(await sponsorCeilingWord() === "reached", "the word reads reached at the count ceiling");

  let err = null;
  try { await renewal.request({ method: "eth_sendRawTransactionSync", params: [await signed()] }); } catch (e) { err = e; }
  ok(err, "a renewal send past the count ceiling is refused");
  ok(received.length === 3, "the refused send never reached the RPC");
  ok(/MPP_SUB_SPONSOR_DAILY_MAX_TX/.test(String(err?.details || err?.message)), "the refusal names the knob that bounds it");
  ok(logs.some((l) => /sponsor ceiling \(MPP_SUB_SPONSOR_DAILY_MAX_TX\)/.test(l)), "a log line names the cause");
  ok(!isTransientChargeError(err) && !isSendPhaseAmbiguity(err), "the refusal is a definite pre-send failure, never a send-phase ambiguity");

  let err2 = null;
  try { await activation.request({ method: "eth_sendRawTransactionSync", params: [await signed()] }); } catch (e) { err2 = e; }
  ok(err2 && received.length === 3, "an activation send past the ceiling is refused before the RPC too");
  const st = await subscriptionFeePayerStatus();
  ok(st.ceiling === "reached", "subscriptionFeePayer on /api/gateway-status carries the ceiling word");
  received.length = 3; // the status read's eth_call is not a send

  await activation.request({ method: "eth_sendRawTransactionSync", params: [await signed({ sponsored: false })] });
  ok(received.length === 4, "an unsponsored transaction is not ours to bound");
  await renewal.request({ method: "eth_chainId", params: [] });
  ok(received.length === 5, "reads pass straight through");

  // The fee ceiling, on its own: $1 a day, each send bounded at $0.60.
  await _resetSponsorCeiling();
  process.env.MPP_SUB_SPONSOR_DAILY_MAX_TX = "100";
  const dear = { gas: 600_000n, maxFeePerGas: 1_000_000_000_000n }; // 6e17 atto = $0.60
  await renewal.request({ method: "eth_sendRawTransactionSync", params: [await signed(dear)] });
  ok(received.length === 6, "a send inside the fee ceiling goes through");
  let err3 = null;
  try { await renewal.request({ method: "eth_sendRawTransactionSync", params: [await signed(dear)] }); } catch (e) { err3 = e; }
  ok(err3 && received.length === 6 && /MPP_SUB_SPONSOR_DAILY_MAX_USD/.test(String(err3?.details || err3?.message)), "a send that would pass the 24 h fee ceiling is refused by name");

  ok(logs.filter((l) => /MPP_SUB_SPONSOR_DAILY_MAX_USD/.test(l)).length === 1, "one refusal is one attempt: the refused send is not retried by the transport");
  // The refused send left nothing behind: a cheaper one that fits still goes.
  await renewal.request({ method: "eth_sendRawTransactionSync", params: [await signed({ gas: 300_000n, maxFeePerGas: 1_000_000_000_000n })] }); // $0.30
  ok(received.length === 7, "a refused send is taken back out of the window, so a send that fits is admitted");

  // The window rolls over 24 h: inside it the budget stays spent, a day later it is open.
  let inside = null;
  try { await admitSponsoredSend(await signed(dear), { now: Date.now() + 23 * 3_600_000, log: () => {} }); } catch (e) { inside = e; }
  ok(inside?.sponsorCeiling === true, "entries younger than 24 h still count");
  const r = await admitSponsoredSend(await signed(dear), { now: Date.now() + 24 * 3_600_000 + 60_000, log: () => {} });
  ok(r.admitted === true, "the window is rolling: entries older than 24 h no longer count");
} finally {
  rpc.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} checks passed`);
process.exit(0);
