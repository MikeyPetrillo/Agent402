// Smoke test for agent402-agentkit. Spawns its own paywalled server
// (X402_SYNC_ON_START=false so no facilitator is contacted; proof-of-work
// bypasses settlement) and drives the three actions the way AgentKit's
// customActionProvider does: schema.parse(args), then invoke(args) or
// invoke(walletProvider, args). @coinbase/agentkit is stubbed to the one
// export the adapter uses, so the test never pulls its dependency tree.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}
const stubDir = join(HERE, "node_modules", "@coinbase", "agentkit");
if (!existsSync(join(stubDir, "package.json"))) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({ name: "@coinbase/agentkit", version: "0.0.0-stub", type: "module", main: "index.js" }));
  writeFileSync(join(stubDir, "index.js"), `
    export function customActionProvider(actions) { return { __stub: true, name: "custom", actions }; }
  `);
}

const { agent402Actions, agent402ActionProvider, payFetchFor } = await import("./index.js");

const PORT = 3087;
const BASE = process.env.AGENT402_BASE_URL || `http://localhost:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn("node", ["src/server.js"], {
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

let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(m); pass++; console.log(`ok - ${m}`); };

async function main() {
  const actions = await agent402Actions({ baseUrl: BASE });
  ok(actions.map((a) => a.name).join(",") === "agent402_find,agent402_call,agent402_about", "three actions in order: find, call, about");
  for (const a of actions) ok(typeof a.schema?.parse === "function" && typeof a.invoke === "function" && a.description.length > 40, `${a.name}: zod schema + invoke + description`);
  const [find, call, about] = actions;
  ok(find.invoke.length !== 2 && call.invoke.length === 2 && about.invoke.length !== 2, "invoke arity tells AgentKit which actions take the wallet provider (call does, find/about do not)");

  // find: free discovery, parsed the way customActionProvider parses it
  const found = JSON.parse(await find.invoke(find.schema.parse({ task: "sha256 hash of a string", k: 3 })));
  ok(Array.isArray(found.results) && found.results.some((r) => r.slug === "hash"), "agent402_find resolves 'sha256 hash of a string' to the hash tool");
  let threw = false; try { find.schema.parse({ task: "" }); } catch { threw = true; }
  ok(threw, "agent402_find schema refuses an empty task");

  // call with NO wallet provider: proof-of-work pays the free-tier tool
  const out = JSON.parse(await call.invoke(null, call.schema.parse({ slug: "hash", params: { text: "hello world", algo: "sha256" } })));
  const want = createHash("sha256").update("hello world").digest("hex");
  ok((out.hex || out.digest || out.hash) === want, "agent402_call paid the free tier with proof-of-work and returned sha256('hello world')");

  // call with a wallet provider shaped like AgentKit's EVM providers: the
  // paying fetch is built from toSigner() (no paid call is made here)
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount("0x" + "11".repeat(32));
  const walletProvider = { toSigner: () => account, readContract: async () => 0n, getNetwork: () => ({ protocolFamily: "evm", networkId: "base-mainnet" }) };
  const pf = await payFetchFor(walletProvider);
  ok(typeof pf === "function", "payFetchFor builds an x402-paying fetch from an EVM wallet provider's toSigner()");
  ok((await payFetchFor({})) === undefined && (await payFetchFor(null)) === undefined, "no toSigner() -> no paying fetch (proof-of-work only), never a throw");
  const out2 = JSON.parse(await call.invoke(walletProvider, { slug: "hash", params: { text: "hello world", algo: "sha256" } }));
  ok((out2.hex || out2.digest || out2.hash) === want, "with a wallet provider the free-tier call still pays by proof-of-work and returns the same result");

  // about: free
  // Spend ceilings hold ACROSS invokes: one client per wallet for the life of
  // the actions (0.1.2). A stub seller answers a $0.003 wallet-only tool by
  // credits key; under a $0.005 daily ceiling the second invoke is refused
  // before any request leaves the process. No wallet is funded.
  {
    const seen = [];
    const stub = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      const j = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [{ slug: "search", method: "POST", path: "/api/search", price: "$0.003", computePayable: false }] });
      if (!req.headers.authorization) return j(402, { error: "Payment required" });
      j(200, { results: [{ url: "https://x402.org" }] });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const STUB = `http://127.0.0.1:${stub.address().port}`;
    const KEY = "a402_" + "k".repeat(40);
    const [, callK] = await agent402Actions({ baseUrl: STUB, creditsKey: KEY, dailyLimitUsd: 0.005, maxPerCallUsd: 0.004 });
    const paid = () => seen.filter((x) => x.url.startsWith("/api/search") && x.auth === `Bearer ${KEY}`).length;
    const first = JSON.parse(await callK.invoke(null, { slug: "search", params: { q: "x402" } }));
    ok(first.results?.[0]?.url === "https://x402.org" && paid() === 1, "call 1 under the daily ceiling settles by credits key (stub saw one paid request)");
    let refused = null;
    try { await callK.invoke(null, { slug: "search", params: { q: "mpp" } }); } catch (e) { refused = String(e?.message || e); }
    ok(refused && /dailyLimitUsd|24h spend/.test(refused) && paid() === 1, "call 2 is refused by the DAILY ceiling with no request sent: the ledger survived across invokes");
    stub.close();
  }

  // The per-call ceiling holds on the payment that is SIGNED. A stub seller
  // quotes $0.01 to the unpaid preflight and $5 (5000000 base units of USDC,
  // beside a decimals hint of 18) to the request the wallet signs for. The
  // wallet is a throwaway key; the stub records any signature it receives.
  {
    const seen = { unpaid: 0, signed: 0 };
    const offer = (amount) => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/api/dear", description: "dear", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", decimals: 18 } }],
    })).toString("base64");
    const stub = createServer((req, res) => {
      const j = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [{ slug: "dear", method: "POST", path: "/api/dear", price: "$0.01", computePayable: false }] });
      req.resume();
      if (req.headers["payment-signature"] || req.headers["x-payment"]) { seen.signed++; return j(200, { ok: true }); }
      seen.unpaid++;
      return j(402, {}, { "payment-required": offer(seen.unpaid === 1 ? 10000 : 5000000) });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const STUB = `http://127.0.0.1:${stub.address().port}`;
    const [, callW] = await agent402Actions({ baseUrl: STUB });
    let refused = null;
    try { await callW.invoke(walletProvider, { slug: "dear", params: { q: "x" } }); } catch (e) { refused = e; }
    ok(seen.unpaid === 2, `the preflight and the paid request each drew a 402 (saw ${seen.unpaid})`);
    ok(seen.signed === 0, "the $5 payment the paid request asked for was never signed under the default $1 ceiling");
    ok(refused?.name === "SpendingLimitError" && refused.atSigning === true, `the refusal is a SpendingLimitError at signing (${refused?.message})`);
    stub.close();
  }

  const ab = JSON.parse(await about.invoke({}));
  ok(ab.tools > 100 && ab.freeTier > 10 && ab.discover.includes("/api/find"), `agent402_about reports ${ab.tools} tools, ${ab.freeTier} free-tier`);

  // the provider wrapper hands the same actions to AgentKit's customActionProvider
  const provider = await agent402ActionProvider({ baseUrl: BASE });
  ok(provider.__stub === true && provider.actions.length === 3 && provider.actions[1].name === "agent402_call", "agent402ActionProvider wraps the three actions with @coinbase/agentkit's customActionProvider");

  console.log(`PASS - agent402-agentkit: ${pass} checks`);
}

main().then(() => { if (proc) proc.kill(); process.exit(0); }).catch((e) => { console.error("FAIL:", e); if (proc) proc.kill(); process.exit(1); });
