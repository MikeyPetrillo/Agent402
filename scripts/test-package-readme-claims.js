#!/usr/bin/env node
// What the published package READMEs say about the code stays true. Offline.
//   1. agent402-client holds a default per-call ceiling (DEFAULT_MAX_PER_CALL_USD
//      in client/index.js), so no package README says no cap is set by default,
//      and a README of a package built on agent402-client that documents
//      maxPerCallUsd states that default's amount.
//   2. The AWS agent service is named "Amazon Bedrock" (the wiki page's URL
//      slug is the one exception, and a URL is not prose).
//   3. The OpenAI examples in the adapter READMEs name one model, so moving the
//      example moves every adapter (one README kept a retired model once).
// Typed chain counts and lists are held by scripts/test-chain-list-copy.js and
// the lead sentence by scripts/test-positioning.js.
//   node scripts/test-package-readme-claims.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedPackageDirs } from "./lib/published-packages.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (f) => readFileSync(join(ROOT, f), "utf8");

const NO_DEFAULT_CAP = /\bno (?:spending )?(?:cap|ceiling|limit)s? (?:is |are )?(?:set )?by default\b|\bnone by default\b|Spending caps \(opt-in\)|\bno cap is set\b/i;
const AWS_BEDROCK = /\bAWS Bedrock\b/;
const OPENAI_MODEL = /\bopenai\(\s*"([^"]+)"\s*\)|\bopenai\(\{\s*model:\s*"([^"]+)"|chat\.completions\.create\(\{\s*model:\s*"([^"]+)"/g;

// Controls: each pattern sees what it guards and passes the corrected text.
ok(NO_DEFAULT_CAP.test("No cap is set by default: a call is never refused") && NO_DEFAULT_CAP.test("maxPerCallUsd?: number; // opt-in spending caps (none by default)") && NO_DEFAULT_CAP.test("## Spending caps (opt-in)"),
  "control: the old no-default-cap sentences are matched");
ok(!NO_DEFAULT_CAP.test("agent402-client 0.10.0 and later hold one ceiling by default: `maxPerCallUsd` of $5") && !NO_DEFAULT_CAP.test("the other two USD caps are optional, none set by default"),
  "control: the corrected sentences are not matched");
ok(AWS_BEDROCK.test("including on AWS Bedrock AgentCore") && !AWS_BEDROCK.test("wiki/AWS-Bedrock-AgentCore") && !AWS_BEDROCK.test("Amazon Bedrock AgentCore"), "control: the Bedrock rule reads prose, not the URL slug");

const src = read("client/index.js");
const capM = /^export const DEFAULT_MAX_PER_CALL_USD = (\d+(?:\.\d+)?);$/m.exec(src);
const cap = capM ? Number(capM[1]) : NaN;
ok(Number.isFinite(cap), `agent402-client's default per-call ceiling is read from client/index.js ($${capM?.[1] ?? "none"})`);

const dirs = publishedPackageDirs();
ok(dirs.length >= 14, `the publish job's packages are read (${dirs.length})`);
const models = new Map();
for (const dir of dirs) {
  const readme = `${dir}/README.md`;
  if (!existsSync(join(ROOT, readme))) { ok(false, `${readme} exists`); continue; }
  const text = read(readme);
  const pkg = JSON.parse(read(`${dir}/package.json`));
  // 1. The default ceiling.
  if (cap > 0) {
    const line = text.split("\n").find((l) => NO_DEFAULT_CAP.test(l));
    ok(!line, `${readme}: no sentence says no cap is set by default (agent402-client defaults $${cap})${line ? `: "${line.trim().slice(0, 120)}"` : ""}`);
    const onClient = dir === "client" || Boolean(pkg.dependencies?.["agent402-client"]);
    if (onClient && /\bmaxPerCallUsd\b/.test(text)) {
      // Some window of three lines names maxPerCallUsd, "default" and the
      // amount ($5 or `5`), so the default is stated next to the option.
      const amount = new RegExp(`(?:\\$|\`)${String(cap).replace(".", "\\.")}(?![\\d.])`);
      const lines = text.split("\n");
      const statesDefault = lines.some((_, i) => {
        const w = lines.slice(i, i + 3).join("\n");
        return /\bmaxPerCallUsd\b/.test(w) && /\bdefault\b/.test(w) && amount.test(w);
      });
      ok(statesDefault,
        `${readme}: documents maxPerCallUsd with agent402-client's $${cap} default`);
    }
  }
  // 2. Bedrock naming, in the README and the npm description.
  const bad = [readme, `${dir}/package.json`].filter((f) => AWS_BEDROCK.test(read(f)));
  ok(bad.length === 0, `${dir}: names the service "Amazon Bedrock"${bad.length ? ` (AWS Bedrock in ${bad.join(", ")})` : ""}`);
  // 3. Collect the OpenAI example models.
  if (dir.startsWith("adapters/")) for (const m of text.matchAll(OPENAI_MODEL)) models.set(`${readme}:${m[1] || m[2] || m[3]}`, m[1] || m[2] || m[3]);
}
const distinct = [...new Set(models.values())];
ok(models.size >= 3, `the adapter READMEs' OpenAI examples are found (${models.size}): zero would mean the scan is blind`);
ok(distinct.length === 1, `every adapter README's OpenAI example names one model (${distinct.join(", ")})${distinct.length > 1 ? `: ${[...models.keys()].join(", ")}` : ""}`);

console.log(`\ntest-package-readme-claims: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
