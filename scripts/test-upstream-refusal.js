// A model provider refusing the buyer's chat request (an upstream 4xx, e.g. "No
// endpoints found that support tool use") is the request's problem, not an
// outage. Proves, through the real code:
//   1. the kit tags it upstreamRejected and keeps it a 502 inside the kit, with
//      the provider's links stripped from the text;
//   2. a failover chain still walks it to the next model (a 400 inside the kit
//      would have stopped the walk);
//   3. the route binder in src/server.js answers the buyer 400 with the clean
//      text, and a provider 5xx is still a 502.
// The upstream is stubbed in-process (part 3 preloads the stub into a booted
// server with --import), so nothing leaves the machine and nothing is spent.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-upstream-refusal");

process.env.OPENROUTER_API_KEY = "test-key";
delete process.env.OPENROUTER_FLEX;
const G = await import("../src/tools/llm-gateway-kit.js");
const nano = G.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const REFUSAL = 'No endpoints found that support tool use. Try disabling "exec". To learn more about provider routing, visit: https://provider.example/docs/routing';
const refused = () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: { message: REFUSAL, code: 404 } }) });
const chatOk = (model) => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "g", model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) });
const realFetch = globalThis.fetch;
const body = (extra = {}) => ({ messages: [{ role: "user", content: "list files" }], tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: {} } } }], ...extra });

// 1. One model, no fallback: the refusal surfaces tagged, as a 502, with clean text.
{
  globalThis.fetch = async () => refused();
  let err = null;
  try { await nano.handler(body({ model_fallback: false })); } catch (e) { err = e; }
  globalThis.fetch = realFetch;
  ok(err?.statusCode === 502 && err?.upstreamRejected === true, `a provider 4xx on a chat call is a tagged 502 inside the kit (got ${err?.statusCode}, tagged ${err?.upstreamRejected})`);
  ok(/No endpoints found that support tool use/.test(err?.message || "") && !/https?:\/\//.test(err?.message || "") && !/learn more/i.test(err?.message || ""),
    `the text keeps the actionable part and drops the provider's link (got: ${err?.message})`);
  ok(/refused this request for [a-z0-9][\w./:-]+: /i.test(err?.message || ""), `the refusal names the model that said no (got: ${err?.message})`);
}

// 2. With fallback on, the refusal on the first model walks to the next.
{
  const seen = [];
  globalThis.fetch = async (_u, init) => { const m = JSON.parse(init.body).model; seen.push(m); return seen.length === 1 ? refused() : chatOk(m); };
  let out = null, err = null;
  try { out = await nano.handler(body()); } catch (e) { err = e; }
  globalThis.fetch = realFetch;
  ok(!err && seen.length >= 2 && out?.choices?.[0]?.message?.content === "OK",
    `a refused first model walks the chain and the next model serves (calls ${seen.length}, ${err ? "threw " + err.statusCode : "served"})`);
}

// 3. The real route binder: refusal -> 400 with the clean text; provider 5xx -> 502.
const dir = mkdtempSync(join(tmpdir(), "upstream-refusal-"));
const stub = join(dir, "stub.mjs");
writeFileSync(stub, `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://openrouter.ai/api/v1/chat/completions")) {
    const b = JSON.parse(init?.body || "{}");
    if (b.messages?.[0]?.content === "boom") return new Response("upstream down", { status: 500 });
    return new Response(JSON.stringify({ error: { message: ${JSON.stringify(REFUSAL)}, code: 404 } }), { status: 404, headers: { "content-type": "application/json" } });
  }
  return real(url, init);
};
`);
const PORT = 3085;
const proc = spawn(process.execPath, ["--import", stub, "src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), OPENROUTER_API_KEY: "test-key", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
const B = `http://127.0.0.1:${PORT}`;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const post = (content) => fetch(`${B}/v1/nano/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body({ model_fallback: false }), messages: [{ role: "user", content }] }) });
  const r = await post("list files");
  const j = await r.json().catch(() => ({}));
  ok(r.status === 400, `the buyer reads 400 for a refused request, not 502 (got ${r.status})`);
  ok(/model provider refused this request/i.test(j.error || "") && !/https?:\/\//.test(j.error || ""), `the 400 carries the clean refusal text (got: ${String(j.error).slice(0, 120)})`);
  const r5 = await post("boom");
  ok(r5.status === 502, `a provider 5xx is still a 502 (got ${r5.status})`);
} finally {
  proc.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
