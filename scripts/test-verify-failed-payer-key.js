// verify_failed carries WHO failed, as a one-way id.
//
// 2026-08-30: seven CDP connect timeouts on Solana in a day, and no way to tell
// "one flaky client retrying" from "several clients hitting a real fault" -
// which is the whole difference between ignoring it and acting on it. Three of
// the seven fell inside thirty seconds, hinting at one retrying caller, but the
// event carried nothing to confirm it and the investigation stalled there.
//
// The id is derived, never the address: an HMAC of the signed EIP-3009 `from`,
// or of the credential when no payer is readable (SVM and Stellar payloads
// carry none), truncated to 32 hex and prefixed a402: - the same construction
// as the gateway's upstream user id, so the two can be compared without either
// carrying an address. Same payer always yields the same id, which is what
// makes a retry loop visible; the id cannot be turned back into a wallet.
//
// The rest of the file guards the boundary: posthog.js must never receive the
// raw address, and a failure to derive the id must never break a payment.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
// The recorder's own event, read from posthog.js's in-memory test sink (no
// network), under the telemetry secret the recorder reads from the env. Set
// before any src/ module loads: posthog.js reads both once at import.
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.TELEMETRY_ID_SECRET = "test-telemetry-secret";
let pass=0, fail=0; const ok=(c,m)=>{c?(pass++,console.log("ok - "+m)):(fail++,console.error("FAIL - "+m));};

const posthog = await readFile("src/posthog.js","utf8");
const payments = await readFile("src/payments.js","utf8");
const block = posthog.slice(posthog.indexOf("capturePostHogVerifyFailed"), posthog.indexOf("capturePostHogVerifyFailed")+1600);

ok(/payerKey \? \{ payerKey: String\(payerKey\)/.test(block), "the event carries payerKey when present");
ok(!/payer:\s*String\(payer\)/.test(block) && !/authorization\.from/.test(block), "posthog.js never sees a raw address");

const derive = payments.slice(payments.indexOf("let payerKey = null;"), payments.indexOf("capturePostHogVerifyFailed({"));
// KEYED, not a bare digest. A bare sha256 of an EVM address is reversible in
// practice: the candidate set is public and enumerable (every address that has
// settled USDC on Base), so anyone with the analytics data recovers the payer by
// hashing candidates. The old assertion below - that the output is not itself an
// address - passes happily for a fully enumerable id, which is how this shipped
// describing itself as one-way.
ok(/createHmac\("sha256", idSecret\)/.test(derive), "the id is an HMAC under a secret, not a bare hash");
ok(/basis && idSecret/.test(derive), "no secret means NO id - never a reversible one");
ok(!/createHash\("sha256"\)\.update\(basis\)/.test(derive), "the bare-hash construction is gone");
ok(/slice\(0, 32\)/.test(derive), "truncated to 32 hex, matching the gateway's upstream user id");
ok(/`a402:\$\{/.test(derive), "prefixed a402: like the existing derived ids");
ok(/svm-payer:\$\{svm\}/.test(derive), "an SVM payload's buyer is read from its signed transaction (svm-payer.js) - a credential is per attempt, a wallet is not");
ok(/credentialKeyOf/.test(derive), "falls back to the credential when no payer is readable (Stellar)");
ok(/catch \{ \/\* telemetry is best-effort \*\/ \}/.test(derive), "a derivation failure never breaks the payment path");

// The property that matters: same payer -> same id, and the id cannot be reversed.
const SECRET = "test-telemetry-secret";
const idOf = (from) => "a402:" + createHmac("sha256", SECRET).update(`payer:${from.toLowerCase()}`).digest("hex").slice(0,32);
const a = idOf("0xAbC0000000000000000000000000000000000001");
ok(a === idOf("0xabc0000000000000000000000000000000000001"), "same payer, same id (case-insensitive) - retries are groupable");
ok(a !== idOf("0xAbC0000000000000000000000000000000000002"), "different payers get different ids");
ok(!/0x/.test(a.slice(5)) && a.length === 5 + 32, "the id carries no address material");

// The caller path for Solana: the id and the log line name the TransferChecked
// authority, on a v2 CAIP-2 network and on an x402 v1 network name alike, and
// never the co-signer that sits first after the fee payer.
{
  const kit = await import("@solana/kit");
  const { verifyFailurePayerKey, registerFacilitatorFailureHooks } = await import("../src/payments.js");
  const { shortPayer } = await import("../src/verify-failure-log.js");
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const fp = await kit.generateKeyPairSigner(), decoy = await kit.generateKeyPairSigner(), buyer = await kit.generateKeyPairSigner();
  const src = (await kit.generateKeyPairSigner()).address, payTo = (await kit.generateKeyPairSigner()).address;
  const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(fp.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstructions([{ programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(USDC), role: kit.AccountRole.READONLY },
      { address: kit.address(payTo), role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
      { address: decoy.address, role: kit.AccountRole.WRITABLE_SIGNER, signer: decoy },
    ], data: new Uint8Array([12, ...u64(1000), 6]) }], m));
  const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([decoy.keyPair, buyer.keyPair], kit.compileTransaction(msg)));
  const keyOf = (basis) => "a402:" + createHmac("sha256", SECRET).update(basis).digest("hex").slice(0, 32);
  const hooks = {};
  registerFacilitatorFailureHooks({ onVerifyFailure() { return this; }, onAfterVerify(fn) { hooks.after = fn; return this; }, onAfterSettle() { return this; }, onSettleFailure() { return this; } }, null, null, {});
  for (const [label, network, paymentPayload] of [
    ["v2", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", { x402Version: 2, payload: { transaction: tx } }],
    ["v1", "solana", { x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: tx } }],
  ]) {
    const ctx = { paymentPayload, requirements: { scheme: "exact", network, amount: "1000", extra: { feePayer: fp.address } } };
    const key = await verifyFailurePayerKey(ctx, { idSecret: SECRET });
    ok(key === keyOf(`svm-payer:${buyer.address}`), `${label} Solana network: the verify-failure id is keyed on the transfer authority (${key === keyOf(`svm-payer:${decoy.address}`) ? "got the decoy" : key})`);
    const lines = [];
    const warn = console.warn; console.warn = (...a) => lines.push(a.join(" "));
    try { await hooks.after({ ...ctx, result: { isValid: false, invalidReason: "transaction_simulation_failed" } }); } finally { console.warn = warn; }
    // The event recordVerifyFailure sends carries the same id: the caller
    // path, not only the helper (posthog.js loads behind a dynamic import).
    const { _testEventsForTest } = await import("../src/posthog.js");
    await new Promise((r) => setImmediate(r));
    const sent = _testEventsForTest().filter((e) => e.event === "verify_failed").at(-1);
    ok(sent?.properties?.payerKey === keyOf(`svm-payer:${buyer.address}`), `${label} Solana network: the recorded verify_failed event carries the transfer authority's id (${sent ? sent.properties.payerKey ?? "no payerKey" : "no event"})`);
    _testEventsForTest().length = 0;
    const line = lines.find((l) => /facilitator VERIFY rejected/.test(l)) || "";
    ok(line.includes(`payer=${shortPayer(buyer.address)}:`) && shortPayer(buyer.address) !== shortPayer(decoy.address), `${label} Solana network: the verify-failure log line names the transfer authority (${line.replace(/^.*payer=/, "payer=").slice(0, 40)})`);
  }
  ok(await verifyFailurePayerKey({ paymentPayload: { x402Version: 2, payload: { transaction: tx } }, requirements: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } }, { idSecret: "" }) === null, "no secret, no id");
}

console.log(`\n${fail?"FAILED":"OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
