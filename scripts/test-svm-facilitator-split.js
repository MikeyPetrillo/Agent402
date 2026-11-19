#!/usr/bin/env node
// A second facilitator on Solana mainnet (src/svm-facilitator-split.js), offline.
//
// Unit legs: the share parser, the address and /supported checks, the split
// ratio over many quotes, quote stability, routing a paid request by the fee
// payer its transaction names, one facilitator down, a fee payer neither
// manages, a listed signer the boot-order facilitator also names.
//
// Booted legs run the real server in paid mode against three local stubs:
// the boot-order facilitator (Base and Solana, fee payer A), the second
// routing client (Base and Solana, fee payer C, never reached for Solana) and
// the listed Solana facilitator (fee payer B), with PAYMENT_SETTLE_FALLBACK on:
//
//   1. quotes split between A and B near the share, each one stable on re-read,
//      and nothing but the fee payer differs between them;
//   2. a paid transaction naming B settles at the listed stub only, one naming
//      A at the boot-order stub only;
//   3. a transaction naming B paid against an A quote (fee payer mismatch) and
//      one naming a fee payer neither manages are refused before any stub is asked;
//   4. a listed-stub refusal that moved no money and a listed-stub 5xx each
//      answer 402 and are never re-settled elsewhere;
//   5. a listed stub that lists Solana with no fee payer is not used: every
//      quote names A, and the boot log says why;
//   6. with SOLANA_FACILITATOR_URL unset, the 402s are byte-identical to that
//      boot's and a paid A transaction settles exactly as before;
//   7. a refusal before broadcast (the listed stub's settle 402, the
//      boot-order stub's verify rejection) answers `requote: true` with the
//      words, the re-requested quote names the other facilitator, and the
//      Solana failure is logged under the facilitator that handled it with
//      the Solana chain, never as Base.
//
//   node scripts/test-svm-facilitator-split.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { getFreePorts } from "./lib/free-port.js";
import { bootServer } from "./lib/boot-server.js";
import {
  SOLANA_MAINNET as SOL, SVM_FEE_PAYER_NOT_OFFERED, SVM_REQUOTE_SENTENCE, REQUOTE_TTL_MS, confirmSvmKind, createSvmFacilitatorSplit, isSolanaAddress,
  parseSvmShare, quoteIdentity, shareBucket, svmFeePayerOfRequest,
} from "../src/svm-facilitator-split.js";
import { labelFacilitatorErrors } from "../src/facilitator-diagnostics.js";
import { settleFailedProps } from "../src/posthog.js";

const BASE = "eip155:8453";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const SOL_PAYTO = "DdeMfXrDae49VAkvVZHUhWh7FDuirAuFCuuJruqXv5G2";
const FEE_A = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const FEE_B = "7XBvUZS4dsEfeXYsbuj5yFcYRyRAQwRCb1fzjBw7T8yp";
const FEE_C = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_X = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const BUYER = "J28Fii2VFnJcavvaeEfsKc628htk3mnrZKubD7WsGStW";

let pass = 0;
let srv = null;
const stubs = [];
const cleanup = () => { srv?.child?.kill("SIGKILL"); for (const s of stubs) s.close(); };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Buffer.from(out);
}
// A legacy wire transaction: two required signers (fee payer first, then the
// buyer), one program key, a blockhash that makes each one unique, no
// instructions. Only its account keys are read before a facilitator is asked.
let txN = 0;
function wireTx(feePayer, buyer = BUYER) {
  const blockhash = Buffer.alloc(32);
  blockhash.writeUInt32BE(++txN, 0);
  blockhash.writeUInt32BE(process.pid, 4);
  return Buffer.concat([
    Buffer.from([2]), Buffer.alloc(128),
    Buffer.from([2, 0, 1]), Buffer.from([3]),
    b58decode(feePayer), b58decode(buyer), Buffer.alloc(32, 6),
    blockhash, Buffer.from([0]),
  ]).toString("base64");
}
const headerReq = (payload, extra = {}) => {
  const value = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { header: (n) => (n === "payment-signature" ? value : undefined), ...extra };
};

// ---------------------------------------------------------------------------
// Unit
{
  ok(parseSvmShare(undefined) === 50 && parseSvmShare("") === 50, "an unset share is 50");
  ok(parseSvmShare("0") === 0 && parseSvmShare("100") === 100 && parseSvmShare(" 30% ") === 30, "integer percents parse");
  ok(parseSvmShare("101") === null && parseSvmShare("-1") === null && parseSvmShare("half") === null && parseSvmShare("50.5") === null, "anything else is null");
  ok(isSolanaAddress(FEE_A) && isSolanaAddress("11111111111111111111111111111111"), "32-byte base58 addresses are addresses");
  ok(!isSolanaAddress("0x" + "ab".repeat(20)) && !isSolanaAddress("z".repeat(44)) && !isSolanaAddress("1".repeat(31)) && !isSolanaAddress(""), "...others are not");
  ok(!confirmSvmKind({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE }] }).ok, "no Solana kind: not confirmed");
  ok(!confirmSvmKind({ kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: {} }] }).ok, "a Solana kind with no fee payer: not confirmed");
  ok(!confirmSvmKind({ kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "nope" } }] }).ok, "an invalid fee payer: not confirmed");
  ok(!confirmSvmKind({ kinds: [{ x402Version: 1, scheme: "exact", network: SOL, extra: { feePayer: FEE_B } }] }).ok, "a v1-only kind: not confirmed");
  const c = confirmSvmKind({ kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_B } }], signers: { "solana:*": [FEE_X] } });
  ok(c.ok && c.signers.has(FEE_B) && c.signers.has(FEE_X), "a valid kind is confirmed with every published signer");

  // The split ratio over many quotes.
  for (const share of [50, 30]) {
    let n = 0;
    const total = 20000;
    for (let i = 0; i < total; i++) if (shareBucket(`198.51.100.${i % 250}|GET|/api/tool-${i}`) < share) n++;
    const got = (100 * n) / total;
    ok(Math.abs(got - share) < 2, `share ${share}: ${got.toFixed(1)}% of 20000 quotes name the listed facilitator`);
  }
  ok(quoteIdentity({ ip: "1.2.3.4", method: "get", originalUrl: "/api/x?a=1" }) === "1.2.3.4|GET|/api/x?a=1", "the quote identity is address, method and URL");

  const kindA = { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_A } };
  const clientA = { name: "A" };
  const supportedB = { kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_B } }], extensions: ["x"], signers: { [SOL]: [FEE_B] } };
  let bDown = false, bNoFee = false;
  const clientB = { name: "B", getSupported: async () => {
    if (bDown) throw new Error("down");
    return bNoFee ? { kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: {} }] } : supportedB;
  } };
  const hooks = [];
  const fakeServer = {
    getSupportedKind: (v, n, s) => (n === SOL && s === "exact" ? kindA : undefined),
    getFacilitatorExtensions: () => [],
    getFacilitatorClient: (v, n, s) => (n === SOL && s === "exact" ? clientA : undefined),
    onBeforeVerify: (fn) => hooks.push(fn),
  };
  const quiet = { log() {}, warn() {} };
  const split = createSvmFacilitatorSplit({ entries: [{ url: "http://b", label: "B", client: clientB }], share: 50, log: quiet });
  split.install(fakeServer);
  split.install(fakeServer);
  ok(hooks.length === 1, "install is idempotent");
  await split.check();
  ok(split.status().active === "B", "a confirming facilitator is active");

  const reqs = Array.from({ length: 400 }, (_, i) => ({ ip: `203.0.113.${i % 200}`, method: "GET", originalUrl: `/api/uuid?n=${i}`, header: () => undefined }));
  const picks = reqs.map((r) => split.decide(r));
  const toB = picks.filter((p) => p?.entry?.label === "B").length;
  ok(toB > 150 && toB < 250, `unpaid quotes split near half (${toB}/400 name B)`);
  ok(reqs.every((r, i) => isDeepStrictEqual(split.decide(r)?.feePayer ?? null, picks[i]?.feePayer ?? null)), "every quote is the same on re-read");

  const paid = (fp, network = SOL) => headerReq({ x402Version: 2, accepted: { scheme: "exact", network }, payload: { transaction: wireTx(fp) } }, { ip: "203.0.113.9", method: "GET", originalUrl: "/api/uuid" });
  ok(svmFeePayerOfRequest(paid(FEE_B)).feePayer === FEE_B, "the fee payer is read from the transaction bytes");
  ok(split.decide(paid(FEE_B))?.entry?.label === "B", "a paid transaction naming B routes to B, whatever the share says");
  ok(split.decide(paid(FEE_A)) === null, "a paid transaction naming A takes the boot-order lookups");
  ok(split.decide(paid(FEE_X))?.refuse === true, "a fee payer neither manages is refused");
  ok(split.decide(headerReq({ x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: "garbage" } })) === null, "an unreadable transaction takes the boot-order lookups (its facilitator refuses it)");
  const forBase = split.decide(paid(FEE_X, BASE));
  ok(forBase === null || forBase.entry?.label === "B", "a payment on another network is not routed by fee payer");

  // Inside a B scope the three lookups name B; outside, the vendor's own.
  const scoped = await new Promise((resolve) => split.wrap(() => resolve({
    kind: fakeServer.getSupportedKind(2, SOL, "exact"), client: fakeServer.getFacilitatorClient(2, SOL, "exact"),
    ext: fakeServer.getFacilitatorExtensions(2, SOL, "exact"), base: fakeServer.getFacilitatorClient(2, BASE, "exact"),
  }))(paid(FEE_B), {}, () => {}));
  ok(scoped.kind.extra.feePayer === FEE_B && scoped.client === clientB && isDeepStrictEqual(scoped.ext, ["x"]), "a B scope names B's kind, client and extensions");
  ok(scoped.base === undefined, "...and never another network");
  ok(fakeServer.getFacilitatorClient(2, SOL, "exact") === clientA, "outside a scope the vendor's own lookup answers");
  const refused = await new Promise((resolve) => split.wrap(async () => resolve(await hooks[0]({ requirements: { network: SOL } })))(paid(FEE_X), {}, () => {}));
  ok(refused?.abort === true && refused.reason === SVM_FEE_PAYER_NOT_OFFERED, "the pre-verify hook refuses a fee payer neither manages");
  const notRefused = await new Promise((resolve) => split.wrap(async () => resolve(await hooks[0]({ requirements: { network: SOL } })))(paid(FEE_B), {}, () => {}));
  ok(notRefused === undefined, "...and lets a listed one through");

  // One facilitator down: every quote names the boot-order one, a payment
  // already quoted with B still routes to B.
  bDown = true;
  await split.check();
  ok(split.status().active === null, "B down: not active");
  ok(reqs.every((r) => split.decide(r) === null), "B down: every quote takes the boot-order facilitator");
  ok(split.decide(paid(FEE_B))?.entry?.label === "B", "B down: a transaction already quoted with B still routes to B (never elsewhere)");
  bDown = false; bNoFee = true;
  await split.check();
  ok(reqs.every((r) => split.decide(r) === null), "B listing no fee payer: every quote takes the boot-order facilitator");
  bNoFee = false;
  await split.check();
  ok(split.status().active === "B", "B back: active again");

  // A listed signer the boot-order facilitator also names: never quoted.
  const overlapServer = { ...fakeServer, onBeforeVerify() {}, getSupportedKind: (v, n, s) => (n === SOL && s === "exact" ? { ...kindA, extra: { feePayer: FEE_B } } : undefined) };
  const overlap = createSvmFacilitatorSplit({ entries: [{ url: "http://b", label: "B", client: clientB }], share: 100, log: quiet });
  overlap.install(overlapServer);
  await overlap.check();
  ok(overlap.status().active === null && reqs.every((r) => overlap.decide(r) === null), "a shared fee payer keeps every quote on the boot-order facilitator");

  // A refusal before broadcast: that identity's next quote names the other
  // facilitator; every other identity keeps its stable pick.
  {
    const t0 = 1_000_000;
    const toB = reqs.find((r) => split.decide(r, { now: t0 })?.entry?.label === "B");
    const toA = reqs.find((r) => split.decide(r, { now: t0 }) === null);
    const paidAs = (r, fp) => headerReq({ x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: wireTx(fp) } }, { ip: r.ip, method: r.method, originalUrl: r.originalUrl });
    const nB = split.noteRefusal(paidAs(toB, FEE_B), { now: t0 });
    ok(nB?.requote === true && nB.handler === "B" && nB.other === "boot-order", `a listed refusal is noted: avoid B, the other is the boot-order facilitator (${JSON.stringify(nB)})`);
    ok(split.decide(toB, { now: t0 + 1000 }) === null, "...and that identity's next quote names the boot-order facilitator");
    ok(split.decide(toB, { now: t0 + 2000 }) === null, "...on every re-read inside the window");
    ok(split.decide(toB, { now: t0 + REQUOTE_TTL_MS + 1 })?.entry?.label === "B", "...and its stable pick again once the window has passed");
    const nA = split.noteRefusal(paidAs(toA, FEE_A), { now: t0 });
    ok(nA?.handler === "boot-order" && nA.other === "B", `a boot-order refusal is noted: the other is B (${JSON.stringify(nA)})`);
    ok(split.decide(toA, { now: t0 + 1000 })?.entry?.label === "B", "...and that identity's next quote names B");
    ok(reqs.filter((r) => r !== toA && r !== toB).every((r, i, arr) => isDeepStrictEqual(split.decide(r, { now: t0 + 1000 })?.feePayer ?? null, picks[reqs.indexOf(r)]?.feePayer ?? null)), "every other identity keeps its stable pick");
    ok(split.noteRefusal(paidAs(toA, FEE_X)) === null && split.noteRefusal(toA) === null, "an unpaid request or a fee payer neither manages notes nothing");
    ok(split.decide(paidAs(toA, FEE_A), { now: t0 + 1000 }) === null, "a paid retry is still routed by its fee payer, never by the note");
    bDown = true;
    await split.check();
    const nA2 = split.noteRefusal(paidAs(toA, FEE_A), { now: t0 });
    ok(nA2?.other === null && split.decide(toA, { now: t0 + 1000 }) === null, "B down: a boot-order refusal has no other facilitator, and the quote stays stable");
    bDown = false;
    await split.check();
    ok(split.handlerLabel(paidAs(toA, FEE_B)) === "B" && split.handlerLabel(paidAs(toA, FEE_A)) === null && split.handlerLabel(toA) === null, "handlerLabel names the listed facilitator a paid request routes to, null otherwise");
  }
  ok(/request this route again without a payment header/i.test(SVM_REQUOTE_SENTENCE) && /nothing was charged/i.test(SVM_REQUOTE_SENTENCE), "the requote sentence says to request a fresh 402 and that nothing was charged");

  // Labels: one client serving two chains names each error with its chain.
  const multi = { async settle() { throw new Error("settle failed (402)"); }, async verify() { throw new Error("boom"); } };
  labelFacilitatorErrors((n) => `CDP (${n === SOL ? "Solana" : "Base"})`, multi);
  const solErr = await multi.settle({ accepted: { network: SOL } }, { network: SOL }).catch((e) => e);
  const baseErr = await multi.verify({}, { network: BASE }).catch((e) => e);
  ok(solErr.__a402Facilitator === "CDP (Solana)" && solErr.message.startsWith("[CDP (Solana)] "), `a Solana error is labeled with the Solana chain (${solErr.message})`);
  ok(baseErr.__a402Facilitator === "CDP (Base)", "...and a Base error with Base");
  const props = settleFailedProps({ slug: "uuid", status: 402, network: "solana", errorReason: solErr.message, facilitator: "Solana listed (http://b)" });
  ok(props.facilitator === "Solana listed (http://b)" && props.network === "solana" && !/Base/.test(JSON.stringify(props)), "settle_failed carries the facilitator and the network solana");
  ok(!("facilitator" in settleFailedProps({ slug: "uuid" })), "...and no facilitator field when none is known");

  const all = createSvmFacilitatorSplit({ entries: [{ url: "http://b", label: "B", client: clientB }], share: 100, log: quiet });
  all.install({ ...fakeServer, onBeforeVerify() {} });
  await all.check();
  ok(reqs.every((r) => all.decide(r)?.entry?.label === "B"), "share 100: every quote names B");
  const none = createSvmFacilitatorSplit({ entries: [{ url: "http://b", label: "B", client: clientB }], share: 0, log: quiet });
  none.install({ ...fakeServer, onBeforeVerify() {} });
  await none.check();
  ok(reqs.every((r) => none.decide(r) === null) && none.decide(paid(FEE_B))?.entry?.label === "B", "share 0: no quote names B, a B transaction still routes to B");
}

// ---------------------------------------------------------------------------
// Booted
function stubFacilitator(port, { feePayer, base = true, solFeePayer = true }) {
  const state = { verify: [], settle: [], mode: "ok", vmode: "ok" };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const reply = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/supported") {
        return reply({
          kinds: [
            ...(base ? [{ x402Version: 2, scheme: "exact", network: BASE }] : []),
            { x402Version: 2, scheme: "exact", network: SOL, extra: solFeePayer ? { feePayer } : {} },
          ],
          extensions: [], signers: solFeePayer ? { [SOL]: [feePayer] } : {},
        });
      }
      let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch { /* keep {} */ }
      if (req.url === "/verify") {
        state.verify.push(parsed);
        if (state.vmode === "reject") return reply({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_simulation_failed", invalidMessage: "simulation failed", payer: BUYER });
        return reply({ isValid: true, payer: BUYER });
      }
      if (req.url === "/settle") {
        state.settle.push(parsed);
        // An HTTP 402 with no transaction: the refusal the settle fallback acts on.
        if (state.mode === "refuse") return reply({ success: false, errorReason: "invalid_exact_svm_payload_transaction_simulation_failed", transaction: "", network: SOL, payer: BUYER }, 402);
        if (state.mode === "5xx") return reply({ error: "upstream" }, 502);
        return reply({ success: true, transaction: `sig-${feePayer.slice(0, 8)}-${state.settle.length}`, network: parsed?.paymentRequirements?.network || SOL, payer: BUYER });
      }
      res.writeHead(404, { Connection: "close" }); res.end();
    });
  });
  stubs.push(srv);
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(state)));
}

const [pA, pC, pB, pBad] = await getFreePorts(4);
const first = await stubFacilitator(pA, { feePayer: FEE_A });
const second = await stubFacilitator(pC, { feePayer: FEE_C });
const listed = await stubFacilitator(pB, { feePayer: FEE_B, base: true });
const broken = await stubFacilitator(pBad, { feePayer: FEE_B, base: false, solFeePayer: false });
let B = "";

async function boot(extraEnv, label) {
  try {
    srv = await bootServer({
      stores: `svm-split-${label}`,
      timeoutMs: 80_000,
      env: {
        FREE_MODE: "",
        WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,solana",
        SOLANA_WALLET_ADDRESS: SOL_PAYTO,
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
        CDP_FACILITATOR_URL: `http://127.0.0.1:${pA}`,
        PAYAI_FACILITATOR_URL: `http://127.0.0.1:${pC}`,
        PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
        PAYMENT_SETTLE_FALLBACK: "true", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "",
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0",
        SOLANA_TOKEN_ACCOUNT_CHECK: "off",
        SOLANA_FACILITATOR_URL: "", SOLANA_FACILITATOR_SHARE: "",
        ...extraEnv,
      },
    });
  } catch (e) { fail(`${label}: server never became healthy: ${String(e.message).slice(-1500)}`); }
  B = srv.url;
  const s = srv;
  return { get text() { return s.log(); } };
}
async function stop() {
  if (!srv) return;
  const s = srv;
  srv = null;
  await s.stop();
}

const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const route = (n) => `${B}/api/uuid?n=${n}`;
async function challenge(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await r.text();
  const pr = r.headers.get("payment-required");
  return { status: r.status, pr: pr ? decode(pr) : null, raw: pr, body };
}
const solAccept = (pr) => (pr?.accepts || []).find((a) => a.network === SOL && a.scheme === "exact");
const withoutFee = (pr) => ({ ...pr, accepts: (pr.accepts || []).map((a) => (a.network === SOL ? { ...a, extra: { ...a.extra, feePayer: "<fee>" } } : a)) });
const credential = (url, accepted, feePayer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: { url, description: "", mimeType: "" }, accepted,
  payload: { transaction: wireTx(feePayer) },
})).toString("base64");
async function pay(url, accepted, feePayer) {
  const r = await fetch(url, { headers: { Accept: "application/json", "payment-signature": credential(url, accepted, feePayer) } });
  const text = await r.text();
  const pr = r.headers.get("payment-required");
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text: `${text} ${pr ? JSON.stringify(decode(pr)) : ""}`, body };
}
const counts = () => [first, second, listed].map((s) => [s.verify.length, s.settle.length]);
const delta = (a, b) => b.map((x, i) => [x[0] - a[i][0], x[1] - a[i][1]]);
const N = 40;

// ---- 1. the split, on a real boot ----------------------------------------
const splitLog = await boot({ SOLANA_FACILITATOR_URL: `http://127.0.0.1:${pB}`, SOLANA_FACILITATOR_SHARE: "50" }, "split");
const quotes = [];
for (let i = 0; i < N; i++) quotes.push(await challenge(route(i)));
ok(quotes.every((q) => q.status === 402 && solAccept(q.pr)), "every quote is a 402 with a Solana accept");
const fees = quotes.map((q) => solAccept(q.pr).extra.feePayer);
const nB = fees.filter((f) => f === FEE_B).length, nA = fees.filter((f) => f === FEE_A).length;
ok(nA + nB === N && nB >= 8 && nA >= 8, `quotes split between the two facilitators (${nB} listed, ${nA} boot-order of ${N}); the second routing client never quoted`);
const again = [];
for (let i = 0; i < N; i++) again.push(await challenge(route(i)));
ok(again.every((q, i) => solAccept(q.pr).extra.feePayer === fees[i]), "every quote names the same fee payer on re-read");
const iA = fees.indexOf(FEE_A), iB = fees.indexOf(FEE_B);
const strip = (pr) => ({ ...withoutFee(pr), resource: { ...pr.resource, url: "<url>" } });
ok(isDeepStrictEqual(strip(quotes[iA].pr), strip(quotes[iB].pr)), "the two offers differ only in the Solana fee payer (and the URL)");
ok(isDeepStrictEqual(quotes[iA].pr.accepts.find((a) => a.network === BASE), quotes[iB].pr.accepts.find((a) => a.network === BASE)), "...the Base accept is the same on both");

// ---- 2. settle routing by fee payer ----------------------------------------
let c0 = counts();
let r = await pay(route(iB), solAccept(quotes[iB].pr), FEE_B);
let d = delta(c0, counts());
ok(r.status === 200, `a paid B transaction answers 200 (got ${r.status} ${r.text.slice(0, 160)})`);
ok(isDeepStrictEqual(d, [[0, 0], [0, 0], [1, 1]]), `...verified and settled at the listed facilitator only (${JSON.stringify(d)})`);
ok(listed.settle.at(-1)?.paymentRequirements?.extra?.feePayer === FEE_B, "...on requirements naming B");
c0 = counts();
r = await pay(route(iA), solAccept(quotes[iA].pr), FEE_A);
d = delta(c0, counts());
ok(r.status === 200 && isDeepStrictEqual(d, [[1, 1], [0, 0], [0, 0]]), `a paid A transaction settles at the boot-order facilitator only (${r.status} ${JSON.stringify(d)})`);
// The share never re-chooses a paid retry: a B transaction on a URL whose
// quote is A still routes to B.
c0 = counts();
const bOnA = { ...solAccept(quotes[iA].pr), extra: { ...solAccept(quotes[iA].pr).extra, feePayer: FEE_B } };
r = await pay(route(iA), bOnA, FEE_B);
d = delta(c0, counts());
ok(r.status === 200 && isDeepStrictEqual(d, [[0, 0], [0, 0], [1, 1]]), `a B quote paid on a URL the share gives A still settles at B (${r.status} ${JSON.stringify(d)})`);

// ---- 3. refused before any facilitator is asked ----------------------------
c0 = counts();
r = await pay(route(iA), solAccept(quotes[iA].pr), FEE_B);
d = delta(c0, counts());
ok(r.status === 402 && isDeepStrictEqual(d, [[0, 0], [0, 0], [0, 0]]), `fee payer mismatch (quote A, transaction B): 402, no facilitator asked (${r.status} ${JSON.stringify(d)})`);
c0 = counts();
r = await pay(route(iA), solAccept(quotes[iA].pr), FEE_X);
d = delta(c0, counts());
ok(r.status === 402 && isDeepStrictEqual(d, [[0, 0], [0, 0], [0, 0]]), `a fee payer neither manages: 402, no facilitator asked (${r.status} ${JSON.stringify(d)})`);
ok(r.text.includes(SVM_FEE_PAYER_NOT_OFFERED), `...answered with the reason ${SVM_FEE_PAYER_NOT_OFFERED} (${r.text.slice(0, 200)})`);
c0 = counts();
r = await pay(route(iA), { ...solAccept(quotes[iA].pr), extra: { ...solAccept(quotes[iA].pr).extra, feePayer: FEE_X } }, FEE_X);
d = delta(c0, counts());
ok(r.status === 402 && isDeepStrictEqual(d, [[0, 0], [0, 0], [0, 0]]), `an offer and transaction both naming an unknown fee payer: 402, no facilitator asked (${JSON.stringify(d)})`);

// ---- 4. listed refusals are never re-settled elsewhere ---------------------
// (7, first half) and the refusal answer asks for a fresh quote, which names
// the boot-order facilitator.
listed.mode = "refuse";
c0 = counts();
r = await pay(route(iB), solAccept(quotes[iB].pr), FEE_B);
d = delta(c0, counts());
ok(r.status === 402, `a listed refusal that moved no money answers 402 (got ${r.status})`);
ok(d[2][1] === 1 && d[0][1] === 0 && d[1][1] === 0, `...and no other facilitator is asked to settle it, though the settle fallback is on (${JSON.stringify(d)})`);
ok(r.body?.requote === true && String(r.body?.hint || "").includes(SVM_REQUOTE_SENTENCE), `...answers requote: true with the words to request a fresh quote (${JSON.stringify({ requote: r.body?.requote, retry: r.body?.retry, hint: r.body?.hint }).slice(0, 300)})`);
ok(solAccept((await challenge(route(iB))).pr)?.extra?.feePayer === FEE_A, "...and the re-requested quote names the boot-order facilitator");
ok(solAccept((await challenge(route(iB))).pr)?.extra?.feePayer === FEE_A, "...on every re-read");
const iB2 = fees.indexOf(FEE_B, iB + 1);
ok(iB2 < 0 || solAccept((await challenge(route(iB2))).pr)?.extra?.feePayer === FEE_B, "...while another request's quote keeps its stable pick");
listed.mode = "5xx";
c0 = counts();
r = await pay(route(iB), solAccept(quotes[iB].pr), FEE_B);
d = delta(c0, counts());
ok(r.status === 402 && d[2][1] >= 1 && d[0][1] === 0 && d[1][1] === 0, `a listed 5xx (may have broadcast): 402, never re-settled elsewhere (${r.status} ${JSON.stringify(d)})`);
ok(r.body?.requote !== true, "...and a 5xx (it may have broadcast) never asks for a fresh quote");
listed.mode = "ok";
// (7, second half) the boot-order facilitator rejects at verify: the next
// quote for that request names the listed one.
first.vmode = "reject";
r = await pay(route(iA), solAccept(quotes[iA].pr), FEE_A);
first.vmode = "ok";
ok(r.status === 402 && r.body?.requote === true, `a boot-order verify rejection answers 402 with requote: true (${r.status} ${JSON.stringify(r.body || {}).slice(0, 200)})`);
ok(solAccept((await challenge(route(iA))).pr)?.extra?.feePayer === FEE_B, "...and the re-requested quote names the listed facilitator");
// A settle refusal at the boot-order facilitator is logged under its own
// label with the Solana chain.
first.mode = "refuse";
const iA2 = fees.indexOf(FEE_A, iA + 1);
r = await pay(route(iA2), solAccept(quotes[iA2].pr), FEE_A);
first.mode = "ok";
await sleep(200);
ok(r.status === 402, `a boot-order settle refusal answers 402 (got ${r.status})`);
const solFailLines = splitLog.text.split("\n").filter((l) => /SETTLE failed|settle REJECTED/.test(l) && l.includes(SOL));
ok(solFailLines.length >= 2 && solFailLines.every((l) => !l.includes("CDP (Base)")), `no Solana settle failure line names Base (${solFailLines.length} lines)`);
ok(solFailLines.some((l) => l.includes("CDP (Solana)")) && solFailLines.some((l) => l.includes(`Solana listed (http://127.0.0.1:${pB})`)), `...each names the facilitator that handled it: ${solFailLines.map((l) => l.slice(0, 140)).join(" | ")}`);
await stop();

// ---- 5. boot check refusal --------------------------------------------------
const brokenLog = await boot({ SOLANA_FACILITATOR_URL: `http://127.0.0.1:${pBad}`, SOLANA_FACILITATOR_SHARE: "100" }, "broken");
const brokenQuotes = [];
for (let i = 0; i < 12; i++) brokenQuotes.push(await challenge(route(i)));
ok(brokenQuotes.every((q) => solAccept(q.pr)?.extra?.feePayer === FEE_A), "a listed facilitator with no Solana fee payer is not used: every quote names the boot-order one");
ok(/not used for Solana quotes: its exact kind on solana:\S+ names no valid fee payer/.test(brokenLog.text), "...and the boot log says why");
c0 = counts();
r = await pay(route(0), solAccept(brokenQuotes[0].pr), FEE_A);
ok(r.status === 200 && isDeepStrictEqual(delta(c0, counts()), [[1, 1], [0, 0], [0, 0]]), "...and a paid A transaction settles at the boot-order facilitator");
await stop();

// ---- 6. switch unset: byte-identical --------------------------------------
await boot({}, "unset");
const unsetQuotes = [];
for (let i = 0; i < 12; i++) unsetQuotes.push(await challenge(route(i)));
ok(unsetQuotes.every((q, i) => q.raw === brokenQuotes[i].raw && q.body === brokenQuotes[i].body), "unset: every 402 (header and body) is byte-identical to a boot whose listed facilitator is not used");
ok(unsetQuotes.every((q) => solAccept(q.pr)?.extra?.feePayer === FEE_A), "unset: every quote names the boot-order facilitator");
ok(unsetQuotes.every((q, i) => fees[i] !== FEE_A || (q.raw === quotes[i].raw && q.body === quotes[i].body)), "unset: every quote the split gave the boot-order facilitator is byte-identical to the unset one");
c0 = counts();
r = await pay(route(1), solAccept(unsetQuotes[1].pr), FEE_A);
ok(r.status === 200 && isDeepStrictEqual(delta(c0, counts()), [[1, 1], [0, 0], [0, 0]]), "unset: a paid A transaction settles at the boot-order facilitator");
c0 = counts();
r = await pay(route(1), { ...solAccept(unsetQuotes[1].pr), extra: { ...solAccept(unsetQuotes[1].pr).extra, feePayer: FEE_B } }, FEE_B);
ok(r.status === 402 && delta(c0, counts())[2].every((x) => x === 0), "unset: a B transaction is never sent to the listed facilitator");
await stop();

cleanup();
console.log(`test-svm-facilitator-split: ${pass} passed`);
