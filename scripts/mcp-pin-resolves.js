#!/usr/bin/env node
// After a deploy: does the agent402-mcp version every install line names
// resolve on npm? The README, the guides, llms-install.md, the connector's own
// answers and the stdio package pin `agent402-mcp@<mcp/package.json version>`
// (scripts/test-mcp-version-pins.js), and the deploy job does not wait on the
// publish job, so a version bump that ships before its publish lands, or
// whose publish failed or was never marked, points every copy-paste install
// at an E404. This reads the registry until the version resolves or the wait
// ends, and fails the step (exit 1, an ::error:: line) when it never does.
//
//   node scripts/mcp-pin-resolves.js
//
// MCP_PIN_WAIT_MS (default 20 minutes) and MCP_PIN_POLL_MS (default 30 s)
// bound the wait; NPM_REGISTRY_URL names the registry (tests point it at a
// stub). An unreadable registry (a network error, a 5xx) is retried within
// the wait and, if it never answers, is a warning (exit 2), not a verdict.
import { readFileSync } from "node:fs";

const PKG = "agent402-mcp";
const version = JSON.parse(readFileSync(new URL("../mcp/package.json", import.meta.url), "utf8")).version;
const registry = String(process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/+$/, "");
const waitMs = Math.max(0, Number(process.env.MCP_PIN_WAIT_MS ?? 20 * 60_000) || 0);
const pollMs = Math.max(10, Number(process.env.MCP_PIN_POLL_MS) || 30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "found" | "missing" (the registry says no such version) | "unread". */
async function read() {
  try {
    const r = await fetch(`${registry}/${PKG}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 200) { const j = await r.json().catch(() => null); return j?.version === version ? "found" : "unread"; }
    await r.arrayBuffer().catch(() => {});
    return r.status === 404 ? "missing" : "unread";
  } catch { return "unread"; }
}

const t0 = Date.now();
let last = "unread", reads = 0;
for (;;) {
  last = await read();
  reads++;
  if (last === "found") break;
  if (Date.now() - t0 + pollMs > waitMs) break;
  await sleep(pollMs);
}
const waited = Math.round((Date.now() - t0) / 1000);
if (last === "found") {
  console.log(`${PKG}@${version} resolves on npm (${reads} read(s), ${waited} s): every install line's pin is installable.`);
  process.exit(0);
}
if (last === "missing") {
  console.log(`::error::${PKG}@${version} does not resolve on npm after ${waited} s (${reads} read(s)): the install lines that pin it answer E404. Check the publish job on this run (a version bump ships with a [publish] subject), or publish it, then re-run this step.`);
  process.exit(1);
}
console.log(`::warning::The npm registry could not be read for ${PKG}@${version} (${reads} read(s), ${waited} s); no verdict on the install pins.`);
process.exit(2);
