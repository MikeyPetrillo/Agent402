#!/usr/bin/env node
// Anthropic-SDK base-URL alias + metered body limit (booted paid server, offline).
//
// Every Anthropic client (the SDK, Claude Code, the Agent SDK) appends
// `/v1/messages` to ANTHROPIC_BASE_URL, so a buyer pointing one at a tier
// (`.../v1/metered`) posts to `/v1/metered/v1/messages`. server.js rewrites
// that to the tier's real route BEFORE any gate, so the alias must answer the
// SAME 402 (same quote) as the real path, keep the query string (Claude Code
// sends `?beta=true`), and a real agent-host turn (~110 KB, measured from
// claude-cli 2.1.250 on 2026-08-27) must reach the metered tier's own
// validation instead of the global 100 KB parser's 413 - while a flat tier
// keeps the 100 KB limit (its price does not grow with the body).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { getFreePorts } from "./lib/free-port.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
let pass = 0;
let proc = null;
let facilitator = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub facilitator: /supported only - the test never pays, it only needs the
// paywall able to mint 402 challenges.
facilitator = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    OPENROUTER_API_KEY: "test-key-never-used",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
  },
  stdio: "ignore",
});

const decode402 = (res) => {
  const h = res.headers.get("payment-required");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
};
const amountOf = (pr) => pr?.accepts?.[0]?.amount ?? pr?.accepts?.[0]?.maxAmountRequired ?? null;
const post = (path, body, headers = {}) => fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// What Claude Code sends: a system array with cache_control, adaptive
// thinking, function tools, max_tokens far over the tier cap, plus fields our
// wire does not carry (output_config, context_management) - dropped, never a 400.
const ccBody = (chars) => ({
  model: "claude-sonnet-5",
  max_tokens: 64000,
  stream: true,
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "high" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "s" }) },
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=test" }, { type: "text", text: "You are a coding agent. ".repeat(Math.max(1, Math.floor(chars / 24))), cache_control: { type: "ephemeral" } }],
  tools: Array.from({ length: 22 }, (_, i) => ({ name: `Tool${i}`, description: "A tool the host exposes. ".repeat(20), input_schema: { type: "object", properties: { a: { type: "string", description: "argument ".repeat(30) } }, required: ["a"] } })),
  messages: [{ role: "user", content: "Reply with the single word ok." }],
});

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  ok((await fetch(`${B}/health`)).ok, "server booted (paid mode, stub facilitator)");

  // 1. The alias answers the same 402 as the real metered route, quote included.
  const small = ccBody(2_000);
  const real = await post("/v1/metered/messages", small);
  const alias = await post("/v1/metered/v1/messages?beta=true", small);
  ok(real.status === 402 && alias.status === 402, `unpaid POST: real ${real.status}, alias ${alias.status} (both 402)`);
  const prReal = decode402(real), prAlias = decode402(alias);
  ok(prReal && prAlias && amountOf(prReal) !== null && amountOf(prReal) === amountOf(prAlias), `alias carries the real route's per-request quote (${amountOf(prReal)} base units)`);
  const resAlias = prAlias.accepts?.[0]?.resource?.url || prAlias.resource?.url || String(prAlias.accepts?.[0]?.resource || "");
  ok(/\/v1\/metered\/(v1\/)?messages/.test(resAlias), `the 402's resource stays under the metered tier (${resAlias.slice(0, 80)})`);

  // 2. The base tier alias too (ANTHROPIC_BASE_URL=https://agent402.tools/v1).
  const baseAlias = await post("/v1/v1/messages", { ...small, model: "claude-haiku-4-5-20251001", max_tokens: 64 });
  ok(baseAlias.status === 402, `/v1/v1/messages -> the base tier's 402 (got ${baseAlias.status})`);
  const unknownAlias = await post("/v1/nope/v1/messages", small);
  ok(unknownAlias.status === 404, `an alias for a tier that does not exist stays 404 (got ${unknownAlias.status})`);

  // 3. A real agent-host turn (~110 KB) reaches the metered tier, not the 100 KB parser.
  const big = ccBody(95_000);
  const bigBytes = Buffer.byteLength(JSON.stringify(big));
  ok(bigBytes > 100 * 1024 && bigBytes < 200_000, `the Claude Code-shaped body is ${bigBytes} bytes (over the global 100 KB limit)`);
  const bigMetered = await post("/v1/metered/v1/messages?beta=true", big);
  ok(bigMetered.status === 402, `110 KB turn on the metered alias -> 402 with a quote, not 413 (got ${bigMetered.status})`);
  const prBig = decode402(bigMetered);
  ok(prBig && Number(amountOf(prBig)) > Number(amountOf(prReal)), `the bigger turn quotes MORE than the small one (${amountOf(prBig)} > ${amountOf(prReal)}) - size is priced, never unpriced`);
  const bigFlat = await post("/v1/messages", big);
  ok(bigFlat.status === 413, `the same body on the flat /v1/messages keeps the 100 KB limit -> 413 (got ${bigFlat.status})`);

  // 4. The tier's own cap still speaks past the parser: 200k chars is a clean 402 at the
  //    cap-refusal quote (the handler's 400 fires after payment; the parser must not 413 first).
  const huge = ccBody(230_000);
  const hugeBytes = Buffer.byteLength(JSON.stringify(huge));
  const hugeMetered = await post("/v1/metered/messages", huge);
  ok(hugeBytes < 1024 * 1024 && hugeMetered.status !== 413, `${hugeBytes}-byte body on metered is parsed by the 1 MB parser (status ${hugeMetered.status}, never 413)`);
  const way = await fetch(`${B}/v1/metered/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"model\":\"x\",\"pad\":\"" + "a".repeat(1_100_000) + "\"}" });
  ok(way.status === 413, `a body over 1 MB on metered is still refused 413 (got ${way.status})`);

  // 5. Non-Messages paths under /v1/metered keep working through the wider parser.
  const chat = await post("/v1/metered/chat/completions", { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
  ok(chat.status === 402, `/v1/metered/chat/completions still 402s unpaid (got ${chat.status})`);

  console.log(`\nPASS - ${pass} checks (Anthropic SDK base-URL alias + metered body limit)`);
  proc.kill("SIGKILL");
  facilitator.close();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
