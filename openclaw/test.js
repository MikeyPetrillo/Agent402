// Offline test for agent402-openclaw: a stub gateway on loopback stands in for
// agent402.tools (GET /v1/models + two tier endpoints that require a Bearer),
// the real proxy is started against it, and the plugin's register() is driven
// with a fake OpenClaw api. No network, no keys, no money.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, chmodSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Async spawn: a synchronous spawn would block this process's event loop, and
// the stub gateway the CLI needs to reach lives in this process.
const run = (cliArgs, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, cliArgs, { cwd: new URL(".", import.meta.url).pathname, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
import { startProxy } from "./proxy.js";
import { routesFromCatalog, openclawModels, AUTO_ID, defaultPrimary, METERED_MAX_INPUT_CHARS, METERED_MAX_TOKENS } from "./models.js";
import plugin, { resolveCreditsKey, resolveWalletKey, selectAccept, uptoReady, PERMIT2_READY_MIN } from "./index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- stub gateway ----------------------------------------------------------
const seen = [];
const catalog = { object: "list", data: [
  { id: "openai/gpt-5-nano", object: "model", x402: { tier: "v1-chat-nano", endpoint: "/v1/nano/chat/completions", priceUsd: 0.003, maxTokens: 768, maxInputChars: 48_000 } },
  { id: "openai/gpt-4o-mini", object: "model", x402: { tier: "v1-chat-auto", endpoint: "/v1/auto/chat/completions", priceUsd: 0.01, maxTokens: 1024, maxInputChars: 32_000 } },
  { id: "openai/gpt-5", object: "model", x402: { tier: "v1-chat-premium", endpoint: "/v1/premium/chat/completions", priceUsd: 0.5, maxTokens: 8192, maxInputChars: 200_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001 } },
  { id: "deepseek/*", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 64_000 } },
  { id: "x/stealth", object: "model", x402: { tier: "v1-chat-ox", endpoint: "/v1/ox/chat/completions", priceUsd: 0.002, maxTokens: 8000, maxInputChars: 32_000, stealth: true } },
] };
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(catalog)); }
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, auth: req.headers.authorization || null, idem: req.headers["idempotency-key"] || null, body });
    if (!req.headers.authorization) { res.writeHead(402, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Payment required" })); }
    if (req.headers.authorization === "Bearer a402_deadkey00000000000000") { res.writeHead(402, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Insufficient credits", reason: "insufficient", balanceUsd: 0 })); }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-credits-balance": "19.99" });
      res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
      setTimeout(() => { res.write('data: {"choices":[{"delta":{"content":"K"}}]}\n\ndata: [DONE]\n\n'); res.end(); }, 30);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-credits-balance": "19.99" });
    res.end(JSON.stringify({ id: "gen-1", model: body.model || "routed", choices: [{ message: { role: "assistant", content: "OK" } }] }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const upstream = `http://127.0.0.1:${stub.address().port}`;

// ---- x402 accept selection (upto = settle actual usage; exact = the quote) ----
{
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "1000" }, { scheme: "upto", network: "eip155:8453", amount: "1000" }, { scheme: "exact", network: "eip155:137" }];
  ok(selectAccept(accepts).scheme === "upto", "with a Permit2 allowance the proxy picks upto on Base (the quote becomes a ceiling, actual usage settles)");
  ok(selectAccept(accepts, { preferUpto: false }).scheme === "exact" && selectAccept(accepts, { preferUpto: false }).network === "eip155:8453", "without the allowance it picks exact on Base");
  ok(selectAccept([{ scheme: "exact", network: "eip155:137" }]).network === "eip155:137" && selectAccept([]) === undefined, "falls back to the first accept; an empty list yields nothing");
  ok(uptoReady(PERMIT2_READY_MIN) && uptoReady("115792089237316195423570985008687907853269984665640564039457584007913129639935") && !uptoReady(0n) && !uptoReady(999n) && !uptoReady("garbage"), "uptoReady: a max-uint (or any >= 1M USDC) Permit2 allowance counts; dust, zero and junk do not");
}

// ---- models.js ------------------------------------------------------------
{
  {
    const r = routesFromCatalog(catalog);
    ok(r.get("openai/gpt-5").maxInputChars === METERED_MAX_INPUT_CHARS && r.get("openai/gpt-5").maxTokens === METERED_MAX_TOKENS, "metered route carries the metered tier's caps (catalog without meteredMax* fields)");
    ok(r.get("openai/gpt-5-nano").maxInputChars === 48_000, "a flat route keeps its own cap");
    const withCaps = routesFromCatalog({ data: [{ id: "a/b", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 32_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001, meteredMaxInputChars: 150_000, meteredMaxTokens: 4096 } }] });
    ok(withCaps.get("a/b").maxInputChars === 150_000 && withCaps.get("a/b").maxTokens === 4096, "catalog-advertised meteredMax* fields win over the built-in defaults");
    ok(defaultPrimary(r).id === "openai/gpt-5", "defaultPrimary: the only route that can hold OpenClaw's prompt");
    ok(defaultPrimary(routesFromCatalog(catalog, { pricing: "flat" })).id === "openai/gpt-5", "defaultPrimary under flat pricing: the premium row (200k chars here) still fits");
    const small = routesFromCatalog({ data: [
      { id: "openai/gpt-4o-mini", object: "model", x402: { tier: "v1-chat-auto", endpoint: "/v1/auto/chat/completions", priceUsd: 0.01, maxTokens: 1024, maxInputChars: 16_000 } },
      { id: "openai/gpt-5-nano", object: "model", x402: { tier: "v1-chat-nano", endpoint: "/v1/nano/chat/completions", priceUsd: 0.003, maxTokens: 768, maxInputChars: 12_000 } },
    ] });
    ok(defaultPrimary(small) === null && small.has(AUTO_ID), "defaultPrimary: null when nothing can hold OpenClaw's prompt - never auto, however cheap");
    const pref = routesFromCatalog({ data: [
      { id: "openai/gpt-5", object: "model", x402: { tier: "v1-chat-premium", endpoint: "/v1/premium/chat/completions", priceUsd: 0.5, maxTokens: 8192, maxInputChars: 200_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001 } },
      { id: "anthropic/claude-haiku-4.5", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 32_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001 } },
      { id: "x/stealth", object: "model", x402: { tier: "v1-chat-ox", endpoint: "/v1/ox/chat/completions", priceUsd: 0.002, maxTokens: 8000, maxInputChars: 200_000, stealth: true } },
    ] });
    ok(defaultPrimary(pref).id === "anthropic/claude-haiku-4.5", "defaultPrimary: preferred tool-caller wins over a pricier fit; stealth rows never chosen");
  }
  const routes = routesFromCatalog(catalog);
  ok(routes.has(AUTO_ID) && routes.get(AUTO_ID).endpoint === "/v1/auto/chat/completions", "catalog -> routes exposes \"auto\" on the routed tier");
  ok(!routes.has("deepseek/*"), "family wildcards are not model ids");
  const m = openclawModels(routes);
  ok(m[0].id === AUTO_ID && /\$0\.01\/call/.test(m[0].name), "OpenClaw models list leads with auto and states the per-call price");
  ok(m.every((x) => x.cost.input === 0 && x.cost.output === 0), "per-token cost fields stay zero (flat per-call billing)");
  ok(!m.some((x) => x.id === "x/stealth"), "stealth listings are not advertised to OpenClaw");
  ok(m.find((x) => x.id === "openai/gpt-5").maxTokens === 8192, "maxTokens comes from the tier");
}

// ---- proxy: credits mode ---------------------------------------------------
const key = "a402_testkey0000000000000000";
const p = await startProxy({ upstream, creditsKey: key, port: 0 });
ok(p.mode === "credits" && p.baseUrl.startsWith("http://127.0.0.1:"), `proxy starts in credits mode on loopback (${p.baseUrl})`);
{
  const h = await (await fetch(`${p.baseUrl}/health`)).json();
  ok(h.ok === true && h.models === 5, "GET /health reports mode + model count");
  const list = await (await fetch(`${p.baseUrl}/v1/models`)).json();
  ok(list.data.some((m) => m.id === "auto") && !list.data.some((m) => m.id === "x/stealth"), "GET /v1/models serves the routed catalog without stealth rows");
}
{
  const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) });
  const j = await r.json(); const s = seen.at(-1);
  ok(r.status === 200 && j.choices[0].message.content === "OK", "auto: forwarded and answered");
  ok(s.url === "/v1/auto/chat/completions" && !("model" in s.body), "auto: routed tier endpoint, model field omitted");
  ok(s.auth === `Bearer ${key}`, "credits key rides as the Bearer upstream");
  ok(typeof s.idem === "string" && s.idem.length >= 32, "every forwarded call carries an Idempotency-Key");
  ok(r.headers.get("x-credits-balance") === "19.99", "X-Credits-Balance passes through to the client");
}
{
  const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "agent402/openai/gpt-5", messages: [] }) });
  const s = seen.at(-1);
  ok(r.status === 200 && s.url === "/v1/metered/chat/completions" && s.body.model === "openai/gpt-5", "explicit model routes to the metered route by default, provider prefix stripped");
  const first = seen.at(-2).idem;
  ok(s.idem !== first, "each call gets its own Idempotency-Key");
}
{
  const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nope/x", messages: [] }) });
  const j = await r.json();
  ok(r.status === 400 && j.error.code === "model_not_found" && seen.at(-1).body.model !== "nope/x", "unknown model is a local 400, nothing forwarded");
}
{
  const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", stream: true, messages: [] }) });
  const text = await r.text();
  ok(r.status === 200 && r.headers.get("content-type").startsWith("text/event-stream") && text.includes('"O"') && text.includes("[DONE]"), "streams pass through byte for byte");
}
{
  const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  ok(r.status === 400, "malformed JSON is a local 400");
}
await p.close();

// ---- proxy: unpaid + insufficient ----------------------------------------
{
  const u = await startProxy({ upstream, port: 0 });
  ok(u.mode === "unpaid", "no key and no payFetch -> unpaid mode");
  const r = await fetch(`${u.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  const j = await r.json();
  ok(r.status === 402 && j.error.code === "agent402_unconfigured" && /credits/.test(j.topup) && j.priceUsd === 0.01, "unpaid call answers a 402 that says how to set up, and nothing is forwarded");
  await u.close();
  const d = await startProxy({ upstream, creditsKey: "a402_deadkey00000000000000", port: 0 });
  const r2 = await fetch(`${d.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  const j2 = await r2.json();
  ok(r2.status === 402 && j2.reason === "insufficient", "the gateway's own 402 (insufficient credits) passes through unchanged");
  await d.close();
}

// ---- proxy: x402 wallet mode via injected payFetch --------------------------
{
  let paid = 0;
  const payFetch = async (url, init) => { paid++; return fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } }); };
  const w = await startProxy({ upstream, payFetch, port: 0 });
  ok(w.mode === "x402", "payFetch without a credits key -> x402 mode");
  const r = await fetch(`${w.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  ok(r.status === 200 && paid === 1, "the paying fetch is what reaches upstream");
  await w.close();
}

// ---- plugin register() with a fake OpenClaw api ----------------------------
{
  const calls = { providers: [], services: [] };
  const api = { id: "agent402", name: "Agent402", config: {}, pluginConfig: { upstream, creditsKey: key, port: 0 }, logger: { info() {}, warn() {}, error() {} },
    registerProvider: (p) => calls.providers.push(p), registerService: (s) => calls.services.push(s), registerTool() {}, registerHook() {}, registerHttpRoute() {}, registerCommand() {}, resolvePath: (x) => x, on() {} };
  plugin.register(api); plugin.register(api);
  ok(calls.providers.length === 2 && calls.services.length === 1, "register() is idempotent: provider each time, proxy service once");
  const prov = calls.providers[0];
  ok(prov.id === "agent402" && prov.models.api === "openai-completions" && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(prov.models.baseUrl), "provider points OpenClaw at the loopback proxy, openai-completions API");
  ok(prov.models.models[0].id === "auto" && prov.auth.length === 0, "provider lists auto first and needs no OpenClaw auth");
  await calls.services[0].start();
  const live = calls.providers[0].models;
  ok(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(live.baseUrl) && live.models.some((m) => m.id === "openai/gpt-5"), "after start, the provider's models come from the gateway catalog");
  const r = await fetch(`${live.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [] }) });
  ok(r.status === 200, "OpenClaw-shaped call through the registered baseUrl succeeds");
  await calls.services[0].stop();
}

// ---- credits key resolution + CLI setup ------------------------------------
{
  const home = mkdtempSync(join(tmpdir(), "a402-oc-"));
  const env = { ...process.env, AGENT402_OPENCLAW_HOME: home, AGENT402_UPSTREAM: upstream };
  delete env.AGENT402_CREDITS_KEY;
  const bad = await run(["cli.js", "setup", "--credits-key", "nope"], env);
  ok(bad.status === 2 && /does not look like/.test(bad.stderr), "setup refuses a malformed credits key");
  const good = await run(["cli.js", "setup", "--credits-key", key, "--write"], env);
  if (good.status !== 0) console.log("setup --write:", good.status, good.stdout, good.stderr);
  const cfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  // The primary is a model that can hold OpenClaw's own prompt (~70k chars before
  // the user's first word): in this catalog only the metered gpt-5 route can.
  // `auto` (routed tier, 32k-char cap here, 16k on prod) would fail every turn.
  ok(good.status === 0 && cfg.agents.defaults.model.primary === "agent402/openai/gpt-5" && cfg.models.providers.agent402.api === "openai-completions", "setup --write stores the key and writes provider + a primary that fits OpenClaw's prompt (metered, never auto) into openclaw.json");
  const gpt5Row = cfg.models.providers.agent402.models.find((m) => m.id === "openai/gpt-5");
  ok(gpt5Row.contextWindow === Math.floor(METERED_MAX_INPUT_CHARS / 4) && gpt5Row.maxTokens === METERED_MAX_TOKENS, "a metered model advertises the METERED route's caps to OpenClaw, not its flat home tier's");
  ok(cfg.models.providers.agent402.models[0].id === "auto" && cfg.models.providers.agent402.models.some((m) => m.id === "openai/gpt-5"), "written models come from the live catalog");
  const stored = readFileSync(join(home, "agent402", "credits.key"), "utf8").trim();
  ok(stored === key, "credits key is stored under the OpenClaw home");
  process.env.AGENT402_OPENCLAW_HOME = home; delete process.env.AGENT402_CREDITS_KEY;
  ok(resolveCreditsKey() === key, "resolveCreditsKey falls back to the stored file");
  const dry = await run(["cli.js", "setup"], env);
  ok(dry.status === 0 && /"primary": "agent402\/openai\/gpt-5"/.test(dry.stdout), "setup without --write prints the block");
  const flat = await run(["cli.js", "setup", "--flat"], env);
  ok(flat.status === 0 && /"primary": "agent402\/openai\/gpt-5"/.test(flat.stdout) && !/Context overflow/.test(flat.stderr), "setup --flat picks the flat premium row here (it fits) with no warning");
  rmSync(home, { recursive: true, force: true });
}


// ---- proxy: browser-hostile on loopback, Idempotency-Key passthrough ----------
{
  const b = await startProxy({ upstream, creditsKey: key, port: 0 });
  const before = seen.length;
  const r1 = await fetch(`${b.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: JSON.stringify({ model: "auto", messages: [] }) });
  ok(r1.status === 403 && seen.length === before, "a request carrying a browser Origin header is refused and nothing is forwarded");
  // fetch() refuses to set Host, so this probe goes through node:http (which is
  // also what a DNS-rebinding request looks like on the wire: loopback socket,
  // foreign Host).
  const r2 = await new Promise((resolve, reject) => {
    const { request } = createRequire(import.meta.url)("node:http");
    const rq = request({ host: "127.0.0.1", port: b.port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", host: "attacker.example:8412" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    rq.on("error", reject); rq.end(JSON.stringify({ model: "auto", messages: [] }));
  });
  ok(r2 === 403 && seen.length === before, "a non-loopback Host is refused and nothing is forwarded");
  const r3 = await fetch(`${b.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "client-key-0001" }, body: JSON.stringify({ model: "auto", messages: [] }) });
  ok(r3.status === 200 && seen.at(-1).idem === "client-key-0001", "a client-supplied Idempotency-Key is passed through unchanged");
  const r4 = await fetch(`${b.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "bad key with spaces" }, body: JSON.stringify({ model: "auto", messages: [] }) });
  ok(r4.status === 200 && /^[0-9a-f-]{36}$/.test(seen.at(-1).idem), "a malformed client key is replaced by a fresh UUID, never forwarded verbatim");
  await b.close();
}

// ---- CLI reachable through npm's bin symlink (0.1.0/0.1.1 shipped a no-op) ----
{
  const home = mkdtempSync(join(tmpdir(), "a402-oc-bin-"));
  const bin = join(home, "node_modules", ".bin"); mkdirSync(bin, { recursive: true });
  const link = join(bin, "agent402-openclaw");
  symlinkSync(new URL("./cli.js", import.meta.url).pathname, link);
  const viaLink = await run([link, "help"], { ...process.env, AGENT402_OPENCLAW_HOME: home });
  ok(viaLink.status === 0 && /setup/.test(viaLink.stdout), `the CLI runs when invoked through a bin symlink (got status ${viaLink.status}, stdout ${JSON.stringify(viaLink.stdout.slice(0, 40))})`);
  const spaced = join(home, "sp ace"); mkdirSync(spaced, { recursive: true });
  const copy = join(spaced, "cli.js"); writeFileSync(copy, readFileSync(new URL("./cli.js", import.meta.url)));
  for (const f of ["index.js", "proxy.js", "models.js", "provider.js", "package.json"]) writeFileSync(join(spaced, f), readFileSync(new URL(`./${f}`, import.meta.url)));
  const viaSpace = await run([copy, "help"], { ...process.env, AGENT402_OPENCLAW_HOME: home });
  ok(viaSpace.status === 0 && /setup/.test(viaSpace.stdout), "the CLI runs from a path containing a space");
  rmSync(home, { recursive: true, force: true });
}

// ---- setup with NO payment method mints a wallet ------------------------------
{
  const home = mkdtempSync(join(tmpdir(), "a402-oc-w-"));
  const env = { ...process.env, AGENT402_OPENCLAW_HOME: home, AGENT402_UPSTREAM: upstream };
  delete env.AGENT402_CREDITS_KEY; delete env.AGENT402_WALLET_KEY;
  const r = await run(["cli.js", "setup"], env);
  const addr = (r.stdout.match(/address: (0x[0-9a-fA-F]{40})/) || [])[1];
  ok(r.status === 0 && addr && /fund it with USDC on Base/.test(r.stdout), `setup with no credits key generates a wallet and prints its address (got ${addr})`);
  const keyFile = join(home, "agent402", "wallet.key");
  const pk = readFileSync(keyFile, "utf8").trim();
  ok(/^0x[0-9a-fA-F]{64}$/.test(pk) && (statSync(keyFile).mode & 0o777) === 0o600, "the private key lands in ~/.openclaw/agent402/wallet.key at 0600");
  ok(!r.stdout.includes(pk) && !r.stderr.includes(pk), "the private key is never printed");
  const again = await run(["cli.js", "setup"], env);
  const addr2 = (again.stdout.match(/address: (0x[0-9a-fA-F]{40})/) || [])[1];
  ok(again.status === 0 && readFileSync(keyFile, "utf8").trim() === pk && (addr2 === undefined || addr2 === addr), "a second setup never overwrites or rotates the wallet");
  const prev = process.env.AGENT402_OPENCLAW_HOME; process.env.AGENT402_OPENCLAW_HOME = home; delete process.env.AGENT402_WALLET_KEY;
  ok(resolveWalletKey() === pk, "resolveWalletKey reads the generated key file (proxy + doctor + permit2-approve see it)");
  ok(resolveWalletKey({ walletKey: "0x" + "ab".repeat(32) }) === "0x" + "ab".repeat(32), "plugin config walletKey takes precedence over the file");
  process.env.AGENT402_WALLET_KEY = "0x" + "cd".repeat(32);
  ok(resolveWalletKey() === "0x" + "cd".repeat(32), "AGENT402_WALLET_KEY takes precedence over the file");
  delete process.env.AGENT402_WALLET_KEY;
  if (prev == null) delete process.env.AGENT402_OPENCLAW_HOME; else process.env.AGENT402_OPENCLAW_HOME = prev;
  const home2 = mkdtempSync(join(tmpdir(), "a402-oc-nw-"));
  const nw = await run(["cli.js", "setup", "--no-wallet"], { ...env, AGENT402_OPENCLAW_HOME: home2 });
  ok(nw.status === 0 && !existsSync(join(home2, "agent402", "wallet.key")) && /no payment method yet/.test(nw.stdout), "--no-wallet keeps the old behaviour (no key generated)");
  const withKey = await run(["cli.js", "setup", "--credits-key", key], { ...env, AGENT402_OPENCLAW_HOME: mkdtempSync(join(tmpdir(), "a402-oc-ck-")) });
  ok(withKey.status === 0 && !/address: 0x/.test(withKey.stdout), "a credits key on the command line means no wallet is generated");
}

// ---- setup: key by env, config mode preserved ---------------------------------
{
  const home = mkdtempSync(join(tmpdir(), "a402-oc-mode-"));
  const cfg = join(home, "openclaw.json");
  writeFileSync(cfg, JSON.stringify({ models: { providers: { other: { apiKey: "sk-secret" } } } }) + "\n", { mode: 0o600 });
  const env = { ...process.env, AGENT402_OPENCLAW_HOME: home, AGENT402_UPSTREAM: upstream, AGENT402_CREDITS_KEY: key };
  const r = await run(["cli.js", "setup", "--write"], env);
  const mode = statSync(cfg).mode & 0o777;
  const out = JSON.parse(readFileSync(cfg, "utf8"));
  ok(r.status === 0 && mode === 0o600, `setup --write preserves the config file mode (got ${mode.toString(8)})`);
  ok(out.models.providers.other.apiKey === "sk-secret" && out.models.providers.agent402, "existing providers survive the merge");
  ok(readFileSync(join(home, "agent402", "credits.key"), "utf8").trim() === key, "the key is taken from AGENT402_CREDITS_KEY when no flag is given");
  ok(!/a402_testkey/.test(r.stdout), "the key is never echoed to stdout");
  rmSync(home, { recursive: true, force: true });
}


// ---- metered routing (0.2.0): explicit models go to the metered route by default ----
{
  const m = routesFromCatalog(catalog);
  ok(m.get("openai/gpt-5").endpoint === "/v1/metered/chat/completions" && m.get("openai/gpt-5").metered === true && m.get("openai/gpt-5").priceUsd === 0.001, "a model whose catalog row advertises meteredEndpoint routes there by default, priced from the metered floor");
  ok(m.get("openai/gpt-5-nano").endpoint === "/v1/nano/chat/completions" && !m.get("openai/gpt-5-nano").metered, "a row without meteredEndpoint keeps its home tier");
  ok(m.get(AUTO_ID).endpoint === "/v1/auto/chat/completions" && !m.get(AUTO_ID).metered, "auto stays on the routed tier (the metered route needs an explicit model)");
  const flat = routesFromCatalog(catalog, { pricing: "flat" });
  ok(flat.get("openai/gpt-5").endpoint === "/v1/premium/chat/completions" && flat.get("openai/gpt-5").priceUsd === 0.5, "pricing: flat keeps every model on its home tier");
  ok(/metered, from \$0\.001\/call/.test(openclawModels(m).find((x) => x.id === "openai/gpt-5").name), "the OpenClaw display name says metered and the floor");
  const p2 = await startProxy({ upstream, creditsKey: key, port: 0 });
  const r = await fetch(`${p2.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5", messages: [] }) });
  ok(r.status === 200 && seen.at(-1).url === "/v1/metered/chat/completions" && seen.at(-1).body.model === "openai/gpt-5", "the proxy forwards an explicit model to the metered route with the model set");
  const h = await (await fetch(`${p2.baseUrl}/health`)).json();
  ok(h.pricing === "metered", "health reports the pricing mode");
  await p2.close();
  const p3 = await startProxy({ upstream, creditsKey: key, port: 0, pricing: "flat" });
  await fetch(`${p3.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5", messages: [] }) });
  ok(seen.at(-1).url === "/v1/premium/chat/completions", "pricing: flat forwards to the home tier");
  await p3.close();
}

stub.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
