// The MCP connector at /mcp exposes one prompt per skill pack. An MCP client
// (Claude Code, Cursor, ChatGPT custom connectors) reads `prompts/list` and
// the user picks a workflow by name; `prompts/get` then returns the rendered
// messages with the user's arguments substituted. If a skill pack silently
// drops from the prompts surface, the workflow is unreachable from any MCP
// client.
//
// This test drives /mcp end-to-end over JSON-RPC and asserts:
//
//   1. initialize advertises the prompts capability.
//   2. prompts/list returns one prompt per SKILL_PACKS pack — same count,
//      every slug present.
//   3. Every prompt has { name, title, description, arguments[] } — the
//      shape MCP clients render.
//   4. arguments[].required is a boolean (MCP schema).
//   5. prompts/get for a pack with a `substitute` arg returns messages with
//      the user's value substituted into the rendered text (not the
//      placeholder). This is the actual rendering contract — silent drop of
//      the substitution logic would still return a "valid" response but with
//      `<host>` literally in the body instead of stripe.com.
//   6. The response includes a description (top-level) so MCP clients can
//      preview the prompt before running it.
//
//   node scripts/test-mcp-prompts.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3084;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (ct === "text/event-stream") {
    const text = await res.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  return res.json();
}

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-mcp-prompts", version: "0.0.0" },
  });
  ok(init.result?.capabilities?.prompts != null, `initialize advertises prompts capability (got capabilities: ${JSON.stringify(Object.keys(init.result?.capabilities || {}))})`);

  const list = await rpc("prompts/list", {});
  const prompts = list.result?.prompts ?? [];
  ok(prompts.length === SKILL_PACKS.length, `prompts/list returns one prompt per skill pack (mcp=${prompts.length}, source=${SKILL_PACKS.length})`);

  // Every SKILL_PACKS slug must appear as a prompt name. Walking by-slug
  // surfaces a silent drop by the missing pack's name.
  const promptNames = new Set(prompts.map((p) => p.name));
  const missing = SKILL_PACKS.filter((p) => !promptNames.has(p.slug)).map((p) => p.slug);
  ok(missing.length === 0, `every SKILL_PACKS slug appears as a prompt (missing: ${missing.join(",") || "none"})`);

  // Shape lock — every prompt carries name/title/description/arguments.
  let shapeOk = 0;
  for (const p of prompts) {
    if (typeof p.name !== "string" || !p.name.length) { fail(`prompt missing name (got ${JSON.stringify(p)})`); break; }
    if (typeof p.title !== "string" || !p.title.length) { fail(`prompt '${p.name}' missing title`); break; }
    if (typeof p.description !== "string" || !p.description.length) { fail(`prompt '${p.name}' missing description`); break; }
    if (!Array.isArray(p.arguments)) { fail(`prompt '${p.name}' missing arguments[]`); break; }
    for (const arg of p.arguments) {
      if (typeof arg.name !== "string") { fail(`prompt '${p.name}' arg.name not string`); break; }
      if (typeof arg.description !== "string") { fail(`prompt '${p.name}' arg.description not string`); break; }
      if (typeof arg.required !== "boolean") { fail(`prompt '${p.name}' arg.required not boolean (got ${typeof arg.required})`); break; }
    }
    shapeOk++;
  }
  ok(shapeOk === prompts.length, `every prompt has full MCP shape (${shapeOk}/${prompts.length})`);

  // Substitution — pick a pack with a substitute arg. status-snapshot's `url`
  // arg substitutes via `https://example.com` in the source claudePrompt; the
  // rendered message should carry `https://stripe.com` (or whatever we pass)
  // and NOT carry the original placeholder `https://example.com`.
  const subPack = SKILL_PACKS.find(
    (p) => (p.promptArgs || []).some((a) => typeof a.substitute === "string"),
  );
  ok(subPack, `source: at least one pack has a substitute arg (got ${subPack?.slug || "none"})`);

  const subArg = subPack.promptArgs.find((a) => typeof a.substitute === "string");
  const userValue = "https://stripe-test-substitution.example";
  const get = await rpc("prompts/get", {
    name: subPack.slug,
    arguments: { [subArg.name]: userValue },
  });
  const messages = get.result?.messages ?? [];
  ok(messages.length > 0, `prompts/get for '${subPack.slug}' returns messages[] (got ${messages.length})`);
  ok(typeof get.result?.description === "string" && get.result.description.length > 0, `prompts/get returns a top-level description (preview text for MCP clients)`);

  // Walk every message; the user value should appear at least once across
  // them, and the placeholder string should NOT appear (if substitution ran).
  const allText = messages.map((m) => m.content?.text || "").join("\n");
  ok(allText.includes(userValue), `rendered messages include the user-provided value '${userValue}'`);
  ok(!allText.includes(subArg.substitute), `rendered messages do NOT contain the literal placeholder '${subArg.substitute}' (substitution ran)`);

  console.log(`\n${pass} passed (${prompts.length} prompts, substitution verified on '${subPack.slug}')`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
