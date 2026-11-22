#!/usr/bin/env node
// Railway feature flags as the runtime-switch provider
// (src/feature-flags-railway.js):
//   - unset (even with RAILWAY_TOKEN in the shell), nothing loads and every
//     switch reads the environment, then its default, as before;
//   - set, Railway's boolean answer wins, and every non-answer (not found,
//     wrong type, stale, conflict, a rollout with no key) falls through;
//   - a failed load or init registers nothing and never logs the token;
//   - the real SDK, fed a stub GraphQL endpoint, reads the flag under its
//     Railway name with the project-token header.
// Offline: the real SDK's only request goes to an in-process stub fetch.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setFlagProvider, evaluateFlag, flagReadCounts } from "../src/feature-flags.js";
import { startRailwayFlags, railwayFlagName, railwayFlagProvider, RAILWAY_FLAGS_TOKEN_ENV } from "../src/feature-flags-railway.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log(`ok - ${msg}`); };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++; console.log(`ok - ${msg}`); };
const NAME = "PRICE_WEBHOOK_DELIVERIES";
const TOKEN = "planted-project-token-value";

eq(RAILWAY_FLAGS_TOKEN_ENV, "FEATURE_FLAGS_RAILWAY_TOKEN", "the documented variable");
eq(railwayFlagName(NAME), "price-webhook-deliveries", "a switch is read under its lower-case hyphenated name");

// Unset: the SDK is never loaded, no provider, reads unchanged.
{
  setFlagProvider(null);
  let loads = 0;
  const logs = [];
  for (const env of [{}, { [RAILWAY_FLAGS_TOKEN_ENV]: "  " }, { RAILWAY_TOKEN: TOKEN, RAILWAY_API_TOKEN: TOKEN }]) {
    const r = await startRailwayFlags({ env, loadSdk: async () => { loads++; return null; }, log: (m) => logs.push(m) });
    eq(r, { started: false, reason: "unset" }, `unset with ${JSON.stringify(Object.keys(env))}: not started`);
  }
  eq(loads, 0, "unset: the SDK is never loaded");
  eq(logs, [], "unset: nothing is logged");
  eq(flagReadCounts().providerRegistered, false, "unset: no provider");
  eq(evaluateFlag(NAME, { env: { [NAME]: "off" } }), { value: false, source: "env" }, "unset: the variable answers");
  eq(evaluateFlag(NAME, { env: {} }), { value: true, source: "default" }, "unset: the default answers");
}

// Set, over a stub SDK: Railway's answer, or a fall-through.
{
  const answers = new Map();
  const seen = [];
  const initOpts = [];
  const stub = {
    synced: true,
    async init(o) { initOpts.push(o); },
    evaluateBoolean(name, ctx, fallback) { seen.push([name, ctx, fallback]); return answers.get(name) ?? { value: fallback, reason: "NOT_FOUND", trace: [] }; },
  };
  const logs = [];
  const r = await startRailwayFlags({ env: { [RAILWAY_FLAGS_TOKEN_ENV]: ` ${TOKEN} ` }, loadSdk: async () => stub, log: (m) => logs.push(m), timeoutMs: 1234 });
  eq(r, { started: true, synced: true }, "set: started");
  eq(initOpts, [{ token: TOKEN, authType: "project-token", timeoutMs: 1234 }], "init gets the trimmed token as a project token, with the timeout");
  ok(flagReadCounts().providerRegistered, "set: a provider is registered");
  ok(!logs.join("\n").includes(TOKEN), "the token is never logged");

  const flag = railwayFlagName(NAME);
  for (const reason of ["TARGETING_MATCH", "SPLIT", "NO_MATCH"]) {
    answers.set(flag, { value: false, reason, trace: [] });
    eq(evaluateFlag(NAME, { env: { [NAME]: "on" } }), { value: false, source: "provider" }, `${reason}: Railway's answer wins over the variable`);
  }
  eq(seen.at(-1), [flag, undefined, false], "the read asks for the Railway name with no caller context");
  for (const reason of ["NOT_FOUND", "TYPE_MISMATCH", "STALE", "CONFLICT", "NO_KEY"]) {
    answers.set(flag, { value: false, reason, trace: [] });
    eq(evaluateFlag(NAME, { env: { [NAME]: "on" } }), { value: true, source: "env" }, `${reason}: falls to the variable`);
    eq(evaluateFlag(NAME, { env: {} }), { value: true, source: "default" }, `${reason}: falls to the default`);
  }
  answers.set(flag, { value: "false", reason: "TARGETING_MATCH", trace: [] });
  eq(evaluateFlag(NAME, { env: {} }).source, "default", "a non-boolean value is not an answer");
  // A provider whose SDK throws at read time is counted and skipped (src/feature-flags.js).
  const before = flagReadCounts().providerErrors;
  setFlagProvider(railwayFlagProvider({ evaluateBoolean: () => { throw new Error("Call `await flags.init()`"); } }));
  eq(evaluateFlag(NAME, { env: { [NAME]: "off" } }), { value: false, source: "env" }, "an SDK that throws on read falls to the variable");
  eq(flagReadCounts().providerErrors, before + 1, "the throw is counted");
  setFlagProvider(null);
}

// A failed load or init registers nothing and logs no token or SDK text.
for (const [label, loadSdk] of [
  ["load throws", async () => { throw new Error(`cannot load ${TOKEN}`); }],
  ["no SDK", async () => ({})],
  ["init throws", async () => ({ init: async () => { throw new Error(`Not Authorized for token ${TOKEN}`); }, evaluateBoolean: () => ({}) })],
]) {
  setFlagProvider(null);
  const logs = [];
  const r = await startRailwayFlags({ env: { [RAILWAY_FLAGS_TOKEN_ENV]: TOKEN }, loadSdk, log: (m) => logs.push(m) });
  eq(r, { started: false, reason: "init_failed" }, `${label}: not started`);
  eq(flagReadCounts().providerRegistered, false, `${label}: no provider`);
  ok(logs.length === 1 && !logs[0].includes(TOKEN) && !/Authorized|cannot load/.test(logs[0]), `${label}: one line, no token, no SDK text (${logs[0]})`);
  eq(evaluateFlag(NAME, { env: {} }), { value: true, source: "default" }, `${label}: reads keep their default`);
}

// The server starts it at boot.
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/^import \{ startRailwayFlags \} from "\.\/feature-flags-railway\.js";$/m.test(src) && /^void startRailwayFlags\(\);$/m.test(src), "src/server.js starts the Railway provider at boot without waiting on it");
}

// The real SDK, with a stub GraphQL endpoint: the flag is read under its
// Railway name, with the project-token header and no bearer header.
{
  setFlagProvider(null);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers || {}, body: JSON.parse(init?.body || "{}") });
    return new Response(JSON.stringify({ data: { signals: [{ name: "price-webhook-deliveries", type: "BOOL", default: false, rules: [], version: 1 }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const logs = [];
  const r = await startRailwayFlags({ env: { [RAILWAY_FLAGS_TOKEN_ENV]: TOKEN }, fetchImpl, log: (m) => logs.push(m) });
  eq(r, { started: true, synced: true }, "real SDK: started and synced");
  ok(requests.length === 1 && /signals/.test(requests[0].body.query || ""), "real SDK: one registry read");
  eq(requests[0].headers["project-access-token"], TOKEN, "real SDK: the project-token header carries the token");
  ok(!("Authorization" in requests[0].headers), "real SDK: no bearer header");
  eq(evaluateFlag(NAME, { env: { [NAME]: "on" } }), { value: false, source: "provider" }, "real SDK: Railway's flag (off) wins over the variable (on)");
  ok(!logs.join("\n").includes(TOKEN), "real SDK: the token is never logged");
  (await import("railway")).flags.close();
  setFlagProvider(null);
}

console.log(`\nfeature flags (Railway provider): ${pass} passed`);
