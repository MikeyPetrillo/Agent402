#!/usr/bin/env node
// Every skill-pack step sends only input keys its target tool declares. A key
// the tool does not read is silently dropped and the tool falls back to its
// default, so a pack can promise one thing and deliver another (a pack sent
// lookbackDays: 90 to a tool that reads days, and returned its 30-day default).
// Boots a FREE_MODE server on port 0 and reads each route's declared inputs
// from /openapi.json.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import { PACK_STEPS } from "../src/tools/skill-runner.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, ...ownStoreEnv("skill-step-inputs"), PORT: "0", FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let base = null;
const portFrom = (s) => { const m = /listening[^\n]*?(?:port\s*|:)(\d{2,5})/i.exec(s); if (m && !base) base = `http://127.0.0.1:${m[1]}`; };
proc.stdout.on("data", (d) => portFrom(String(d)));
proc.stderr.on("data", (d) => portFrom(String(d)));
const stop = () => { try { proc.kill("SIGTERM"); } catch { /* gone */ } };
try {
  for (let i = 0; i < 240 && !base; i++) await new Promise((r) => setTimeout(r, 250));
  if (!base) throw new Error("server did not report its port");
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const openapi = await (await fetch(`${base}/openapi.json`)).json();
  // slug -> the input keys its route declares (query parameters and body properties).
  const declared = new Map();
  for (const e of pricing.endpoints || []) {
    const op = openapi.paths?.[e.path]?.[String(e.method || "GET").toLowerCase()];
    if (!op) continue;
    const keys = new Set((op.parameters || []).filter((p) => p.in === "query").map((p) => p.name));
    const body = op.requestBody?.content?.["application/json"]?.schema;
    const props = body?.properties || body?.allOf?.flatMap((s) => Object.keys(s.properties || {})).reduce((o, k) => ({ ...o, [k]: 1 }), {}) || {};
    for (const k of Object.keys(props)) keys.add(k);
    const open = body && (body.additionalProperties === true || (!body.properties && !body.allOf));
    declared.set(e.slug, { keys, open: !!open || (!body && !(op.parameters || []).length) });
  }
  // A sample argument object: any property reads as a short string.
  const args = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? "AAPL" : undefined), has: () => true });
  const bad = [];
  let checked = 0;
  for (const [pack, cfg] of Object.entries(PACK_STEPS)) {
    for (const step of cfg?.steps || []) {
      if (typeof step.mapInput !== "function") continue;
      const d = declared.get(step.slug);
      if (!d || d.open) continue;
      let input;
      try { input = step.mapInput(args, {}); } catch { continue; }
      if (!input || typeof input !== "object") continue;
      checked++;
      const unknown = Object.keys(input).filter((k) => !d.keys.has(k));
      if (unknown.length) bad.push(`${pack} -> ${step.slug}: ${unknown.join(", ")}`);
    }
  }
  // wallet-audit reads token metadata for a token the wallet holds, never for the wallet itself.
  const tm = PACK_STEPS["wallet-audit"].steps.find((s) => s.slug === "token-metadata");
  const held = tm.mapInput({ address: "0xabc" }, { "wallet-balance": { tokens: [{ contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }] } });
  let none = null; try { tm.mapInput({ address: "0xabc" }, { "wallet-balance": { tokens: [] } }); } catch (e) { none = e; }
  ok(PACK_STEPS["wallet-audit"].mode === "chain" && held.contract === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" && none?.statusCode === 422, "wallet-audit looks up a token the wallet holds (chain), and says so when it holds none");
  ok(checked >= 50, `the check reads enough pack steps to mean something (${checked} checked)`);
  ok(bad.length === 0, `every pack step sends only input keys its tool declares${bad.length ? `:\n  ${bad.join("\n  ")}` : ""}`);
} catch (e) {
  fail++; console.log(`FAIL - ${e?.message || e}`);
} finally { stop(); }
console.log(`\ntest-skill-step-inputs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
