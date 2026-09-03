#!/usr/bin/env node
// The alias layer may never change the MEANING of a call.
//
// It exists because 60 days of telemetry showed the buyers who explored the
// catalog and left failed only on 400s, and a third of plausible first attempts
// fail on the parameter NAME alone. It converts those into sales - but a layer
// that guesses wrong turns a correct call into a wrong one silently, which is
// far worse than a 400. These are the three rules that make that impossible.
import { applyInputAliases, PARAM_ALIASES } from "../src/input-aliases.js";
import { handlerInputOf } from "../src/handler-input.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const def = (required, properties) => ({ discovery: { inputSchema: { required, properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } } });

// --- it works at all -------------------------------------------------------
{
  const i = { domain: "github.com" };
  const filled = applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "github.com" && filled.join() === "host", "a required `host` is filled from `domain`");
}
{
  const i = { number: 2026 };
  applyInputAliases(i, def(["value"], ["value"]));
  ok(i.value === 2026, "a required `value` is filled from `number`");
}
{
  const i = { q: "NVDA" };
  applyInputAliases(i, def(["ticker"], ["ticker"]));
  ok(i.ticker === "NVDA", "a required `ticker` is filled from `q`");
}

// --- rule 1: never overwrite, never invent ---------------------------------
{
  const i = { host: "real.example", domain: "decoy.example" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "real.example", "a value the caller sent is never overwritten by a synonym");
}
{
  const i = { number: 5 };
  applyInputAliases(i, def([], ["value"]));
  ok(i.value === undefined, "an OPTIONAL parameter is never invented from a synonym");
}
{
  const i = { host: "" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "", "a tool with no synonym present is left exactly as it was");
}

// --- rule 2: the synonym must not mean something else here -----------------
{
  // A tool that declares BOTH: `domain` is its own parameter, not a spelling
  // of `host`. Taking one for the other would corrupt the call.
  const i = { domain: "example.com" };
  applyInputAliases(i, def(["host"], ["host", "domain"]));
  ok(i.host === undefined, "a synonym that is itself a declared property is NEVER borrowed");
}

// --- rule 3: ambiguity answers 400, it does not guess ----------------------
{
  const i = { hostname: "a.example", domain: "b.example" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === undefined, "two candidate synonyms is ambiguity: nothing is filled");
}

// --- shape safety ----------------------------------------------------------
ok(applyInputAliases(null, def(["host"], ["host"])).length === 0, "a null input is handled");
ok(applyInputAliases({}, null).length === 0, "no tool def means no aliasing");
ok(applyInputAliases({ domain: "x" }, { discovery: {} }).length === 0, "a tool with no inputSchema is never aliased");
{
  const i = { domain: "x" };
  applyInputAliases(i, def(["host"], ["host"]));
  const again = applyInputAliases(i, def(["host"], ["host"]));
  ok(again.length === 0 && i.host === "x", "applying twice is idempotent (pricing and serving read one input)");
}

// --- the table itself ------------------------------------------------------
{
  const selfRef = Object.entries(PARAM_ALIASES).filter(([k, v]) => v.includes(k));
  ok(selfRef.length === 0, `no canonical name lists itself as its own synonym (${selfRef.map(([k]) => k).join(",") || "none"})`);
  const dupes = Object.entries(PARAM_ALIASES).filter(([, v]) => new Set(v).size !== v.length);
  ok(dupes.length === 0, "no alias list repeats a name");
}

// --- through the real input construction -----------------------------------
{
  const req = { query: {}, body: { expression: "2+2" } };
  const input = handlerInputOf(req, def(["expr"], ["expr"]));
  ok(input.expr === "2+2", "handlerInputOf fills the alias when given the tool def");
  ok(Array.isArray(req.__aliasedParams) && req.__aliasedParams.includes("expr"), "the fill is recorded on the request for telemetry");
}
{
  // The invariant src/handler-input.js exists to protect: pricing and serving
  // must read ONE object. A quote taken before the def is known must not see a
  // different input than the handler does.
  const req = { query: {}, body: { content: "hello" } };
  const priced = handlerInputOf(req);            // no def yet
  const served = handlerInputOf(req, def(["text"], ["text"]));
  ok(priced === served, "the same object is returned with and without a def");
  ok(served.text === "hello", "the later call with a def fills the alias in place");
}
{
  // An MCP-style envelope and an alias compose: unwrap first, then alias.
  const req = { query: {}, body: { input: { domain: "example.com" } } };
  const input = handlerInputOf(req, def(["host"], ["host"]));
  ok(input.host === "example.com", "an alias inside a {input:{...}} envelope still resolves");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
