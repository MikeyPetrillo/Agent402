#!/usr/bin/env node
// /contribute tells a contributor how a change gets through CI. Every script it
// tells them to run must exist, every source file it names must exist, and the
// rules it states must be the ones the code applies:
//   - the free tier is an allowlist (src/free-tier.js FREE_TIER_SLUGS), so a
//     new tool is wallet-only by default, with WALLET_ONLY_SLUGS an override;
//   - a new route is recorded with published-slugs.js --write;
//   - a skill pack also runs server-side at POST /api/skill/<slug> for one
//     payment, priced by scripts/pack-prices.js.
// Offline.
import { existsSync, readFileSync } from "node:fs";
import { contributePage } from "../src/contribute.js";
import { decodeEntities, stripTags, stripInlineTags } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);

const html = contributePage("https://agent402.tools");
const text = decodeEntities(stripTags(stripInlineTags(html))).replace(/\s+/g, " ");

const scripts = [...new Set([...text.matchAll(/node (scripts\/[a-z0-9-]+\.js)/g)].map((m) => m[1]))];
ok(scripts.length >= 5, `the page names ${scripts.length} scripts to run`);
for (const s of scripts) ok(existsSync(new URL(s, root)), `${s} exists`);
// src/tools/my-kit.js is the page's worked example of a file you create.
const files = [...new Set([...text.matchAll(/\b((?:src|scripts)\/[a-z0-9/-]+\.js)\b/g)].map((m) => m[1]))].filter((f) => f !== "src/tools/my-kit.js");
for (const f of files) ok(existsSync(new URL(f, root)), `${f} exists`);

const freeTier = readFileSync(new URL("src/free-tier.js", root), "utf8");
ok(/export const FREE_TIER_SLUGS = new Set\(/.test(freeTier) && text.includes("New tools are wallet-only by default") && text.includes("FREE_TIER_SLUGS in src/free-tier.js"),
  "the free-tier rule is the allowlist in src/free-tier.js");
ok(!/automatically eligible for the free proof-of-work tier|must be added to WALLET_ONLY_SLUGS/.test(text), "no pre-allowlist free-tier rule");
ok(text.includes("node scripts/published-slugs.js --write"), "adding a route records it with published-slugs.js --write");
ok(text.includes("POST /api/skill/<slug>") && text.includes("scripts/pack-prices.js") && text.includes("src/tools/skill-runner.js"),
  "skill packs: the server-side paid run, its runner and its generated price are described");
ok(!/Payment only happens when the agent actually calls each tool - the template itself is free\./.test(text), "no claim that a pack is only ever paid per tool");
ok(text.includes("ships in a catalog of 500+ tools"), "the intro says a contribution ships in the catalog");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
