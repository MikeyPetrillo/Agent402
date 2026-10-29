// A v1-era client's payment settles instead of looping forever.
//
// Measured 2026-08-30: one client sent a payment header to /api/render about
// nine times a minute for twenty-one hours and was refused every time. The
// rejection classifier, once it could report WHICH field of the echoed
// `accepted` block differed, named exactly one: `maxAmountRequired` - x402 v1's
// name for what v2 calls `amount`. Everything else in their block matched.
//
// x402 deep-equals the echoed block, so that single rename made an otherwise
// correct payment unmatchable, refused before the facilitator with a bare 402.
//
// The property that makes translating it safe, and the one this file exists to
// hold: it fires ONLY when the v2 key is absent, a shape refused 100% of the
// time today. It can turn a guaranteed failure into a normal match; it can
// never change the outcome of a payment that already works.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { translateV1Accepts } from "../src/x402-v1-accepts.js";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_MAINNET_LEGACY_CAIP2 } from "../src/avm-network.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, proc = null, facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- unit: the translation itself ----
const base = { scheme: "exact", network: "eip155:8453", asset: "0xA", payTo: "0xB", maxTimeoutSeconds: 300 };
const wrap = (accepted) => ({ x402Version: 2, scheme: "exact", network: "eip155:8453", accepted, payload: { authorization: { from: "0xF", to: "0xB", value: "20000" }, signature: "0xSIGNATURE" } });

const v1 = translateV1Accepts(wrap({ ...base, maxAmountRequired: "20000" }));
ok(v1?.payload.accepted.amount === "20000", "a v1 payload gets the value under the v2 name");
ok(!("maxAmountRequired" in v1.payload.accepted), "and the v1 key is removed, so the block deep-equals ours");
ok(v1.payload.payload.signature === "0xSIGNATURE", "the signature is carried through untouched - it signs the authorization, not this block");
ok(JSON.stringify(v1.translated) === JSON.stringify(["maxAmountRequired"]), "it reports what it translated");

ok(translateV1Accepts(wrap({ ...base, amount: "20000" })) === null,
  "a v2 payload is a NO-OP - the working path is never rewritten");
ok(translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: "999" })) === null,
  "a payload carrying BOTH is left alone - that is not a v1 client and we must not guess which it meant");
ok(translateV1Accepts(wrap(base)) === null, "no price field at all -> no-op");

// The shape the live buyer actually sends: BOTH names, same value. Renaming
// alone did not convert them - the translator correctly no-opped on what
// looked ambiguous, so the surplus alias survived and the block still failed
// to deep-equal. Dropping a key we never advertised, whose value equals the
// one that stays, cannot change the terms agreed.
const both = translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: "20000" }));
ok(!!both, "BOTH names with the SAME value is handled, not skipped");
ok(both.payload.accepted.amount === "20000" && !("maxAmountRequired" in both.payload.accepted),
  "the surplus v1 alias is dropped and the v2 value is untouched");
ok(both.translated.join(",").includes("surplus"), "and it reports that it dropped a surplus alias, not a rename");
ok(translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: "999" })) === null,
  "BOTH names with DIFFERENT values is left alone - a real disagreement about price must still fail");
// Same price, different SPELLING: a client that copies the v2 string into a v1
// NUMBER. The surplus rule shipped comparing JSON, so `20000` beside `"20000"`
// read as a disagreement and the render buyer was still refused ~1,800 times
// in fourteen hours on 2026-09-03. Equality is numeric now; junk still is not.
const numeric = translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: 20000 }));
ok(!!numeric && numeric.payload.accepted.amount === "20000" && !("maxAmountRequired" in numeric.payload.accepted),
  "a NUMERIC v1 alias equal to the string v2 amount is dropped as surplus");
ok(translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: 20001 })) === null, "a numeric alias one unit off is still a disagreement");
ok(translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: "2e4" })) === null, "a non-integer spelling is never coerced into agreement");
ok(translateV1Accepts(wrap({ ...base, amount: "20000", maxAmountRequired: 20000.5 })) === null, "a fractional alias is never coerced into agreement");
for (const junk of [null, undefined, "str", 42, [], { accepted: [] }, { accepted: "x" }]) {
  if (translateV1Accepts(junk) !== null) fail(`junk input ${JSON.stringify(junk)} should be a no-op`);
}
pass++; console.log("ok - every malformed input is a no-op, never a throw");

// The second explicit pair: the full-hash spelling of Algorand mainnet folds to
// the CAIP-2 id the 402 carries. Any other network, the CAIP-2 id itself and
// the testnet hash are left exactly as sent.
const avm = (network, over = {}) => ({ x402Version: 2, accepted: { scheme: "exact", network, asset: "31566704", payTo: "A", amount: "1000", ...over }, payload: { paymentGroup: ["x"], paymentIndex: 0 } });
const folded = translateV1Accepts(avm(ALGORAND_MAINNET_LEGACY_CAIP2));
ok(folded?.payload.accepted.network === ALGORAND_MAINNET_CAIP2 && folded.translated.join(",") === "network(alias)", "the full-hash Algorand id becomes the CAIP-2 id, reported as a network alias");
ok(folded.payload.payload.paymentGroup[0] === "x" && folded.payload.accepted.amount === "1000", "the signed group and every other term are carried through untouched");
ok(translateV1Accepts(avm(ALGORAND_MAINNET_CAIP2)) === null, "the CAIP-2 id itself is a no-op");
ok(translateV1Accepts(avm("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=")) === null, "the testnet hash is never folded to mainnet");
ok(translateV1Accepts(avm("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8")) === null && translateV1Accepts(avm(ALGORAND_MAINNET_LEGACY_CAIP2.toLowerCase())) === null, "only the exact full-hash spelling folds");
const bothPairs = translateV1Accepts(avm(ALGORAND_MAINNET_LEGACY_CAIP2, { maxAmountRequired: "1000" }));
ok(bothPairs?.payload.accepted.network === ALGORAND_MAINNET_CAIP2 && !("maxAmountRequired" in bothPairs.payload.accepted) && bothPairs.translated.length === 2, "both pairs apply to one payload");

// ---- the wire: does a v1-shaped payment actually settle? ----
const [PORT, FAC_PORT] = [await getFreePort(), await getFreePort()];
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const ALGO_TREASURY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const facCalls = { verify: 0, settle: 0, avmVerify: [], avmSettle: [] };
// One stub facilitator, two paths: the EVM rail at /evm and the Algorand rail
// at /avm, the latter listing the CAIP-2 id the way the live facilitator does.
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const [path] = req.url.split("?");
    if (path === "/evm/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    if (path === "/avm/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: ALGORAND_MAINNET_CAIP2 }], extensions: [], signers: {} }));
    if (path === "/evm/verify") facCalls.verify++;
    if (path === "/evm/settle") facCalls.settle++;
    if (path === "/avm/verify") { facCalls.avmVerify.push(JSON.parse(b)); return res.end(JSON.stringify({ isValid: true, payer: ALGO_TREASURY })); }
    if (path === "/avm/settle") { facCalls.avmSettle.push(JSON.parse(b)); return res.end(JSON.stringify({ success: true, transaction: "TX" + facCalls.avmSettle.length, network: ALGORAND_MAINNET_CAIP2, payer: ALGO_TREASURY })); }
    res.end(JSON.stringify({ isValid: true, success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453" }));
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    PAYMENT_NETWORKS: "base,algorand", ALGORAND_WALLET_ADDRESS: ALGO_TREASURY,
    FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
    PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}/evm`, ALGORAND_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}/avm`,
    ALGORAND_UPSTREAM_BUYER_ADDRESS: "", MPP_SECRET_KEY: "", PAYMENT_SETTLE_FALLBACK: "", AVM_SUBCENT_GATE: "off", CIRCLE_FACILITATOR_API_KEY: "",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", X402_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  // Build a REAL payment with a real x402 client and a real signature, then
  // rename the price field to the v1 name. A hand-assembled payload cannot
  // settle at all (the first version of this test proved nothing, because its
  // v2 control failed too), so the client has to mint the credential.
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);

  // Control: an unmodified client settles, so the harness is known-good.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const r = await wrapFetchWithPayment(fetch, client)(`${B}/api/uuid`);
    ok(r.status === 200, `control: an unmodified x402 client settles (${r.status}) - the harness can produce a real payment`);
  }

  // The live client's shape: the same real credential, price named the v1 way.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const before = facCalls.settle;

    // Capture the header the client actually mints. init.headers may be a
    // Headers instance, a plain object or an array - normalise before reading.
    // The SDK sends PAYMENT-SIGNATURE (x-payment is the older spelling), and it
    // passes a Request object rather than (url, init) - assuming either cost
    // this test two false failures, and hid a real bug where the server only
    // read x-payment.
    let minted = null;
    let mintedHeader = null;
    // The paid attempt is NOT forwarded: the credential must reach our server
    // for the FIRST time as the v1-shaped replay below. Letting the capture
    // spend it produced a 409 from the replay guard - which was itself the
    // clue that the translation works, since a 409 means the payment MATCHED.
    const capturing = async (input, init) => {
      const r = input instanceof Request ? input : new Request(input, init);
      for (const name of ["payment-signature", "x-payment"]) {
        const v = r.headers.get(name);
        if (v) { minted = v; mintedHeader = name; }
      }
      if (minted) return new Response("{}", { status: 402, headers: { "Content-Type": "application/json" } });
      return fetch(input, init);
    };
    await wrapFetchWithPayment(capturing, client)(`${B}/api/uuid`).catch(() => {});
    ok(!!minted, "captured a genuine signed payment header from the client");

    const decoded = JSON.parse(Buffer.from(minted, "base64").toString("utf8"));
    ok(!!decoded.accepted?.amount, "the genuine header echoes `accepted` carrying a v2 `amount`");

    const v1Payload = { ...decoded, accepted: { ...decoded.accepted } };
    v1Payload.accepted.maxAmountRequired = v1Payload.accepted.amount;
    delete v1Payload.accepted.amount;
    const v1Header = Buffer.from(JSON.stringify(v1Payload), "utf8").toString("base64");

    ok(mintedHeader === "payment-signature", `the SDK sends it as ${mintedHeader} - the server must read that name, not just x-payment`);
    const paid = await fetch(`${B}/api/uuid`, { headers: { [mintedHeader]: v1Header } });
    ok(paid.status === 200, `a v1-shaped payment SETTLES instead of looping (got ${paid.status})`);
    ok(facCalls.settle > before, `and it reached the facilitator to settle (${before} -> ${facCalls.settle})`);
  }

  const bare = await fetch(`${B}/api/uuid`);
  ok(bare.status === 402 && !!bare.headers.get("payment-required"), "an unpaid request is unchanged");

  // The network alias on the wire: the 402 offers Algorand under the CAIP-2
  // id, and a payment echoing that accept under the full-hash spelling (a
  // client holding its own copy of the id) still matches, verifies and
  // settles, with the facilitator asked about the CAIP-2 id. Shape-only
  // Algorand payloads reach the stub exactly as in test-avm-subcent-offer.
  {
    const pr = JSON.parse(Buffer.from(bare.headers.get("payment-required"), "base64").toString("utf8"));
    const offered = (pr.accepts || []).map((a) => a.network);
    const avmAccept = (pr.accepts || []).find((a) => String(a.network).startsWith("algorand:"));
    ok(avmAccept?.network === ALGORAND_MAINNET_CAIP2 && offered.every((n) => /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(n)), `the 402 offers Algorand as the CAIP-2 id and every accept is strict CAIP-2 (${offered.join(", ")})`);
    const payAvm = (accepted) => fetch(`${B}/api/uuid`, { headers: { "payment-signature": b64({ x402Version: 2, accepted, payload: { paymentGroup: [Buffer.from(`group-${Date.now()}-${Math.random()}`).toString("base64")], paymentIndex: 0 } }) } });

    const control = await payAvm({ ...avmAccept });
    ok(control.status === 200 && facCalls.avmSettle.length === 1, `control: a payment echoing the CAIP-2 accept settles on the Algorand rail (${control.status})`);

    const legacy = await payAvm({ ...avmAccept, network: ALGORAND_MAINNET_LEGACY_CAIP2 });
    ok(legacy.status === 200 && facCalls.avmSettle.length === 2, `a payment naming the full-hash Algorand id SETTLES (${legacy.status})`);
    const seen = facCalls.avmVerify.at(-1);
    ok(seen?.paymentPayload?.accepted?.network === ALGORAND_MAINNET_CAIP2 && seen?.paymentRequirements?.network === ALGORAND_MAINNET_CAIP2,
      "and the facilitator is asked about the CAIP-2 id on both sides of the verify");

    // An id that is not an alias of what was offered still fails to match
    // before the facilitator: the fold is a vocabulary difference, not a
    // weaker check.
    const before = facCalls.avmVerify.length;
    const testnet = await payAvm({ ...avmAccept, network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" });
    ok(testnet.status === 402 && facCalls.avmVerify.length === before, `the testnet hash matches nothing and never reaches the facilitator (${testnet.status})`);
  }

  console.log(`\nPASS - ${pass} checks (x402 v1 accepts translation)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
