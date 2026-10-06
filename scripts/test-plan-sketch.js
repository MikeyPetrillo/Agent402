// Free multi-step plan sketch (src/plan-sketch.js). Offline.
//
// What is pinned:
//  - only explicit sequence words split a task; a bare "and" never does, so a
//    single-tool query never turns into a plan;
//  - each step is ranked by the ranker handed in, with a strong/weak verdict,
//    fallbacks and a price total that counts free steps as zero;
//  - the sketch never reaches the network: the module imports nothing, and a
//    build with fetch and http patched to throw completes without touching them;
//  - find, route and the connector all attach it, and the /api/find miss path
//    reads the caller IP it is handed (it used to reference an out-of-scope
//    `req`, which threw and was swallowed, so no HTTP miss was ever recorded).
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { splitSteps, buildPlanSketch, PLAN_MAX_STEPS } from "../src/plan-sketch.js";
import { findTools } from "../src/find.js";
import { KIT } from "../src/tools/kit.js";
import { KIT2 } from "../src/tools/kit2.js";
import { STATS_TOOLS } from "../src/tools/stats-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- splitting
const split = [
  ["get the bitcoin price then compute rsi", 2],
  ["geocode paris and then get the weather forecast", 2],
  ["extract the article; summarize it; translate to spanish", 3],
  ["1. hash the text 2. base64 encode it 3. make a qr code", 3],
  ["step 1: get stock quote step 2: compute moving average", 2],
  ["convert 5 miles to km, then format as json, finally hash it", 3],
];
for (const [q, n] of split) ok(splitSteps(q).length === n, `"${q}" splits into ${n} steps (got ${JSON.stringify(splitSteps(q))})`);
for (const q of ["search the web for x402 adoption", "bitcoin and ethereum price", "what happened then", "a then b", "", "hash and encode"]) {
  ok(splitSteps(q).length === 0, `"${q}" stays a single step`);
}

// ---- building against the real catalog kits
const C = Object.fromEntries([...KIT, ...KIT2, ...STATS_TOOLS].map((t) => [t.route, t]));
const free = new Set(["hash", "base64", "qr", "rsi", "moving-average", "json-format", "unit-convert"]);
const rank = (task) => findTools(C, task, { k: 3, baseUrl: "https://agent402.tools", powSlugs: free });
const upgrade = { tool: "decide", route: "POST /api/decide", price: "$0.005" };

ok(buildPlanSketch("hash a string with sha256", { rank, upgrade }) === null, "a single-step task gets no sketch");
const p = buildPlanSketch("hash the text with sha256, then base64 encode it, then make a qr code", { rank, upgrade });
ok(p && p.kind === "sketch" && p.stepCount === 3, "a three-step task gets a three-step sketch");
ok(p.steps.map((s) => s.tool?.slug).join(",") === "hash,base64,qr", `each step ranks its own tool (${p.steps.map((s) => s.tool?.slug)})`);
ok(p.steps.every((s) => s.match === "strong"), "clear steps match strongly");
ok(p.steps[0].dependsOn === undefined && p.steps[1].dependsOn?.[0] === 1 && p.steps[2].dependsOn?.[0] === 2, "each step after the first depends on the one before it");
ok(p.estimatedCostUsd === 0 && p.estimatedCostIsFloor === false, "free (proof-of-work) steps add nothing to the total");
ok(p.upgrade === upgrade, "the paid decide upgrade is passed through unchanged");
ok(/no model/.test(p.builtBy), "the sketch says how it was built");
ok(p.steps.every((s) => Array.isArray(s.fallbacks) && s.fallbacks.length <= 2), "at most two fallbacks per step");

const paidRank = (task) => { const r = rank(task); r.results = r.results.map((t) => ({ ...t, computePayable: false, priceUsd: 0.002 })); return r; };
const priced = buildPlanSketch("hash the text, then base64 encode it", { rank: paidRank });
ok(priced.estimatedCostUsd === 0.004, `paid steps sum their list prices (${priced.estimatedCostUsd})`);
ok(priced.upgrade === undefined, "no upgrade is named when decide is not served");

const weak = buildPlanSketch("hash the text then order me a pizza", { rank });
ok(weak.steps[1].match !== "strong" && weak.weakSteps?.includes(2) && weak.estimatedCostIsFloor === true, "a step nothing serves is flagged and the total becomes a floor");

const long = buildPlanSketch(Array.from({ length: 8 }, (_, i) => `hash text number ${i}`).join(" then "), { rank });
ok(long.stepCount === PLAN_MAX_STEPS && long.truncated === true && long.maxSteps === PLAN_MAX_STEPS, `steps are capped at ${PLAN_MAX_STEPS}`);

// ---- no network, ever
const src = readFileSync(new URL("../src/plan-sketch.js", import.meta.url), "utf8");
ok(!/^\s*import\s/m.test(src) && !/\brequire\(/.test(src), "plan-sketch.js imports nothing (the ranker is handed in)");
ok(!/\bfetch\(|https?:\/\//.test(src.replace(/\/\/.*$/gm, "")), "plan-sketch.js names no fetch and no URL outside comments");
{
  let touched = 0;
  const realFetch = globalThis.fetch, realReq = http.request, realsReq = https.request;
  globalThis.fetch = () => { touched++; throw new Error("network"); };
  http.request = () => { touched++; throw new Error("network"); };
  https.request = () => { touched++; throw new Error("network"); };
  try { buildPlanSketch("get the stock price then compute a moving average then compute rsi", { rank, upgrade }); }
  finally { globalThis.fetch = realFetch; http.request = realReq; https.request = realsReq; }
  ok(touched === 0, "building a sketch made no network call");
}

// ---- wiring
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const mcp = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
const findFn = server.slice(server.indexOf("const computeFind = async"), server.indexOf("const findCachePath"));
ok(/const plan = planSketchFor\(q\);[\s\S]{0,80}result\.plan = plan/.test(findFn), "/api/find attaches the sketch");
ok(!/\breq\?\.ip\b/.test(findFn) && /computeFind = async \(q, k, meter = null, ip = null\)/.test(findFn), "the /api/find miss path reads the IP it is handed, not an out-of-scope req");
ok((server.match(/computeFind\(q, k, meter, req\.ip\)/g) || []).length === 2, "both /api/find routes hand computeFind the caller IP");
ok(/const plan = q \? planSketchFor\(q\) : null;\s*if \(plan\) out\.plan = plan;/.test(server), "/api/route attaches the sketch");
ok(/buildPlanSketch\(taskStr,/.test(mcp) && /\.\.\.\(plan \? \{ plan \} : \{\}\)/.test(mcp), "the connector's catalog.find attaches the sketch");
ok(!/multiStep/.test(server), "the fixed multiStep pointer is gone (decide is named inside a sketch instead)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
