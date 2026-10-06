#!/usr/bin/env node
// Every HTML page names /llms.txt (a <link rel="alternate"> in the head and a
// Link response header), so an agent that reads only the page it landed on
// finds the machine-readable site map. JSON answers carry neither. And an agent
// on a non-EVM rail learns which routes it cannot pay before it pays:
// /api/pricing lists a restricted route's networks, the x402 manifest says so.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { withLlmsLinkTag, LLMS_LINK_TAG } from "../src/llms-link.js";

let pass = 0, proc = null;
const log = [];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of log.slice(-20)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : fail(m); };

// --- offline: the injector
const page = "<!doctype html><html><head><title>x</title></head><body></body></html>";
ok(withLlmsLinkTag(page).includes(`${LLMS_LINK_TAG}\n</head>`), "the tag lands just before </head>");
ok(withLlmsLinkTag(withLlmsLinkTag(page)).split('href="/llms.txt"').length === 2, "a second pass adds no second tag");
ok(withLlmsLinkTag("<p>fragment</p>") === "<p>fragment</p>", "a fragment with no </head> is left alone");

// --- live: FREE_MODE boot
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", X402_SYNC_ON_START: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
proc.stderr.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
let up = false;
for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
try {
  ok(up, "server booted");
  // One page from each kind of shell: ledger shell, hand-written heads, the
  // legacy chrome, a tool page, and a 404.
  for (const p of ["/", "/tools", "/tools/hash", "/revenue", "/sell", "/why", "/crawler", "/what-is-x402", "/no-such-page"]) {
    const r = await fetch(`${B}${p}`);
    const html = await r.text();
    ok(html.split(LLMS_LINK_TAG).length === 2, `${p} carries the /llms.txt link tag exactly once`);
    ok(/<\/llms\.txt>; rel="alternate"; type="text\/plain"/.test(r.headers.get("link") || ""), `${p} sends the /llms.txt Link header`);
  }
  // A route's own Link header keeps its value; ours is appended.
  for (const p of ["/api/pricing", "/llms.txt", "/.well-known/x402"]) {
    const r = await fetch(`${B}${p}`);
    ok(!/llms\.txt/.test(r.headers.get("link") || ""), `${p} (not HTML) carries no /llms.txt Link header`);
  }

  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const row = (slug) => pricing.endpoints.find((e) => e.slug === slug);
  const mem = row("memory-write");
  ok(mem && Array.isArray(mem.networks) && mem.networks.length && mem.networks.every((n) => n.startsWith("eip155:")), "an identity-bound route lists EVM networks only");
  ok(mem.identityBound === true, "...and says it is identity-bound");
  ok(!("networks" in row("hash")) && !("identityBound" in row("hash")), "a route every rail can pay carries neither field");
  const manifest = await (await fetch(`${B}/.well-known/x402`)).json();
  ok(/EVM chains only/.test(manifest.ecosystem?.restrictedRoutes || "") && /\/api\/pricing/.test(manifest.ecosystem.restrictedRoutes), "the x402 manifest names the restriction and where to read it");

  console.log(`\n${pass} passed, 0 failed`);
} finally { proc?.kill("SIGKILL"); }
