#!/usr/bin/env node
// What the router and /api/decide/execute do with a third-party result, said
// one way everywhere: Agent402 buys the result from the outside seller and
// sells it to the buyer, at the seller's price plus a disclosed markup or at
// the route's flat price. This keeps the copy, docs, package READMEs, tool
// tags and the terms on that description.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n.startsWith(".") || n === "package-lock.json") continue;
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(js|mjs|md|json|html)$/.test(n)) files.push(f);
  }
};
for (const d of ["src", "wiki", "docs", "mcp", "client", "adapters", "openclaw", "tollbooth"]) { try { walk(join(ROOT, d)); } catch { /* absent */ } }
files.push(join(ROOT, "README.md"));
ok(files.length > 100, `the scan read the published trees (${files.length} files)`);

// "on your behalf" describes us acting for the buyer; these phrases are about
// something else (a cache, a balance we do not hold, a post we do not make).
const AGENCY = /\bon (?:your|the buyer'?s|a buyer'?s|the caller'?s|a caller'?s|an agent'?s|the agent'?s|their) behalf\b/i;
const NOT_AGENCY = /caches nothing on your behalf|holds a balance on your behalf|(?:nothing|not) (?:is )?posted on your behalf/i;
const agency = [], fee = [], tags = [];
for (const f of files) {
  const rel = f.slice(ROOT.length);
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (AGENCY.test(line) && !NOT_AGENCY.test(line)) agency.push(`${rel}:${i + 1}`);
    // Prose only: code comments may still name the internal routingFee figure.
    if (/routing fee/i.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) fee.push(`${rel}:${i + 1}`);
  });
  // Tag lists span lines, so they are read whole.
  for (const m of readFileSync(f, "utf8").matchAll(/\btags:\s*\[([^\]]*)\]/g)) {
    if (/"(?:broker|delegate|behalf)"/.test(m[1])) tags.push(rel);
  }
}
ok(agency.length === 0, `no published text says we act on a buyer's behalf${agency.length ? `: ${agency.slice(0, 8).join(", ")}` : ""}`);
ok(fee.length === 0, `published prose calls the router's margin a markup, not a routing fee${fee.length ? `: ${fee.slice(0, 8).join(", ")}` : ""}`);
ok(tags.length === 0, `no tool is tagged broker, delegate or behalf${tags.length ? `: ${tags.join(", ")}` : ""}`);

// The router's public reason string and the terms say the same thing.
const dispatch = readFileSync(join(ROOT, "src", "dispatch-eligibility.js"), "utf8");
ok(/eligible: "the router will buy from this seller"/.test(dispatch), "the router's eligible reason reads \"the router will buy from this seller\"");
const terms = readFileSync(join(ROOT, "src", "terms.js"), "utf8");
ok(/Results from other sellers/.test(terms) && /buys that result from the seller for its own account/.test(terms) && /sells it to you/.test(terms),
  "the terms state that Agent402 buys a third-party result for its own account and sells it to the buyer");
ok(/redeemable only for Agent402 services/.test(terms), "the terms say a route's service credit is redeemable only for Agent402 services");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
