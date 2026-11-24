// Unit test for the Algorand rail canary's paid-attempt classifiers
// (scripts/avm-canary-classify.js). These decide whether a non-200 buy in the
// ~500-tool weekly sweep is a real rail/tool defect (fails the run) or a
// third-party/edge outage or our-own-burst throttle (reported, does not fail).
// Getting this wrong is why #806 stayed open: a transient edge 502 or an
// upstream vendor 5xx was booked as a broken tool on first sight.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { outcomeOf, nextStep, transportAttempt, avmPaymentTxid, readPaymentOnChain, settledChainReading, noAnswerVerdict, recheckVerdict, isUpstreamOutage, isThrottle, isOurSettleBreaker, subcentBudget, rotateSubcent, isBuyerNetworkError, errorText, failedClasses, isEdgeTimeout, isNoSellerMatched } from "./avm-canary-classify.js";
import { classesText } from "./algorand-canary-classes.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)})`}`);
const R = (status, body = "", elapsedMs = 6000) => ({ status, body, elapsedMs });

// ---- a throw before any paid request (the runner's network) ----
{
  const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  ok(isBuyerNetworkError(fetchFailed) && isBuyerNetworkError(Object.assign(new Error("x"), { cause: { code: "EAI_AGAIN" } })) && isBuyerNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" })) && isBuyerNetworkError(new TypeError("fetch failed")), "a transport failure preparing a payment (fetch failed, a reset, DNS, a timeout) is the runner's network");
  ok(!isBuyerNetworkError(new Error("unsupported scheme for network algorand:x")) && !isBuyerNetworkError(new TypeError("Cannot read properties of undefined")) && !isBuyerNetworkError(null), "an offer the client cannot sign, or a bug, is not the runner's network");
  ok(errorText(fetchFailed) === "fetch failed <- ECONNRESET read ECONNRESET", `the log line names the cause (${errorText(fetchFailed)})`);
  const r = { railFail: [], toolFail: [], chargedNoAnswer: [], chargeUnverified: [], noAnswer: [], chargedEmpty: [], buyerNetwork: [{ key: "x" }], aborted: null };
  eq(failedClasses(r, []), [], "a run with only a runner-network row names no failed class");
  eq(failedClasses({ ...r, toolFail: [{}] }, []), ["tool-failure"], "a tool failure alone names only that class");
  eq(failedClasses({ ...r, railFail: [{}], chargedEmpty: [{}] }, [{ key: "y" }]), ["rail-failure", "unexpected-missing-accept", "charged-empty"], "each failed class is named, in order");
  const one = classesText({ failedClasses: ["tool-failure"] });
  ok(/tool failure/.test(one) && !/rail failure/.test(one) && !/missing accept/.test(one), "the alert lists only the class that failed");
  ok(/rail failure/.test(classesText(null)) && /tool failure/.test(classesText(null)), "an unreadable report lists every class");
  const yml = readFileSync(new URL("../.github/workflows/algorand-rail-canary.yml", import.meta.url), "utf8");
  ok(yml.includes("node scripts/algorand-canary-classes.js rail-report.json") && !yml.includes("Three failure classes"), "the workflow's alert text comes from the report's failed classes");
  const canary = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  ok(/report\.failedClasses = failedClasses\(report, unexpectedNoAvm\)/.test(canary) && /attemptOnce\(\)/.test(canary) && /e\?\.buyerSide/.test(canary), "the sweep retries a throw before any paid request once and writes its failed classes");
}

// ---- outcomeOf ----
ok(outcomeOf(R(200, '{"x":1}')) === "ok", "200 with a body is ok");
ok(outcomeOf(R(200, "   ")) === "empty", "200 with a blank body is empty");
ok(outcomeOf(R(200, "")) === "empty" && outcomeOf({ status: 200, elapsedMs: 10 }) === "empty" && outcomeOf(R(200, "", 10)) === "empty",
  "200 with no body, or one that could not be read (the sweep reads it as \"\"), is empty at any speed");

// ---- nextStep: what is signed again, every branch ----
// A 200 is the settled status: an empty one is a charge, never a retry (a
// retry that answered would be two charges with one counted and exit 0).
ok(nextStep("empty") === "charged-empty", "a 200 with an empty body is charged-empty");
ok(nextStep(outcomeOf(R(200, ""))) !== "retry" && nextStep(outcomeOf(R(200, " \n"))) !== "retry", "...so an empty or unreadable 200 is NEVER signed again");
ok(nextStep("ok") === "done", "a delivered payload is done");
ok(nextStep("no-answer") === "read-chain", "no answer: the chain decides before anything is signed");
ok(nextStep("unfunded") === "stop", "an unfunded wallet stops, no retry");
for (const o of ["breaker", "fast-402", "throttle", "slow-402", "other"]) ok(nextStep(o) === "retry", `an HTTP error answer (${o}) cancels settlement: one fresh retry`);
ok(nextStep("something-new") === "stop" && nextStep(undefined) === "stop", "an outcome nobody classified signs nothing");
// Every outcome outcomeOf can name is decided, and only >=400 answers retry.
for (const [a, want] of [[R(200, "x"), "done"], [R(200, ""), "charged-empty"], [R(402, "{}", 85), "retry"], [R(402, "{}", 5629), "retry"], [R(429, ""), "retry"], [R(500, "x"), "retry"], [transportAttempt(new Error("socket hang up"), 10, "T"), "read-chain"]])
  ok(nextStep(outcomeOf(a)) === want, `status ${a.status} -> ${want}`);
ok(outcomeOf(R(402, "{}", 85)) === "fast-402", "a sub-1.5s 402 is fast-402 (never reached the chain)");
ok(outcomeOf(R(402, "{}", 5629)) === "slow-402", "a 5.6s 402 is slow-402 (a genuine settlement attempt)");
ok(outcomeOf(R(402, '{"error":"Payment rejected","reason":"requirements-mismatch","hint":"..."}', 40)) === "slow-402",
  "a FAST 402 carrying our gate's own named refusal is a rail verdict, never a throttle (metered Messages, 2026-08-31 + 09-07)");
ok(outcomeOf(R(402, '{"error":"Payment required"}', 40)) === "fast-402", "a fast bare 402 with no named refusal is still fast-402");
// The 402 body now also carries the PaymentRequired offer, mirrored from the
// PAYMENT-REQUIRED header: a refusal with a hint carries no `error` at all, and
// the offer's extensions can hold a `reason` of their own inside an example.
ok(outcomeOf(R(402, JSON.stringify({ reason: "requirements-mismatch", hint: "...", retry: "rebuild-payment", x402Version: 2, resource: {}, accepts: [], extensions: {} }), 40)) === "slow-402",
  "a FAST gate refusal in the mirrored shape (no error, our reason first, then the offer) is still a rail verdict");
ok(outcomeOf(R(402, JSON.stringify({ x402Version: 2, error: "Payment required", resource: {}, accepts: [], extensions: { bazaar: { info: { output: { example: { reason: "requirements-mismatch" } } } } } }), 40)) === "fast-402",
  "a fast mirrored unpaid 402 whose only `reason` is nested in an extension example is still fast-402");
ok(outcomeOf(R(402, JSON.stringify({ error: "Payment rail temporarily unavailable", reason: "facilitator-quota", retry: "other-network" }), 40)) === "fast-402",
  "a fast settle refusal on OUR billing quota (facilitator-quota) is not a gate refusal");
ok(outcomeOf(R(402, '<html>"reason": "requirements-mismatch"</html>', 40)) === "fast-402",
  "a fast non-JSON 402 is never read as a gate refusal, whatever text it holds");
ok(outcomeOf(R(429, "rate limited")) === "throttle", "429 is throttle");
ok(outcomeOf(R(503, "rate limit exceeded")) === "throttle", "503 that says rate-limit is throttle");
ok(outcomeOf(R(502, "upstream error")) === "other", "a 502 is 'other' (handed to the upstream-vs-tool split)");
ok(outcomeOf(R(409, '{"error":"Payment authorization already used."}')) === "other", "409 replay is 'other'");
ok(outcomeOf(R(500, '{"error":"bad thing"}')) === "other", "500 is 'other'");

// ---- isUpstreamOutage: the NON-failing third-party/edge signatures ----
ok(isUpstreamOutage(502, "upstream error") === true, "502 'upstream error' (Railway edge mid-deploy) is an upstream outage");
ok(isUpstreamOutage(500, '{"error":"The operation was aborted due to timeout"}') === true, "500 'aborted due to timeout' (Blockscout) is an upstream outage");
ok(isUpstreamOutage(502, '{"error":"Seller rejected the paid retry (HTTP 500)"}') === true, "router 'Seller rejected the paid retry' is an upstream outage");
ok(isUpstreamOutage(504, "") === true, "504 Gateway Timeout is an upstream outage");
ok(isUpstreamOutage(503, "") === true, "a bare 503 is an upstream outage");

// ---- what MUST still fail the run (our own defect) ----
ok(isUpstreamOutage(409, '{"error":"Payment authorization already used."}') === false, "a 409 that SURVIVES a fresh retry is a real replay bug, not an upstream outage");
ok(isUpstreamOutage(500, '{"error":"TypeError: cannot read x"}') === false, "a 500 from our own handler is NOT an upstream outage");
ok(isUpstreamOutage(400, '{"error":"bad input"}') === false, "a 400 is our own validation, not an upstream outage");
ok(isUpstreamOutage(422, '{"error":"unprocessable"}') === false, "a 422 is not an upstream outage");

// ---- isThrottle only catches the burst shapes ----
ok(isThrottle(429, "") === true && isThrottle(503, "overloaded") === true, "429 and 503+overload are throttles");
ok(isThrottle(502, "upstream error") === false && isThrottle(500, "") === false, "502/500 are not throttles");

// ---- end-to-end intent: the exact 2026-08-19 failure set is now non-failing ----
const survivors = [
  R(502, "upstream error"),                                          // xml-validate (pure CPU! edge blip)
  R(500, '{"error":"The operation was aborted due to timeout"}'),    // a paid upstream that timed out
  R(502, '{"error":"Seller rejected the paid retry (HTTP 500)"}'),   // a paid upstream that 5xx'd after payment
  R(502, "upstream error"),                                          // lei-lookup
];
ok(survivors.every((a) => outcomeOf(a) === "other" && isUpstreamOutage(a.status, a.body)), "every persistent third-party/edge failure from run 32301215912 is classified upstream (non-failing), not a tool defect");

// ---- bare (unpaid) probe: a 502/503/504 is the edge in front of the tool
// (the handler only ever answers 402 unpaid), so it is an upstream outage;
// a 500/404 with a real body is a genuine defect. #842 was opened on a bare
// 502 for nft-holdings while it was 402ing fine seconds later.
ok(isUpstreamOutage(502, "") === true && isUpstreamOutage(503, "") === true && isUpstreamOutage(504, "") === true, "a bare-probe 502/503/504 (no body) is an upstream/edge outage");
ok(isUpstreamOutage(500, "") === false && isUpstreamOutage(404, "") === false && isUpstreamOutage(400, "") === false, "a bare-probe 500/404/400 is NOT auto-excused (a real problem still fails)");

// ---- OUR OWN settle breaker is not a vendor throttle -----------------------
//
// From run 35604560799 (2026-09-21), verbatim. An upstream facilitator failed
// 14 minutes into the sweep after 145 clean settlements; three settle failures
// opened our per-wallet breaker, and 346 of the remaining attempts came back as
// this and were reported as "upstream throttles (vendor refused us even after a
// backoff)". Our own guard, described as somebody else's, at the top of the
// only file anyone reads when the rail breaks.
const BREAKER_BODY = '{"error":"Recent payments from this wallet failed to settle (3 in the last 15 min: they verified, the call was served, and settlement failed). Retry after the window clears."}';
ok(isOurSettleBreaker(429, BREAKER_BODY) === true, "the live breaker body from run 35604560799 is recognised as ours");
ok(outcomeOf(R(429, BREAKER_BODY)) === "breaker", "...and classifies as `breaker`, not `throttle`");
ok(isThrottle(429, BREAKER_BODY) === false, "...and is NOT also counted as a vendor throttle - one refusal, one class");

// The global half of the same guard, which pauses the paid catalog rather than
// one wallet. Same conclusion for the sweep: nothing was measured.
ok(outcomeOf(R(429, '{"error":"The paid catalog is paused for a moment."}')) === "breaker", "the GLOBAL pause is also ours, not a vendor");

// CONTROL, in the other direction: a real vendor 429 must still read as a
// throttle. A predicate that swallowed every 429 would hide the facilitator
// rate-limiting our volume, which is the thing isThrottle was written for.
ok(isOurSettleBreaker(429, "rate limit exceeded") === false, "a vendor 429 is NOT claimed as ours");
ok(outcomeOf(R(429, "rate limit exceeded")) === "throttle", "...and still classifies as a vendor throttle");
ok(isOurSettleBreaker(402, BREAKER_BODY) === false, "the text alone is not enough - it has to be a 429");

// Ordering: `breaker` is decided before the 402 shapes and before isThrottle,
// because it is the only outcome that says nothing at all about the tool.
ok(outcomeOf({ status: 429, body: BREAKER_BODY, elapsedMs: 50 }) === "breaker", "a FAST breaker refusal is still a breaker, not a fast-402 or a throttle");

// ---- a paid request that got no HTTP answer --------------------------------
// The server settles a connection that closes during its settle call, so a
// request that threw may have been charged. The rule: never exit 0 after a
// possible charge. The chain is asked about the signed payment BEFORE anything
// is signed again.
{
  const algosdk = (await import("algosdk")).default;
  const TXID = "A".repeat(52);
  const dropped = transportAttempt(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }), 1200, TXID);
  ok(dropped.status === 0 && dropped.noAnswer === true && dropped.elapsedMs === 1200 && dropped.tx === null && dropped.txid === TXID, "a thrown request is shaped as an attempt with no status, no receipt, and its payment's id");
  ok(/fetch failed \(UND_ERR_SOCKET\)/.test(dropped.body) && dropped.kind === "connection", "...whose body names the error and its cause code, kind `connection`");
  ok(outcomeOf(dropped) === "no-answer", "...and it classifies `no-answer`, never `other`: its payment's fate is unknown");
  const timedOut = transportAttempt(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 90000, TXID);
  ok(outcomeOf(timedOut) === "no-answer" && timedOut.kind === "timeout", "the request's own deadline reads the same way, kind `timeout`");
  ok(outcomeOf(transportAttempt(new Error("Invalid URL"), 3)) === "no-answer" && transportAttempt(new Error("Invalid URL")).txid === null, "any other throw is a no-answer too, with no id unless one is given");
  ok(outcomeOf({ status: 500, body: "fetch failed", elapsedMs: 9 }) === "other", "CONTROL: an HTTP error ANSWER is still `other` (a >=400 cancels settlement)");
  ok(transportAttempt("x".repeat(5000)).body.length <= 300, "the recorded text is bounded");

  // The payment's id, from a signed payload shaped as @x402/avm signs it.
  const acct = algosdk.generateAccount();
  const sp = { fee: 1000, minFee: 1000, flatFee: true, firstValid: 100, lastValid: 1100, genesisID: "mainnet-v1.0", genesisHash: new Uint8Array(32).fill(7) };
  const mk = (amount) => algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: acct.addr, receiver: acct.addr, amount, assetIndex: 31566704, suggestedParams: sp });
  const [feeTxn, payTxn] = algosdk.assignGroupID([mk(0), mk(1000)]);
  const b64 = (t) => Buffer.from(t.signTxn(acct.sk)).toString("base64");
  const signedPayload = { x402Version: 2, payload: { paymentGroup: [b64(feeTxn), b64(payTxn)], paymentIndex: 1 } };
  ok(avmPaymentTxid(signedPayload) === payTxn.txID() && payTxn.txID() !== feeTxn.txID(), "the payment's id is the transaction at paymentIndex, grouped or not");
  ok(avmPaymentTxid({ payload: { paymentGroup: [Buffer.from(algosdk.encodeUnsignedTransaction(feeTxn)).toString("base64"), b64(payTxn)], paymentIndex: 0 } }) === feeTxn.txID(), "an unsigned group member (a fee payer signs later) still has an id");
  for (const bad of [null, {}, { payload: {} }, { payload: { paymentGroup: [], paymentIndex: 0 } }, { payload: { paymentGroup: ["AAAA"], paymentIndex: 0 } }, { payload: { paymentGroup: [b64(payTxn)], paymentIndex: 3 } }]) {
    ok(avmPaymentTxid(bad) === null, `an unreadable payload has no id (${JSON.stringify(bad)?.slice(0, 40)})`);
  }

  // The chain reading, against stub nodes. `algod` and `idx` are status codes
  // or bodies; "throw" is a failed read.
  const chain = (algod, idx, extra = {}) => {
    const calls = [];
    const answer = (v) => {
      if (v === "throw") throw new Error("socket");
      if (typeof v === "number") return new Response("{}", { status: v });
      return new Response(JSON.stringify(v), { status: 200 });
    };
    const fetchImpl = async (url) => { calls.push(url); return answer(url.includes("/pending/") ? algod : (Array.isArray(idx) ? idx[calls.filter((u) => !u.includes("/pending/")).length - 1] : idx)); };
    return readPaymentOnChain({ txid: TXID, algodUrl: "https://algod.example/", indexers: ["https://idx.example"], fetchImpl, ...extra }).then((v) => ({ v, calls }));
  };
  const landedIdx = { transaction: { "confirmed-round": 9 } };
  ok((await chain({ "confirmed-round": 9 }, 404)).v === "landed", "a confirmed round on algod: landed");
  ok((await chain(404, landedIdx)).v === "landed", "a confirmed transaction on the indexer: landed, even when algod no longer holds it");
  ok((await chain("throw", landedIdx)).v === "landed", "...and even when algod cannot be read");
  const absent = await chain(404, 404);
  ok(absent.v === "absent" && absent.calls[0] === `https://algod.example/v2/transactions/pending/${TXID}` && absent.calls[1] === `https://idx.example/v2/transactions/${TXID}`, "algod 404 AND the indexer 404: absent (both asked, by the payment's id)");
  ok((await chain({ "confirmed-round": 0, "pool-error": "" }, 404)).v === "pending", "in algod's pool, unconfirmed: pending, never absent");
  ok((await chain({ "pool-error": "transaction already in ledger" }, 404)).v === "absent", "refused by the pool and not indexed: absent");
  ok((await chain(404, "throw")).v === "unreadable", "an indexer that cannot be read proves nothing: unreadable");
  ok((await chain(404, 500)).v === "unreadable", "an indexer 5xx is not a 404: unreadable");
  ok((await chain("throw", 404)).v === "unreadable", "algod unreadable: unreadable, never absent on the indexer's word alone (it lags)");
  ok((await chain(503, 404)).v === "unreadable", "algod 5xx: unreadable");
  ok((await chain(404, { transaction: {} })).v === "unreadable", "an indexer row with no confirmed round is not a landing and not a 404: unreadable");
  ok((await chain(404, [404, 500], { indexers: ["https://a.example", "https://b.example"] })).v === "unreadable", "EVERY indexer must answer 404 for absent");
  ok((await chain(404, [500, landedIdx], { indexers: ["https://a.example", "https://b.example"] })).v === "landed", "any indexer holding it is a landing");
  ok((await readPaymentOnChain({ txid: null, algodUrl: "https://algod.example", indexers: ["https://idx.example"], fetchImpl: async () => new Response("{}", { status: 404 }) })) === "unreadable", "no readable id: unreadable (two 404s for nothing are not absence)");
  ok((await readPaymentOnChain({ txid: TXID, algodUrl: "https://algod.example", indexers: [], fetchImpl: async () => new Response("{}", { status: 404 }) })) === "unreadable", "no indexer configured: unreadable");

  // A pooled payment is read again until it confirms or drops.
  const polled = async (seq, polls) => { let i = 0, slept = 0; const v = await settledChainReading({ read: async () => seq[Math.min(i++, seq.length - 1)], sleep: async () => { slept++; }, polls }); return { v, reads: i, slept }; };
  eq(await polled(["pending", "pending", "landed"], 4), { v: "landed", reads: 3, slept: 2 }, "a pooled payment is read again until it lands");
  eq(await polled(["pending"], 3), { v: "pending", reads: 3, slept: 2 }, "still pooled after the last read stays pending");
  eq(await polled(["absent", "landed"], 4), { v: "absent", reads: 1, slept: 0 }, "a settled reading is not read twice");

  // THE RULE, every branch.
  ok(noAnswerVerdict({ chain: "landed" }) === "charged" && noAnswerVerdict({ chain: "landed", retried: true }) === "charged", "landed: charged, on the first attempt or the retry");
  for (const c of ["pending", "unreadable", undefined, "something-new"]) {
    ok(noAnswerVerdict({ chain: c }) === "unverified" && noAnswerVerdict({ chain: c, retried: true }) === "unverified", `chain ${c}: unverified (a charge is not ruled out), never a retry`);
  }
  ok(noAnswerVerdict({ chain: "absent" }) === "retry", "absent on the first attempt: the one fresh retry");
  ok(noAnswerVerdict({ chain: "absent", retried: true }) === "no-answer", "absent on the last attempt: no-answer, which fails the run");
  ok(noAnswerVerdict() === "unverified", "no reading at all: unverified");
  ok(recheckVerdict({ chain: "landed" }) === "charged", "end of run: a payment that landed after its request failed is charged");
  ok(recheckVerdict({ chain: "absent" }) === "clear", "end of run: still absent is clear");
  ok(recheckVerdict({ chain: "pending" }) === "unverified" && recheckVerdict({ chain: "unreadable" }) === "unverified" && recheckVerdict() === "unverified", "end of run: pooled or unreadable is unverified");
  ok(recheckVerdict({ chain: "landed", delivered: true }) === "clear", "end of run: an id that answered 200 is that buy's own payment");

  // And the sweep acts on it (source pins: the sweep self-runs on import).
  const src = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  ok(/try \{ paid = await signed\.send\(\); \} catch \(e\) \{ return transportAttempt\(e, Date\.now\(\) - startedMs, signed\.txid\); \}/.test(src),
     "the sweep shapes a thrown request as an attempt that carries its signed payment's id");
  ok(/let signed;\s*try \{ signed = await signOnce\(\); \} catch \(e\) \{ if \(isBuyerNetworkError\(e\)\) e\.buyerSide = true; throw e; \}\s*let paid;/.test(src), "...while a throw from signing stays outside that catch: marked as the runner's network only when it is a transport failure, and thrown either way");
  // A throw before the paid request left is signed again once, and only then:
  // the retry inside attemptOnce runs on e.buyerSide alone (nothing was sent).
  {
    const once = /const attemptOnce = async \(\) => \{[\s\S]*?\n  \};\n/.exec(src)?.[0] || "";
    ok(/try \{ return await attempt\(\); \} catch \(e\) \{\s*if \(!e\?\.buyerSide\) throw e;[\s\S]*await sleep\(THROTTLE_BACKOFF_MS\);\s*return await attempt\(\);\s*\}/.test(once) && (once.match(/await attempt\(\)/g) || []).length === 2,
       "attemptOnce signs again only after a throw before any paid request (buyerSide), once, after a pause");
  }
  ok(/return \{ send, txid: avmPaymentTxid\(payload\) \};/.test(src), "the id is read from the payload that was signed");
  ok(/const send = \(\) => fetch\(url, \{\s*\.\.\.reqInit,\s*signal: AbortSignal\.timeout\(/.test(src) && !/const reqInit = \{[^}]*signal:/.test(src),
     "each attempt gets its own deadline: a signal built once left the retry already aborted");
  ok(/const first = out === "no-answer" \? await settleNoAnswer\(a, false\)\s*: step === "read-chain" \? await settleNoAnswer\(a, false, \{ edge: true \}\)\s*: "retry";\s*if \(first !== "retry"\) chargeRecorded = out !== "no-answer";\s*if \(first === "retry"\) \{\s*a = await attemptOnce\(\);/.test(src),
     "a no-answer is settled on chain BEFORE the retry signs, and only `retry` signs again");
  // An empty 200 is a charge: the retry block is entered on the classifier's
  // word alone, and there is no other attempt anywhere in the sweep.
  {
    // Read line by line (no backtracking regex): the step line, then only
    // comment or blank lines, then the charge flag and the gated block.
    const marker = 'const step = isEdgeTimeout(a.status) ? "read-chain" : nextStep(out);';
    const at = src.indexOf(marker);
    const rest = at < 0 ? [] : src.slice(at + marker.length).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    ok(at >= 0 && rest[0] === "let chargeRecorded = false;" && rest[1] === 'if (step === "retry" || step === "read-chain") {', "the retry block is entered only on nextStep's retry or read-chain");
  }
  ok((src.match(/await attemptOnce\(\)/g) || []).length === 2 && (src.match(/await attempt\(\)/g) || []).length === 2 && !/if \(out !== "ok"\) \{/.test(src) && !/nextStep\([^)]*\) (!==|===) "(done|charged-empty)"/.test(src),
     "...and the sweep holds exactly two attempts: the first, and the one inside that block");
  {
    const block = /const step = isEdgeTimeout\(a\.status\) \? "read-chain" : nextStep\(out\);[\s\S]*?\n    \}\n/.exec(src)?.[0] || "";
    ok(block.includes("a = await attemptOnce();") && src.replace(block, "").match(/await attemptOnce\(\)/g)?.length === 1, "the second attempt sits inside the gated block");
  }
  ok(/\} else if \(out === "empty"\) \{[^}]*\s*report\.chargedEmpty\.push\(\{ key, slug: t\.slug, usd, tx: a\.tx \|\| null,[^\n]*\n\s*report\.spentUsd \+= usd;/.test(src),
     "an empty 200 is recorded as charged with an empty answer (tool, receipt transaction id) and counted in the spend");
  ok(/CHARGED, empty answer: 200 with [^\n]*\$\{t\.slug\}\$\{a\.tx \? ` · tx \$\{a\.tx\}`/.test(src), "its line names the tool and the receipt's transaction id");
  ok(!/report\.toolFail\.push\([^\n]*empty body/.test(src), "an empty 200 is never booked as an uncharged tool failure");
  ok(/const bad = [^;]*\+ noAnswerBad \+ report\.chargedEmpty\.length;/.test(src), "a charge with an empty answer FAILS the run");
  ok(/const body = await paid\.text\(\)\.catch\(\(\) => \{ unreadable = true; return ""; \}\);/.test(src), "a body that cannot be read is an empty one");
  ok(/const chain = x\.txid \? await chainReading\(x\.txid\) : "unreadable";\s*const verdict = noAnswerVerdict\(\{ chain, retried: wasRetry \}\);/.test(src),
     "the verdict is the classifier's, on the chain's reading; a payment with no id is unreadable");
  ok(/if \(verdict === "charged"\) \{\s*report\.chargedNoAnswer\.push\(row\);\s*report\.spentUsd \+= usd;/.test(src), "a landed payment is counted in the spend and recorded as charged without an answer");
  ok(/if \(out === "no-answer"\) \{ await sleep\(THROTTLE_BACKOFF_MS\); await settleNoAnswer\(a, true\); \}/.test(src), "a retry with no answer is settled the same way, and there is no third attempt");
  ok(/const noAnswerBad = report\.chargedNoAnswer\.length \+ report\.chargeUnverified\.length \+ report\.noAnswer\.length;\s*const bad = [^;]*\+ noAnswerBad[;\s+]/.test(src),
     "charged, not ruled out, and unanswered on the last attempt each FAIL the run");
  ok(!/report\.upstreamFail\.push\([^)]*answerOf|a\.status \? "not charged/.test(src) && !/answerOf/.test(src), "a no-answer never reaches the upstream bucket, whose header says the buyer was not charged");
  ok(/for \(const p of absentPayments\) \{\s*const waitMs = p\.failedAt \+ CHARGE_RECHECK_MS - Date\.now\(\);\s*if \(waitMs > 0\) await sleep\(waitMs\);/.test(src)
     && /const verdict = recheckVerdict\(\{ chain, delivered \}\);/.test(src)
     && /report\.chargedNoAnswer\.push\(\{ \.\.\.row, late: true \}\);\s*report\.spentUsd \+= p\.usd;/.test(src),
     "every absent payment is read again at the end of the run, after the recheck wait, and a late landing is spend and a failure");
  ok(src.indexOf("for (const p of absentPayments)") < src.indexOf("const noAnswerBad =") && src.indexOf("for (const p of absentPayments)") > src.indexOf("await sleep(DELAY_MS);"),
     "...after the sweep and before the verdict");
  ok(/if \(paid\.status === 200 && signed\.txid\) deliveredTxids\.add\(signed\.txid\);/.test(src), "an id that answered 200 is remembered as delivered");
  ok(/NEVER EXIT 0 AFTER A POSSIBLE\s*\/\/\s*CHARGE, and never sign again after one\./.test(src) && /A 200 WITH AN EMPTY OR UNREADABLE BODY/.test(src), "the rule is stated in the script header, the empty 200 included");
}

// ---- and the SWEEP acts on it ---------------------------------------------
//
// Source pins, because the sweep self-runs on import and cannot be driven from
// here. Each pins a decision the classifier alone cannot make: what the sweep
// DOES once a refusal is known to be ours.
{
  const src = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");

  // CONTROL. A pin that matches nothing reports a clean run forever, so prove
  // the file is being read and that a string known to be absent is absent.
  ok(/ABORT_AFTER_CONSECUTIVE/.test(src), "control: the sweep source is readable and carries the abort knob");
  ok(!/CANARY_THIS_DOES_NOT_EXIST/.test(src), "control: and a string that should not be there is not found");

  ok(/out === "breaker" \? Math\.min\(a\.retryAfterMs/.test(src),
     "a breaker refusal waits the Retry-After it carries, not the 8s burst backoff that cannot clear a 15-minute window");
  ok(/report\.blocked\.push/.test(src) && !/out === "breaker"[\s\S]{0,400}report\.throttled\.push/.test(src),
     "a breaker refusal goes in `blocked`, never in the vendor-throttle bucket");
  ok(/consecutiveBlind \+\+|consecutiveBlind\+\+/.test(src) && /consecutiveBlind >= ABORT_AFTER_CONSECUTIVE/.test(src),
     "consecutive unmeasurable outcomes abort the sweep instead of buying ~350 more attempts that observe nothing");
  ok(/out === "ok"\) consecutiveBlind = 0/.test(src),
     "...and a single success resets the run, so an isolated failure among successes never trips it - that failure is what this alarm is for");
  ok(/bodyType \|\| ""\)\.toLowerCase\(\) === "form-data"[\s\S]{0,300}report\.skipped\.push/.test(src),
     "a multipart route is SKIPPED, not driven with JSON and then booked as a handler defect - and it is read from the seller's own declaration, not a slug list");
  ok(/report\.aborted && !bad[\s\S]{0,300}process\.exit\(1\)/.test(src),
     "an aborted sweep FAILS the run even with no defect recorded - a partial sweep may not report a pass");
}

// ---- SUB-CENT BUDGET: the sweep must never spend the facilitator's free quota -
//
// Live values from GoPlausible's /sponsorship/status for our payTo on
// 2026-09-22: quota 1000, usedMonth 1003, suBalance 0 - the September
// allowance gone, all of it to this sweep and the daily canary.
{
  const exhausted = { quota: 1000, usedMonth: 1003, suBalance: 0 };
  const fresh = { quota: 1000, usedMonth: 0, suBalance: 0 };
  ok(subcentBudget({ status: exhausted, max: 150, reserve: 300 }).budget === 0,
     "with the month's quota spent, the sweep buys ZERO sub-cent tools - it has nothing left to spend that is not a buyer's");
  ok(subcentBudget({ status: fresh, max: 150, reserve: 300 }).budget === 150,
     "on a fresh month it spends at most the cap (150 of 1000)");
  ok(subcentBudget({ status: { quota: 1000, usedMonth: 600, suBalance: 0 }, max: 150, reserve: 300 }).budget === 100,
     "as the month fills, the reserve holds: 1000 - 600 = 400 left, minus 300 kept for buyers = 100, under the cap");
  ok(subcentBudget({ status: { quota: 1000, usedMonth: 1003, suBalance: 25000 }, max: 150, reserve: 300 }).budget === 150,
     "purchased Settlement Units count as headroom (quota gone, 25,000 SU -> the cap applies)");
  const blind = subcentBudget({ status: null, max: 150, reserve: 300 });
  ok(blind.budget === 150 && blind.source === "cap-only",
     "an UNREADABLE quota falls back to the fixed cap alone - it is never treated as unlimited");
  ok(subcentBudget({ status: fresh, max: -5, reserve: 300 }).budget === 0, "a negative cap is zero, never a spend");
  // A row last written in an EARLIER UTC month is last month's count (the
  // document has no month field; its counter may only roll on the next
  // write). Budgeted as reset, so the sweep's first sub-cent buy is the write
  // that rolls it - or, if the facilitator has not reset, a refused settle the
  // run reports - instead of a zero budget that excuses it every week.
  {
    const sepRow = { quota: 1000, usedMonth: 1013, suBalance: 0, updatedTs: 1790559828059 }; // the live shape: epoch ms
    const oct5 = Date.UTC(2026, 9, 5, 6, 41);
    const b1 = subcentBudget({ status: sepRow, max: 150, reserve: 300, now: oct5 });
    ok(b1.budget === 150 && b1.remaining === 1000 && /earlier month/.test(b1.source), `a September row read in October is budgeted as reset (got ${JSON.stringify(b1)})`);
    ok(subcentBudget({ status: sepRow, max: 150, reserve: 300, now: Date.UTC(2026, 8, 28, 6, 41) }).budget === 0, "...and is still exhausted in September");
    ok(subcentBudget({ status: { ...sepRow, updatedTs: Date.UTC(2026, 9, 5, 6) }, max: 150, reserve: 300, now: oct5 }).budget === 0, "a row the facilitator rewrote this month is taken at its word");
    // A PRESENT updatedTs that is not a readable time (0, negative, small,
    // text, far in the future) cannot name its month. The budget spends what
    // buyers would be left, so its usedMonth is taken at its word and the
    // reserve holds - never read as reset, and never by the accident of
    // Date.parse reading "0" as January 2000.
    for (const v of [0, -5, "0", 7, "soon", Date.UTC(9999, 11, 31), 1.79e11]) {
      const b = subcentBudget({ status: { ...sepRow, usedMonth: 900, updatedTs: v }, max: 150, reserve: 300, now: Date.UTC(2026, 9, 5, 6, 41) });
      ok(b.budget === 0 && b.remaining === 100 && /not a readable time/.test(b.source), `updatedTs ${JSON.stringify(v)}: not evidence, usedMonth taken at its word (got ${JSON.stringify(b)})`);
    }
    ok(subcentBudget({ status: { quota: 1000, usedMonth: 1013, suBalance: 0 }, max: 150, reserve: 300, now: oct5 }).budget === 0, "a row with NO updatedTs is taken at its word (the documented rule)");
  }

  // The one predicate both canaries excuse a missing sub-cent accept on: the
  // restriction /api/rails publishes, nothing else.
  {
    const { railsReportSubcentPause, avmSubcentOfferStatus, noteAvmSettleRefusal, _resetAvmSponsorshipForTest } = await import("../src/avm-sponsorship.js");
    ok(railsReportSubcentPause({ restrictions: [{ network: "algorand", status: "paused", scope: "routes priced under one cent" }] }), "a published Algorand pause is reported");
    ok(!railsReportSubcentPause({ restrictions: [] }) && !railsReportSubcentPause(null) && !railsReportSubcentPause({}) && !railsReportSubcentPause({ restrictions: "paused" }), "no restriction, an unreadable or malformed document: nothing is reported");
    ok(!railsReportSubcentPause({ restrictions: [{ network: "base", status: "paused" }] }) && !railsReportSubcentPause({ restrictions: [{ network: "algorand", status: "open" }] }), "another network, or another status, is not the Algorand pause");
    _resetAvmSponsorshipForTest({ logger: () => {} });
    noteAvmSettleRefusal({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", payTo: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ", reason: "subcent_quota_exceeded" });
    ok(railsReportSubcentPause({ restrictions: avmSubcentOfferStatus() }), "...and it reads exactly the shape the server publishes on /api/rails");
    _resetAvmSponsorshipForTest({ logger: () => {} });
  }

  // Rotation: this week's window, and the next, cover the catalog in turn.
  const tools = [
    ...Array.from({ length: 10 }, (_, i) => ({ slug: `sub-${String(i).padStart(2, "0")}`, priceUsd: 0.001 })),
    { slug: "cent-tool", priceUsd: 0.01 }, { slug: "dollar-tool", priceUsd: 1.5 },
  ];
  const w0 = rotateSubcent(tools, { week: 0, cap: 4 });
  const w1 = rotateSubcent(tools, { week: 1, cap: 4 });
  const bought = (r) => r.filter((t) => t.priceUsd < 0.01 && !t.subcentSkip).map((t) => t.slug);
  const eqArr = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (got ${JSON.stringify(a)})`);
  eqArr(bought(w0), ["sub-00", "sub-01", "sub-02", "sub-03"], "week 0 buys the first window of sub-cent tools");
  eqArr(bought(w1), ["sub-04", "sub-05", "sub-06", "sub-07"], "week 1 buys the NEXT window, not the same four again");
  eqArr(bought(rotateSubcent(tools, { week: 2, cap: 4 })).sort(), ["sub-00", "sub-01", "sub-08", "sub-09"], "the window wraps, so every sub-cent tool is exercised within ceil(N/cap) weeks (set compare: buying order is the catalog order)");
  ok(w0.filter((t) => t.priceUsd >= 0.01).every((t) => t.subcentSkip === false),
     "tools at or above one cent are NEVER budgeted - the facilitator does not meter them");
  ok(rotateSubcent(tools, { week: 3, cap: 0 }).filter((t) => t.priceUsd < 0.01).every((t) => t.subcentSkip === true),
     "a zero budget skips every sub-cent tool and touches none at a cent or more");
  ok(JSON.stringify(bought(rotateSubcent(tools, { week: 7, cap: 4 }))) === JSON.stringify(bought(rotateSubcent(tools, { week: 7, cap: 4 }))),
     "deterministic in the week: a rerun in the same week covers the same tools");

  // The sweep actually honours it, before any request leaves.
  const src = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  ok(/tools = rotateSubcent\(tools, \{ week, cap: subcentPlan\.budget \}\)/.test(src), "the sweep rotates its tool list by the computed budget");
  ok(/if \(t\.subcentSkip\) \{ report\.skipped\.push/.test(src), "a tool outside the window is SKIPPED (recorded, never bought, never a failure)");
  ok(src.indexOf("if (t.subcentSkip)") < src.indexOf("const bareFetch = () => fetch("), "...and the skip happens BEFORE the bare 402 fetch, so it costs the seller nothing either");
  ok(/sponsorship\/status\?wallet=\$\{payTo\}/.test(src), "the budget is read from the facilitator's LIVE quota for our payTo, not a constant");
  ok(/if \(!ONLY\.length\)/.test(src), "an explicit --slugs run is exempt (a handful of tools by definition)");
  // While the allowance is spent the server withdraws Algorand from sub-cent
  // 402s (src/avm-sponsorship.js) and publishes it on /api/rails. The sweep
  // must read the payTo from a one-cent route, buy no sub-cent tool, and
  // excuse a sub-cent tool's missing accept ONLY on the server's own word.
  ok(/fetch\(`\$\{TARGET\}\/api\/solidity-scan`, \{ method: "POST"/.test(src) && !/fetch\(`\$\{TARGET\}\/api\/uuid`/.test(src), "the payTo is read from the one-cent route, not a sub-cent one that may carry no Algorand accept");
  ok(/subcentPlan = \(await subcentWithdrawnNow\(\)\)\s*\? \{ budget: 0/.test(src), "a server-withdrawn sub-cent offer buys zero sub-cent tools");
  ok(/import \{ railsReportSubcentPause \} from "\.\.\/src\/avm-sponsorship\.js"/.test(src) && /subcentWithdrawnSeen = railsReportSubcentPause\(rails\)/.test(src) && /fetch\(`\$\{TARGET\}\/api\/rails`/.test(src), "the withdrawal is read from /api/rails, the server's own published state, by the server's own predicate");
  ok(/const withdrawn = !expectedNoAvm && t\.priceUsd < 0\.01 && \(await subcentWithdrawnNow\(\)\)/.test(src), "only a SUB-CENT tool's missing accept is excused, and only while the server says so - anything else is still a regression");
}


// The sweep's defaults keep most of the month's sponsored sub-cent allowance
// for buyers (2026-10-01: September's was spent 1,006 of 1,015 by our own runs).
{
  const src = (await import("node:fs")).readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  const max = Number(/CANARY_SUBCENT_MAX \?\? "(\d+)"/.exec(src)?.[1]);
  const reserve = Number(/CANARY_SUBCENT_RESERVE \?\? "(\d+)"/.exec(src)?.[1]);
  ok(max > 0 && max <= 50 && reserve >= 500, `sweep defaults: at most 50 sub-cent buys a run, at least 500 kept for buyers (got ${max}/${reserve})`);
  ok(5 * max + 31 <= 1000 - reserve, "five weekly sweeps plus a daily leg fit inside what the reserve leaves for testing");
}
// ---- an edge timeout: the chain decides; a router tier with no seller: the seller set ----
{
  const CF504 = '{"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/","title":"Gateway time-out","status":504}';
  ok(isEdgeTimeout(504) && isEdgeTimeout(524), "a 504 or 524 is the edge giving up on our origin: the origin may still settle");
  ok(!isEdgeTimeout(502) && !isEdgeTimeout(503) && !isEdgeTimeout(500) && !isEdgeTimeout(404) && !isEdgeTimeout(200) && !isEdgeTimeout(0), "no other status reads as an edge timeout");
  ok(outcomeOf(R(504, CF504)) === "other", "the outcome name is unchanged (still handed to the upstream-vs-tool split on its last attempt)");
  const NO_SELLER = JSON.stringify({ error: "No external x402 seller matched that task on algorand. Explore /api/route?q=<task>&include=external.", tool: "route-execute-mid", errorCode: "not_found" });
  ok(isNoSellerMatched(404, NO_SELLER), "a router tier's 404 'no external seller matched' is the seller set, not our rail or handler");
  ok(isNoSellerMatched(404, "No external x402 seller matched that task on algorand. Explore /api/route?q=<task>&include=external."), "...read from a plain-text body too");
  ok(isNoSellerMatched(404, JSON.stringify({ error: "3 outside seller(s) matched those words on algorand, and none of them does that task (matched too few of the task's words to buy). Nothing was spent." })), "...and so is the match-floor refusal (judged no match: no seller does the task)");
  ok(!isNoSellerMatched(500, NO_SELLER) && !isNoSellerMatched(200, NO_SELLER) && !isNoSellerMatched(402, NO_SELLER), "only a refusal status (4xx, never a 402) reads as no seller");
  ok(!isNoSellerMatched(404, '{"error":"Not found"}') && !isNoSellerMatched(404, "") && !isNoSellerMatched(404, '{"error":"No seller is eligible"}'), "any other 404 stays a tool failure");
  const canary = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");
  ok(/isEdgeTimeout\(a\.status\) \? "read-chain" : nextStep\(out\)/.test(canary), "the sweep reads the chain for an edge timeout before it signs again");
  ok(/settleNoAnswer\(a, true, \{ edge: true \}\)/.test(canary), "...and for an edge timeout on the retry, so a charge behind either attempt is reported");
  ok(/isNoSellerMatched\(a\.status, a\.body\)\) \{\s*report\.noSeller\.push/.test(canary) && /noSeller: \[\]/.test(canary), "a router tier with no seller for its task is recorded under its own reason");
  const r = { railFail: [], toolFail: [], chargedNoAnswer: [], chargeUnverified: [], noAnswer: [], chargedEmpty: [], noSeller: [{ key: "POST /api/route/execute-mid" }], aborted: null };
  eq(failedClasses(r, []), [], "no seller for the task fails no class: it is an ecosystem condition");
  const bad = /const bad = ([^;]+);/.exec(canary)?.[1] || "";
  ok(bad && !/noSeller/.test(bad) && /noAnswerBad/.test(bad), "...and does not count toward the run's failure total");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
