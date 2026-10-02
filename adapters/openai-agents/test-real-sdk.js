// Builds a real @openai/agents Agent from agent402Tools() and runs one tool.
// test.js covers only the framework-agnostic specs; the native wrapper is what
// breaks when the SDK tightens its schema rules (0.18 refused the Zod form),
// so this installs the current SDK into a scratch dir and drives it for real.
// Needs a running Agent402 server (AGENT402_BASE_URL, default :3000).
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.AGENT402_BASE_URL || "http://localhost:3000";
const dir = mkdtempSync(join(tmpdir(), "a402-oa-sdk-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "oa-sdk-check", private: true, type: "module" }));
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "@openai/agents@latest"], { cwd: dir, stdio: "inherit" });
copyFileSync(join(here, "index.js"), join(dir, "adapter.mjs"));

const { agent402Tools } = await import(join(dir, "adapter.mjs"));
const { Agent } = await import(join(dir, "node_modules", "@openai", "agents", "dist", "index.mjs")).catch(() => import(join(dir, "node_modules", "@openai", "agents", "dist", "index.js")));
let pass = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL - ${m}`); process.exit(1); } pass++; console.log(`ok - ${m}`); };

const tools = await agent402Tools({ baseUrl: base });
ok(tools.length === 4, `agent402Tools() returns four tools (${tools.length})`);
const agent = new Agent({ name: "check", instructions: "test", tools });
ok(agent.tools.length === 4, "new Agent({ tools }) accepts them under the installed SDK");
const call = tools.find((t) => t.name === "agent402_call");
const out = await call.invoke({}, JSON.stringify({ slug: "hash", params: { text: "hello world", algorithm: "sha256" } }));
ok(/b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9/.test(typeof out === "string" ? out : JSON.stringify(out)), "agent402_call runs through the SDK tool and returns the hash");
console.log(`PASS - agent402-openai-agents real SDK: ${pass} assertions`);
