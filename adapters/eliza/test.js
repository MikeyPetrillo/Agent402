// elizaos-plugin-agent402 - offline against a paid-mode Agent402 server (free
// tier via proof-of-work), plus a stub gateway that records the Authorization
// header for the credits-key path. No @elizaos/core needed: the plugin never
// imports it at runtime; a stub runtime supplies getSetting().
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}
const { getFreePort } = await import("../../scripts/lib/free-port.js");
const plugin = (await import("./index.js")).default;
const { findAction, callAction, aboutAction, agent402Provider } = await import("./index.js");

const PORT = await getFreePort();
const BASE = process.env.AGENT402_BASE_URL || `http://127.0.0.1:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn("node", ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off",
      POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(m); pass++; console.log(`ok - ${m}`); };
const runtime = (settings = {}) => ({ getSetting: (k) => settings[k] ?? null, getService: () => null });
const msg = (content) => ({ id: "m1", entityId: "u1", roomId: "r1", content });
const capture = () => { const calls = []; const cb = async (c) => { calls.push(c); return []; }; return { calls, cb }; };

async function main() {
  ok(plugin.name === "agent402" && plugin.actions.length === 3 && plugin.providers.length === 1 && typeof plugin.init === "function", "plugin shape: name, three actions, one provider, init");
  ok(plugin.actions.map((a) => a.name).join(",") === "AGENT402_FIND,AGENT402_CALL,AGENT402_ABOUT", "actions in order: find, call, about");
  for (const a of plugin.actions) ok(typeof a.validate === "function" && typeof a.handler === "function" && a.description.length > 40 && Array.isArray(a.examples) && a.examples[0].length === 2, `${a.name}: validate + handler + description + a two-turn example`);
  await plugin.init({}, runtime({ AGENT402_BASE_URL: BASE }));

  const rt = runtime({ AGENT402_BASE_URL: BASE });
  // find: structured task, then plain text
  let { calls, cb } = capture();
  let r = await findAction.handler(rt, msg({ text: "", task: "sha256 hash of a string", k: 3 }), undefined, undefined, cb);
  ok(r.success === true && r.data.results.some((x) => x.slug === "hash") && /`hash`/.test(r.text), "AGENT402_FIND resolves a structured task to the hash tool and names it in the reply");
  ok(calls.length === 1 && calls[0].text === r.text, "the callback receives the same text the ActionResult carries");
  r = await findAction.handler(rt, msg({ text: "which tool makes a uuid" }), undefined, undefined, undefined);
  ok(r.success === true && r.data.results.some((x) => x.slug === "uuid"), "AGENT402_FIND falls back to the message text and needs no callback");
  r = await findAction.handler(rt, msg({ text: "" }));
  ok(r.success === false && /what you need/.test(r.text), "AGENT402_FIND with nothing to search answers a prompt, not an error");

  // call: validate needs a slug; the free tier pays with proof-of-work
  ok((await callAction.validate(rt, msg({ text: "hi" }))) === false && (await callAction.validate(rt, msg({ text: "", slug: "hash" }))) === true, "AGENT402_CALL validates only when a slug is present");
  ({ calls, cb } = capture());
  r = await callAction.handler(rt, msg({ text: "", slug: "hash", params: { text: "hello world", algo: "sha256" } }), undefined, undefined, cb);
  const want = createHash("sha256").update("hello world").digest("hex");
  ok(r.success === true && (r.data.result.hex || r.data.result.digest || r.data.result.hash) === want, "AGENT402_CALL paid the free tier with proof-of-work and returned sha256('hello world')");
  ok(calls.length === 1 && /returned/.test(calls[0].text), "AGENT402_CALL reports the result through the callback");
  r = await callAction.handler(rt, msg({ text: "", slug: "no-such-tool-xyz", params: {} }));
  ok(r.success === false && /failed/.test(r.text), "an unknown slug is a clean failure, never a throw");

  // credits key path: a stub gateway sees Authorization: Bearer <key> on the paid route
  const seen = [];
  const stub = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    if (req.url.startsWith("/api/find")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ results: [{ slug: "search", name: "search", price: "$0.02", route: "POST /api/search", walletOnly: true, description: "web search" }] })); }
    if (req.url.startsWith("/api/pricing")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ endpoints: [{ slug: "search", method: "POST", path: "/api/search", price: "$0.02", computePayable: false }, { slug: "hash", method: "POST", path: "/api/hash", price: "$0.001", computePayable: true }] })); }
    res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Insufficient credits", reason: "insufficient", balanceUsd: 0 }));
  });
  await new Promise((r2) => stub.listen(0, "127.0.0.1", r2));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  const KEY = "a402_" + "k".repeat(40);
  const rtKey = runtime({ AGENT402_BASE_URL: stubBase, AGENT402_CREDITS_KEY: KEY });
  r = await callAction.handler(rtKey, msg({ text: "", slug: "search", params: { q: "x402" } }));
  ok(r.success === false && seen.some((s) => s.auth === `Bearer ${KEY}`) && /credits|402|failed/i.test(r.text), "with AGENT402_CREDITS_KEY the paid call carries Authorization: Bearer <key>; an insufficient-credits 402 is a clean failure");
  ok(!JSON.stringify(r).includes(KEY), "the credits key never appears in the ActionResult");
  r = await aboutAction.handler(rtKey, msg({ text: "what is agent402" }));
  ok(r.success === true && r.data.tools === 2 && r.data.freeTier === 1 && /2 deterministic/.test(r.text), "AGENT402_ABOUT reads /api/pricing and reports tool + free-tier counts");
  stub.close();

  // wallet key without the x402 peers installed: no paying fetch, free tier still works, nothing throws
  const rtWallet = runtime({ AGENT402_BASE_URL: BASE, AGENT402_WALLET_KEY: "0x" + "11".repeat(32) });
  r = await callAction.handler(rtWallet, msg({ text: "", slug: "hash", params: { text: "abc", algo: "sha256" } }));
  ok(r.success === true, `a wallet key (x402 peers present or not) still pays the free tier with proof-of-work (got: ${r.text})`);

  // provider: names the payment mode without leaking a key
  const p = await agent402Provider.get(rtKey, msg({ text: "" }), {});
  ok(/card credits/.test(p.text) && p.values.agent402PaymentMode === "card credits" && !p.text.includes(KEY), "provider context names the payment mode (card credits) and never the key");
  const p2 = await agent402Provider.get(runtime({ AGENT402_BASE_URL: BASE }), msg({ text: "" }), {});
  ok(/free tier only/.test(p2.text), "provider says free tier only when nothing is configured");
}

try {
  await main();
  console.log(`\n${pass} passed`);
} finally {
  if (proc) proc.kill("SIGKILL");
}
