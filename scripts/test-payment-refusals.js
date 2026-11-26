// The payment refusal record (src/payment-refusals.js), in file mode, then
// through the REAL paid server against a stub facilitator:
//
//   - a refused payment writes one record; the payer is kept only when the
//     payment verified on that request (a settle that failed after verify),
//     never the address an unverified header names (a bad signature, a
//     verify that found no funds);
//   - repeats inside a day add to one row's count; a base58 payer is kept
//     exactly, never case-folded;
//   - a flood of distinct refusals opens at most the day's row cap, the rest
//     counted in the overflow row, every refusal counted once;
//   - the retention pass removes rows past 90 days (dry run counts only);
//   - a 402 without a credential, a 400 and a 200 write nothing; a 429 is
//     recorded only when a gate marked it;
//   - /__operator/refusals.json answers 404 without the token, and filters
//     by payer, slug, reason and since, with a per-day count by reason.
//
//   node scripts/test-payment-refusals.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const TMP = mkdtempSync(join(tmpdir(), "payment-refusals-"));
process.env.PAYMENT_REFUSALS_FILE = join(TMP, "unit", "refusals.json");

const PR = await import("../src/payment-refusals.js");
const { stashVerifiedPayment } = await import("../src/verified-payment.js");
const { markPaymentRefusal } = await import("../src/refusal-mark.js");
const { hadCredential } = await import("../src/funnel.js");
const fileRows = () => { const f = process.env.PAYMENT_REFUSALS_FILE; return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).rows : []; };

// ---------------------------------------------------------------------------
// 1. The module, in file mode.
const EVM_A = "0x" + "Ab".repeat(20);
const fakeReq = (headers = {}) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
const fakeRes = (statusCode) => {
  const res = { statusCode, json(body) { return body; } };
  PR.watchRefusalBody(res);
  return res;
};
const x402Header = (from) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x" + "11".repeat(65), authorization: { from, nonce: "0x01" } } });
{
  const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
  // An unverified header naming a payer: the payer is never kept.
  const req = fakeReq({ "payment-signature": x402Header(EVM_A) });
  req.__paymentRejectReason = "unclassified";
  const res = fakeRes(402);
  const r = PR.refusalOfResponse(req, res, { hadCredential, slug: "hash", amountUsd: 0.001 });
  ok(r && r.payer === null && r.rail === "x402" && r.reason === "unclassified", `an unverified payment's refusal names no payer (${JSON.stringify(r)})`);
  PR.recordPaymentRefusal(r, { now: T0 });
  // The same payment verified, then refused at settlement: the verified payer is kept.
  const vreq = fakeReq({ "payment-signature": x402Header(EVM_A) });
  stashVerifiedPayment(vreq, { payer: EVM_A, paymentPayload: {} });
  const vres = fakeRes(402);
  vres.json({ error: "insufficient_funds" });
  const vr = PR.refusalOfResponse(vreq, vres, { hadCredential, slug: "hash", amountUsd: 0.001 });
  ok(vr && vr.payer === EVM_A.toLowerCase() && vr.reason === "insufficient_funds", `a verified payment's refusal keeps the verified payer, and the body's code is its reason (${JSON.stringify(vr)})`);
  for (let i = 0; i < 3; i++) PR.recordPaymentRefusal(vr, { now: T0 + i * 1000 });
  await PR.flushPaymentRefusals();
  const rows = fileRows();
  const proven = rows.filter((x) => x.payer === EVM_A.toLowerCase());
  ok(rows.length === 2 && proven.length === 1 && proven[0].count === 3 && proven[0].firstAt < proven[0].lastAt, `repeats inside a day are one row with a count (rows ${rows.length}, count ${proven[0]?.count})`);
  ok(!JSON.stringify(rows.filter((x) => x.payer !== EVM_A.toLowerCase())).toLowerCase().includes(EVM_A.slice(2).toLowerCase()), "the unverified payer's address appears nowhere in the stored rows");
  ok(!JSON.stringify(rows).includes("signature") && rows.every((x) => !("ip" in x) && !("body" in x)), "no signature, address or body field is stored");
  // A base58 payer is kept exactly.
  const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  PR.recordPaymentRefusal({ slug: "hash", rail: "x402", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", reason: "settlement_failed", payer: SOL }, { now: T0 });
  await PR.flushPaymentRefusals();
  ok(fileRows().some((x) => x.payer === SOL), "a base58 payer is stored exactly as verified (not case-folded)");

  // What is not a refusal.
  const none = (h, st, mark) => { const q = fakeReq(h); if (mark) markPaymentRefusal(q, mark); return PR.refusalOfResponse(q, fakeRes(st), { hadCredential }); };
  ok(none({}, 402) === null, "a 402 without a credential (a first-contact quote) is not a refusal");
  ok(none({ "payment-signature": x402Header(EVM_A) }, 400) === null && none({ "payment-signature": x402Header(EVM_A) }, 200) === null, "a 400 and a 200 with a credential are not refusals");
  ok(none({ "payment-signature": x402Header(EVM_A) }, 429) === null, "an unmarked 429 is not a refusal");
  const marked = none({ "payment-signature": x402Header(EVM_A) }, 429, "settle-breaker-wallet");
  ok(marked?.reason === "settle-breaker-wallet" && marked.status === 429 && marked.payer === null, `a 429 the breaker marked is one, with its code (${JSON.stringify(marked)})`);
  const credits = none({ authorization: "Bearer a402_" + "x".repeat(20) }, 402);
  ok(credits?.rail === "credits" && credits.payer === null, `a credits key's refusal names the credits rail and no payer (${credits?.rail})`);

  // The cap under a flood of distinct refusals (each a distinct proven payer).
  PR.__resetPaymentRefusalsForTests();
  PR.__setPaymentRefusalLimitsForTests({ keysPerDay: 50 });
  const day = Date.UTC(2026, 10, 21, 1, 0, 0);
  for (let i = 0; i < 5000; i++) PR.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: i % 2 ? "insufficient_funds" : "invalid_payload", payer: "0x" + i.toString(16).padStart(40, "0") }, { now: day + i });
  await PR.flushPaymentRefusals();
  const dayRows = fileRows().filter((x) => x.day === "2026-11-21");
  const overflow = dayRows.find((x) => x.overflow);
  const total = dayRows.reduce((t, x) => t + x.count, 0);
  ok(dayRows.length === 51 && overflow?.count === 4950 && total === 5000, `a flood of 5000 distinct refusals opens 50 rows and one overflow row, every refusal counted once (rows ${dayRows.length}, overflow ${overflow?.count}, total ${total})`);
  ok(overflow && !("payer" in overflow) && !("slug" in overflow) && overflow.byReason.insufficient_funds + overflow.byReason.invalid_payload === 4950, `the overflow row keeps a count by reason and no payer or slug (${JSON.stringify(overflow?.byReason)})`);
  // The view's summary counts the overflow by reason.
  const v = await PR.paymentRefusalsView(PR.refusalFiltersOf({ since: "2026-11-21" }, { now: day }), { limit: 10 });
  ok(v.matched === 51 && v.returned === 10 && v.summary[0]?.total === 5000 && v.summary[0].byReason.invalid_payload === 2500, `the view pages the rows and sums the day by reason (${JSON.stringify(v.summary[0])})`);

  // Retention: rows past 90 days go; dry run counts only.
  PR.__resetPaymentRefusalsForTests();
  const now = Date.UTC(2026, 10, 26, 12);
  PR.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: "old" }, { now: now - 100 * 86_400_000 });
  PR.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: "recent" }, { now: now - 10 * 86_400_000 });
  await PR.flushPaymentRefusals();
  const before = fileRows().length;
  const dry = await PR.prunePaymentRefusals({ now });
  const wet = await PR.prunePaymentRefusals({ now, apply: true });
  const after = fileRows();
  ok(dry.due >= 1 && dry.removed === 0 && wet.removed === dry.due && after.length === before - wet.removed && after.some((x) => x.reason === "recent") && !after.some((x) => x.reason === "old"), `the retention pass removes rows past 90 days only, dry run first (due ${dry.due}, removed ${wet.removed})`);
  const LR = await import("../src/ledger-retention.js");
  PR.recordPaymentRefusal({ slug: "hash", rail: "x402", reason: "old" }, { now: now - 100 * 86_400_000 });
  const pass1 = await LR.runLedgerRetention({ now, env: {}, log: () => {} });
  ok(pass1.apply === false && pass1.parts.refusals?.removed >= 1 && !fileRows().some((x) => x.reason === "old"), `the daily pass deletes old refusal rows even while the ledgers' pass is a dry run (${JSON.stringify(pass1.parts.refusals)})`);
  PR.__resetPaymentRefusalsForTests();
}

// ---------------------------------------------------------------------------
// 2. The real paid server.
const OP = "refusals-test-operator-token-0123456789abcdef";
const BAD_SIG = "0x" + "b1".repeat(20), NO_FUNDS = "0x" + "b2".repeat(20), SETTLE_FAILS = "0x" + "b3".repeat(20), CLEAN = "0x" + "c1".repeat(20);
const fac = { settle: {} };
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      return reply({ jsonrpc: "2.0", id: rpc.id ?? 1, result: "0x" + "0".repeat(64) });
    }
    if (req.url === "/SDN.XML") return reply({}, 503);
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const payer = String(p.paymentPayload?.payload?.authorization?.from || "").toLowerCase();
    if (req.url === "/verify") {
      if (payer === BAD_SIG) return reply({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer });
      if (payer === NO_FUNDS) return reply({ isValid: false, invalidReason: "insufficient_funds", payer });
      return reply({ isValid: true, payer });
    }
    if (req.url === "/settle") {
      fac.settle[payer] = (fac.settle[payer] || 0) + 1;
      if (payer === SETTLE_FAILS) return reply({ success: false, errorReason: "invalid_exact_evm_payload_authorization_nonce", transaction: "", network: "eip155:8453", payer });
      return reply({ success: true, transaction: `0x${String(Object.values(fac.settle).reduce((a, n) => a + n, 0)).padStart(64, "0")}`, network: "eip155:8453", payer });
    }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
let srv = null;
const STORES = ownStoreEnv("payment-refusals");
setTimeout(() => { console.error("FAIL - timed out"); try { for (const l of srv?.log().split("\n").slice(-25) || []) console.error("  server:", l); } catch { /* none */ } srv?.child?.kill("SIGKILL"); process.exit(1); }, 150_000).unref();
try {
  srv = await bootServer({ stores: false, timeoutMs: 90_000, env: {
    ...STORES, TRUST_PROXY_HOPS: "1", FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", TEMPO_RELAY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", AGENT402_OPERATOR_TOKEN: OP,
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    SANCTIONS_LIST_URL: `${FAC}/SDN.XML`, LEDGER_RETENTION: "off",
  } });
  const B = srv.url;
  const BODY = JSON.stringify({ text: "hello" });
  const quote = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
  const pr = quote.headers.get("payment-required");
  const accepted = pr ? (JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts || []).find((x) => x.network === "eip155:8453" && x.scheme === "exact") : null;
  ok(quote.status === 402 && accepted, `the route quotes a Base exact payment (${quote.status})`);
  let nonce = 0;
  const pay = async (from) => {
    const n = "0x" + (0x9000 + ++nonce).toString(16).padStart(64, "0");
    const cred = b64({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: n } } });
    const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred }, body: BODY });
    await r.text();
    return r.status;
  };
  const codes = [await pay(BAD_SIG), await pay(NO_FUNDS), await pay(SETTLE_FAILS), await pay(SETTLE_FAILS), await pay(CLEAN)];
  ok(codes.slice(0, 4).every((c) => c === 402) && codes[4] === 200, `three kinds of refused payment answer 402, the clean control 200 (${codes.join(",")})`);
  const read = async (qs = "", token = OP) => {
    const r = await fetch(`${B}/__operator/refusals.json${qs}`, token ? { headers: { "X-Operator-Token": token } } : {});
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, cc: r.headers.get("cache-control"), j };
  };
  const anon = await read("", null);
  const wrong = await read("", "not-the-token");
  ok(anon.status === 404 && wrong.status === 404, `the operator route answers 404 without the token (${anon.status}, ${wrong.status})`);
  const all = await read();
  const rows = all.j?.rows || [];
  ok(all.status === 200 && /private/.test(all.cc || "") && /no-store/.test(all.cc || ""), `with the token it answers, private and no-store (${all.status}, ${all.cc})`);
  const proven = rows.filter((x) => x.payer);
  ok(rows.length === 3 && rows.every((x) => x.slug === "hash" && x.rail === "x402" && x.network === "eip155:8453" && x.status === 402 && x.amountUsd > 0), `the three refusals are three rows on the route, rail and network, with the price quoted (${rows.length}: ${rows.map((x) => `${x.reason}/${x.count}`).join(", ")})`);
  ok(proven.length === 1 && proven[0].payer === SETTLE_FAILS && proven[0].count === 2, `only the payment that verified keeps its payer, and its repeat adds to its count (${JSON.stringify(proven.map((x) => [x.payer, x.count]))})`);
  ok(!JSON.stringify(all.j).includes(BAD_SIG.slice(2)) && !JSON.stringify(all.j).includes(NO_FUNDS.slice(2)) && !JSON.stringify(all.j).includes(CLEAN.slice(2)), "no unverified payer and no served payer appears in the record");
  ok(all.j?.matched === 3 && all.j.returned === 3 && all.j.complete === true, `the answer says it is complete (${all.j?.matched}/${all.j?.returned})`);
  const byPayer = await read(`?payer=${SETTLE_FAILS.toUpperCase().replace("0X", "0x")}`);
  ok(byPayer.j?.rows?.length === 1 && byPayer.j.rows[0].payer === SETTLE_FAILS && byPayer.j.summary.byDay[0]?.total === 2, `the payer filter (an EVM address in any case) finds its row and sums its day (${byPayer.j?.rows?.length})`);
  const reason = proven[0]?.reason;
  ok(reason === "invalid_exact_evm_payload_authorization_nonce", `a settle refused after verify is recorded under the settle receipt's code (${reason})`);
  const byReason = await read(`?reason=${encodeURIComponent(reason || "x")}`);
  ok(byReason.j?.rows?.length === 1 && byReason.j.rows[0].reason === reason, `the reason filter finds the one row with that code (${reason})`);
  const bySlug = await read("?slug=pdf-to-markdown");
  const future = await read("?since=2099-01-01");
  ok(bySlug.j?.matched === 0 && future.j?.matched === 0 && (await read("?slug=hash")).j?.matched === 3, "the slug and since filters exclude what they do not match");
  const bad = await read("?payer=not-an-address");
  const lim = await read("?limit=5000");
  ok(bad.status === 400 && lim.j?.requestedExceededMax === true, `a malformed filter is a 400, and a limit past the maximum says it was clamped (${bad.status})`);
  const today = new Date().toISOString().slice(0, 10);
  const sum = all.j?.summary?.byDay?.find((d) => d.day === today);
  ok(sum && sum.total === 4 && Object.values(sum.byReason).reduce((a, n) => a + n, 0) === 4, `the summary counts today's four refusals by reason (${JSON.stringify(sum)})`);

  // A refusal recorded just before a graceful shutdown (inside the write-behind
  // interval, with no read to flush it) is on disk after the server exits:
  // the shutdown path writes it.
  const STORE_FILE = STORES.PAYMENT_REFUSALS_FILE;
  const countOf = () => { try { return (JSON.parse(readFileSync(STORE_FILE, "utf8")).rows || []).filter((r) => r.reason === "insufficient-funds").reduce((t, r) => t + r.count, 0); } catch { return -1; } };
  const before = countOf();
  const last = await pay(NO_FUNDS);
  await srv.stop();
  const exited = srv.exited();
  srv = null;
  ok(before === 1 && last === 402 && countOf() === 2, `a refusal made just before a graceful shutdown is written by the shutdown path (on disk ${before}, then ${countOf()} after exit ${JSON.stringify(exited)})`);
} finally {
  if (srv) await srv.stop();
  facilitator.close();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
