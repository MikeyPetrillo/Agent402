// The CLASS of a 4xx, and the promise that the caller's words never ride with it
// (src/refusal-reason.js).
//
// Built after a question telemetry could not answer. The metered chat tier read
// as refusing 89% of callers over twenty days; it was two bursts from bot
// clients, every other day clean, and the first reading was wrong because a
// `tool_call` row records the STATUS and nothing else - a scanner sending
// garbage and a buyer who mistyped one field are the same row. The whole point
// of this module is to make that one GROUP BY, so the two things it must get
// right are: the vocabulary is closed, and no buyer text escapes.
//
//   node scripts/test-refusal-reason.js
const { refusalReason, REFUSAL_REASONS } = await import("../src/refusal-reason.js");
const { readFileSync } = await import("node:fs");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// Real messages, copied from the kits that throw them.
const CASES = [
  ['"model" is required', "missing_required"],
  ['"contents" must be a non-empty array', "missing_required"],
  ['each function declaration needs a "name"', "missing_required"],
  ["code must be 8-14 digits (a UPC/EAN barcode)", "wrong_type"],
  ["Request body must be a JSON object", "wrong_type"],
  ['"generationConfig" must be an object', "wrong_type"],
  ['"parts" is capped at 64', "out_of_range"],
  ['Model "x" is not in the gateway allowlist. GET /v1/models lists every supported model and its tier.', "model_not_allowed"],
  ['Model "google/gemini-2.5-flash" is served by the v1-chat tier - call /v1/gemini (price $0.02/call) instead.', "model_wrong_tier"],
  ["This request was quoted at $0.001 but the body being served quotes $0.4. Nothing was charged; resend the request exactly as it should be served.", "quote_mismatch"],
  ["This request would cost $8.1000 metered, above the $2 per-call cap of /v1/metered/messages - lower max_tokens or the input.", "over_cap"],
  ['"safetySettings" is not supported on this route - this wire cannot honour a safety threshold it does not control upstream.', "unsupported_field"],
  ['"generationConfig.responseMimeType" must be "text/plain" or "application/json" (got text/csv)', "unknown_field_value"],
];
let hit = 0;
for (const [msg, want] of CASES) { const got = refusalReason(msg, 400); if (got === want) hit++; else console.log(`   MISS ${want} != ${got}: ${msg.slice(0, 70)}`); }
ok(hit === CASES.length, `every real refusal message classifies as expected (${hit}/${CASES.length})`);

// The closed-vocabulary promise. This is the one that keeps buyer text out of
// an analytics pipeline: a message we do not recognise must become "other",
// never itself. A 400 routinely quotes what the caller sent.
{
  const secrets = [
    'code must be 8-14 digits, got "sk-live-4f9a2b7c0e1d"',
    "unrecognised: user said 'my password is hunter2'",
    "Bearer a402_deadbeefcafe is not valid",
    "0xAbCdEf0123456789 is not a contract on this chain",
  ];
  let leaked = 0, allInVocab = true;
  for (const s of secrets) {
    const r = refusalReason(s, 400);
    if (!REFUSAL_REASONS.includes(r)) allInVocab = false;
    if (typeof r === "string" && (r.includes("sk-live") || r.includes("hunter2") || r.includes("a402_") || r.includes("0xAbCdEf"))) leaked++;
  }
  ok(leaked === 0, "no caller text, key or address can survive into the reason");
  ok(allInVocab, "every answer is a member of the published vocabulary");
  ok(refusalReason("something we have never seen before", 400) === "other", "an unrecognised message is `other`, so a NEW error string cannot start exporting words");
}

// Only a refusal has a reason. A 5xx is our fault or the upstream's and says
// nothing about the caller's input, so tagging one would invite a GROUP BY that
// reads server errors as user error.
ok(refusalReason("upstream error", 502) === null, "a 5xx carries no reason");
ok(refusalReason("anything", 200) === null, "a success carries no reason");
ok(refusalReason("", 400) === "other", "an empty message still classifies rather than throwing");
ok(refusalReason(undefined, 400) === "other", "a missing message still classifies");
ok(refusalReason("x", 413) === "too_large" && refusalReason("x", 404) === "not_found", "the statuses that speak for themselves are read from the status");

// The vocabulary is a closed set a query can GROUP BY.
ok(new Set(REFUSAL_REASONS).size === REFUSAL_REASONS.length && REFUSAL_REASONS.includes("other"), "the vocabulary is unique and always has a fallback");
ok(Object.isFrozen(REFUSAL_REASONS), "the vocabulary is frozen, so a caller cannot widen it at runtime");

// Wired where it is actually needed: the dispatcher classifies, and the
// telemetry carries the class and not the message.
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/refusalClass = refusalReason\(err\?\.message, status\)/.test(server), "the dispatcher classifies the error it caught (source pin)");
  ok(/capturePostHogToolCall\([^)]*refusalReason: refusalClass/.test(server), "and passes the CLASS to telemetry, never err.message (source pin)");
  const ph = readFileSync(new URL("../src/posthog.js", import.meta.url), "utf8");
  ok(/\.\.\.\(refusalReason \? \{ refusalReason \} : \{\}\)/.test(ph), "tool_call carries the reason only when there is one (source pin)");
}

// --- routing refusals (2026-09-21) --------------------------------------------
// Added after a question telemetry could not answer: how many calls fail to
// route because no seller clears the settlement gate? Every message below used
// to classify as "other", so the gate's cost was invisible.
//
// The two that matter are NOT interchangeable. "nothing in the index does this
// task" and "plenty do and every one is below the floor" call for opposite
// responses - list more sellers, or revisit the gate - so a rule that collapses
// them would answer the question wrongly rather than not at all.
const ROUTING = [
  ["No external seller is eligible for this task on base right now: 4 matched it and all of them are below our settlement gate. Nothing was spent and nothing is charged.", 409, "no_seller_eligible"],
  ["No external x402 seller matched this task on base. Nothing was spent.", 409, "no_seller_matched"],
  ["No external x402 or MPP seller matched this task. Nothing was spent.", 409, "no_seller_matched"],
  ['Tool "hash" is listed at $0.05 - above this endpoint\'s $0.005 underlying cap.', 400, "underlying_over_cap"],
  ["External routing settles on eip155:8453 - this request paid on solana. Pay on a supported chain.", 409, "network_unsupported"],
  ["External routing is not enabled on this host", 409, "routing_disabled"],
  ["External routing on base is paused for everyone right now, nothing was spent.", 429, "routing_paused"],
  ["External routing is paused for this wallet: unsettled spend ceiling", 429, "routing_paused"],
];
for (const [msg, status, want] of ROUTING) {
  const got = refusalReason(msg, status);
  ok(got === want, `routing: ${JSON.stringify(msg.slice(0, 58))} -> ${want} (got ${got})`);
}

// The distinction is the whole point, so assert it directly rather than trust
// the two rows above to have exercised it.
const eligible = refusalReason("No external seller is eligible for this task on base right now: 4 matched it and all of them are below our settlement gate.", 409);
const matched = refusalReason("No external x402 seller matched this task on base.", 409);
ok(eligible !== matched, `the gated-out case and the nothing-matched case are DIFFERENT reasons (${eligible} vs ${matched})`);
ok(eligible === "no_seller_eligible", "a gate-blocked refusal is attributable to the gate, not to absent supply");

// Every routing reason must be a declared member, or a GROUP BY silently
// splits on a value the vocabulary does not contain.
for (const [, , want] of ROUTING) {
  ok(REFUSAL_REASONS.includes(want), `${want} is a declared member of REFUSAL_REASONS`);
}

// The routing rules run BEFORE the generic ones: the over-cap message also
// matches the generic over_cap rule, and first-match-wins is what keeps them
// apart. This fails if the blocks are ever reordered.
ok(refusalReason('Tool "x" is listed at $1 - above this endpoint\'s $0.005 underlying cap.', 400) === "underlying_over_cap",
  "a routing cap message is not swallowed by the generic over_cap rule");

// --- the rules must match the messages THE CODE ACTUALLY EMITS ---------------
// Everything above classifies strings typed into this file, which proves the
// regexes work and nothing about whether they match production. A reword in
// route-execute would send these straight back to "other" with every assertion
// above still green. So read the real templates out of the source, fill their
// interpolations, and classify those.
const routeSrc = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
const templates = [
  ...[...routeSrc.matchAll(/throw bad\(`([^`]+)`/g)].map((m) => m[1]),
  // Quoted strings too. The first cut read only backticks and so could not see
  // `throw bad("External routing is not enabled on this host", 409)`, which is
  // exactly the kind of message this pin exists to keep classified.
  ...[...routeSrc.matchAll(/throw bad\("([^"]+)"/g)].map((m) => m[1]),
];
ok(templates.length >= 6, `found the refusal templates in route-execute (${templates.length})`);

// Fill ${...} with a plausible value so the literal words survive.
const fill = (t) => t
  .replace(/\$\{[^}]*\?[^}]*\}/g, "x402")        // ternaries pick a branch
  .replace(/\$\{[^}]*\}/g, "1");                 // amounts, counts, chain ids
const classified = templates.map((t) => [t, refusalReason(fill(t), 409)]);

for (const [needle, want] of [
  ["all of them are below our settlement gate", "no_seller_eligible"],
  ["seller matched that task", "no_seller_matched"],   // the real wording is "that", not "this"
  ["used the Tempo time budget", "routing_budget_spent"],
  ["underlying cap", "underlying_over_cap"],
  ["External routing is not enabled", "routing_disabled"],
]) {
  const hit = classified.find(([t]) => t.includes(needle));
  ok(!!hit, `route-execute still emits a message containing ${JSON.stringify(needle)}`);
  if (hit) ok(hit[1] === want, `that real template classifies as ${want} (got ${hit[1]})`);
}

// No routing refusal may land in "other": that is the bucket this work exists
// to empty, and a silent fall-through there is the regression.
// `Routed tool "x" failed: <seller's own words>` is excluded on purpose: it
// relays the seller's error, so its cause belongs to them and a reason of ours
// would be a guess about someone else's system.
const strayOther = classified.filter(([t, r]) => r === "other"
  && /external|seller|routing/i.test(t)
  && !/^Routed tool /.test(t));
ok(strayOther.length === 0,
  `no routing refusal classifies as "other"${strayOther.length ? ` - ${JSON.stringify(strayOther[0][0].slice(0, 70))}` : ""}`);

// The resolver must actually tally, or the message above can never be reached.
const serverSrcRaw = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
// Strip line comments BEFORE testing. Two mutations survived the first cut of
// these pins: commenting out the increment left the text in place so a bare
// substring search still matched, and an `a|b` regex whose second alternative
// ignored `enumerable: false` passed whatever that flag said. A pin that a
// comment or a spare alternative can satisfy is decoration.
const serverSrc = serverSrcRaw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
ok(/gateDrops\.total\+\+/.test(serverSrc), "the dispatch-gate filter counts what it drops, in live code");
ok(/__gateDrops/.test(serverSrc) && /__gateDrops/.test(routeSrc), "the tally is carried to the caller that reports it");
const defineBlock = (serverSrc.match(/defineProperty\([^;]*__gateDrops[^;]*;/s) || [""])[0].replace(/\s+/g, " ");
ok(/enumerable: false/.test(defineBlock) && /value: gateDrops/.test(defineBlock),
  `the tally is non-enumerable, so it cannot reach a receipt or a response body (${defineBlock.slice(0, 80)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
