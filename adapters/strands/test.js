// Smoke test for agent402-strands. Spawns its own paywalled server
// (X402_SYNC_ON_START=false so the facilitator is never contacted; PoW
// bypasses settlement) and exercises the auto-payment path through a stub
// Strands `tool({...})` shape.
//
// We stub @strands-agents/sdk here so the test doesn't pull AWS Bedrock /
// uuid / yaml transitively just to verify the adapter wiring. The shape we
// stub matches the real SDK: tool({ name, description, inputSchema, callback }).
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// Make the local agent402-client resolvable without a manual install.
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}

// Stub @strands-agents/sdk — just enough surface to test that we wire fields
// through correctly and the callback works end-to-end.
const stubDir = join(HERE, "node_modules", "@strands-agents", "sdk");
if (!existsSync(join(stubDir, "package.json"))) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({
    name: "@strands-agents/sdk",
    version: "0.0.0-stub",
    type: "module",
    main: "index.js",
  }));
  writeFileSync(join(stubDir, "index.js"), `
    export function tool(def) {
      return { __isStrandsTool: true, name: def.name, description: def.description, inputSchema: def.inputSchema, callback: def.callback };
    }
    export class Agent {
      constructor(opts) { this.tools = opts?.tools || []; }
      async invoke(_input) { return null; }
    }
  `);
}

const { agent402Tools, agent402Execute } = await import("./index.js");

const PORT = 3086;
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
  // 1. Catalog → Strands tool instances
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  const hashTool = tools.find((t) => t.name === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");
  if (!hashTool.__isStrandsTool) throw new Error("expected a Strands tool() instance");
  if (typeof hashTool.description !== "string") throw new Error("description must be a string");
  if (typeof hashTool.callback !== "function") throw new Error("callback must be a function");

  // 2. Schema is a Zod schema, not a raw JSON Schema — Strands needs Zod.
  if (!hashTool.inputSchema || typeof hashTool.inputSchema.parse !== "function") {
    throw new Error("inputSchema must be a Zod schema (got " + typeof hashTool.inputSchema + ")");
  }
  // Zod accepts well-formed input
  const parsed = hashTool.inputSchema.parse({ text: "hi", algo: "sha256" });
  if (parsed.text !== "hi") throw new Error("Zod schema did not pass through 'text'");

  // 3. callback() pays under the hood and returns the structured result
  //    directly (Strands accepts any JSON-serializable return type — no
  //    JSON.stringify wrapper needed).
  const out = await hashTool.callback({ text: "hello world", algo: "sha256" });
  if (!out || typeof out !== "object") throw new Error("expected an object from callback (got " + typeof out + ")");
  if (!out.hex && !out.digest && !out.hash) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // 4. execute() resolves the slug and returns the same result
  const out2 = await execute("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("execute() and callback() disagreed");

  // 5. Standalone executor works the same
  const exec = agent402Execute({ baseUrl: BASE });
  const out3 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out3)) throw new Error("standalone executor disagreed");

  console.log(`PASS — agent402-strands: ${tools.length} tool(s) generated, callback() and execute() returned the real result.`);
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

main().then(() => { if (proc) proc.kill(); process.exit(0); }).catch((e) => { console.error("FAIL:", e); if (proc) proc.kill(); process.exit(1); });
