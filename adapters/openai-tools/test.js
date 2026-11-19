// Smoke test for agent402-openai-tools. Spawns its own paywalled server
// (X402_SYNC_ON_START=false so the facilitator is never contacted; PoW bypasses
// settlement) and exercises the auto-payment path through the OpenAI tool shape.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Make the local agent402-client resolvable without requiring a manual install.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}

const { agent402Tools, agent402Execute } = await import("./index.js");

const PORT = 3082;
const BASE = process.env.AGENT402_BASE_URL || `http://localhost:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
      POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  // 1. Catalog → OpenAI tool definitions
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  const hashTool = tools.find((t) => t.function.name === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");
  if (hashTool.type !== "function") throw new Error("expected type=function");
  if (!hashTool.function.parameters?.properties) throw new Error("expected parameters schema");

  // 2. Tool definitions match OpenAI's documented shape
  if (typeof hashTool.function.name !== "string") throw new Error("function.name must be string");
  if (typeof hashTool.function.description !== "string") throw new Error("function.description must be string");

  // 3. execute() resolves the slug and returns a real result
  const out = await execute("hash", { text: "hello world", algo: "sha256" });
  if (!out || typeof out !== "object") throw new Error("expected an object from execute");
  if (!out.hex && !out.digest && !out.hash && !out.result) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // 4. Standalone executor works the same
  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  console.log(`PASS — agent402-openai-tools: ${tools.length} tool(s) generated, execute() returned a real result.`);
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
