// LIVE proof that a metered call settles BELOW the ceiling the buyer authorized.
//
// The flat-price gateway charges the tier price whatever a call cost. Metering bills
// the actual cost plus a markup, using x402's `upto` scheme - the buyer signs a
// Permit2 authorization for a CEILING and the seller names the settled amount
// afterwards, never above it.
//
// The claim worth proving on-chain is exactly one thing: the amount that
// actually MOVED is less than the amount that was authorized. Everything else
// (the 402 offering upto, the client signing it, a 200 coming back) can be true
// while the buyer is still charged the full ceiling, which is the failure this
// exists to catch. So the assertion is on the SETTLED amount, read from the
// settle receipt, not on the response status.
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const ROUTE = process.env.METER_ROUTE || "/v1/chat/completions";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const die = (m, code = 2) => { console.error(`upto-meter-canary: ${m}`); process.exit(code); };
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) die("no BURNER_KEY");
const secret = (process.env.POW_SECRET || "").trim();
if (!secret) die("no POW_SECRET - this canary would otherwise record as external demand");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const hb = () => createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32);
console.log(`buyer:  ${account.address}`);
console.log(`target: ${TARGET}${ROUTE}`);

// --- 0. the 402 must actually offer upto -----------------------------------
const bare = await fetch(`${TARGET}${ROUTE}`, {
  method: "POST", headers: { "content-type": "application/json", "X-Heartbeat-Token": hb() },
  body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 8 }),
});
if (bare.status !== 402) fail(`expected a 402 from ${ROUTE}, got ${bare.status} (nothing to meter if the route is not paid)`);
const prHeader = bare.headers.get("payment-required");
if (!prHeader) fail("402 carried no payment-required header");
const accepts = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")).accepts || [];
const uptoOption = accepts.find((a) => String(a.scheme).toLowerCase() === "upto" && String(a.network) === "eip155:8453");
if (!uptoOption) {
  fail(`the live 402 offers no upto option on Base (schemes: ${[...new Set(accepts.map((a) => a.scheme))].join(", ") || "none"}). ` +
       `X402_UPTO_NETWORKS must include eip155:8453 for metering to be possible at all.`);
}
const ceilingAtomic = BigInt(uptoOption.maxAmountRequired ?? uptoOption.amount ?? 0);
if (ceilingAtomic <= 0n) fail(`the upto option names no ceiling (${JSON.stringify(uptoOption).slice(0, 200)})`);
console.log(`ceiling authorized: ${ceilingAtomic} atomic units ($${(Number(ceilingAtomic) / 1e6).toFixed(6)})`);

// --- 1. Permit2 allowance, the precondition upto cannot work without --------
const { getPermit2AllowanceReadParams } = await import("@x402/evm/upto/client");
const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
try {
  const params = getPermit2AllowanceReadParams({ tokenAddress: BASE_USDC, ownerAddress: account.address });
  const allowance = await pub.readContract(params);
  console.log(`permit2 allowance: ${allowance}`);
  if (!allowance || BigInt(allowance) < ceilingAtomic) {
    die(`the burner has not approved Permit2 for USDC on Base (allowance ${allowance}). ` +
        `upto pays through Permit2, so this is a one-time on-chain approval the wallet must make before ANY metered payment can be signed. ` +
        `Use createPermit2ApprovalTx from @x402/evm/upto/client.`, 2);
  }
} catch (e) {
  die(`could not read the Permit2 allowance (${String(e?.message || e).slice(0, 160)}) - refusing to sign blind`, 2);
}

// --- 2. pay it over upto ----------------------------------------------------
const [{ x402Client }, { wrapFetchWithPayment }, { UptoEvmScheme }, { toClientEvmSigner }] = await Promise.all([
  import("@x402/core/client"), import("@x402/fetch"), import("@x402/evm/upto/client"), import("@x402/evm"),
]);
const client = disableVendorSpendControls(new x402Client());
// UptoEvmScheme takes the signer POSITIONALLY - `new UptoEvmScheme(signer, options?)`.
// The exact scheme is registered through a HELPER that takes an options object
// (`registerExactEvmScheme(client, { signer })`), and pattern-matching that shape
// onto this constructor passes an object whose signTypedData is undefined, which
// fails at signing time rather than at registration. Same class as passing an
// options object to createPermit2ApprovalTx, which takes its token positionally.
//
// toClientEvmSigner composes the account with a public client so the scheme can
// also read on-chain state, which upto needs for Permit2 extension enrichment.
client.register("eip155:8453", new UptoEvmScheme(toClientEvmSigner(account, pub)));
const payFetch = wrapFetchWithPayment(fetch, client);

let res;
try {
  res = await payFetch(`${TARGET}${ROUTE}`, {
    method: "POST", headers: { "content-type": "application/json", "X-Heartbeat-Token": hb() },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 8 }),
  });
} catch (e) {
  fail(`paying over upto threw: ${String(e?.message || e).slice(0, 300)}`);
}
const body = await res.text();
console.log(`status: ${res.status}`);
if (res.status !== 200) fail(`metered call returned ${res.status}: ${body.slice(0, 300)}`);

// A buyer must never see our upstream bill.
if (/__meterUpstreamUsd|cost_details|is_byok/.test(body)) fail(`the response leaked a billing field: ${body.slice(0, 300)}`);

// --- 3. THE ASSERTION: what actually moved, versus what was authorized ------
const payResp = res.headers.get("payment-response") || res.headers.get("x-payment-response");
if (!payResp) fail("settled 200 but carried no payment-response header, so the settled amount cannot be read");
let settled;
try {
  const decoded = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
  settled = BigInt(decoded.amount ?? decoded.settledAmount ?? decoded.payment?.amount ?? 0);
  console.log(`settle receipt: ${JSON.stringify(decoded).slice(0, 300)}`);
} catch (e) {
  fail(`could not read the settle receipt (${String(e?.message || e).slice(0, 160)})`);
}
const meterHeader = res.headers.get("x-metered-usd");
console.log(`metered header: ${meterHeader || "(none)"}`);
console.log(`settled: ${settled} atomic units ($${(Number(settled) / 1e6).toFixed(6)})  vs ceiling ${ceilingAtomic}`);

if (settled <= 0n) fail("the receipt reports a zero settle: nothing was charged");
if (settled >= ceilingAtomic) {
  fail(`settled ${settled} against a ceiling of ${ceilingAtomic} - the buyer was charged the FULL ceiling, so metering is not in effect. ` +
       `Check GATEWAY_METERED_BILLING=on in prod and that the handler reported a cost.`);
}

const ratio = Number(ceilingAtomic) / Number(settled);
console.log(`\nPASS - a metered call settled BELOW its ceiling against production.`);
console.log(`  authorized $${(Number(ceilingAtomic) / 1e6).toFixed(6)}, charged $${(Number(settled) / 1e6).toFixed(6)} (${ratio.toFixed(1)}x less than the flat price)`);
