// The returning-wallet price end to end in paid mode (src/returning-wallet.js)
// against a stub facilitator that records every verify and settle with the
// requirement it was asked to check:
//   - switch off: a hint changes nothing and the 402 names no offer;
//   - switch on: a wallet with a paid day is quoted the discount on the same
//     call that carries its hint, pays it, and the facilitator is asked to
//     verify and settle the discounted amount FROM that wallet; the sale is
//     booked at what moved;
//   - the hint is a claim: another wallet paying the discounted quote under
//     the first wallet's hint is answered 402 at list price, and the
//     facilitator is never asked (nothing verified, nothing settled);
//   - a wallet that does not qualify, a request with no hint, a malformed
//     hint and a route sold on the referral routes are quoted list;
//   - one client address naming unused wallets (600 unpaid requests inside a
//     minute) spends its own share of the ledger reads: a qualifying wallet
//     from another address is still quoted its price;
//   - on a chain whose price floor holds the quote at list, the 402 does not
//     say the discount was applied, and the call settles at that amount.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_TOKEN = "returning-wallet-test-operator-token-0123";
const RUN = randomBytes(8).toString("hex");
const wallet = (n) => "0x" + RUN + n.toString(16).padStart(24, "0");
const HINT = "x-agent402-wallet";

// ---- stub facilitator ----
const verifies = [], settlesSeen = [];
const settledNonces = new Set();
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let p = {}; try { p = JSON.parse(body || "{}"); } catch { /* ignore */ }
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: p.id ?? 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
    const auth = p?.paymentPayload?.payload?.authorization || null;
    const seen = { from: String(auth?.from || "").toLowerCase(), value: String(auth?.value || ""), required: String(p?.paymentRequirements?.amount ?? p?.paymentRequirements?.maxAmountRequired ?? "") };
    if (req.url === "/verify") { verifies.push(seen); return reply({ isValid: true, payer: auth?.from }); }
    if (req.url === "/settle") {
      settlesSeen.push(seen);
      const nonce = String(auth?.nonce || "").toLowerCase();
      if (settledNonces.has(nonce)) return reply({ success: false, errorReason: "nonce already used", transaction: "", network: "eip155:8453", payer: auth?.from });
      settledNonces.add(nonce);
      return reply({ success: true, transaction: "0x" + createHash("sha256").update(nonce).digest("hex"), network: "eip155:8453", payer: auth?.from });
    }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

const boot = async (label, extra) => {
  const srv = await bootRaw(label, extra);
  // The paywall answers once the facilitator handshake has landed.
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${srv.url}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello world" }) }).catch(() => null);
    if (r?.status === 402) return srv;
    await sleep(250);
  }
  await srv.stop();
  throw new Error("the server did not come up with a paywall");
};
const bootRaw = (label, extra) => bootServer({
  stores: label, readyPath: "/health",
  env: {
    FREE_MODE: "", NODE_ENV: "test", TRUST_PROXY_HOPS: "1",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
    MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
    REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
    STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
    HANGUP_FORGIVE_FILE: "off", FIRST_CALL_ALLOWANCE: "", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
    AGENT402_OPERATOR_TOKEN: OP_TOKEN,
    ...extra,
  },
});

const ROUTES = {
  hash: { path: "/api/hash", method: "POST", body: JSON.stringify({ text: "hello world" }) },
  base64: { path: "/api/base64", method: "POST", body: JSON.stringify({ text: "hi", mode: "encode" }) },
};
async function quote(B, route, hint, from = null) {
  const rt = ROUTES[route];
  const r = await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", ...(hint ? { [HINT]: hint } : {}), ...(from ? { "x-forwarded-for": from } : {}) }, body: rt.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf-8") || "{}");
  const accept = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  return { status: r.status, accept, json };
}
const credential = (accept, from) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
async function pay(B, route, accept, from, hint) {
  const rt = ROUTES[route];
  const r = await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", "payment-signature": credential(accept, from), ...(hint ? { [HINT]: hint } : {}) }, body: rt.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  let again = null;
  try { again = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf-8") || "{}"); } catch { again = null; }
  return { status: r.status, json, headers: r.headers, requote: (again?.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact") || null };
}
const waitFor = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(150); } };

const W1 = wallet(0xa1), W2 = wallet(0xa2), W3 = wallet(0xa3), W4 = wallet(0xa4), W5 = wallet(0xa5);
const operator = (B) => fetch(`${B}/__operator/returning-wallets.json`, { headers: { "X-Operator-Token": OP_TOKEN, Authorization: `Bearer ${OP_TOKEN}` } }).then((r) => r.json());
let off = null, on = null, floor = null;
try {
  // ---------------- switch off ----------------
  off = await boot("returning-wallet-off", { RETURNING_WALLET_PRICE: "" });
  {
    const plain = await quote(off.url, "hash", null);
    const hinted = await quote(off.url, "hash", W1);
    ok(plain.status === 402 && plain.accept?.amount === "1000" && hinted.accept?.amount === "1000", `off: a hint changes no quote (${plain.accept?.amount} / ${hinted.accept?.amount})`);
    ok(hinted.json && hinted.json.returningWalletPrice === undefined, "off: the 402 names no offer");
    const llmsOff = (await fetch(`${off.url}/llms.txt`).then((r) => r.text())) + (await fetch(`${off.url}/llms-full.txt`).then((r) => r.text()));
    const apiOff = await fetch(`${off.url}/openapi.json`).then((r) => r.json());
    const wk = await fetch(`${off.url}/.well-known/x402`).then((r) => r.text());
    ok(!/X-Agent402-Wallet/.test(llmsOff) && !/X-Agent402-Wallet/.test(JSON.stringify(apiOff)) && !/X-Agent402-Wallet/.test(wk), "off: the llms documents, the OpenAPI document and the service manifest never name the header");
    ok(!/X-Agent402-Wallet/.test(await fetch(`${off.url}/privacy`).then((r) => r.text())), "off: /privacy does not name it either");
    const paid = await pay(off.url, "hash", plain.accept, W1, W1);
    ok(paid.status === 200 && settlesSeen.at(-1)?.value === "1000", `off: the call settles at list (${paid.status}, ${settlesSeen.at(-1)?.value})`);
  }
  await off.stop(); off = null;

  // ---------------- switch on: one paid day qualifies ----------------
  on = await boot("returning-wallet-on", { RETURNING_WALLET_PRICE: "on", RETURNING_WALLET_MIN_PAID_DAYS: "1", REFERRAL_SLUGS: "base64" });
  const B = on.url;
  {
    const fresh = await quote(B, "hash", W1);
    ok(fresh.accept?.amount === "1000" && fresh.json?.returningWalletPrice?.applied === false && fresh.json.returningWalletPrice.header === "X-Agent402-Wallet" && fresh.json.returningWalletPrice.discountPercent === 10,
      `a wallet with no paid day is quoted list, and the 402 states the offer (${fresh.accept?.amount}, ${JSON.stringify(fresh.json?.returningWalletPrice && { applied: fresh.json.returningWalletPrice.applied, pct: fresh.json.returningWalletPrice.discountPercent })})`);
    const none = await quote(B, "hash", null);
    ok(none.accept?.amount === "1000" && none.json?.returningWalletPrice?.applied === false, "no hint: list");
    ok((await quote(B, "hash", "0x1234")).accept?.amount === "1000" && (await quote(B, "hash", "not-a-wallet")).accept?.amount === "1000", "a malformed hint: list");
    // W3 buys once at list with no hint (so no quote for it is cached yet).
    const first = await pay(B, "hash", none.accept, W3, null);
    ok(first.status === 200 && settlesSeen.at(-1)?.from === W3 && settlesSeen.at(-1)?.value === "1000", `a first purchase settles at list (${first.status})`);
  }
  // The sale lands in the ledger on the response's finish; then W3 qualifies.
  const quoted = await waitFor(async () => { const q = await quote(B, "hash", W3); return q.accept?.amount === "900" ? q : null; });
  ok(!!quoted && quoted.json?.returningWalletPrice?.applied === true, `a wallet with a paid day is quoted 10% under list on the call that carries its hint (${quoted?.accept?.amount})`);
  {
    const v0 = verifies.length, s0 = settlesSeen.length;
    const paid = await pay(B, "hash", quoted.accept, W3, W3);
    ok(paid.status === 200 && paid.json?.hex, `the hinted wallet pays the discounted quote and is served (${paid.status})`);
    ok(verifies.length === v0 + 1 && verifies.at(-1).from === W3 && verifies.at(-1).required === "900" && verifies.at(-1).value === "900", `the facilitator verified the discounted amount from that wallet (${JSON.stringify(verifies.at(-1))})`);
    ok(settlesSeen.length === s0 + 1 && settlesSeen.at(-1).from === W3 && settlesSeen.at(-1).required === "900" && settlesSeen.at(-1).value === "900", `and settled exactly that (${JSON.stringify(settlesSeen.at(-1))})`);
    const sale = await waitFor(async () => {
      const r = await fetch(`${B}/__operator/sales.json?days=1`, { headers: { "X-Operator-Token": OP_TOKEN, Authorization: `Bearer ${OP_TOKEN}` } }).then((x) => x.json()).catch(() => null);
      const text = JSON.stringify(r || {});
      return /0\.0009\b/.test(text) || /0\.0019\b/.test(text) ? text : null;
    });
    ok(!!sale, "the sale is booked at what moved, not at list");
  }
  // ---------------- the hint is a claim ----------------
  {
    const stolen = await quote(B, "hash", W3); // anyone can read W3's quote
    ok(stolen.accept?.amount === "900", "the discounted quote is readable under the hint alone");
    const v0 = verifies.length, s0 = settlesSeen.length;
    const other = await pay(B, "hash", stolen.accept, W2, W3);
    ok(other.status === 402 && verifies.length === v0 && settlesSeen.length === s0, `another wallet paying that quote under the hint is refused 402, and the facilitator is never asked (${other.status}, verifies +${verifies.length - v0}, settles +${settlesSeen.length - s0})`);
    ok(other.requote?.amount === "1000", `the refusal re-quotes list (${other.requote?.amount})`);
    const noHint = await pay(B, "hash", stolen.accept, W3, null);
    ok(noHint.status === 402 && verifies.length === v0 && noHint.requote?.amount === "1000", `the qualifying wallet without its hint is quoted list too (${noHint.status})`);
    const listPaid = await pay(B, "hash", other.requote, W2, W3);
    ok(listPaid.status === 200 && settlesSeen.at(-1).from === W2 && settlesSeen.at(-1).value === "1000", `that other wallet pays list under the same hint and is served (${listPaid.status}, ${settlesSeen.at(-1).value})`);
  }
  // ---------------- never discounted ----------------
  {
    const ref = await quote(B, "base64", W3);
    ok(ref.status === 402 && ref.accept?.amount === "1000" && ref.json?.returningWalletPrice === undefined, `a route sold on the referral routes is quoted list and names no offer (${ref.accept?.amount})`);
    const pricing = await fetch(`${B}/api/pricing`, { headers: { [HINT]: W3 } }).then((r) => r.json());
    const rows = Object.values(pricing).find((v) => Array.isArray(v) && v.some((t) => t?.slug === "hash")) || [];
    const row = rows.find((t) => t.slug === "hash");
    ok(row?.price === "$0.001", `the published price stays list, with or without a hint (${row?.price})`);
    const op = await fetch(`${B}/__operator/returning-wallets.json`, { headers: { "X-Operator-Token": OP_TOKEN, Authorization: `Bearer ${OP_TOKEN}` } }).then((r) => r.json());
    ok(op.enabled === true && op.counts?.paidDiscount === 1 && op.counts?.paidOtherWallet >= 1 && op.returnRate?.payers >= 2, `the operator view counts the discounted payment, the other-wallet attempt and the payers (${JSON.stringify({ counts: op.counts, payers: op.returnRate?.payers })})`);
    // The surfaces that describe paying state the offer while it is on.
    const llms = await fetch(`${B}/llms-full.txt`).then((r) => r.text());
    ok(/Returning wallets pay less: send your wallet address in the `X-Agent402-Wallet` request header/.test(llms) && /on 1 or more days in the last 30/.test(llms) && /quoted 10% under the route's list price on its x402 exact accepts on EVM chains; a chain's premium and price floor still apply/.test(llms), "llms-full.txt states the offer with the settings in force");
    ok(/a payment of the lower amount from any other wallet is answered 402 at the list price, and nothing is charged/.test(llms) && !/any other payer is quoted list/.test(llms), "and says what the gate does with another wallet's payment of the lower amount");
    const short = await fetch(`${B}/llms.txt`).then((r) => r.text());
    ok(!/X-Agent402-Wallet/.test(short), "CONTROL the rule is on llms-full.txt, not on llms.txt");
    const notes = (await fetch(`${B}/changelog`).then((r) => r.text())).replace(/\s+/g, " ");
    ok(/\/llms-full\.txt states the rule/.test(notes) && !/\/llms\.txt states the rule/.test(notes), "the release notes name the document that carries the rule");
    const api = await fetch(`${B}/openapi.json`).then((r) => r.json());
    const headersOf = (path) => (api.paths?.[path]?.post?.parameters || []).filter((p) => p.in === "header").map((p) => p.name);
    ok(headersOf("/api/hash").includes("X-Agent402-Wallet") && !headersOf("/api/base64").includes("X-Agent402-Wallet"), `the OpenAPI document declares the header on an eligible route only (${headersOf("/api/hash").join(", ")} / ${headersOf("/api/base64").join(", ")})`);
    const param = (api.paths?.["/api/hash"]?.post?.parameters || []).find((x) => x.name === "X-Agent402-Wallet");
    ok(/premium and price floor still apply/.test(param?.description || "") && /answered 402 at the list price, and nothing is charged/.test(param?.description || ""), "and its description carries the rule the 402 body no longer spells out");
    const manifest = await fetch(`${B}/.well-known/x402`).then((r) => r.text());
    const KEPT = "read against the sales ledger to decide that request's quote; the address and its count of paid days are held in memory for about 10 minutes and never written to a store";
    ok(/X-Agent402-Wallet request header, when sent/.test(manifest) && manifest.includes(KEPT), "the service manifest's data handling names the header, what it is read for and what is kept");
    const privacy = (await fetch(`${B}/privacy`).then((r) => r.text())).replace(/\s+/g, " ");
    ok(/the wallet address a request names in the <code>X-Agent402-Wallet<\/code> header/.test(privacy) && privacy.includes(KEPT), "/privacy says the same thing in the same words");
    const anon = await fetch(`${B}/__operator/returning-wallets.json`);
    ok(anon.status === 404, "the operator view is not served without the token");
  }
  // ---------------- the 402 body: the offer in fields, small ----------------
  {
    const none = await quote(B, "hash", null);
    const field = none.json?.returningWalletPrice;
    ok(field && field.note === undefined && Buffer.byteLength(JSON.stringify(field)) <= 126 && JSON.stringify(Object.keys(field)) === JSON.stringify(["header", "discountPercent", "minPaidDays", "windowDays", "applied"]), `the 402 states the offer in fields (${JSON.stringify(field)})`);
    const under = await quote(B, "hash", W1);
    ok(under.json?.returningWalletPrice?.applied === false && under.json.returningWalletPrice.why === "unqualified", `a named wallet under the bar is told why its quote is list (${under.json?.returningWalletPrice?.why})`);
    const lowered = await quote(B, "hash", W3);
    ok(lowered.accept?.amount === "900" && lowered.json?.returningWalletPrice?.applied === true && lowered.json.returningWalletPrice.atListOn === undefined, `a lowered quote reads applied, with no chain held at list (${JSON.stringify(lowered.json?.returningWalletPrice)})`);
  }
  // ---------------- one address cannot spend everyone's ledger reads ----------------
  {
    // W5 buys once at list with no hint, so its paid day is on the ledger and nothing about it is cached.
    const before = (await operator(B)).returnRate?.payers ?? 0;
    const list = await quote(B, "hash", null);
    const first = await pay(B, "hash", list.accept, W5, null);
    ok(first.status === 200, `CONTROL a wallet buys once at list (${first.status})`);
    await waitFor(async () => ((await operator(B)).returnRate?.payers ?? 0) > before);
    // The probe: 600 unpaid requests inside a minute from one address, each naming an unused wallet.
    const PROBER = "203.0.113.7", BUYER = "198.51.100.9";
    const held0 = (await operator(B)).counts;
    // Start early in a clock minute, so the whole burst and the buyer's call share it.
    while (Date.now() % 60_000 > 45_000) await sleep(500);
    const t0 = Date.now();
    const statuses = new Map();
    let next = 0;
    const one = async () => { while (next < 600) { const i = next++; const q = await quote(B, "hash", wallet(0x100000 + i), PROBER); const k = `${q.status}:${q.accept?.amount}`; statuses.set(k, (statuses.get(k) || 0) + 1); } };
    await Promise.all(Array.from({ length: 16 }, one));
    const buyer = await quote(B, "hash", W5, BUYER);
    const took = Date.now() - t0;
    ok(statuses.size === 1 && statuses.get("402:1000") === 600, `600 unpaid requests naming unused wallets are each quoted list (${JSON.stringify([...statuses])})`);
    ok(took < 14_000 && buyer.accept?.amount === "900" && buyer.json?.returningWalletPrice?.applied === true, `a qualifying wallet from another address is quoted its price in the same minute (${buyer.accept?.amount}, ${JSON.stringify(buyer.json?.returningWalletPrice)}, ${took} ms)`);
    const held1 = (await operator(B)).counts;
    ok(held1.lookupsHeldAddress - (held0.lookupsHeldAddress || 0) >= 500 && held1.lookupsHeld === (held0.lookupsHeld || 0), `the prober's reads past its share were held for that address alone (${held1.lookupsHeldAddress} held for an address, ${held1.lookupsHeld} service-wide)`);
    const busy = await quote(B, "hash", wallet(0x200000), PROBER);
    ok(busy.accept?.amount === "1000" && busy.json?.returningWalletPrice?.why === "lookup_busy", `and its 402 says so (${busy.json?.returningWalletPrice?.why})`);
  }
  await on.stop(); on = null;

  // ---------------- a chain at its price floor ----------------
  floor = await boot("returning-wallet-floor", { RETURNING_WALLET_PRICE: "on", RETURNING_WALLET_MIN_PAID_DAYS: "1", NETWORK_PRICE_FLOORS: "eip155:8453=0.001" });
  {
    const F = floor.url;
    const before = (await operator(F)).returnRate?.payers ?? 0;
    const list = await quote(F, "hash", null);
    ok(list.accept?.amount === "1000", `CONTROL the floor equals this route's list price (${list.accept?.amount})`);
    const first = await pay(F, "hash", list.accept, W4, null);
    ok(first.status === 200, `a first purchase settles at list (${first.status})`);
    await waitFor(async () => ((await operator(F)).returnRate?.payers ?? 0) > before);
    const q = await quote(F, "hash", W4);
    const field = q.json?.returningWalletPrice;
    ok(q.accept?.amount === "1000" && field?.applied === false && field.why === "price_floor", `a qualifying wallet on a floored chain is quoted the same amount, and the 402 does not say the discount was applied (${q.accept?.amount}, ${JSON.stringify(field)})`);
    const s0 = settlesSeen.length;
    const paid = await pay(F, "hash", q.accept, W4, W4);
    ok(paid.status === 200 && settlesSeen.length === s0 + 1 && settlesSeen.at(-1).from === W4 && settlesSeen.at(-1).value === "1000", `its payment settles at that amount (${paid.status}, ${settlesSeen.at(-1)?.value})`);
    const under = await quote(F, "hash", W1);
    ok(under.json?.returningWalletPrice?.why === "unqualified", "CONTROL a wallet under the bar reads its own reason there");
  }
} finally {
  if (off) await off.stop().catch(() => {});
  if (on) { if (failed) console.error(on.log().split("\n").slice(-25).join("\n")); await on.stop().catch(() => {}); }
  if (floor) { if (failed) console.error(floor.log().split("\n").slice(-25).join("\n")); await floor.stop().catch(() => {}); }
  facilitator.closeAllConnections?.(); facilitator.close();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
