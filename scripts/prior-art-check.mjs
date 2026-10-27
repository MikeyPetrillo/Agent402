#!/usr/bin/env node
// Before building a feature: look for an existing, maintained, licensed project
// and for a live tool in our own catalog. Read-only; prints a shortlist.
//
//   node scripts/prior-art-check.mjs "rate limiter for express"
//
// Needs the gh CLI signed in (for GitHub search). Catalog search is public.
import { execFileSync } from "node:child_process";

const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error("usage: node scripts/prior-art-check.mjs <what you want to build>"); process.exit(2); }

const SIX_MONTHS = Date.now() - 182 * 24 * 3600 * 1000;

// GitHub: keyword search, most-starred first, then keep only repos that are
// active, licensed and not archived.
let repos = [];
try {
  const out = execFileSync("gh", ["search", "repos", query, "--sort", "stars", "--limit", "15", "--json", "fullName,url,stargazersCount,pushedAt,license,isArchived,description"], { encoding: "utf8" });
  repos = JSON.parse(out);
} catch (e) {
  console.log(`GitHub search unavailable (${String(e.message || e).split("\n")[0].slice(0, 120)}). Run it by hand: gh search repos "${query}"`);
}
const kept = repos.filter((r) => !r.isArchived && r.license && r.pushedAt && Date.parse(r.pushedAt) >= SIX_MONTHS);
console.log(`\nGitHub: ${repos.length} matches, ${kept.length} active (pushed in 6 months), licensed, not archived`);
for (const r of kept.slice(0, 8)) {
  console.log(`  ${r.fullName} (${r.stargazersCount}★, ${r.license?.name || r.license?.key || "license?"}, pushed ${r.pushedAt.slice(0, 10)})`);
  console.log(`    ${r.url}${r.description ? " - " + r.description.slice(0, 90) : ""}`);
}

// Our catalog: public find endpoint, free, no payment.
try {
  const res = await fetch(`https://agent402.tools/api/find?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  const tools = (j.tools || j.results || []).slice(0, 5);
  console.log(`\nAgent402 catalog: ${tools.length} close match(es)`);
  for (const t of tools) console.log(`  ${t.slug || t.name} | ${t.price || "-"} | ${String(t.description || "").slice(0, 90)}`);
  if (!tools.length) console.log("  none - nothing in the catalog covers this yet");
} catch (e) {
  console.log(`\nAgent402 catalog unreachable (${String(e.message || e).slice(0, 80)})`);
}
console.log("\nDecide before building: reuse, extend, or build. Write the decision in the PR body.");
