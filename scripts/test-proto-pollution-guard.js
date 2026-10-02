#!/usr/bin/env node
// A seller's OpenAPI could name a required body path "__proto__.creditsSettling";
// the live-402 probe walked it into Object.prototype and every request then read
// as settled at the payment gate (found by the 2026-09-24 security review). Three
// layers, each pinned: request-contract refuses prototype-addressing names, the
// body builder cannot reach a prototype, and the gate reads only own true flags.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { requestContractOf, packRequestContract, unpackRequestContract, safeName } = await import("../src/request-contract.js");
const { probeBodyFor } = await import("../src/x402-live-quote.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const clean = () => ({}).creditsSettling === undefined && ({}).tempoSettling === undefined && ({}).stripeSettling === undefined;

// 1. the names are refused at the source
for (const name of ["__proto__", "constructor", "prototype"]) ok(safeName(name) === null, `safeName refuses ${name}`);
ok(safeName("user_id") === "user_id", "ordinary names still pass");

// 2. the exact crafted operation from the review
const op = JSON.parse('{"requestBody":{"content":{"application/json":{"schema":{"type":"object","required":["__proto__","url"],"properties":{"__proto__":{"type":"object","required":["creditsSettling"]},"url":{"type":"string"}}}}}}}');
const packed = packRequestContract(requestContractOf(op));
ok(!JSON.stringify(packed).includes("__proto__"), `the contract drops the prototype path (${JSON.stringify(packed)})`);
const body = probeBodyFor({ requestContract: packed });
ok(clean(), "building the probe body does not pollute Object.prototype");
ok(body === '{"url":"https://example.com"}', `the ordinary field survives (${body})`);

// 3. even a contract written straight to the cache cannot reach the prototype
const forged = { requestContract: ["declared", { body: ["__proto__.creditsSettling", "constructor.prototype.tempoSettling", "a.b"] }] };
probeBodyFor(forged);
ok(clean(), "a forged cached contract does not pollute Object.prototype");
ok(unpackRequestContract(forged)?.required?.body?.every((p) => !/__proto__|constructor|prototype/.test(p)), "unpacking drops the reserved segments too");

// 4. the gate reads own, strictly-true flags only
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/ownTrue\(req, "tempoSettling"\) \|\| ownTrue\(req, "stripeSettling"\) \|\| ownTrue\(req, "creditsSettling"\)/.test(src), "the payment gate checks own true flags");
ok(!/if \(req\.tempoSettling \|\| req\.stripeSettling \|\| req\.creditsSettling\)/.test(src), "the inheritable truthy check is gone");
console.log(`test-proto-pollution-guard: ${n} assertions ok`);
