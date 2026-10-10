// /api/gateway-status is PUBLIC and must publish verdicts, never figures.
//
// The rule was already written for the OpenRouter leg - "bucketed status,
// numbers never exposed" - and the spend counters added later did not honour
// it. Before this guard the unauthenticated response carried xDataSpend's
// capUsd and spentUsd, exaSpend's daily cap, exaAllowance's funded and
// remaining dollars, and upstreamBudgets' exact daily ceiling for SEVEN
// vendors.
//
// Why that is worse than untidy: a published ceiling is an attack plan. A
// reader who sees `capUsd: 1` beside `spentUsd: 0.80` knows how few calls
// remain before a paid product refuses for the rest of the UTC day, and can
// spend pennies to get there. The seven vendor budgets are a map of which door
// is cheapest to push on.
//
// The operator still sees everything - the figures are needed to act - and an
// operator-authed read is never cached.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PORT = await getFreePort();
const TOKEN = "privacy-test-operator-token-0123456789";
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
         AGENT402_OPERATOR_TOKEN: TOKEN, EXA_KEY: "k", EXA_CREDITS_USD: "10", X_BEARER_TOKEN: "t" },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const pub = await fetch(`${base}/api/gateway-status`);
const pubBody = await pub.json();
const opRes = await fetch(`${base}/api/gateway-status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const opBody = await opRes.json();

// --- the money fields, by name ---------------------------------------------
const MONEY = /"(capUsd|spentUsd|budget|callsToday|fundedUsd|remainingUsd|spentSinceRestartUsd|refusedToday|lowBelowFraction)":\s*-?[0-9]/;
ok(!MONEY.test(JSON.stringify(pubBody)),
  `the PUBLIC response carries no spend, cap, budget or balance figure${MONEY.test(JSON.stringify(pubBody)) ? ` (found ${JSON.stringify(pubBody).match(MONEY)[0]})` : ""}`);
ok(MONEY.test(JSON.stringify(opBody)), "the OPERATOR response still carries them - the figures are what you act on");

// --- the verdict survives, or the alarm is useless -------------------------
for (const k of ["xDataSpend", "exaSpend", "exaAllowance", "upstreamBudgets"]) {
  ok(typeof pubBody?.[k]?.status === "string", `${k} still publishes its status word publicly`);
}
// Heartbeat reads only .status, so bucketing must not break paging.
ok(typeof pubBody?.upstreamBudgets?.status === "string", "upstreamBudgets keeps the top-level status the heartbeat reads");

// --- per-vendor ceilings must not leak one at a time -----------------------
const ups = pubBody?.upstreamBudgets?.upstreams || {};
ok(Object.keys(ups).length > 0, "per-vendor rows are still present publicly (so a reader can see WHICH vendor is elevated)");
ok(Object.values(ups).every((v) => Object.keys(v).join(",") === "status"),
  "...but each carries the status word ONLY - never callsToday, never the budget");

// --- an operator read must not land in a shared cache ----------------------
ok(/no-store/.test(opRes.headers.get("cache-control") || ""), "an operator-authed read is private, no-store");
ok(/max-age/.test(pub.headers.get("cache-control") || ""), "the public read is still cacheable");


// --- the operator-auth brute-force oracle ----------------------------------
// {failures1h, threshold} on a public surface is a live tuning aid against the
// operator token: the threshold says how many wrong tokens per hour stay under
// the alarm, and the counter confirms in real time that a grind is being
// counted - so an attacker can pace themselves and WATCH the alarm stay quiet.
{
  ok(typeof pubBody?.operatorAuth?.status === "string", "operatorAuth still publishes its verdict publicly");
  ok(!("failures1h" in (pubBody.operatorAuth || {})), "the PUBLIC view carries no live failure counter");
  ok(JSON.stringify(pubBody.backup) === JSON.stringify({ status: "off" }), `the offsite backup is one word, off without a bucket (${JSON.stringify(pubBody.backup)})`);
  ok(!("threshold" in (pubBody.operatorAuth || {})), "and never the alarm threshold");
  ok(typeof opBody?.operatorAuth?.failures1h === "number" && typeof opBody?.operatorAuth?.threshold === "number",
     "the OPERATOR view keeps both - you cannot act on a verdict alone");
}

// --- the CLASS, not the two instances --------------------------------------
// The money regex above matches BALANCE-shaped names and could never have seen
// ttlMs, maxResponses or worstMs: those are schedules and durations. Scoping a
// guard to the shape that leaked last is how the next one gets through, so the
// rule is now positional rather than nominal - ANY number on the public
// response is a finding until it is named here with a reason. Adding a number
// to this endpoint is then a deliberate act with an argument attached.
{
  const ALLOWED_PUBLIC_NUMBERS = new Set([
    // none today. A verdict endpoint has no honest use for a figure; if one
    // earns its place, name the path here and say why a stranger may read it.
  ]);
  const nums = [];
  (function walk(o, path) {
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    } else if (typeof o === "number") nums.push(path);
  })(pubBody, "");
  const unexplained = nums.filter((p) => !ALLOWED_PUBLIC_NUMBERS.has(p));
  ok(unexplained.length === 0,
     `the PUBLIC response publishes no unexplained number${unexplained.length ? `: ${unexplained.join(", ")}` : ""}`);
  // ...and the sweep must be able to SEE one, or it certifies an empty object.
  const opNums = [];
  (function walk(o, path) {
    if (o && typeof o === "object") { for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k); }
    else if (typeof o === "number") opNums.push(path);
  })(opBody, "");
  ok(opNums.length >= 5, `the same sweep finds ${opNums.length} numbers on the OPERATOR response (sanity: it is not blind)`);
}

// --- the two remaining knobs, bucketed 2026-09-14 --------------------------
// Found by re-reading the live public response after the spend fields were
// bucketed: these were the only numbers left, and both describe a schedule
// rather than a balance, which is why the money regex above could never see
// them. `ttlMs` + `maxResponses` are the wrong-domain hold's LAPSE SCHEDULE -
// a client told the hold ends after N responses knows when challenges return.
// loopLag is a live "how blocked is the event loop" readout, a timing signal
// for anyone probing for a window, that nobody outside ever acted on.
{
  const f = pubBody?.mppEvmDomainFallback || {};
  ok(typeof f.enabled === "boolean",
     "the fallback still says whether it is armed - a probe learns that from one wrong-domain credential anyway, and hiding a measurable fact is theatre");
  ok(!("ttlMs" in f) && !("maxResponses" in f), "...but never the hold's lapse schedule");
  ok(!("suppressedClients" in f), "and never a live count of our own traffic");
  ok(typeof opBody?.mppEvmDomainFallback?.ttlMs === "number" && typeof opBody?.mppEvmDomainFallback?.maxResponses === "number"
     && typeof opBody?.mppEvmDomainFallback?.suppressedClients === "number",
     "the OPERATOR view keeps all three");

  const l = pubBody?.loopLag || {};
  ok(l.watching === true || l.watching === false, "loopLag still publishes THAT we watch, which is the claim");
  ok(!("worstMs" in l) && !("stalls" in l) && !("lastStallMs" in l) && !("worstAt" in l) && !("lastStallAt" in l),
     "...and none of the measurements");
  ok(typeof opBody?.loopLag?.worstMs === "number" && typeof opBody?.loopLag?.stalls === "number",
     "the OPERATOR view keeps the figures - they are what you read after a bad deploy");
}

// --- NOT hidden, and the reason is worth keeping -------------------------
// The wish board's qualification constants stay public. An attempt to hide
// them was reverted within the hour: the PAID demand-radar ($0.005) states the
// same three figures, so hiding them on the free beacon protected nothing an
// attacker would not buy for half a cent, while breaking the cross-surface
// check that both surfaces state one bar. Obscurity you can purchase is not a
// control; the per-caller dedupe and the distinct-caller minimum are, and they
// work in plain sight.
{
  const w = await (await fetch(`${base}/api/wishes`)).json();
  ok(typeof w.threshold === "number",
     "the wish qualification bar stays published - the paid radar states it too, so hiding it here would be theatre");
}

child.kill();
console.log(`\ntest-gateway-status-privacy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
