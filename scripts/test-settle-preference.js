#!/usr/bin/env node
// Per-request facilitator preference (src/settle-preference.js), offline.
//
// Unit legs drive the module against a fake resource server and fake
// requests. The booted leg runs the real server in paid mode with the
// PRODUCTION facilitator order against two local stubs, "cdp" first and
// "payai" second, both advertising Base and Solana with different Solana
// signers, and pins:
//
//   1. an untagged 402 names the first facilitator's Solana feePayer;
//   2. the header WITHOUT the operator token leaves the 402 byte-identical
//      (decoded PAYMENT-REQUIRED and body), and so does a WRONG token;
//   3. the header WITH the token names the second facilitator's feePayer on
//      the Solana accept and changes nothing else in the envelope;
//   4. a paid call carrying the header and token is verified and settled at
//      the second stub only, and an untagged paid call at the first only;
//   5. a tagged paid retry that drops the header is refused before any
//      facilitator is asked (the quoted feePayer no longer matches).
//
//   node scripts/test-settle-preference.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  SETTLE_VIA_HEADER, installSettlePreference, registerSettlePreference, resetSettlePreferences,
  runWithSettlePreference, settlePreferenceMiddleware, settleViaOf,
} from "../src/settle-preference.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "eip155:8453";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
// Any well-formed base58 public keys: the stubs never look at them.
const SOL_PAYTO = "DdeMfXrDae49VAkvVZHUhWh7FDuirAuFCuuJruqXv5G2";
const FEE_A = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const FEE_B = "7XBvUZS4dsEfeXYsbuj5yFcYRyRAQwRCb1fzjBw7T8yp";
const TOKEN = "op-token-for-settle-preference-test";

let pass = 0;
let proc = null;
const stubs = [];
const cleanup = () => { proc?.kill("SIGKILL"); for (const s of stubs) s.close(); };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Unit: the header read, the gate, the scoped lookups.
{
  ok(settleViaOf({ headers: { [SETTLE_VIA_HEADER]: " PayAI " } }) === "payai", "the header value is trimmed and lowercased");
  ok(settleViaOf({ headers: {} }) === null && settleViaOf(null) === null, "no header reads null");

  const supportedB = { kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_B } }], extensions: ["bazaar"], signers: { [SOL]: [FEE_B] } };
  const clientA = { name: "A" };
  const clientB = { name: "B", getSupported: async () => supportedB };
  const kindA = { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_A } };
  const server = {
    getSupportedKind: (v, n, s) => (n === SOL && s === "exact" ? kindA : undefined),
    getFacilitatorExtensions: () => [],
    getFacilitatorClient: (v, n, s) => (n === SOL && s === "exact" ? clientA : undefined),
  };
  installSettlePreference(server);
  installSettlePreference(server);
  ok(server.getSupportedKind(2, SOL, "exact") === kindA && server.getFacilitatorClient(2, SOL, "exact") === clientA, "outside a scope the vendor's own lookup answers");
  runWithSettlePreference({ via: "payai", client: clientB, supported: supportedB }, () => {
    ok(server.getSupportedKind(2, SOL, "exact").extra.feePayer === FEE_B, "inside a scope the preferred facilitator's kind answers");
    ok(server.getFacilitatorClient(2, SOL, "exact") === clientB, "...and its client settles");
    ok(isDeepStrictEqual(server.getFacilitatorExtensions(2, SOL, "exact"), ["bazaar"]), "...and its extensions are read");
    ok(server.getFacilitatorClient(2, BASE, "exact") === undefined && server.getSupportedKind(2, BASE, "exact") === undefined, "a pair the preferred facilitator does not advertise falls through to the boot order");
  });

  resetSettlePreferences();
  registerSettlePreference("PayAI", clientB, "PayAI");
  const mw = settlePreferenceMiddleware({ authed: (req) => req.headers["x-operator-token"] === TOKEN, log: { warn() {} } });
  const run = (headers) => new Promise((resolve) => {
    let sync = true;
    mw({ headers }, {}, () => resolve({ sync, client: server.getFacilitatorClient(2, SOL, "exact") }));
    sync = false;
  });
  let r = await run({});
  ok(r.sync && r.client === clientA, "untagged: continues synchronously on the boot order");
  r = await run({ [SETTLE_VIA_HEADER]: "payai" });
  ok(r.sync && r.client === clientA, "tagged without the token: continues synchronously on the boot order");
  r = await run({ [SETTLE_VIA_HEADER]: "payai", "x-operator-token": "wrong" });
  ok(r.sync && r.client === clientA, "tagged with a wrong token: boot order");
  r = await run({ [SETTLE_VIA_HEADER]: "nobody", "x-operator-token": TOKEN });
  ok(r.sync && r.client === clientA, "a name nobody registered: boot order, even with the token");
  r = await run({ [SETTLE_VIA_HEADER]: "payai", "x-operator-token": TOKEN });
  ok(!r.sync && r.client === clientB, "tagged with the token: the rest of the request runs inside the preference scope");
  const dead = { getSupported: async () => { throw new Error("down"); } };
  registerSettlePreference("dead", dead);
  r = await run({ [SETTLE_VIA_HEADER]: "dead", "x-operator-token": TOKEN });
  ok(r.client === clientA, "a preferred facilitator whose /supported fails leaves the request on the boot order");
  resetSettlePreferences();
}

// ---------------------------------------------------------------------------
// Booted: the production order against two stubs.
function stubFacilitator(port, feePayer) {
  const state = { verify: [], settle: [], feePayer };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/supported") {
        return reply({
          kinds: [
            { x402Version: 2, scheme: "exact", network: BASE },
            { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer } },
          ],
          extensions: [], signers: { [SOL]: [feePayer] },
        });
      }
      let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch { /* keep {} */ }
      if (req.url === "/verify") { state.verify.push(parsed); return reply({ isValid: true, payer: SOL_PAYTO }); }
      if (req.url === "/settle") { state.settle.push(parsed); return reply({ success: true, transaction: `sig-${state.settle.length}`, network: parsed?.paymentRequirements?.network || SOL, payer: SOL_PAYTO }); }
      res.writeHead(404, { Connection: "close" }); res.end();
    });
  });
  stubs.push(srv);
  return new Promise((r) => srv.listen(port, () => r(state)));
}

const first = await stubFacilitator(3971, FEE_A);
const second = await stubFacilitator(3972, FEE_B);
const PORT = 3973;
const B = `http://127.0.0.1:${PORT}`;
const log = { text: "" };
proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,solana",
    SOLANA_WALLET_ADDRESS: SOL_PAYTO,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
    CDP_FACILITATOR_URL: "http://127.0.0.1:3971",
    PAYAI_FACILITATOR_URL: "http://127.0.0.1:3972",
    AGENT402_OPERATOR_TOKEN: TOKEN,
    // Hermetic boot: nothing below may add a client that probes a real host.
    PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
    PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0",
    SOLANA_TOKEN_ACCOUNT_CHECK: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (c) => { log.text += c; });
proc.stderr.on("data", (c) => { log.text += c; });
{
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ }
    if (!up) await sleep(500);
  }
  if (!up) fail(`server never became healthy; log tail: ${log.text.slice(-1200)}`);
}

const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const ROUTE = `${B}/api/uuid`;
async function challenge(headers = {}) {
  const r = await fetch(ROUTE, { headers: { Accept: "application/json", ...headers } });
  const body = await r.json().catch(() => null);
  const pr = r.headers.get("payment-required");
  return { status: r.status, pr: pr ? decode(pr) : null, body };
}
const solAccept = (pr) => (pr?.accepts || []).find((a) => a.network === SOL && a.scheme === "exact");
const withoutSolFeePayer = (pr) => ({ ...pr, accepts: (pr.accepts || []).map((a) => (a.network === SOL ? { ...a, extra: { ...a.extra, feePayer: "<fee>" } } : a)) });

const plain = await challenge();
ok(plain.status === 402 && plain.pr, `untagged request: 402 with PAYMENT-REQUIRED (got ${plain.status})`);
ok(solAccept(plain.pr)?.extra?.feePayer === FEE_A, "untagged: the Solana accept names the FIRST facilitator's feePayer");
ok((plain.pr.accepts || []).some((a) => a.network === BASE), "untagged: Base is offered too");

const headerOnly = await challenge({ "X-Agent402-Settle-Via": "payai" });
ok(headerOnly.status === 402 && isDeepStrictEqual(headerOnly.pr, plain.pr), "the header WITHOUT the operator token: PAYMENT-REQUIRED is identical");
ok(isDeepStrictEqual(headerOnly.body, plain.body), "...and the 402 body is identical");

const wrongToken = await challenge({ "X-Agent402-Settle-Via": "payai", "X-Operator-Token": "not-the-token" });
ok(wrongToken.status === 402 && isDeepStrictEqual(wrongToken.pr, plain.pr), "the header with a WRONG token: PAYMENT-REQUIRED is identical");

const tagged = await challenge({ "X-Agent402-Settle-Via": "payai", "X-Operator-Token": TOKEN });
ok(tagged.status === 402 && solAccept(tagged.pr)?.extra?.feePayer === FEE_B, `the header WITH the token: the Solana accept names the SECOND facilitator's feePayer (got ${solAccept(tagged.pr)?.extra?.feePayer})`);
ok(isDeepStrictEqual(withoutSolFeePayer(tagged.pr), withoutSolFeePayer(plain.pr)), "...and nothing else in the envelope changed");

const again = await challenge();
ok(isDeepStrictEqual(again.pr, plain.pr), "the next untagged request is untouched by the tagged one");

// ---- paid calls: which stub is asked -------------------------------------
// A fresh "transaction" per credential: one authorization answers once
// (src/settlement-claims.js), so a reused one is refused for being a replay,
// which is not the refusal the last leg measures.
let txN = 0;
const credential = (accepted) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: { url: ROUTE, description: "", mimeType: "" }, accepted,
  payload: { transaction: Buffer.from(`not-a-real-transaction-${++txN}`).toString("base64") },
})).toString("base64");
async function pay(accepted, headers = {}) {
  const r = await fetch(ROUTE, { headers: { Accept: "application/json", "payment-signature": credential(accepted), ...headers } });
  const text = await r.text();
  return { status: r.status, text, receipt: r.headers.get("payment-response") };
}
const counts = () => ({ a: [first.verify.length, first.settle.length], b: [second.verify.length, second.settle.length] });

const before = counts();
const paidTagged = await pay(solAccept(tagged.pr), { "X-Agent402-Settle-Via": "payai", "X-Operator-Token": TOKEN });
let after = counts();
ok(paidTagged.status === 200, `tagged paid call answers 200 (got ${paidTagged.status} ${paidTagged.text.slice(0, 160)})`);
ok(after.b[0] === before.b[0] + 1 && after.b[1] === before.b[1] + 1, "tagged paid call: verified and settled at the SECOND facilitator");
ok(after.a[0] === before.a[0] && after.a[1] === before.a[1], "...and the first facilitator was never asked");
ok(second.settle.at(-1)?.paymentRequirements?.extra?.feePayer === FEE_B, "the settled requirements name the second facilitator's feePayer");
ok(paidTagged.receipt && decode(paidTagged.receipt).success === true, "the buyer's receipt reports the settlement");

const before2 = counts();
const paidPlain = await pay(solAccept(plain.pr));
after = counts();
ok(paidPlain.status === 200, `untagged paid call answers 200 (got ${paidPlain.status})`);
ok(after.a[0] === before2.a[0] + 1 && after.a[1] === before2.a[1] + 1 && after.b[0] === before2.b[0] && after.b[1] === before2.b[1], "untagged paid call: verified and settled at the FIRST facilitator only");

const before3 = counts();
const dropped = await pay(solAccept(tagged.pr));
after = counts();
ok(dropped.status === 402, `a retry quoted the second signer but sent WITHOUT the header is refused (got ${dropped.status})`);
ok(isDeepStrictEqual(after, before3), "...before either facilitator is asked");

cleanup();
console.log(`test-settle-preference: ${pass} passed`);
