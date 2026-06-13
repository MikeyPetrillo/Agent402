// Drive EVERY catalog tool through the real /mcp connector path (call_tool),
// not just direct HTTP — this is the gap that let the stringified-params bug
// ship. Free-tier (proof-of-work-eligible) tools must execute with their own
// documented example and return a non-error result; wallet-only tools must be
// cleanly REFUSED with paid-path guidance (never crash, never silently run).
//
// Needs no network: free tools are pure-CPU; wallet tools are refused before
// any handler runs. Start the server with a raised MCP rate limit, e.g.:
//   AGENT402_MCP_MAX_PER_MIN=1000000 AGENT402_MCP_MAX_PER_HOUR=1000000 \
//     FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-mcp-all.js
const TARGET = process.env.TARGET_URL || "http://localhost:3000";

let idc = 1;
async function rpc(method, params) {
  const res = await fetch(`${TARGET}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: idc++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (ct === "text/event-stream") {
    const t = await res.text();
    return JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
  }
  return res.json();
}

// Build each tool's example input from the OpenAPI spec (same source the direct
// HTTP smoke test uses): GET → parameter examples; POST → requestBody example.
const [pricing, spec] = await Promise.all([
  fetch(`${TARGET}/api/pricing`).then((r) => r.json()),
  fetch(`${TARGET}/openapi.json`).then((r) => r.json()),
]);

function exampleFor(method, path) {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  if (!op) return {};
  if (method === "GET") {
    const out = {};
    for (const p of op.parameters ?? []) if (p.example !== undefined) out[p.name] = p.example;
    return out;
  }
  return op.requestBody?.content?.["application/json"]?.example ?? {};
}

const endpoints = pricing.endpoints || [];
let freeOk = 0, freeFail = 0, walletOk = 0, walletFail = 0;
const failures = [];

for (const e of endpoints) {
  const slug = e.slug || e.docs?.split("/tools/").pop();
  if (!slug) continue;
  // memory tools are wallet-only and identity-bound; they should refuse cleanly
  // on the connector like any other wallet-only tool — covered by that branch.
  const params = exampleFor(e.method, e.path);
  let r;
  try {
    r = await rpc("tools/call", { name: "call_tool", arguments: { slug, params } });
  } catch (err) {
    failures.push(`${slug} → transport error: ${err.message}`);
    (e.computePayable ? freeFail++ : walletFail++);
    continue;
  }
  const isError = r.result?.isError === true;
  const text = r.result?.content?.[0]?.text ?? r.result?.content?.[0]?.data ?? "";

  if (e.computePayable) {
    // Free tier: must execute and NOT be an error.
    if (!isError && r.result?.content?.length) freeOk++;
    else { freeFail++; failures.push(`FREE ${slug} → ${isError ? "isError" : "no content"}: ${String(text).slice(0, 80)}`); }
  } else {
    // Wallet-only: must be refused with guidance (clean, not a crash).
    if (isError && /agent402-mcp|wallet|AGENT_KEY/i.test(String(text))) walletOk++;
    else { walletFail++; failures.push(`WALLET ${slug} → expected refusal, got ${isError ? "error w/o guidance" : "EXECUTION"}: ${String(text).slice(0, 80)}`); }
  }
}

console.log(`\nDrove ${endpoints.length} tools through /mcp call_tool at ${TARGET}`);
console.log(`  free-tier executed:   ${freeOk} ok, ${freeFail} failed`);
console.log(`  wallet-only refused:  ${walletOk} ok, ${walletFail} failed`);
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ` + failures.slice(0, 50).join("\n  ") + (failures.length > 50 ? `\n  …and ${failures.length - 50} more` : ""));
}
process.exit(freeFail === 0 && walletFail === 0 ? 0 : 1);
