// Smoke test for agent402-llamaindex. Expects a FREE_MODE server reachable at
// AGENT402_BASE_URL (defaults to http://localhost:3000). Self-installs
// agent402-client and llamaindex if they're not in node_modules.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}
if (!existsSync(join(HERE, "node_modules", "llamaindex"))) {
  // EXACT pin + --ignore-scripts. "^0.12" was described as a pin but is a
  // RANGE: it accepts any 0.12.x, and every transitive dep floats freely. This
  // install pulls a large third-party tree, so its lifecycle scripts are the
  // widest install-time execution surface in this repo - the 2026 worm waves
  // (ChainDrop et al) all delivered through exactly that hook. Nothing here
  // needs a build step, so scripts are simply off.
  execSync("npm install llamaindex@0.12.0 --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}

const { agent402Tools, agent402Execute } = await import("./index.js");
const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";

async function main() {
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  // LlamaIndex tools expose metadata via .metadata (FunctionTool) or directly.
  const findName = (t) => t.metadata?.name || t.name;
  const hashTool = tools.find((t) => findName(t) === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");

  const meta = hashTool.metadata || hashTool;
  if (typeof meta.name !== "string") throw new Error("name must be string");
  if (typeof meta.description !== "string") throw new Error("description must be string");
  if (!meta.parameters || meta.parameters.type !== "object") throw new Error("parameters must be a JSON object schema");

  // Drive the tool's call() — both FunctionTool and the newer tool() helper
  // expose it. The result is the raw object returned from agent402-client.
  const callable = hashTool.call || hashTool.invoke;
  if (typeof callable !== "function") throw new Error("tool must expose call() or invoke()");
  const out = await callable.call(hashTool, { text: "hello world", algo: "sha256" });
  if (!out || typeof out !== "object") throw new Error("expected an object from tool.call");
  if (!out.hex && !out.digest && !out.hash) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // Standalone executor agrees.
  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  // Bundled execute() helper agrees.
  const out3 = await execute("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out3)) throw new Error("bundled execute() disagreed with tool.call");

  console.log(`PASS — agent402-llamaindex: ${tools.length} tool(s) generated, call() returned a real result.`);
}

// Spending caps pass through to agent402-client: with none set the client's
// own default holds (a $5 per-call ceiling from agent402-client 0.10.0, none
// before it), and the ones a caller sets reach the client.
{
  const { agent402Tools: tools402 } = await import("./index.js");
  const base = BASE;
  // The server this test reads may still be starting (when the test boots its own).
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
  const plain = (await tools402({ baseUrl: base, slugs: ["hash"] })).client.spendingSummary().limits;
  const capped = (await tools402({ baseUrl: base, slugs: ["hash"], maxPerCallUsd: 0.5, dailyLimitUsd: 2, maxPerHostUsd: 1 })).client.spendingSummary().limits;
  const clientDefault = (await import("agent402-client")).DEFAULT_MAX_PER_CALL_USD ?? null;
  if (plain.maxPerCallUsd !== clientDefault || plain.dailyLimitUsd !== null || plain.maxPerHostUsd !== null) { console.error("FAIL: with no cap set, only the client's own per-call default holds", plain, clientDefault); process.exit(1); }
  if (capped.maxPerCallUsd !== 0.5 || capped.dailyLimitUsd !== 2 || capped.maxPerHostUsd !== 1) { console.error("FAIL: caller-set caps reach the client", capped); process.exit(1); }
  console.log("ok - spending caps pass through to agent402-client; with none set only its own per-call default holds");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
