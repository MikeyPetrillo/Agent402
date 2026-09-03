// The plugin against a REAL OpenClaw, the way a user gets it - not the fake
// plugin api in test.js. Every green run of that file proved the plugin against
// OUR MODEL of OpenClaw; this proves it against OpenClaw:
//   npm i openclaw@<pinned>      (the actual host, ~90 MB, Node >= 22.22)
//   npm pack + npm i -g <tgz>    (the bin SYMLINK path - 0.1.0/0.1.1 were no-ops through it)
//   openclaw plugins install <tgz>   (the documented install; 0.1.0-0.2.0 were REFUSED here:
//                                    "plugin manifest requires configSchema")
//   agent402-openclaw setup --write  (through the symlink, against a stub gateway)
//   openclaw models list / status    (the provider and primary OpenClaw actually sees)
//   openclaw gateway run             (the plugin service must start the loopback proxy)
//   openclaw agent -m ...            (ONE agent turn: OpenClaw -> proxy -> stub, paid with the key)
// The last step is the one that found `agent402/auto` as primary could never
// complete a turn: OpenClaw sends ~70k chars of system prompt + tool schemas
// before the user's first word and its precheck refuses a model whose
// contextWindow cannot hold that. No stub can see that; only the host can.
// Network: npm registry only (the model gateway is a loopback stub; no money).
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const pkgDir = new URL(".", import.meta.url).pathname;
// PINNED, deliberately. This lane installs the host from npm, so tracking
// @latest hands a third party a veto over every merge in this repo: OpenClaw
// published 2026.8.1 overnight on 2026-08-30 and the lane went red with no
// commit of ours, blocking an unrelated catalog fix for hours. The pin is the
// newest version the plugin is PROVEN against; openclaw-latest.yml runs this
// same file against @latest on a schedule and opens an issue, so a host change
// still reaches us - as a page, not as a blocked merge. Raise the pin when
// that watcher goes red and the plugin has been fixed to match.
const OPENCLAW_SPEC = process.env.OPENCLAW_SPEC || "openclaw@2026.8.1";

// ASYNC spawn only: the stub gateway lives in this process, and a synchronous
// spawn blocks the event loop so nothing the child asks the stub is answered
// (setup's /v1/models read timed out that way on the first draft).
const sh = (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { ...opts });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
  child.on("error", (e) => resolve({ status: -1, out: String(e), stdout, stderr: String(e) }));
  child.on("close", (status) => resolve({ status, out: stdout + stderr, stdout, stderr }));
});

// ---- stub gateway (what agent402.tools answers) -------------------------------
const seen = [];
const catalog = { object: "list", data: [
  { id: "openai/gpt-5-nano", object: "model", x402: { tier: "v1-chat-nano", endpoint: "/v1/nano/chat/completions", priceUsd: 0.003, maxTokens: 768, maxInputChars: 12_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001, meteredMaxInputChars: 200_000, meteredMaxTokens: 8192 } },
  { id: "anthropic/claude-haiku-4.5", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 32_000, meteredEndpoint: "/v1/metered/chat/completions", meteredFromUsd: 0.001, meteredMaxInputChars: 200_000, meteredMaxTokens: 8192 } },
  { id: "openai/gpt-4o-mini", object: "model", x402: { tier: "v1-chat-auto", endpoint: "/v1/auto/chat/completions", priceUsd: 0.01, maxTokens: 1024, maxInputChars: 16_000 } },
] };
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(catalog)); }
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep {} */ }
    seen.push({ url: req.url, auth: req.headers.authorization || null, model: body.model, stream: !!body.stream, chars: raw.length });
    if (!req.headers.authorization) { res.writeHead(402, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Payment required" })); }
    const text = "STUB-OK";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-credits-balance": "19.99" });
      res.write(`data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", "x-credits-balance": "19.99" });
    res.end(JSON.stringify({ id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const upstream = `http://127.0.0.1:${stub.address().port}`;

const work = mkdtempSync(join(tmpdir(), "a402-real-openclaw-"));
const home = join(work, "home");           // OpenClaw state + config AND the plugin's state dir
const host = join(work, "host");           // where openclaw itself is installed
const prefix = join(work, "global");       // npm -g prefix for OUR package (bin symlink)
const proxyPort = 18400 + Math.floor(Math.random() * 400);
const gwPort = 19400 + Math.floor(Math.random() * 400);
const key = "a402_realinstall00000000000000";
// Allowlisted env, never `...process.env`: this spawns an UNPINNED third-party
// package (npm i openclaw@latest, lifecycle scripts included) and then runs its
// binary with network access, and the CI job that hosts this test carries
// metered API keys at job scope. The repo's rule (deploy.yml, F07) is that a
// third-party install must not be able to read them; an allowlist keeps that
// true here without depending on the workflow remembering to shadow each key.
const ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LANG", "LC_ALL", "TZ", "CI", "GITHUB_ACTIONS", "RUNNER_TEMP", "OPENCLAW_SPEC"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_ALLOW.includes(k) || /^(npm_config_|NODE_|NVM_|OPENCLAW_)/.test(k)));
const env = {
  ...baseEnv,
  OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
  AGENT402_OPENCLAW_HOME: home, AGENT402_UPSTREAM: upstream, AGENT402_CREDITS_KEY: key,
  NO_COLOR: "1", FORCE_COLOR: "0",
};
delete env.AGENT402_WALLET_KEY; delete env.AGENT402_PRICING;
let gateway = null;
const cleanup = () => {
  if (gateway && gateway.exitCode === null) { try { gateway.kill("SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { gateway.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref(); }
  stub.close();
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the gateway may still be writing its state; the OS tmp dir reaps it */ }
};
process.on("exit", cleanup);

try {
  // 1. The real host.
  await sh("mkdir", ["-p", host, prefix, home]);
  const inst = await sh("npm", ["i", OPENCLAW_SPEC, "--no-audit", "--no-fund", "--prefix", host], { cwd: host, env });
  ok(inst.status === 0, `npm i ${OPENCLAW_SPEC} into a scratch dir (${inst.status === 0 ? "ok" : inst.out.slice(-400)})`);
  if (inst.status !== 0) throw new Error("no host");
  const oc = join(host, "node_modules", ".bin", "openclaw");
  const ver = await sh(oc, ["--version"], { env });
  ok(/\d{4}\.\d+\.\d+/.test(ver.stdout), `openclaw --version: ${ver.stdout.trim()}`);

  // 2. Our package, the way it ships: packed, then installed through the bin symlink.
  const packed = await sh("npm", ["pack", "--pack-destination", work], { cwd: pkgDir });
  const tgz = join(work, packed.stdout.trim().split("\n").pop());
  ok(packed.status === 0 && existsSync(tgz), `npm pack -> ${tgz.split("/").pop()}`);
  const g = await sh("npm", ["i", "-g", tgz, "--no-audit", "--no-fund", "--prefix", prefix]);
  const bin = join(prefix, "bin", "agent402-openclaw");
  ok(g.status === 0 && existsSync(bin), "npm i -g <tgz> links bin/agent402-openclaw (a symlink)");
  ok(realpathSync(bin) !== bin, "the bin IS a symlink - the entry guard must survive it (0.1.0/0.1.1 did not)");

  // 3. The documented install: openclaw plugins install.
  // 2026.8.1 gates a plugin from a LOCAL ARCHIVE ("outside ClawHub review and
  // trust metadata") behind capability consent: without --accept-capabilities the
  // CLI refuses to start at all. CI cannot answer an interactive prompt, and this
  // is our own tgz, so consent is given here explicitly.
  // --accept-capabilities exists only on 2026.8.1+, where a plugin from a LOCAL
  // ARCHIVE ("outside ClawHub review and trust metadata") is gated behind
  // consent and the CLI refuses to start without it. 2026.7.1 rejects the flag
  // outright ("does not recognize option"), so probe the help text rather than
  // hardcoding either host: pinning the flag on made this test measure the CLI's
  // option list instead of our plugin.
  const installHelp = await sh(oc, ["plugins", "install", "--help"], { env });
  const CONSENT = /--accept-capabilities/.test(installHelp.out) ? ["--accept-capabilities"] : [];
  const pi = await sh(oc, ["plugins", "install", tgz, "--force", ...CONSENT], { env, cwd: home });
  ok(pi.status === 0 && /Installed plugin: agent402/.test(pi.out), `openclaw plugins install <tgz> accepts the package (exit ${pi.status}: ${(/Reason:\s*([^\n]+(?:\n(?!\[)[^\n]*)*)/.exec(pi.out)?.[1] || pi.out).trim().replace(/\s+/g, " ").slice(0, 900) || "<no output>"})`);
  const insp = await sh(oc, ["plugins", "inspect", "agent402"], { env });
  ok(/Status: loaded/.test(insp.out) && /text-inference: agent402/.test(insp.out), "openclaw plugins inspect agent402: loaded, registers text-inference");
  // Consent given at install time does not survive into the gateway's runtime:
  // 2026.8.1 quarantines the plugin until it is enabled with consent too (the
  // refusal names this command itself). Without it the gateway loads every other
  // plugin and silently never starts ours.
  const pe = CONSENT.length
    ? await sh(oc, ["plugins", "enable", "agent402", ...CONSENT], { env, cwd: home })
    : { status: 0, out: "(host has no capability gate)" };
  ok(pe.status === 0, `plugins enable${CONSENT.length ? " --accept-capabilities" : " (not gated on this host)"} (exit ${pe.status}: ${pe.out.trim().replace(/\s+/g, " ").slice(0, 300)})`);
  const doc = await sh(oc, ["plugins", "doctor"], { env });
  // 2026.8.1 reworded a clean bill of health ("...checks passed"); a plugin it
  // rejects still prints a "Plugin errors:" block (that is how the id mismatch
  // surfaced), so require BOTH a success phrase and the absence of that block -
  // matching the wording alone would pass on a doctor that found real errors.
  ok(!/Plugin errors/.test(doc.out) && /(No plugin issues detected|checks passed)/.test(doc.out), `openclaw plugins doctor: ${doc.out.trim().replace(/\s+/g, " ").slice(0, 600)}`);

  // 4. setup --write through the SYMLINK, against the stub gateway.
  const setup = await sh(bin, ["setup", "--write", "--port", String(proxyPort)], { env });
  ok(setup.status === 0 && /wrote provider "agent402"/.test(setup.stdout), `setup --write via the symlink: ${(setup.stdout + setup.stderr).trim().split("\n").pop().slice(0, 200)}`);
  const cfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  const primary = String(cfg.agents?.defaults?.model?.primary || "");
  if (!primary) console.log(`setup stdout: ${setup.stdout.trim()}\nsetup stderr: ${setup.stderr.trim()}\nconfig: ${JSON.stringify(cfg).slice(0, 400)}`);
  // The config key is the MANIFEST id, not the provider id - OpenClaw 2026.8.1
  // requires the manifest id to equal the npm package name, so it is
  // "agent402-openclaw" while the provider a user types stays "agent402".
  // Asserting the old key here is how the 2026-08-26 --port defect hid: setup
  // wrote one key and the service read another, and nothing errored.
  const entry = cfg.plugins?.entries?.["agent402"];
  ok(entry?.config?.port === proxyPort, `setup --port wrote the plugin's own port into plugins.entries["agent402"].config (${JSON.stringify(entry)})`);
  ok(primary === "agent402/anthropic/claude-haiku-4.5", `primary is a model that can hold OpenClaw's prompt: ${primary}`);
  ok(entry?.enabled === true, `setup --write preserved the plugin's enabled flag while writing its port (${JSON.stringify(entry)})`);

  // 5. What OpenClaw itself now lists.
  const ml = await sh(oc, ["models", "list", "--provider", "agent402", "--plain"], { env });
  ok(/agent402\/auto/.test(ml.out) && /agent402\/anthropic\/claude-haiku-4\.5/.test(ml.out) && /agent402\/openai\/gpt-5-nano/.test(ml.out), "openclaw models list shows auto + the catalog's explicit models under provider agent402");
  const ms = await sh(oc, ["models", "status", "--plain"], { env });
  ok(ms.out.trim().split("\n")[0].trim() === primary, `openclaw models status names the primary (${ms.out.trim().split("\n")[0].trim()})`);

  // 6. The gateway must start the plugin's proxy service.
  for (const [k, v] of [["gateway.auth.mode", "token"], ["gateway.auth.token", "ci-real-install"], ["gateway.mode", "local"], ["gateway.port", String(gwPort)]]) {
    const r = await sh(oc, ["config", "set", k, v], { env });
    if (r.status !== 0) console.log(`config set ${k}: ${r.out.trim().slice(0, 200)}`);
  }
  let gwLog = "";
  gateway = spawn(oc, ["gateway", "run", "--port", String(gwPort), "--bind", "loopback"], { env, cwd: home });
  gateway.stdout.on("data", (c) => { gwLog += c; }); gateway.stderr.on("data", (c) => { gwLog += c; });
  const deadline = Date.now() + 90_000;
  let proxyUp = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { proxyUp = true; break; } } catch { /* not yet */ }
    if (gateway.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(proxyUp, `gateway boot started the plugin's loopback proxy on :${proxyPort} (${proxyUp ? "up" : gwLog.slice(-600)})`);
  ok(/\[agent402-openclaw\] proxy on http:\/\/127\.0\.0\.1:\d+\/v1/.test(gwLog), "gateway log carries the plugin's proxy line");
  ok(new RegExp(`agent model: ${primary.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`).test(gwLog), "gateway resolved the agent model to our primary");
  while (Date.now() < deadline && !/\[gateway\].*ready/.test(gwLog)) await new Promise((r) => setTimeout(r, 500));

  // 7. One real agent turn: OpenClaw -> proxy -> stub, paid with the key.
  const before = seen.length;
  const turn = await sh(oc, ["agent", "--agent", "main", "--session-key", "agent:main:real-install", "-m", "Say hello.", "--json", "--timeout", "120"], { env, cwd: home });
  let result = null;
  { const raw = turn.stdout; const dec = { parse: (s) => JSON.parse(s) }; const i = raw.indexOf("{"); if (i >= 0) { try { result = dec.parse(raw.slice(i)); } catch { const objs = raw.slice(i).split(/\n(?=\{)/); for (const o of objs) { try { result = JSON.parse(o); } catch { /* partial */ } } } } }
  const r = result?.result || result || {};
  const paid = seen.slice(before).filter((s) => s.auth === `Bearer ${key}`);
  ok(paid.length >= 1 && paid.every((s) => s.url === "/v1/metered/chat/completions" && s.model === "anthropic/claude-haiku-4.5"), `the turn reached the stub on the METERED route with the credits key (${paid.length} call(s): ${paid.map((s) => `${s.url} ${s.model} ${s.chars} chars`).join("; ").slice(0, 200)})`);
  ok(paid.some((s) => s.chars > 40_000), `OpenClaw's real prompt is big (${Math.max(0, ...paid.map((s) => s.chars))} chars) - the reason auto cannot be primary`);
  ok(!r.error, `no error on the turn (${r.error ? JSON.stringify(r.error).slice(0, 200) : "clean"})`);
  // `openclaw agent --json` answers { payloads: [{ text }], meta } (2026.7.1).
  const said = [r.finalAssistantVisibleText, r.finalAssistantRawText, ...(Array.isArray(r.payloads) ? r.payloads.map((x) => x?.text) : [])].filter(Boolean).join(" ");
  if (!/STUB-OK/.test(said)) console.log(`turn keys: ${Object.keys(r).join(",")}\nturn: ${JSON.stringify(r, (k, v) => (k === "meta" ? undefined : v)).slice(0, 1500)}\nstdout tail: ${turn.stdout.slice(-600)}\nstderr tail: ${turn.stderr.slice(-400)}`);
  ok(/STUB-OK/.test(said), `the stub's answer came back through OpenClaw (${JSON.stringify(said).slice(0, 120)})`);
} catch (e) {
  fail++; console.log(`FAIL - aborted: ${e?.stack || e}`);
}
console.log(`${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
