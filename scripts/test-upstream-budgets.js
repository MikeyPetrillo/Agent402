// Daily call budgets for every paid upstream.
//
// Nine upstreams had an alarm and seven did not, and the seven were not the
// unimportant ones: Brave backs our best-selling tool, Alchemy is PAYG and can
// bill with no revenue attached, CoinGecko's monthly quota has already been
// exhausted once. This pins the properties that make the alarm honest rather
// than decorative.
import { upstreamBudgetStatus, UPSTREAM_BUDGETS } from "../src/upstream-budgets.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
const rep = (hosts) => ({ day: "2026-09-14", hosts });

// --- one upstream, many hosts ----------------------------------------------
// Alchemy serves every chain from its own subdomain, so a per-host budget
// would divide the spend across a dozen rows and never trip.
{
  const s = upstreamBudgetStatus(rep([
    { host: "solana-mainnet.g.alchemy.com", calls: 1074 },
    { host: "base-mainnet.g.alchemy.com", calls: 243 },
  ]));
  eq(s.upstreams.alchemy.callsToday, 1317, "every Alchemy subdomain folds into ONE upstream total");
  eq(s.upstreams.alchemy.status, "ok", "and 1,317 is under the default budget, so switching this on pages nobody");
}

// --- the alarm actually fires ----------------------------------------------
{
  const s = upstreamBudgetStatus(rep([{ host: "api.coingecko.com", calls: 400 }]));
  eq(s.upstreams.coingecko.status, "elevated", "past the daily budget it reads elevated");
  eq(s.status, "elevated", "and the top-level status reflects the worst upstream");
  const q = upstreamBudgetStatus(rep([{ host: "api.coingecko.com", calls: 12 }]));
  eq(q.status, "ok", "normal traffic stays ok");
}

// --- a malformed budget must not silently disable the alarm ----------------
{
  process.env.BUDGET_COINGECKO_CALLS = "three hundred";
  const s = upstreamBudgetStatus(rep([{ host: "api.coingecko.com", calls: 400 }]));
  eq(s.upstreams.coingecko.status, "elevated",
     "a typo in the budget falls back to the DEFAULT, never to disabled - a typo must not turn an alarm off");
  process.env.BUDGET_COINGECKO_CALLS = "off";
  eq(upstreamBudgetStatus(rep([{ host: "api.coingecko.com", calls: 9999 }])).upstreams.coingecko.status, "disabled",
     "but an EXPLICIT off is honoured and says so");
  delete process.env.BUDGET_COINGECKO_CALLS;
}

// --- silence is not an error ------------------------------------------------
{
  const s = upstreamBudgetStatus(rep([]));
  eq(s.upstreams.brave.callsToday, 0, "a vendor we did not call today reads 0");
  eq(s.upstreams.brave.status, "ok", "which is ok, not an alarm - absence is not failure");
}

// --- it must never claim to be a balance ------------------------------------
{
  const s = upstreamBudgetStatus(rep([]));
  ok(s.sinceRestart === true, "flags that the counter resets on deploy");
  ok(/not a vendor balance/i.test(s.note), "the note says plainly this is not a balance read");
  ok(/bounded by proxy/i.test(s.note), "and that a monthly quota is only bounded by proxy, never read");
  const blob = JSON.stringify(s);
  ok(!/key|token|secret|https?:\/\//i.test(blob.replace(/"why":"[^"]*"/g, "")),
     "carries no key, token or URL - this rides a public surface");
}

// --- every paid upstream in the exposure guard is budgeted here -------------
// The two guards must agree, or a vendor gets a leak check and no spend alarm.
{
  const exposure = readFileSync(new URL("./test-ci-key-exposure.js", import.meta.url), "utf8");
  const names = new Set(UPSTREAM_BUDGETS.map((b) => b.name));
  for (const [cred, name] of [["BRAVE_API_KEY","brave"],["ALCHEMY_API_KEY","alchemy"],["COINGECKO_API_KEY","coingecko"],["E2B_API_KEY","e2b"],["OPENAI_API_KEY","openai"],["NEYNAR_API_KEY","neynar"],["EXA_KEY","exa"]]) {
    ok(exposure.includes(cred) && names.has(name), `${cred} is both leak-guarded and budget-alarmed`);
  }
}

// A vendor that is also an indexed seller: crawler reads of its domain are not
// tool use. 621 unpaid crawler calls to api.exa.ai tripped the Exa budget on
// 2026-09-26 with $0 spent. With the kit's own counter registered, only tool
// calls count - and tool calls over the budget still trip it.
{
  const { registerUpstreamCounter } = await import("../src/upstream-budgets.js");
  let toolCalls = 3;
  registerUpstreamCounter("exa", () => toolCalls);
  const crawled = rep([{ host: "api.exa.ai", calls: 621 }]);
  let s = upstreamBudgetStatus(crawled);
  ok(s.upstreams.exa.status === "ok" && s.upstreams.exa.callsToday === 3, `crawler traffic to an indexed seller does not trip its budget (${JSON.stringify(s.upstreams.exa)})`);
  ok(s.upstreams.exa.counts === "tool calls only", "and the row says what it counts");
  toolCalls = 600;
  s = upstreamBudgetStatus(crawled);
  ok(s.upstreams.exa.status === "elevated", "real tool calls over the budget still trip it");
  ok(upstreamBudgetStatus(rep([{ host: "api.search.brave.com", calls: 5000 }])).upstreams.brave.status === "elevated", "a budget with no registered counter still reads host traffic");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/registerUpstreamCounter\("exa", exaCallsToday\)/.test(server), "the server registers the Exa kit's own counter");
}

console.log(`\ntest-upstream-budgets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
