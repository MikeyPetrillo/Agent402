// The AgentCore EIP-712 domain-name fallback, proven through the REAL server.
//
// Measured 2026-08-28 (reported upstream as awslabs/agentcore-samples#2002):
// AWS Bedrock AgentCore Payments signs Base USDC EIP-3009 authorizations under
// EIP-712 domain name "USDC" while Base USDC's contract says "USD Coin", so the
// facilitator answers invalid_exact_evm_payload_signature. Their manager prefers
// MPP and falls back to x402 only on a challenge SELECTION error - never on a
// failed verify - so a dual-stack seller's Base route is unpayable from
// AgentCore even though its x402 option settles the same instrument fine.
//
// This test locks the whole remedy:
//   1. the diagnosis recovers the signer and can tell "signed under the other
//      known name" apart from "healthy" and from "ordinary bad signature";
//   2. such a credential is refused LOCALLY - the facilitator is never asked;
//   3. the 402 that answers it carries NO WWW-Authenticate at all (neither the
//      evm nor the tempo half), which is the only thing that makes an
//      MPP-preferring manager take the x402 offer in the same response;
//   4. the refusal is sticky for that client, because an agent retrying its
//      tool call sends a FRESH request that carries no credential;
//   5. a healthy MPP client is untouched - still challenged, still settles.
//
// Boots the real server with the paywall ACTIVE against a stub facilitator, so
// the assertions are about the real gate chain and not a mock of it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Challenge, Credential, PaymentRequest, x402 } from "mppx";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { diagnoseEvmAuthorizationDomain, domainMismatchDetail } from "../src/mpp-evm-domain.js";
import { mppChallengesSuppressed, noteWrongDomainSigner, mppFallbackStatus, _resetMppFallback } from "../src/mpp-fallback.js";

const PORT = 3105;
const FAC_PORT = 3106;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-mpp-domain-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"cd".repeat(32)}`;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

let pass = 0;
let proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub facilitator: counts every verify/settle so "never asked" is provable ----
const facCalls = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") {
      return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    }
    const parsed = body ? JSON.parse(body) : {};
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { facCalls.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { facCalls.settle++; return reply({ success: true, transaction: TX, network: "eip155:8453", payer }); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    MPP_SECRET_KEY: SECRET,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  },
  // NOT "ignore". This failed once in CI on 2026-08-31 with a healthy credential
  // getting a 402, and the server's own reason had been discarded - the run
  // proved only that something went wrong. Keep the tail.
  stdio: ["ignore", "pipe", "pipe"],
});

/** Build an MPP evm/charge credential against a live challenge, signing the
 *  EIP-3009 authorization under whatever domain NAME the caller names. */
async function credentialSignedUnder(domainName, { challenge, advertised, account, nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address, to: TREASURY, value: advertised.amount,
    validAfter: "0", validBefore: String(now + 300), nonce,
  };
  const signature = await account.signTypedData({
    domain: { name: domainName, version: "2", chainId: 8453, verifyingContract: BASE_USDC },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { header: Credential.serialize({ challenge, payload: { ...authorization, signature, type: "authorization" } }), authorization, signature };
}

const get402 = (ua) => fetch(`${B}/api/uuid`, { headers: ua ? { "User-Agent": ua } : {} });
const challengeFrom = (res) => {
  const wwwAuth = res.headers.get("www-authenticate");
  if (!wwwAuth) return null;
  return Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }))
    .find((c) => c.method === "evm" && c.intent === "charge") || null;
};

try {
  let serverLog = "";
const keep = (c) => { serverLog = (serverLog + c).slice(-8000); };
proc.stdout?.on("data", keep);
proc.stderr?.on("data", keep);
proc.on("exit", (code, sig) => { if (code) keep(`\n[server exited code=${code} sig=${sig}]`); });

let booted = false;
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { booted = true; break; } } catch {} await sleep(500); }
// A boot that never happened must SAY so. Falling through to the first fetch
// reported "TypeError: fetch failed" with no cause - which is how a corrupt
// /tmp/agent402.db (every server-booting test shares that one path) looks
// exactly like a paywall bug. Measured locally 2026-08-31.
if (!booted) {
  console.error(`server never answered /health on ${B} within 60s. Server said:\n${serverLog || "<nothing>"}`);
  process.exit(1);
}

  // ================= 1. The diagnosis itself (pure, no server) =================
  const probe = privateKeyToAccount(generatePrivateKey());
  const accepted = { network: "eip155:8453", asset: BASE_USDC, extra: { name: "USD Coin", version: "2" } };
  const authorization = {
    from: probe.address, to: TREASURY, value: "1000",
    validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${"11".repeat(32)}`,
  };
  const msg = {
    from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
    validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
  };
  const signUnder = (name, chainId = 8453, verifyingContract = BASE_USDC) => probe.signTypedData({
    domain: { name, version: "2", chainId, verifyingContract }, types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization", message: msg,
  });

  const dWrong = await diagnoseEvmAuthorizationDomain({ accepted, authorization, signature: await signUnder("USDC") });
  ok(dWrong.verdict === "domain-mismatch" && dWrong.signedName === "USDC" && dWrong.expectedName === "USD Coin",
    `AgentCore-shaped signature -> domain-mismatch (signed ${dWrong.signedName}, expected ${dWrong.expectedName})`);
  ok(dWrong.chainId === 8453 && dWrong.asset === BASE_USDC, "mismatch names the chain and token it was diagnosed on");

  const dGood = await diagnoseEvmAuthorizationDomain({ accepted, authorization, signature: await signUnder("USD Coin") });
  ok(dGood.verdict === "matches", "a signature under the advertised name -> matches");

  const dJunk = await diagnoseEvmAuthorizationDomain({ accepted, authorization, signature: `0x${"22".repeat(65)}` });
  ok(dJunk.verdict === "unknown", "an ordinary bad signature -> unknown (the facilitator still gets to judge it)");

  // Someone else's signature must never be read as this payer's mistake.
  const other = privateKeyToAccount(generatePrivateKey());
  const dOther = await diagnoseEvmAuthorizationDomain({
    accepted, authorization,
    signature: await other.signTypedData({ domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: BASE_USDC }, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message: msg }),
  });
  ok(dOther.verdict === "unknown", "a wrong-domain signature by a DIFFERENT wallet is not attributed to this payer");

  // A token outside the known USDC-name family gets no guessing at all.
  const usdg = { network: "eip155:4663", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", extra: { name: "Global Dollar", version: "1" } };
  const dUsdg = await diagnoseEvmAuthorizationDomain({ accepted: usdg, authorization, signature: await signUnder("USDC", 4663, usdg.asset) });
  ok(dUsdg.verdict === "unknown", "a non-USDC-family token (USDG) is never guessed at");

  // Celo USDC's own domain IS "USDC" - the diagnosis is per-token, not a
  // hardcoded "USD Coin is always right".
  const celo = { network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", extra: { name: "USDC", version: "2" } };
  const dCeloOk = await diagnoseEvmAuthorizationDomain({ accepted: celo, authorization, signature: await signUnder("USDC", 42220, celo.asset) });
  ok(dCeloOk.verdict === "matches", "Celo USDC signed under \"USDC\" is healthy (per-token domain, not a global default)");
  const dCeloBad = await diagnoseEvmAuthorizationDomain({ accepted: celo, authorization, signature: await signUnder("USD Coin", 42220, celo.asset) });
  ok(dCeloBad.verdict === "domain-mismatch" && dCeloBad.signedName === "USD Coin", "the mismatch is symmetric (Celo signed under \"USD Coin\")");

  ok(/USDC/.test(domainMismatchDetail(dWrong)) && /x402/.test(domainMismatchDetail(dWrong)),
    "the buyer-facing detail names the wrong domain AND the path that does work");

  // ================= 2. Suppression bookkeeping (pure) =================
  _resetMppFallback();
  const reqOf = (ua, extra = {}) => ({ ip: "9.9.9.9", headers: { "user-agent": ua, ...extra } });
  ok(!mppChallengesSuppressed(reqOf("A")), "a client we have never seen is not suppressed");
  noteWrongDomainSigner(reqOf("A"));
  ok(mppChallengesSuppressed(reqOf("A")), "after proof, that client is suppressed");
  ok(!mppChallengesSuppressed(reqOf("B")), "a different User-Agent from the same IP is NOT suppressed");
  ok(mppFallbackStatus().suppressedClients === 1, "operator status counts clients, never fingerprints");
  ok(!Object.values(mppFallbackStatus()).some((v) => typeof v === "string" && /9\.9\.9\.9/.test(v)), "no address is exposed in the status");

  // The suppression also gates the TEMPO challenge, and a wallet funded only in
  // USDC.e has no x402 offer it can pay - so a blanket hold on a shared IP+UA
  // would be a total payment denial for a client we have no evidence about.
  // Three bounds keep a collateral hit to a blip.
  _resetMppFallback();
  noteWrongDomainSigner(reqOf("C"));
  ok(!mppChallengesSuppressed(reqOf("C", { authorization: "Payment abc" })),
    "a request PRESENTING a credential is never suppressed - it is mid-flow and needs a fresh challenge");
  let held = 0;
  for (let i = 0; i < 12; i++) if (mppChallengesSuppressed(reqOf("C"))) held++;
  ok(held > 0 && held <= 6, `stickiness lapses after a few responses, not a blanket 30 minutes (held ${held})`);
  ok(!mppChallengesSuppressed(reqOf("C")), "once spent, the client is challenged normally again");

  _resetMppFallback();
  const noUa = { ip: "9.9.9.9", headers: {} };
  noteWrongDomainSigner(noUa);
  ok(noUa.mppSuppressChallenges === true, "a client with no User-Agent still gets THIS response suppressed");
  ok(!mppChallengesSuppressed({ ip: "9.9.9.9", headers: {} }),
    "...but is never REMEMBERED - address alone is too broad to withhold a payment method from");

  _resetMppFallback();
  noteWrongDomainSigner(reqOf("A"));
  process.env.MPP_EVM_DOMAIN_FALLBACK = "off";
  ok(!mppChallengesSuppressed(reqOf("A")), "MPP_EVM_DOMAIN_FALLBACK=off disarms the whole mechanism");
  delete process.env.MPP_EVM_DOMAIN_FALLBACK;
  _resetMppFallback();

  // ================= 3. Through the real server =================
  const HEALTHY_UA = "mppx-healthy-probe/1";
  const AGENTCORE_UA = "AgentCore-shaped-probe/1";

  const base402 = await get402(HEALTHY_UA);
  ok(base402.status === 402, "unpaid catalog GET -> 402");
  const prHeader = base402.headers.get("payment-required");
  const advertised = x402.Header.decodePaymentRequiredEnvelope(prHeader).accepts.find((a) => a.network === "eip155:8453");
  ok(!!advertised && advertised.extra?.name === "USD Coin", `Base accepts entry advertises its real domain name (${advertised?.extra?.name})`);

  // 3a. A HEALTHY MPP buyer still gets challenged and still settles.
  const healthyAcct = privateKeyToAccount(generatePrivateKey());
  const healthyCh = challengeFrom(base402);
  ok(!!healthyCh, "a healthy client's 402 carries an evm/charge challenge");
  const healthy = await credentialSignedUnder("USD Coin", { challenge: healthyCh, advertised, account: healthyAcct, nonce: `0x${"a1".repeat(32)}` });
  const healthyRes = await fetch(`${B}/api/uuid`, { headers: { "User-Agent": HEALTHY_UA, Authorization: healthy.header } });
  if (healthyRes.status !== 200) {
    // The most confusing failure this test can produce: the stub facilitator
    // approves everything, so a 402 here means the request never reached it.
    const body = await healthyRes.clone().text().catch(() => "<unreadable>");
    console.error(`healthy buy refused: ${healthyRes.status}\n  body: ${body.slice(0, 500)}\n  facilitator: verify=${facCalls.verify} settle=${facCalls.settle}\n  server tail:\n${serverLog.slice(-2000)}`);
  }
  ok(healthyRes.status === 200, `healthy MPP credential still settles (got ${healthyRes.status})`);
  ok(!!healthyRes.headers.get("payment-receipt"), "healthy MPP buy still gets a Payment-Receipt");
  ok(facCalls.verify === 1 && facCalls.settle === 1, `healthy buy reached the facilitator exactly once (${facCalls.verify}/${facCalls.settle})`);

  // 3b. The AgentCore-shaped credential.
  const acAcct = privateKeyToAccount(generatePrivateKey());
  const ac402 = await get402(AGENTCORE_UA);
  const acCh = challengeFrom(ac402);
  ok(!!acCh, "the AgentCore-shaped client is challenged normally on its FIRST 402");
  const wrongCred = await credentialSignedUnder("USDC", { challenge: acCh, advertised, account: acAcct, nonce: `0x${"b2".repeat(32)}` });
  const verifyBefore = facCalls.verify;
  const rejected = await fetch(`${B}/api/uuid`, { headers: { "User-Agent": AGENTCORE_UA, Authorization: wrongCred.header } });
  ok(rejected.status === 402, `wrong-domain credential -> 402 (got ${rejected.status})`);
  ok(facCalls.verify === verifyBefore, "the facilitator was NEVER asked - we recognised it locally");
  const ct = rejected.headers.get("content-type") || "";
  const problem = await rejected.json().catch(() => ({}));
  ok(/application\/problem\+json/.test(ct) && problem.type === "https://paymentauth.org/problems/verification-failed",
    `refusal is RFC 9457 problem+json, type verification-failed (got ${problem.type})`);
  ok(/"USDC"/.test(problem.detail || "") && /"USD Coin"/.test(problem.detail || "") && /x402/.test(problem.detail || ""),
    "the problem detail names both domain names and the working path");
  ok(!rejected.headers.get("www-authenticate"),
    "THE FIX: that 402 carries NO WWW-Authenticate at all, so an MPP-preferring manager has nothing to select");
  ok(!!rejected.headers.get("payment-required"),
    "...while the x402 offer is still right there in the same response");

  // 3c. Sticky: the agent's NEXT attempt is a fresh request with no credential.
  const retry402 = await get402(AGENTCORE_UA);
  ok(retry402.status === 402, "the flagged client's next bare request is still a 402");
  ok(!retry402.headers.get("www-authenticate"),
    "STICKINESS: a fresh credential-less request from that client gets no MPP challenge either");
  ok(!!retry402.headers.get("payment-required"), "...and still gets the x402 offer");

  // 3d. Nobody else is affected.
  const other402 = await get402(HEALTHY_UA);
  ok(!!other402.headers.get("www-authenticate"), "a healthy client is still challenged after another client was flagged");
  const otherAcct = privateKeyToAccount(generatePrivateKey());
  const stillGood = await credentialSignedUnder("USD Coin", { challenge: challengeFrom(other402), advertised, account: otherAcct, nonce: `0x${"c3".repeat(32)}` });
  const stillRes = await fetch(`${B}/api/uuid`, { headers: { "User-Agent": HEALTHY_UA, Authorization: stillGood.header } });
  ok(stillRes.status === 200, `and still buys (got ${stillRes.status})`);

  // 3e. A plain x402 buyer never touched any of this.
  const plain = await fetch(`${B}/api/uuid`);
  ok(plain.status === 402 && !!plain.headers.get("payment-required"), "a plain unpaid 402 is unchanged");

  console.log(`\nPASS - ${pass} checks (MPP evm EIP-712 domain fallback)`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
