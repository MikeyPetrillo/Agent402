#!/usr/bin/env node
// Runtime switches (src/feature-flags.js): provider, then environment, then
// the declared default; booleans and declared names only.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { RUNTIME_FLAGS, setFlagProvider, evaluateFlag, flagEnabled, parseSwitch, flagReadCounts } from "../src/feature-flags.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++; };
const NAME = "PRICE_WEBHOOK_DELIVERIES";

// The declared default answers with no provider and no variable.
setFlagProvider(null);
eq(evaluateFlag(NAME, { env: {} }), { value: RUNTIME_FLAGS[NAME].default, source: "default" }, "default with nothing set");

// The environment answers next, in every documented spelling.
for (const [text, want] of [["on", true], ["ON", true], ["true", true], ["1", true], ["yes", true], ["off", false], ["Off", false], ["false", false], ["0", false], ["no", false], [" off ", false]]) {
  eq(evaluateFlag(NAME, { env: { [NAME]: text } }), { value: want, source: "env" }, `env "${text}"`);
}
// Text that is neither is skipped, never read as off.
for (const text of ["", "maybe", "2", "enabled"]) {
  eq(evaluateFlag(NAME, { env: { [NAME]: text } }).source, "default", `env "${text}" falls to the default`);
  eq(parseSwitch(text), null, `parseSwitch("${text}")`);
}

// A provider's boolean wins over the environment.
ok(setFlagProvider({ getBoolean: (n) => (n === NAME ? false : undefined) }) === true, "provider registered");
eq(evaluateFlag(NAME, { env: { [NAME]: "on" } }), { value: false, source: "provider" }, "provider over env");
eq(flagEnabled(NAME, { env: { [NAME]: "on" } }), false, "flagEnabled reads the same value");
// A provider that answers a non-boolean is skipped.
for (const answer of [undefined, null, "off", 0, {}]) {
  setFlagProvider({ getBoolean: () => answer });
  eq(evaluateFlag(NAME, { env: { [NAME]: "off" } }), { value: false, source: "env" }, `provider answer ${JSON.stringify(answer)} falls to env`);
  eq(evaluateFlag(NAME, { env: {} }).source, "default", `provider answer ${JSON.stringify(answer)} falls to the default`);
}
// A provider that throws changes nothing and is counted.
const before = flagReadCounts().providerErrors;
setFlagProvider({ getBoolean: () => { throw new Error("registry not synced"); } });
eq(evaluateFlag(NAME, { env: { [NAME]: "off" } }), { value: false, source: "env" }, "throwing provider falls to env");
eq(evaluateFlag(NAME, { env: {} }), { value: RUNTIME_FLAGS[NAME].default, source: "default" }, "throwing provider falls to the default");
eq(flagReadCounts().providerErrors, before + 2, "provider errors counted");
// Not a provider: refused, and cleared.
eq(setFlagProvider({}), false, "an object without getBoolean is not a provider");
eq(flagReadCounts().providerRegistered, false, "no provider registered after a refused one");

// Undeclared names throw, with a provider or without; inherited names too.
for (const name of ["SOR_WALLET_DAILY_MAX_USD", "toString", "__proto__", ""]) {
  assert.throws(() => evaluateFlag(name, { env: { [name]: "on" } }), /not a declared runtime switch/, `undeclared "${name}"`); pass++;
}
// Every declared switch is a boolean default with a purpose; no number reads exist.
for (const [name, decl] of Object.entries(RUNTIME_FLAGS)) {
  ok(typeof decl.default === "boolean" && typeof decl.purpose === "string" && decl.purpose, `${name} declares a boolean default and a purpose`);
  ok(!/(_USD|_MAX|_LIMIT|_CAP|PRICE_USD|_BPS)$/.test(name), `${name} is not a money limit`);
}
const mod = await import("../src/feature-flags.js");
ok(!Object.keys(mod).some((k) => /number|string|json/i.test(k)), "the module exports no number, string or JSON read");

console.log(`\nfeature flags: ${pass} passed`);
