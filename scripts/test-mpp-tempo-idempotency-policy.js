// src/mpp-tempo.js relayFetch: the Tempo relay refuses an idempotent broadcast
// whose transaction is valid for more than an hour (`policy_denied`:
// "Idempotent broadcasts require a transaction validBefore within one hour").
// mppx sends an idempotency-key on every broadcast and a buyer's SDK picks the
// validBefore, so the refusal lands after our handler ran (measured 2026-10-09
// on four outside payments: handler 200, relay refused, buyer answered 402 and
// not charged). The refusal is the key's, not the payment's, so the same
// request is re-sent once without the key. Drives relayFetch through its test
// seam against a stubbed global fetch and asserts: two calls, the second with
// no idempotency-key header and the same body, the trace marked; any other
// 2xx refusal, a refusal on validate, or a broadcast with no key is not
// retried. Mutation-checked: dropping the retry fails the first assertion.
import { __testRelayFetch, isIdempotencyPolicyRefusal } from "../src/mpp-tempo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const REFUSAL = JSON.stringify({ success: false, error: { code: "policy_denied", message: "Idempotent broadcasts require a transaction validBefore within one hour." } });
const SUCCESS = JSON.stringify({ success: true, transactionHash: "0xabc" });
const json = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const BROADCAST = "https://relay.example/v1/mpp/broadcast";
const VALIDATE = "https://relay.example/v1/mpp/validate";
const keyOf = (init) => {
  const h = init?.headers;
  if (!h) return null;
  const entries = typeof h.entries === "function" ? [...h.entries()] : Object.entries(h);
  const hit = entries.find(([k]) => k.toLowerCase() === "idempotency-key");
  return hit ? hit[1] : null;
};

async function run(answer, url, init) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, i) => { calls.push({ url: String(input), init: i }); return answer(calls.length, i); };
  try { return { ...(await __testRelayFetch(url, init)), calls }; } finally { globalThis.fetch = realFetch; }
}
const refuseKeyed = (n, init) => json(keyOf(init) ? REFUSAL : SUCCESS);
const body = JSON.stringify({ transaction: "0xdeadbeef" });
const headers = { Accept: "application/json", "content-type": "application/json", "tempo-api-key": "k", "idempotency-key": "idem-1" };

// 1. The live shape: keyed broadcast refused, re-sent without the key.
let r = await run(refuseKeyed, BROADCAST, { method: "POST", body, headers });
ok(r.calls.length === 2, `a keyed broadcast the relay refuses for its validBefore is re-sent once (calls=${r.calls.length})`);
ok(r.calls.length === 2 && keyOf(r.calls[1].init) === null, "the second send carries no idempotency-key");
ok(r.calls.length === 2 && r.calls[1].init.body === body && r.calls[1].init.method === "POST", "the second send is the same body and method");
ok(r.calls.length === 2 && r.calls[1].init.headers["tempo-api-key"] === "k" && r.calls[1].init.headers.Accept === "application/json", "the other headers are kept");
ok(r.res && r.res.status === 200 && (await r.res.clone().json()).success === true, "the caller gets the second answer");
ok(r.trace.policyRetried === true, "the trace says the policy retry happened");
ok(!r.trace.relayError, "a successful retry leaves no relay error on the trace");

// 2. Headers as a Headers object (mppx may build one).
r = await run(refuseKeyed, BROADCAST, { method: "POST", body, headers: new Headers(headers) });
ok(r.calls.length === 2 && keyOf(r.calls[1].init) === null && r.calls[1].init.headers["tempo-api-key"] === "k", "a Headers object is read and rewritten the same way");

// 3. A broadcast with no key is never retried; the refusal is reported.
r = await run(() => json(REFUSAL), BROADCAST, { method: "POST", body, headers: { "tempo-api-key": "k" } });
ok(r.calls.length === 1 && !r.trace.policyRetried, "a broadcast sent without a key is not re-sent");
ok(/policy_denied/.test(r.trace.relayError || ""), "its refusal reaches the trace");

// 4. The retry is once: a second refusal stands.
r = await run(() => json(REFUSAL), BROADCAST, { method: "POST", body, headers });
ok(r.calls.length === 2 && /policy_denied/.test(r.trace.relayError || ""), "a refusal that survives the keyless send is reported, not retried again");

// 5. Any other 2xx refusal on a keyed broadcast is not retried.
for (const other of [
  { success: false, error: { code: "policy_denied", message: "Transaction value exceeds the relay policy." } },
  { success: false, error: { code: "insufficient_funds", message: "validBefore within one hour" } },
  { success: false, error: { code: "unknown", message: "Invalid transaction: no matching payment call found" } },
]) {
  r = await run(() => json(JSON.stringify(other)), BROADCAST, { method: "POST", body, headers });
  ok(r.calls.length === 1 && !r.trace.policyRetried, `not retried: ${other.error.code} "${other.error.message.slice(0, 40)}"`);
}

// 6. A non-2xx answer with the same body is not retried (the loop's own rules apply).
r = await run(() => json(REFUSAL, 400), BROADCAST, { method: "POST", body, headers });
ok(r.calls.length === 1 && !r.trace.policyRetried, "a 400 carrying the policy text is not the retry case");

// 7. Validate is never retried for this.
r = await run(refuseKeyed, VALIDATE, { method: "POST", body, headers });
ok(r.calls.length === 1 && !r.trace.policyRetried, "a validate answer is never re-sent for the key");

// 8. Success first time: one call.
r = await run(() => json(SUCCESS), BROADCAST, { method: "POST", body, headers });
ok(r.calls.length === 1 && !r.trace.policyRetried, "a broadcast that succeeds is sent once");

// 9. The predicate on its own.
ok(await isIdempotencyPolicyRefusal(json(REFUSAL)) === true, "predicate: the live refusal");
ok(await isIdempotencyPolicyRefusal(json(SUCCESS)) === false, "predicate: success");
ok(await isIdempotencyPolicyRefusal(new Response("not json", { status: 200 })) === false, "predicate: non-JSON");
ok(await isIdempotencyPolicyRefusal(json(JSON.stringify({ success: true, error: { code: "policy_denied", message: "validBefore within one hour" } }))) === false, "predicate: needs success:false");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
