#!/usr/bin/env node
// Reads the operator wishes feed (JSON) on stdin and prints, one JSON object
// per line, the qualified clusters whose text the listing screen does not flag
// (src/listing-screen.js: hidden characters, oversized text, instruction
// phrases). Used by .github/workflows/wish-issues.yml, which runs it with no
// install: the screen module depends on nothing outside src/.
import { looksLikeListingInjection } from "../src/listing-screen.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let feed;
try { feed = JSON.parse(raw || "{}"); } catch { feed = {}; }
let skipped = 0;
for (const c of Array.isArray(feed.clusters) ? feed.clusters : []) {
  if (!c || c.qualified !== true) continue;
  const sources = c.sources && typeof c.sources === "object" ? Object.entries(c.sources).map(([k, v]) => `${k} ${v}`).join(" ") : "";
  if (looksLikeListingInjection(`${c.text ?? ""} ${sources}`)) { skipped++; continue; }
  process.stdout.write(`${JSON.stringify(c)}\n`);
}
if (skipped) process.stderr.write(`skipped ${skipped} cluster(s) the listing screen flags\n`);
