// Verify falls over when a facilitator is UNREACHABLE, and never when it ANSWERS.
//
// Measured 2026-08-30: seven Solana verifies died on
// `[CDP (Base)] fetch failed [UND_ERR_CONNECT_TIMEOUT]`, and one buyer's three
// attempts in 30 s produced no settlement - the sale was lost. @x402/core
// resolves ONE client per network and does not fall back when it throws, so CDP
// (first-tried for Solana) taking a connect timeout means PayAI is never asked.
//
// The bright line these assertions exist to hold: verify is a READ, so trying a
// second facilitator cannot double charge - but a facilitator that ANSWERS has
// done its job, and retrying a verdict until somebody approves the payment
// would be shopping for a yes. Unreachable is retried; answers never are.
import { strict as assert } from "node:assert";
import { isUnreachable, isVerdict, verifyElsewhere } from "../src/verify-failover.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- classification ---------------------------------------------------------
for (const e of [
  new Error("[CDP (Base)] fetch failed [UND_ERR_CONNECT_TIMEOUT]"),
  new Error("fetch failed"), new Error("socket hang up"),
  Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
  Object.assign(new Error("x"), { cause: { code: "ETIMEDOUT" } }),
]) ok(isUnreachable(e), `unreachable: ${String(e.message).slice(0, 44)}`);

for (const e of [
  new Error("[CDP (Base)] invalid_payload: contract call failed: execution reverted"),
  new Error("insufficient funds"), new Error("invalid_exact_evm_payload_signature"),
  new Error("HTTP 400 malformed payload"),
]) {
  ok(!isUnreachable(e), `NOT unreachable: ${String(e.message).slice(0, 44)}`);
  ok(isVerdict(e), `is a verdict: ${String(e.message).slice(0, 44)}`);
}

// --- failover behaviour -----------------------------------------------------
const kinds = (network) => ({ kinds: [{ network, scheme: "exact" }] });
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const req = { network: NET, scheme: "exact" };
const mk = (label, behaviour, network = NET) => ({
  label,
  client: {
    getSupported: async () => kinds(network),
    verify: async () => {
      if (behaviour === "unreachable") throw new Error("fetch failed [UND_ERR_CONNECT_TIMEOUT]");
      if (behaviour === "rejects") throw new Error("invalid_payload: execution reverted");
      if (behaviour === "invalid") return { isValid: false, invalidReason: "insufficient_funds" };
      return { isValid: true, payer: "0xabc" };
    },
  },
});
const run = (registry, error = new Error("fetch failed [UND_ERR_CONNECT_TIMEOUT]")) =>
  verifyElsewhere({ error, paymentPayload: {}, requirements: req, registry });

ok((await run([mk("cdp", "unreachable"), mk("payai", "ok")]))?.via === "payai",
  "an unreachable first facilitator falls over to the next and recovers");
ok((await run([mk("cdp", "unreachable"), mk("payai", "invalid")]))?.result?.isValid === false,
  "a fallback that says INVALID is returned as the verdict, not skipped past");
ok((await run([mk("cdp", "unreachable"), mk("payai", "rejects"), mk("third", "ok")])) === null,
  "a fallback that REJECTS stops the search - we do not hunt for a yes");
ok((await run([mk("cdp", "unreachable"), mk("payai", "unreachable")])) === null,
  "everything unreachable recovers nothing (the original failure stands)");
ok((await run([mk("cdp", "unreachable"), mk("other", "ok", "eip155:8453")])) === null,
  "a facilitator that does not advertise this network is never asked");
ok((await run([mk("cdp", "unreachable")])) === null, "a single configured facilitator has nothing to fall over to");

// THE line: a payment REJECTION must never trigger a second opinion.
//
// The APPROVING facilitator is deliberately FIRST in these registries. With the
// rejected-payment guard in place the answer is null either way - but if the
// guard is ever removed, the loop reaches an approver immediately and returns a
// recovery, so the assertion fails. An earlier version of this test put the
// rejecting client first, which made it pass for the wrong reason: the loop
// re-asked that same client, got the same rejection, and stopped. The mutation
// "retry on ANY failure" survived a green run.
ok((await run([mk("payai", "ok"), mk("cdp", "rejects")], new Error("invalid_payload: execution reverted"))) === null,
  "a rejected payment is NEVER re-verified elsewhere, even with an approver first in the registry");
ok((await run([mk("payai", "ok"), mk("cdp", "rejects")], new Error("insufficient funds"))) === null,
  "an underfunded wallet is NEVER re-verified elsewhere, even with an approver first");
ok((await run([mk("payai", "ok"), mk("cdp", "rejects")], new Error("invalid_exact_evm_payload_signature"))) === null,
  "a bad signature is NEVER re-verified elsewhere, even with an approver first");

// A client that cannot describe itself is skipped rather than guessed at.
ok((await run([mk("cdp", "unreachable"), { label: "mute", client: { getSupported: async () => { throw new Error("nope"); }, verify: async () => ({ isValid: true }) } }])) === null,
  "a facilitator whose support cannot be read is skipped, never guessed");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
