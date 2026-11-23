#!/usr/bin/env node
// The auto-paying packages each ship a default per-call ceiling that protects
// the buyer's own wallet: agent402-mcp (AGENT402_MAX_PER_CALL),
// agent402-openclaw, agent402-agentkit and the four meta-tool adapters
// (maxPerCallUsd) and elizaos-plugin-agent402 (AGENT402_MAX_PER_CALL_USD). The default must cover
// every fixed price this server lists, so a buyer on defaults is never refused
// a listed tool. This boots a FREE_MODE server on port 0, reads the dearest
// fixed price from /api/pricing (each endpoint's price and each gateway tier
// that is not quoted per request), and fails when it exceeds any package's
// default: a pricier tool forces a decision on the default or the price.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// Each package declares its default as a named constant; read it from source
// so a package with its own install tree needs no dependencies here.
const PACKAGES = [
  ["agent402-mcp", "mcp/index.js"],
  ["agent402-openclaw", "openclaw/index.js"],
  ["agent402-agentkit", "adapters/agentkit/index.js"],
  ["elizaos-plugin-agent402", "adapters/eliza/index.js"],
  ["agent402-langchain", "adapters/langchain/index.js"],
  ["agent402-ai-sdk", "adapters/ai-sdk/index.js"],
  ["agent402-openai-agents", "adapters/openai-agents/index.js"],
  ["agent402-google-adk", "adapters/google-adk/index.js"],
];
const defaults = PACKAGES.map(([name, file]) => {
  const src = readFileSync(`${ROOT}${file}`, "utf8");
  const m = /^(?:export )?const DEFAULT_MAX_PER_CALL_USD = (\d+(?:\.\d+)?);$/m.exec(src);
  ok(m && Number(m[1]) > 0, `${name} declares a finite default per-call ceiling (${m ? `$${m[1]}` : "none found"} in ${file})`);
  return { name, usd: m ? Number(m[1]) : NaN };
});

const usdOf = (price) => {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price ?? "").trim());
  return m ? Number(m[1]) : null;
};

const srv = await bootServer({
  env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off" },
  stores: "package-cap-defaults",
});
try {
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const endpoints = pricing.endpoints || [];
  ok(endpoints.length >= 400, `the catalog is read (${endpoints.length} endpoints)`);
  const rows = [
    ...endpoints.map((e) => ({ what: e.slug || e.path, usd: usdOf(e.price) })),
    ...((pricing.llmGateway?.tiers) || []).filter((t) => !t.quoted).map((t) => ({ what: t.path, usd: usdOf(t.price) })),
  ];
  const unread = rows.filter((r) => r.usd == null);
  ok(unread.length === 0, `every listed price reads as a fixed USD amount${unread.length ? `: ${unread.slice(0, 5).map((r) => r.what).join(", ")}` : ""}`);
  const dearest = rows.reduce((a, r) => (r.usd != null && r.usd > a.usd ? r : a), { what: null, usd: 0 });
  ok(dearest.usd > 0, `the dearest fixed price is read from /api/pricing ($${dearest.usd}, ${dearest.what})`);
  for (const d of defaults) {
    ok(Number.isFinite(d.usd) && dearest.usd <= d.usd, `${d.name}'s default per-call ceiling $${d.usd} covers the dearest fixed price $${dearest.usd} (${dearest.what})`);
  }
} finally {
  await srv.stop();
}

console.log(`\ntest-package-cap-defaults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
