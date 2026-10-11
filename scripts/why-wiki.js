#!/usr/bin/env node
// wiki/Why-Pay-Here.md is GENERATED from WHY_POINTS (src/why.js), the list the
// home page's #why section renders. The page used to say its points were
// "copied from" that list and then drifted from it (a sentence the list had
// gained was missing, and a count the list had dropped was still there).
//
//   node scripts/why-wiki.js            print the page
//   node scripts/why-wiki.js --write    rewrite wiki/Why-Pay-Here.md
//   node scripts/why-wiki.js --check    exit 1 when the file differs
//
// scripts/test-why-wiki.js runs --check in CI.
import { readFileSync, writeFileSync } from "node:fs";
import { WHY_POINTS } from "../src/why.js";

const SITE = "https://agent402.tools";
const FILE = new URL("../wiki/Why-Pay-Here.md", import.meta.url);
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const count = (n) => WORDS[n] || String(n);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const titleKicker = (k) => k.replace(/\/\s*(.+)$/, (_, w) => `/ ${cap(w.toLowerCase())}`);
const abs = (href) => (/^https?:\/\//.test(href) ? href : SITE + href);

export function whyWikiMarkdown() {
  const n = WHY_POINTS.length;
  const head = `# Why pay here

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

${cap(count(n))} things that are different about paying here. Every claim links to the surface that proves it: what the server does, measured on the server, on the open protocols anyone can build on, x402 and MPP. The live version is ${SITE}/#why; this page is generated from the same list (\`src/why.js\`) by \`scripts/why-wiki.js\`.
`;
  const points = WHY_POINTS.map((w) => {
    const links = [...(w.links || []), ...(w.more || [])].map(([href, label]) => `- ${cap(label)}: ${abs(href)}`).join("\n");
    return `## ${titleKicker(w.kicker)} - ${w.h}\n\n${w.p}\n${links ? `\n${links}\n` : ""}`;
  }).join("\n");
  const tail = `## Start with one call

Add the hosted MCP connector, pay per call in USDC from a wallet, or buy a finished report by card. Selling into it is open too: the tollbooth charges agents per request on your own API over both protocols.

- Add to your agent: ${SITE}/docs#add
- Get a report: ${SITE}/reports
- Sell your API: ${SITE}/sell
- Receipts (settled under the quoted ceiling, with the settle tx): ${SITE}/proof
`;
  return `${head}\n${points}\n${tail}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = whyWikiMarkdown();
  if (process.argv.includes("--write")) {
    writeFileSync(FILE, want);
    console.log("wrote wiki/Why-Pay-Here.md");
  } else if (process.argv.includes("--check")) {
    const have = readFileSync(FILE, "utf8");
    if (have !== want) {
      console.error("wiki/Why-Pay-Here.md differs from WHY_POINTS: run node scripts/why-wiki.js --write");
      process.exit(1);
    }
    console.log("wiki/Why-Pay-Here.md matches WHY_POINTS");
  } else {
    process.stdout.write(want);
  }
}
