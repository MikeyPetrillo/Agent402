// Hard daily ceilings for the pay-as-you-go upstreams (src/upstream-hard-caps.js).
//
// The budgets in src/upstream-budgets.js only alarm. These refuse: a host past
// its ceiling is never called, the caller gets an uncharged 503, and the
// ceiling is read the same way as every other spend guard (0 refuses all,
// `off` disables, malformed reads as the default).
import {
  HARD_CAPS, hardCapOf, takeHardCap, hardCapRefusalForHost, hardCapStatus, _resetHardCaps,
} from "../src/upstream-hard-caps.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const cap = (name) => HARD_CAPS.find((c) => c.name === name);
const T0 = Date.parse("2026-10-19T12:00:00Z");

// --- reading a ceiling --------------------------------------------------------
{
  const c = cap("brave");
  ok(hardCapOf(c, {}) === c.dflt, "unset reads as the default");
  ok(hardCapOf(c, { [c.env]: "" }) === c.dflt, "blank reads as the default");
  ok(hardCapOf(c, { [c.env]: "junk" }) === c.dflt, "malformed reads as the default, never as disabled");
  ok(hardCapOf(c, { [c.env]: "-5" }) === c.dflt, "negative reads as the default");
  ok(hardCapOf(c, { [c.env]: "0" }) === 0, "0 is a ceiling of zero");
  ok(hardCapOf(c, { [c.env]: "off" }) === null, "off disables");
  ok(hardCapOf(c, { [c.env]: " 25 " }) === 25, "a number is the ceiling");
}

// --- refusing past the ceiling ------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "3";
  const host = "api.search.brave.com";
  const r = [1, 2, 3, 4, 5].map(() => hardCapRefusalForHost(host, T0));
  ok(r.slice(0, 3).every((x) => x === null), "calls under the ceiling go ahead");
  ok(r[3]?.statusCode === 503 && r[4]?.statusCode === 503, "calls past the ceiling are refused with 503");
  ok(/Nothing was charged/.test(r[3].message) && !/brave/i.test(r[3].message), "the refusal says nothing was charged and does not name the upstream");
  const s = hardCapStatus(T0);
  ok(s.status === "capped" && s.upstreams.brave.refusedToday === 2 && s.upstreams.brave.usedToday === 3, "status reads capped and counts the refusals");
  ok(hardCapRefusalForHost(host, T0 + 86_400_000) === null, "a new UTC day starts the count again");
  ok(hardCapStatus(T0 + 86_400_000).status === "ok", "and the status clears with it");
  delete process.env.HARDCAP_BRAVE_CALLS;
}

// --- host matching ------------------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_ALCHEMY_CALLS = "1";
  ok(hardCapRefusalForHost("base-mainnet.g.alchemy.com", T0) === null, "an Alchemy subdomain takes the shared ceiling");
  ok(hardCapRefusalForHost("solana-mainnet.g.alchemy.com", T0)?.statusCode === 503, "every subdomain folds into ONE ceiling");
  ok(hardCapRefusalForHost("notalchemy.com", T0) === null, "a host that merely ends in the same letters is not matched");
  ok(hardCapRefusalForHost("example.com", T0) === null, "an uncapped host is never refused");
  delete process.env.HARDCAP_ALCHEMY_CALLS;
}

// --- zero and off -------------------------------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_OPENAI_CALLS = "0";
  ok(hardCapRefusalForHost("api.openai.com", T0)?.statusCode === 503, "a ceiling of 0 refuses the first call");
  process.env.HARDCAP_OPENAI_CALLS = "off";
  ok(hardCapRefusalForHost("api.openai.com", T0) === null, "off lets calls through");
  ok(hardCapStatus(T0).upstreams.openai.status === "disabled", "and reads disabled");
  delete process.env.HARDCAP_OPENAI_CALLS;
}

// --- a kit-counted ceiling (E2B sandboxes) ------------------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_E2B_SANDBOXES = "2";
  ok(takeHardCap("e2b", T0) && takeHardCap("e2b", T0), "sandboxes under the ceiling start");
  ok(takeHardCap("e2b", T0) === false, "the next sandbox is refused");
  delete process.env.HARDCAP_E2B_SANDBOXES;
}

// --- the fetch hook refuses before any network call ---------------------------
{
  _resetHardCaps();
  process.env.HARDCAP_BRAVE_CALLS = "1";
  let reached = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { reached++; return new Response("{}"); };
  try {
    const { installEgressMeter } = await import("../src/egress-meter.js");
    installEgressMeter();
    await fetch("https://api.search.brave.com/res/v1/web/search?q=a");
    let err = null;
    try { await fetch("https://api.search.brave.com/res/v1/web/search?q=b"); } catch (e) { err = e; }
    ok(reached === 1, `the refused call never reached the network (reached ${reached})`);
    ok(err?.statusCode === 503 && err?.hardCap === true, "the caller gets the 503 refusal");
    await fetch("https://example.com/");
    ok(reached === 2, "other hosts are untouched");
  } finally { globalThis.fetch = real; delete process.env.HARDCAP_BRAVE_CALLS; }
}

// --- the kit gate is wired ------------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools/code-run-kit.js", import.meta.url), "utf8");
  const gate = src.indexOf('takeHardCap("e2b")'), create = src.indexOf("Sandbox.create(");
  ok(gate > 0 && gate < create, "code-run takes the sandbox ceiling before it creates a sandbox");
}

console.log(`\ntest-upstream-hard-caps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
