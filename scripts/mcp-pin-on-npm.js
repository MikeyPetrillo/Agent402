// Every agent402-mcp version production tells people to install exists on npm.
//
// The live site and the connector's server.describe print `npx -y
// agent402-mcp@<version>`. A deploy ships those pins while the [publish] job
// publishes the package beside it, so for a few minutes after a merge (or for
// good, when a publish fails) the served pin can name a version npm does not
// have, and every copied install fails with ETARGET. This reads the pins from
// /llms.txt and server.describe and asks the npm registry for each.
//
//   TARGET_URL=https://agent402.tools node scripts/mcp-pin-on-npm.js
//
// Prints one JSON line {word, versions, missing}: word is ok (every pin
// resolves), missing (at least one does not) or unknown (the site or the
// registry could not be read; never an alarm). Always exits 0; the heartbeat
// step reads the word. NPM_REGISTRY overrides the registry (tests).
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const REGISTRY = (process.env.NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
const PIN = /agent402-mcp@(\d+\.\d+\.\d+)/g;

const timed = (ms) => AbortSignal.timeout(ms);
async function servedVersions() {
  const found = new Set();
  let read = 0;
  try {
    const r = await fetch(`${TARGET}/llms.txt`, { signal: timed(15000) });
    if (r.ok) { read++; for (const m of (await r.text()).matchAll(PIN)) found.add(m[1]); }
  } catch { /* unreadable: counted below */ }
  try {
    const r = await fetch(`${TARGET}/mcp`, {
      method: "POST", signal: timed(15000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server.describe", arguments: {} } }),
    });
    if (r.ok) { read++; for (const m of (await r.text()).matchAll(PIN)) found.add(m[1]); }
  } catch { /* unreadable: counted below */ }
  return { read, versions: [...found].sort() };
}

async function onNpm(version) {
  try {
    const r = await fetch(`${REGISTRY}/agent402-mcp/${version}`, { signal: timed(15000), headers: { accept: "application/json" } });
    if (r.status === 404) return false;
    if (!r.ok) return null;
    const j = await r.json();
    return j?.version === version;
  } catch { return null; }
}

const { read, versions } = await servedVersions();
let word = "ok";
const missing = [];
if (!read || !versions.length) word = "unknown";
else {
  for (const v of versions) {
    const there = await onNpm(v);
    if (there === null) { word = "unknown"; continue; }
    if (!there) missing.push(v);
  }
  if (missing.length) word = "missing";
}
console.log(JSON.stringify({ word, versions, missing }));
