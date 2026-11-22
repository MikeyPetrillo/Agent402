// The returning-wallet price end to end in paid mode (src/returning-wallet.js)
// against a stub facilitator that records every verify and settle with the
// requirement it was asked to check:
//   - switch off: a hint changes nothing and the 402 names no offer;
//   - switch on: a wallet with a paid day is quoted the discount on the same
//     call that carries its hint, pays it, and the facilitator is asked to
//     verify and settle the discounted amount FROM that wallet; the sale is
//     booked at what moved;
//   - the hint is read only with a proof: a hint with no valid proof (none,
//     another key's, expired, for another route or server, or replayed) is
//     quoted list, and its 402 is byte for byte the 402 of a wallet that does
//     not qualify;
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
const { privateKeyToAccount } = await import("viem/accounts");
// Each wallet is a key this suite holds, so it can prove the wallet.
const accounts = new Map();
const account = (n) => { if (!accounts.has(n)) accounts.set(n, privateKeyToAccount("0x" + createHash("sha256").update(`${RUN}:${n}`).digest("hex"))); return accounts.get(n); };
const wallet = (n) => account(n).address.toLowerCase();
const HINT = "x-agent402-wallet", PROOF = "x-agent402-wallet-proof";
// The server's host name (BASE_URL unset: 127.0.0.1) and each route as a proof names it.
const HOST = "127.0.0.1";
const message = (w, route, time, host = HOST) => `Agent402 returning-wallet price\nhost: ${host}\nroute: ${route}\nwallet: ${w.toLowerCase()}\ntime: ${time}`;
// One signature per text, so each proof names a time of its own inside the skew.
let proofSeq = 0;
const freshTime = () => Math.floor(Date.now() / 1000) - (proofSeq++ % 200);
/** A hint for wallet `n` with its proof (another key, time, route or host when named). */
const proven = async (n, route = "hash", { by = n, time = freshTime(), host = HOST, routeLine = `${ROUTES[route].method} ${ROUTES[route].path}` } = {}) =>
  ({ hint: wallet(n), proof: `${time}.${await account(by).signMessage({ message: message(wallet(n), routeLine, time, host) })}` });
/** The request headers for `who`: null (none), a bare hint (a string), or a proven hint. */
const whoHeaders = (who) => (who == null ? {} : typeof who === "string" ? { [HINT]: who } : { [HINT]: who.hint, [PROOF]: who.proof });

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
    FREE_MODE: "", NODE_ENV: "test", TRUST_PROXY_HOPS: "1", BASE_URL: "",
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
async function quote(B, route, who, from = null) {
  const rt = ROUTES[route];
  const r = await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", ...whoHeaders(who), ...(from ? { "x-forwarded-for": from } : {}) }, body: rt.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf-8") || "{}");
  const accept = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  // Every header but the clock's and the request's own id, for comparing two answers byte for byte.
  const headers = [...r.headers].filter(([k]) => k !== "date" && k !== "x-request-id").map(([k, v]) => `${k}: ${v}`).join("\n");
  return { status: r.status, accept, json, text, headers };
}
const credential = (accept, from) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accept.resource, accepted: accept,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } },
})).toString("base64");
async function pay(B, route, accept, from, who) {
  const rt = ROUTES[route];
  const r = await fetch(`${B}${rt.path}`, { method: rt.method, headers: { "content-type": "application/json", "payment-signature": credential(accept, from), ...whoHeaders(who) }, body: rt.body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  let again = null;
  try { again = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf-8") || "{}"); } catch { again = null; }
  return { status: r.status, json, headers: r.headers, requote: (again?.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact") || null };
}
const waitFor = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(150); } };

const W1 = wallet(0xa1), W2 = wallet(0xa2), W3 = wallet(0xa3), W4 = wallet(0xa4), W5 = wallet(0xa5), W7 = wallet(0xa7);
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
  // A day counts at $0.0015 spent: two $0.001 calls reach it, one does not.
  on = await boot("returning-wallet-on", { RETURNING_WALLET_PRICE: "on", RETURNING_WALLET_MIN_PAID_DAYS: "1", RETURNING_WALLET_MIN_DAY_SPEND_USD: "0.0015", REFERRAL_SLUGS: "base64" });
  const B = on.url;
  {
    const fresh = await quote(B, "hash", await proven(0xa1));
    ok(fresh.accept?.amount === "1000" && fresh.json?.returningWalletPrice?.applied === false && fresh.json.returningWalletPrice.header === "X-Agent402-Wallet" && fresh.json.returningWalletPrice.discountPercent === 10,
      `a wallet with no paid day is quoted list, and the 402 states the offer (${fresh.accept?.amount}, ${JSON.stringify(fresh.json?.returningWalletPrice && { applied: fresh.json.returningWalletPrice.applied, pct: fresh.json.returningWalletPrice.discountPercent })})`);
    const none = await quote(B, "hash", null);
    ok(none.accept?.amount === "1000" && none.json?.returningWalletPrice?.applied === false, "no hint: list");
    ok((await quote(B, "hash", "0x1234")).accept?.amount === "1000" && (await quote(B, "hash", "not-a-wallet")).accept?.amount === "1000", "a malformed hint: list");
    // W7 buys once: its day stays under the per-day spend floor.
    const once = await pay(B, "hash", none.accept, W7, null);
    ok(once.status === 200 && settlesSeen.at(-1)?.from === W7, `one purchase from another wallet (${once.status})`);
    // W3 buys once at list with no hint (so no quote for it is cached yet).
    const first = await pay(B, "hash", none.accept, W3, null);
    ok(first.status === 200 && settlesSeen.at(-1)?.from === W3 && settlesSeen.at(-1)?.value === "1000", `a first purchase settles at list (${first.status})`);
    const second = await pay(B, "hash", none.accept, W3, null);
    ok(second.status === 200, `a second purchase the same day settles at list (${second.status})`);
  }
  // The sale lands in the ledger on the response's finish; then W3 qualifies.
  const quoted = await waitFor(async () => { const who = await proven(0xa3); const q = await quote(B, "hash", who); return q.accept?.amount === "900" ? { ...q, who } : null; });
  ok(!!quoted && quoted.json?.returningWalletPrice?.applied === true, `a wallet with a paid day at the per-day spend floor is quoted 10% under list on the call that carries its hint and proof (${quoted?.accept?.amount})`);
  {
    // Its sale was written before W3's: W7's single day is under the floor.
    const under = await quote(B, "hash", await proven(0xa7));
    ok(under.accept?.amount === "1000" && under.json?.returningWalletPrice?.why === "unqualified", `a wallet whose only paid day is under the per-day spend floor is quoted list (${under.accept?.amount}, ${under.json?.returningWalletPrice?.why})`);
  }
  {
    const v0 = verifies.length, s0 = settlesSeen.length;
    // The signed retry resends the same two headers.
    const paid = await pay(B, "hash", quoted.accept, W3, quoted.who);
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
  // ---------------- the hint is read only with a proof ----------------
  {
    // A wallet that qualifies (W3) and one that does not (W1), each named with
    // no proof: the same 402, byte for byte, apart from the clock.
    const bareYes = await quote(B, "hash", W3), bareNo = await quote(B, "hash", W1);
    ok(bareYes.status === 402 && bareYes.accept?.amount === "1000" && bareYes.json?.returningWalletPrice?.why === "unproven", `a qualifying wallet named with no proof is quoted list, and the 402 says only that it was not proven (${bareYes.accept?.amount}, ${bareYes.json?.returningWalletPrice?.why})`);
    ok(bareYes.text === bareNo.text && bareYes.headers === bareNo.headers, "its 402 is the 402 of a wallet that does not qualify, body and headers");
    const refused = [
      ["a proof signed by another key", await proven(0xa3, "hash", { by: 0xa2 })],
      ["an expired proof", await proven(0xa3, "hash", { time: Math.floor(Date.now() / 1000) - 400 })],
      ["a proof for another route", await proven(0xa3, "hash", { routeLine: "POST /api/base64" })],
      ["a proof for another server", await proven(0xa3, "hash", { host: "other.example" })],
    ];
    for (const [label, who] of refused) {
      const q = await quote(B, "hash", who);
      ok(q.accept?.amount === "1000" && q.text === bareNo.text, `${label} is quoted list with that same 402 (${q.accept?.amount}, ${q.json?.returningWalletPrice?.why})`);
    }
    const once = await proven(0xa3);
    const first = await quote(B, "hash", once);
    const replay = await quote(B, "hash", once);
    ok(first.accept?.amount === "900" && replay.accept?.amount === "1000" && replay.text === bareNo.text, `a proof sent a second time without a payment is quoted list with that same 402 (${first.accept?.amount} then ${replay.accept?.amount})`);
    const v0 = verifies.length;
    const bare = await pay(B, "hash", quoted.accept, W3, W3);
    ok(bare.status === 402 && verifies.length === v0 && bare.requote?.amount === "1000", `the qualifying wallet paying the lower quote with its hint and no proof is answered 402 at list, and the facilitator is never asked (${bare.status}, ${bare.requote?.amount})`);
  }
  // ---------------- the hint is a claim ----------------
  {
    const stolen = quoted;
    const v0 = verifies.length, s0 = settlesSeen.length;
    const other = await pay(B, "hash", stolen.accept, W2, await proven(0xa3));
    ok(other.status === 402 && verifies.length === v0 && settlesSeen.length === s0, `another wallet paying that quote under the hint is refused 402, and the facilitator is never asked (${other.status}, verifies +${verifies.length - v0}, settles +${settlesSeen.length - s0})`);
    ok(other.requote?.amount === "1000", `the refusal re-quotes list (${other.requote?.amount})`);
    const noHint = await pay(B, "hash", stolen.accept, W3, null);
    ok(noHint.status === 402 && verifies.length === v0 && noHint.requote?.amount === "1000", `the qualifying wallet without its hint is quoted list too (${noHint.status})`);
    const listPaid = await pay(B, "hash", other.requote, W2, await proven(0xa3));
    ok(listPaid.status === 200 && settlesSeen.at(-1).from === W2 && settlesSeen.at(-1).value === "1000", `that other wallet pays list under the same hint and is served (${listPaid.status}, ${settlesSeen.at(-1).value})`);
  }
  // ---------------- never discounted ----------------
  {
    const ref = await quote(B, "base64", await proven(0xa3, "base64"));
    ok(ref.status === 402 && ref.accept?.amount === "1000" && ref.json?.returningWalletPrice === undefined, `a route sold on the referral routes is quoted list and names no offer (${ref.accept?.amount})`);
    const pricing = await fetch(`${B}/api/pricing`, { headers: { [HINT]: W3 } }).then((r) => r.json());
    const rows = Object.values(pricing).find((v) => Array.isArray(v) && v.some((t) => t?.slug === "hash")) || [];
    const row = rows.find((t) => t.slug === "hash");
    ok(row?.price === "$0.001", `the published price stays list, with or without a hint (${row?.price})`);
    const op = await fetch(`${B}/__operator/returning-wallets.json`, { headers: { "X-Operator-Token": OP_TOKEN, Authorization: `Bearer ${OP_TOKEN}` } }).then((r) => r.json());
    ok(op.enabled === true && op.counts?.paidDiscount === 1 && op.counts?.paidOtherWallet >= 1 && op.returnRate?.payers >= 2, `the operator view counts the discounted payment, the other-wallet attempt and the payers (${JSON.stringify({ counts: op.counts, payers: op.returnRate?.payers })})`);
    // The surfaces that describe paying state the offer while it is on.
    const llms = await fetch(`${B}/llms-full.txt`).then((r) => r.text());
    ok(/Returning wallets pay less: send your wallet address in the `X-Agent402-Wallet` request header/.test(llms) && /at least \$0\.0015 on each of 1 or more UTC days in the last 30/.test(llms) && /quoted 10% under the route's list price on its x402 exact accepts on EVM chains; a chain's premium and price floor still apply/.test(llms), "llms-full.txt states the offer with the settings in force");
    ok(/a payment of the lower amount from any other wallet is answered 402 at the list price, and nothing is charged/.test(llms) && !/any other payer is quoted list/.test(llms), "and says what the gate does with another wallet's payment of the lower amount");
    ok(llms.includes("prove that wallet in the `X-Agent402-Wallet-Proof` header as `<unix seconds>.<signature>`: the wallet's EIP-191 (personal_sign) signature over five lines separated by single line feeds (none after the last): `Agent402 returning-wallet price`, `host: <this server's host name>`, `route: <METHOD> <path>`, `wallet: <the address in lowercase>` and `time: <the same seconds>`, within 5 minutes of the server's clock"), "and how a request proves the wallet, in the exact words of the message it signs");
    const short = await fetch(`${B}/llms.txt`).then((r) => r.text());
    ok(!/X-Agent402-Wallet/.test(short), "CONTROL the rule is on llms-full.txt, not on llms.txt");
    const notes = (await fetch(`${B}/changelog`).then((r) => r.text())).replace(/\s+/g, " ");
    ok(/\/llms-full\.txt states the rule/.test(notes) && !/\/llms\.txt states the rule/.test(notes), "the release notes name the document that carries the rule");
    const api = await fetch(`${B}/openapi.json`).then((r) => r.json());
    const headersOf = (path) => (api.paths?.[path]?.post?.parameters || []).filter((p) => p.in === "header").map((p) => p.name);
    ok(headersOf("/api/hash").includes("X-Agent402-Wallet") && headersOf("/api/hash").includes("X-Agent402-Wallet-Proof") && !headersOf("/api/base64").includes("X-Agent402-Wallet") && !headersOf("/api/base64").includes("X-Agent402-Wallet-Proof"), `the OpenAPI document declares the header on an eligible route only (${headersOf("/api/hash").join(", ")} / ${headersOf("/api/base64").join(", ")})`);
    const param = (api.paths?.["/api/hash"]?.post?.parameters || []).find((x) => x.name === "X-Agent402-Wallet");
    ok(/premium and price floor still apply/.test(param?.description || "") && /answered 402 at the list price, and nothing is charged/.test(param?.description || ""), "and its description carries the rule the 402 body no longer spells out");
    const manifest = await fetch(`${B}/.well-known/x402`).then((r) => r.text());
    const KEPT = "read against the sales ledger to decide that request's quote, only when the same request proves control of that wallet with a signature in the X-Agent402-Wallet-Proof header; the address and its count of paid days are held in memory for about 10 minutes, and a used proof's signature until its 5-minute window has passed, and neither is written to a store";
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
    const under = await quote(B, "hash", await proven(0xa1));
    ok(under.json?.returningWalletPrice?.applied === false && under.json.returningWalletPrice.why === "unqualified", `a proven wallet under the bar is told why its quote is list (${under.json?.returningWalletPrice?.why})`);
    const lowered = await quote(B, "hash", await proven(0xa3));
    ok(lowered.accept?.amount === "900" && lowered.json?.returningWalletPrice?.applied === true && lowered.json.returningWalletPrice.atListOn === undefined, `a lowered quote reads applied, with no chain held at list (${JSON.stringify(lowered.json?.returningWalletPrice)})`);
  }
  // ---------------- one address cannot spend everyone's ledger reads ----------------
  {
    // W5 buys twice at list with no hint (its day reaches the per-day spend
    // floor), so its paid day is on the ledger and nothing about it is cached.
    // W8 buys after it: once W8 is counted, W5's sales are written too.
    const before = (await operator(B)).returnRate?.payers ?? 0;
    const list = await quote(B, "hash", null);
    const first = await pay(B, "hash", list.accept, W5, null);
    const again = await pay(B, "hash", list.accept, W5, null);
    ok(first.status === 200 && again.status === 200, `CONTROL a wallet buys twice at list (${first.status}, ${again.status})`);
    const after = await pay(B, "hash", list.accept, wallet(0xa8), null);
    ok(after.status === 200, `CONTROL another wallet buys after it (${after.status})`);
    await waitFor(async () => ((await operator(B)).returnRate?.payers ?? 0) >= before + 2);
    // The probe: 600 unpaid requests inside a minute from one address, each naming an unused wallet.
    const PROBER = "203.0.113.7", BUYER = "198.51.100.9";
    const held0 = (await operator(B)).counts;
    // Each probe names a wallet the prober holds and proves, so each asks for a fresh read.
    const probes = [];
    for (let i = 0; i < 600; i++) probes.push(await proven(0x100000 + i));
    // Start early in a clock minute, so the whole burst and the buyer's call share it.
    while (Date.now() % 60_000 > 45_000) await sleep(500);
    const t0 = Date.now();
    const statuses = new Map();
    let next = 0;
    const one = async () => { while (next < 600) { const i = next++; const q = await quote(B, "hash", probes[i], PROBER); const k = `${q.status}:${q.accept?.amount}`; statuses.set(k, (statuses.get(k) || 0) + 1); } };
    await Promise.all(Array.from({ length: 16 }, one));
    const buyer = await quote(B, "hash", await proven(0xa5), BUYER);
    const took = Date.now() - t0;
    ok(statuses.size === 1 && statuses.get("402:1000") === 600, `600 unpaid requests naming unused wallets are each quoted list (${JSON.stringify([...statuses])})`);
    ok(took < 14_000 && buyer.accept?.amount === "900" && buyer.json?.returningWalletPrice?.applied === true, `a qualifying wallet from another address is quoted its price in the same minute (${buyer.accept?.amount}, ${JSON.stringify(buyer.json?.returningWalletPrice)}, ${took} ms)`);
    const held1 = (await operator(B)).counts;
    ok(held1.lookupsHeldAddress - (held0.lookupsHeldAddress || 0) >= 500 && held1.lookupsHeld === (held0.lookupsHeld || 0), `the prober's reads past its share were held for that address alone (${held1.lookupsHeldAddress} held for an address, ${held1.lookupsHeld} service-wide)`);
    const busy = await quote(B, "hash", await proven(0x200000), PROBER);
    ok(busy.accept?.amount === "1000" && busy.json?.returningWalletPrice?.why === "lookup_busy", `and its 402 says so (${busy.json?.returningWalletPrice?.why})`);
  }
  await on.stop(); on = null;

  // ---------------- a chain at its price floor ----------------
  floor = await boot("returning-wallet-floor", { RETURNING_WALLET_PRICE: "on", RETURNING_WALLET_MIN_PAID_DAYS: "1", RETURNING_WALLET_MIN_DAY_SPEND_USD: "0", NETWORK_PRICE_FLOORS: "eip155:8453=0.001" });
  {
    const F = floor.url;
    const before = (await operator(F)).returnRate?.payers ?? 0;
    const list = await quote(F, "hash", null);
    ok(list.accept?.amount === "1000", `CONTROL the floor equals this route's list price (${list.accept?.amount})`);
    const first = await pay(F, "hash", list.accept, W4, null);
    ok(first.status === 200, `a first purchase settles at list (${first.status})`);
    await waitFor(async () => ((await operator(F)).returnRate?.payers ?? 0) > before);
    const w4 = await proven(0xa4);
    const q = await quote(F, "hash", w4);
    const field = q.json?.returningWalletPrice;
    ok(q.accept?.amount === "1000" && field?.applied === false && field.why === "price_floor", `a qualifying wallet on a floored chain is quoted the same amount, and the 402 does not say the discount was applied (${q.accept?.amount}, ${JSON.stringify(field)})`);
    const s0 = settlesSeen.length;
    const paid = await pay(F, "hash", q.accept, W4, w4);
    ok(paid.status === 200 && settlesSeen.length === s0 + 1 && settlesSeen.at(-1).from === W4 && settlesSeen.at(-1).value === "1000", `its payment settles at that amount (${paid.status}, ${settlesSeen.at(-1)?.value})`);
    const under = await quote(F, "hash", await proven(0xa1));
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
