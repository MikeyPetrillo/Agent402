// MCP `call_tool` is the only tool an LLM has to know about — every other
// Agent402 capability is reached through it. The shape contract it must
// honor isn't just "happy path returns a result"; it includes three
// LLM-specific tolerances that have been hand-tuned through real client
// behavior and would silently regress if reorganized:
//
//   1. {slug, params} envelope (canonical).
//   2. Flattened args fallback — LLMs often emit `{ slug, value: 10 }`
//      instead of `{ slug, params: { value: 10 } }`. Without this fallback
//      the analytics dashboard fills with 1ms 4xx errors (the whois
//      precedent — was 100% errored at p50=1ms until this fallback shipped).
//   3. Stringified params — LLMs sometimes JSON.stringify the args object.
//   4. Wallet-only tools refuse with `walletRequiredText` guidance text
//      (NOT silently execute; NOT return a generic 401-style error).
//   5. Bad input → self-correction envelope with tool/expected/required/
//      example/callWith — the LLM needs the call recipe in the error to
//      avoid a second search_tools roundtrip.
//
// This test boots FREE_MODE and walks the contract:
//
//   1. initialize → tools/list includes call_tool.
//   2. call_tool with canonical {slug, params} → result body (deterministic).
//   3. call_tool with flattened args → same result (no params: wrapper).
//   4. call_tool with stringified params → same result.
//   5. call_tool on a wallet-only slug → isError:true + guidance mentions
//      USDC or wallet (not silent execute).
//   6. call_tool on an unknown slug → isError:true + guidance to use
//      search_tools.
//   7. call_tool with bad input (missing required field) → isError:true +
//      hint body has the documented self-correction keys (tool, expected,
//      required, example, callWith).
//
//   node scripts/test-mcp-call-tool-contract.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3097;
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
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-mcp-call-tool-contract", version: "0.0.0" } });
  ok(init.result?.serverInfo?.name === "agent402", `initialize returns serverInfo.name=agent402 (got ${init.result?.serverInfo?.name})`);

  const list = await rpc("tools/list", {});
  const toolNames = (list.result?.tools ?? []).map((t) => t.name);
  ok(toolNames.includes("call_tool"), `tools/list exposes call_tool (got ${toolNames.join(",")})`);

  // 2. Canonical {slug, params} call. value=10 km → 6.21371... mi.
  const canonical = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "convert-kilometers-to-miles", params: { value: 10 } },
  });
  const canonicalText = canonical.result?.content?.[0]?.text || "";
  ok(!canonical.result?.isError, `canonical {slug, params} call returns success (got isError=${canonical.result?.isError})`);
  ok(canonicalText.includes("6.2137"), `canonical call yields the conversion (got '${canonicalText.slice(0, 80)}…')`);

  // 3. Flattened args fallback — { slug, value } without `params:` wrapper.
  // Critical: the whois analytics regression (p50=1ms, 100% errored) was
  // exactly this — LLMs flattening the envelope. Without the fallback, this
  // call returns a 4xx self-correction envelope; with the fallback, it
  // succeeds the same way the canonical path does.
  const flattened = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "convert-kilometers-to-miles", value: 10 },
  });
  const flattenedText = flattened.result?.content?.[0]?.text || "";
  ok(!flattened.result?.isError, `flattened args (no params: wrapper) executes (got isError=${flattened.result?.isError})`);
  ok(flattenedText.includes("6.2137"), `flattened args yields the same result (got '${flattenedText.slice(0, 80)}…')`);

  // 4. Stringified params — LLMs sometimes JSON.stringify the object.
  const stringified = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "convert-kilometers-to-miles", params: JSON.stringify({ value: 10 }) },
  });
  const stringifiedText = stringified.result?.content?.[0]?.text || "";
  ok(!stringified.result?.isError, `stringified params executes (got isError=${stringified.result?.isError})`);
  ok(stringifiedText.includes("6.2137"), `stringified params yields the same result (got '${stringifiedText.slice(0, 80)}…')`);

  // 5. Wallet-only refusal. /api/extract is a paid web-fetching tool with
  // network access — wallet-only. The MCP path must refuse with guidance
  // (mentioning USDC or wallet), not execute it free or return a generic
  // error envelope.
  const walletOnly = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "extract", params: { url: "https://example.com" } },
  });
  ok(walletOnly.result?.isError === true, `wallet-only call refuses with isError:true (got isError=${walletOnly.result?.isError})`);
  const walletText = walletOnly.result?.content?.[0]?.text || "";
  ok(/USDC|wallet|x402/i.test(walletText), `wallet-only refusal mentions USDC/wallet/x402 in guidance (got '${walletText.slice(0, 120)}…')`);

  // 6. Unknown slug — must guide the LLM back to search_tools rather than
  // silently 404.
  const unknown = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "this-tool-does-not-exist", params: {} },
  });
  ok(unknown.result?.isError === true, `unknown slug → isError:true (got ${unknown.result?.isError})`);
  const unknownText = unknown.result?.content?.[0]?.text || "";
  ok(unknownText.includes("search_tools"), `unknown-slug guidance points to search_tools (got '${unknownText.slice(0, 120)}…')`);

  // 7. Bad input → self-correction envelope. Pick a tool with a required
  // field and omit it. hash requires `text`.
  const badInput = await rpc("tools/call", {
    name: "call_tool",
    arguments: { slug: "hash", params: {} },
  });
  ok(badInput.result?.isError === true, `bad input → isError:true (got ${badInput.result?.isError})`);
  const hintText = badInput.result?.content?.[0]?.text || "";
  let hint = null;
  try { hint = JSON.parse(hintText); } catch {}
  ok(hint != null, `bad-input hint is JSON (got '${hintText.slice(0, 120)}…')`);
  for (const k of ["error", "tool", "expected", "required", "example", "callWith"]) {
    ok(hint && k in hint, `hint carries '${k}' for self-correction (got keys: ${hint ? Object.keys(hint).join(",") : "n/a"})`);
  }
  ok(hint?.tool === "hash", `hint.tool='hash' (got ${hint?.tool})`);
  ok(hint?.callWith?.name === "call_tool", `hint.callWith.name='call_tool' (got ${hint?.callWith?.name})`);
  ok(hint?.callWith?.arguments?.slug === "hash", `hint.callWith.arguments.slug='hash' (got ${hint?.callWith?.arguments?.slug})`);

  console.log(`\n${pass} passed (call_tool contract: canonical + flattened + stringified + wallet-refusal + unknown + self-correction)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
