#!/usr/bin/env node
// Two copy facts the catalog must keep on every surface a buyer reads:
//   1. A model-backed tool says so in its description (CLAUDE.md "Honest
//      claims"): the word model, or a term that only a model-backed tool
//      earns (LLM, chat, embeddings, image or video generation, speech).
//   2. A data-source credit in a description (World Bank, FRED) survives the
//      listing cap, which trims from the end, so it is never cut away.
// Boots a FREE_MODE server on port 0 and reads /api/pricing.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import { bazaarCapDescription } from "../src/payments.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, ...ownStoreEnv("catalog-honesty"), PORT: "0", FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let base = null;
const portFrom = (s) => { const m = /listening[^\n]*?(?:port\s*|:)(\d{2,5})/i.exec(s); if (m && !base) base = `http://127.0.0.1:${m[1]}`; };
proc.stdout.on("data", (d) => portFrom(String(d)));
proc.stderr.on("data", (d) => portFrom(String(d)));
try {
  for (let i = 0; i < 240 && !base; i++) await new Promise((r) => setTimeout(r, 250));
  if (!base) throw new Error("server did not report its port");
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
  const endpoints = (await (await fetch(`${base}/api/pricing`)).json()).endpoints || [];
  ok(endpoints.length >= 400, `the catalog is read (${endpoints.length} endpoints)`);

  const MODEL_TERM = /model|\bLLM\b|\bAI\b|chat|embedding|rerank|moderation|generat|synthes|written|writes|summar|narrat|video|speech|voice/i;
  const mb = endpoints.filter((e) => e.modelBacked);
  const silent = mb.filter((e) => !MODEL_TERM.test(String(e.description || "")));
  ok(mb.length >= 20, `model-backed tools are flagged (${mb.length})`);
  ok(silent.length === 0, `every model-backed tool says so in its description${silent.length ? `: ${silent.map((e) => e.slug).join(", ")}` : ""}`);
  const listingSilent = mb.filter((e) => !MODEL_TERM.test(bazaarCapDescription(String(e.description || ""))));
  ok(listingSilent.length === 0, `and still says so after the listing cap${listingSilent.length ? `: ${listingSilent.map((e) => e.slug).join(", ")}` : ""}`);

  const CREDIT = /World Bank|FRED/;
  const credited = endpoints.filter((e) => CREDIT.test(String(e.description || "")));
  const cut = credited.filter((e) => { const m = String(e.description).match(CREDIT)[0]; return !bazaarCapDescription(String(e.description)).includes(m); });
  ok(credited.length >= 5, `credited descriptions are found (${credited.length})`);
  ok(cut.length === 0, `every World Bank or FRED credit survives the listing cap${cut.length ? `: ${cut.map((e) => e.slug).join(", ")}` : ""}`);
} catch (e) {
  fail++; console.log(`FAIL - ${e?.message || e}`);
} finally { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
console.log(`\ntest-catalog-honesty-markers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
