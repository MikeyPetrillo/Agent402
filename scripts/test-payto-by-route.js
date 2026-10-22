#!/usr/bin/env node
// The payee a route's 402 names is the payee the service manifest declares.
//
// A buyer that checks a 402's payTo against /.well-known/x402 refuses a route
// whose 402 names an address the manifest does not. The router tiers settle
// some networks to the router's own spending wallet (SELF_FUNDING_SLUGS /
// AVM_SELF_FUNDING_SLUGS in src/payments.js), so the manifest publishes those
// payees under payment.x402.payToByRoute, derived from payToForRoute, the
// function the 402 builder calls.
//
// Boots the paid server twice against a stub facilitator (no payment is made,
// nothing leaves 127.0.0.1): once with both spending-wallet addresses set
// (throwaway values), once with them unset. Each boot asks every catalog
// route for its unpaid 402 and checks every accept's payTo against the
// manifest's declared payee for that route and network.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { payToForRoute, SELF_FUNDING_SLUGS, AVM_SELF_FUNDING_SLUGS } from "../src/payments.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "eip155:8453";
const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const ALGO_TREASURY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
// Throwaway addresses (no key exists for either): the spending wallets.
const EVM_BUYER = "0x000000000000000000000000000000000000b0b1";
const AVM_BUYER = "AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI";
const ROUTER_SLUGS = new Set([...SELF_FUNDING_SLUGS, ...AVM_SELF_FUNDING_SLUGS]);

// ---- Part 1: the helper, offline ------------------------------------------
{
  const rails = { walletAddress: TREASURY, algorandWallet: ALGO_TREASURY, solanaWallet: "SoL", stellarWallet: "GST", upstreamBuyerAddress: EVM_BUYER, avmUpstreamBuyerAddress: AVM_BUYER };
  const unset = { ...rails, upstreamBuyerAddress: "", avmUpstreamBuyerAddress: "" };
  for (const slug of ROUTER_SLUGS) {
    ok(payToForRoute(slug, BASE, rails) === EVM_BUYER, `${slug} on Base settles to the Base spending wallet when it is set`);
    ok(payToForRoute(slug, ALGO, rails) === AVM_BUYER, `${slug} on Algorand settles to the AVM spending wallet when it is set`);
    ok(payToForRoute(slug, "eip155:137", rails) === TREASURY, `${slug} on another EVM chain settles to the treasury`);
    ok(payToForRoute(slug, BASE, unset) === TREASURY && payToForRoute(slug, ALGO, unset) === ALGO_TREASURY, `${slug} settles to the treasury with the spending wallets unset`);
  }
  ok(payToForRoute("uuid", BASE, rails) === TREASURY && payToForRoute("uuid", ALGO, rails) === ALGO_TREASURY, "a non-router route settles to the treasury on Base and Algorand");
  ok(payToForRoute("uuid", "solana:x", rails) === "SoL" && payToForRoute("uuid", "stellar:pubnet", rails) === "GST", "Solana and Stellar settle to their own receiving wallets");
}

// ---- Part 2: booted, every catalog route ------------------------------------
const [FAC] = await getFreePorts(1);
const fac = createServer((rq, rs) => {
  rq.on("data", () => {});
  rq.on("end", () => {
    const reply = (code, obj) => { rs.writeHead(code, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
    const [pathOnly] = rq.url.split("?");
    if (pathOnly === "/evm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }], extensions: [], signers: {} });
    if (pathOnly === "/avm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: ALGO }], extensions: [], signers: {} });
    return reply(404, {});
  });
});
await new Promise((r) => fac.listen(FAC, "127.0.0.1", r));

const procs = [];
const serverLog = [];
const boot = async (extraEnv) => {
  const [port] = await getFreePorts(1);
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "", NODE_ENV: "test",
      WALLET_ADDRESS: TREASURY, NETWORK: "base",
      PAYMENT_NETWORKS: "base,algorand", ALGORAND_WALLET_ADDRESS: ALGO_TREASURY,
      SOLANA_WALLET_ADDRESS: "", STELLAR_WALLET_ADDRESS: "",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC}/evm`, ALGORAND_FACILITATOR_URL: `http://127.0.0.1:${FAC}/avm`,
      AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`,
      MPP_SECRET_KEY: "", PAYMENT_SETTLE_FALLBACK: "", AVM_SUBCENT_GATE: "off", CIRCLE_FACILITATOR_API_KEY: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", SOLANA_LEADERBOARD: "off",
      STATS_ALLOW_EPHEMERAL: "true", UNPAID_QUOTE_BUDGET_PER_HOUR: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(`[${port}] ${l.slice(0, 400)}`); if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${B}/health`)).ok) return { B, proc }; } catch { /* booting */ } await sleep(250); }
  return { B: null, proc };
};
const done = (code) => {
  for (const p of procs) p.kill("SIGKILL");
  fac.close();
  if (code) for (const l of serverLog.slice(-30)) console.error("  server:", l);
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(code);
};

// Every catalog route's unpaid 402, checked against the manifest.
async function sweep(B, label) {
  const manifest = await (await fetch(`${B}/.well-known/x402`)).json();
  const x402 = manifest?.payment?.x402 || {};
  const byRoute = x402.payToByRoute || {};
  const declared = (url, network) => byRoute[url]?.[network]
    ?? (String(network).startsWith("eip155:") ? x402.payTo : x402.payToByNetwork?.[String(network).split(":")[0]]);
  const origin = new URL(manifest.homepage).origin;
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  ok(endpoints.length >= 400, `${label}: /api/pricing lists the catalog (${endpoints.length} routes)`);
  let cursor = 0, checked = 0, accepts = 0, algoAccepts = 0;
  const mismatches = [];
  const seen = new Map(); // url -> { network: payTo } as the 402s named it
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < endpoints.length) {
      const e = endpoints[cursor++];
      const method = String(e.method || "GET").toUpperCase();
      let r;
      try {
        r = await fetch(`${B}${e.path}`, { method, headers: { "content-type": "application/json" }, body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined, signal: AbortSignal.timeout(20_000) });
      } catch (err) { mismatches.push(`${method} ${e.path}: request failed ${err?.message || err}`); continue; }
      const header = r.headers.get("payment-required");
      await r.arrayBuffer();
      if (r.status !== 402 || !header) continue;
      const pr = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      const url = `${origin}${e.path}`;
      checked++;
      for (const a of pr.accepts || []) {
        accepts++;
        if (String(a.network).startsWith("algorand:")) algoAccepts++;
        const want = declared(url, a.network);
        if (a.payTo !== want) mismatches.push(`${method} ${e.path} ${a.scheme} ${a.network}: 402 payTo ${a.payTo}, manifest declares ${want}`);
        if (!seen.has(url)) seen.set(url, {});
        seen.get(url)[a.network] = a.payTo;
      }
    }
  }));
  ok(checked >= 400, `${label}: ${checked} routes answered an unpaid 402 (${accepts} accepts, ${algoAccepts} on Algorand)`);
  ok(algoAccepts > 0, `${label}: the Algorand rail is in the offer, so its payee is checked too`);
  ok(mismatches.length === 0, `${label}: every accept's payTo equals the manifest's declared payee for its route and network${mismatches.length ? `\n    ${mismatches.slice(0, 12).join("\n    ")}` : ""}`);
  return { manifest, x402, byRoute, seen, origin, endpoints };
}

try {
  // Spending-wallet addresses set: the router tiers name them, the manifest says so.
  const on = await boot({ X402_UPSTREAM_BUYER_ADDRESS: EVM_BUYER, ALGORAND_UPSTREAM_BUYER_ADDRESS: AVM_BUYER });
  if (!on.B) { ok(false, "paid server booted (spending wallets set)"); done(1); }
  const s1 = await sweep(on.B, "wallets set");
  const routerPaths = s1.endpoints.filter((e) => ROUTER_SLUGS.has(e.slug)).map((e) => e.path);
  const routerUrls = routerPaths.map((p) => `${s1.origin}${p}`);
  ok(routerUrls.length === ROUTER_SLUGS.size, `every router tier is in the catalog (${routerUrls.length})`);
  for (const url of routerUrls) {
    const named = s1.seen.get(url) || {};
    ok(named[BASE] === EVM_BUYER, `${url} 402 names the Base spending wallet on Base`);
    ok(s1.byRoute[url]?.[BASE] === EVM_BUYER, `${url} manifest payToByRoute names the Base spending wallet on Base`);
    if (named[ALGO]) ok(named[ALGO] === AVM_BUYER && s1.byRoute[url]?.[ALGO] === AVM_BUYER, `${url} names the AVM spending wallet on Algorand, in the 402 and the manifest`);
    else ok(!(ALGO in (s1.byRoute[url] || {})), `${url} offers no Algorand accept, so the manifest lists no Algorand payee for it`);
  }
  const extra = Object.keys(s1.byRoute).filter((u) => !routerUrls.includes(u));
  ok(extra.length === 0, `payToByRoute lists the router tiers only${extra.length ? ` (also: ${extra.join(", ")})` : ""}`);
  ok(typeof s1.x402.payToNote === "string" && /spending wallet/.test(s1.x402.payToNote), "the manifest explains payToByRoute in payToNote");
  ok(s1.x402.payTo === TREASURY, "the manifest's default payTo stays the treasury");
  on.proc.kill("SIGKILL");

  // Unset (a self-host): every route settles to the treasury, no override published.
  const off = await boot({ X402_UPSTREAM_BUYER_ADDRESS: "", ALGORAND_UPSTREAM_BUYER_ADDRESS: "" });
  if (!off.B) { ok(false, "paid server booted (spending wallets unset)"); done(1); }
  const s2 = await sweep(off.B, "wallets unset");
  ok(!("payToByRoute" in s2.x402) && !("payToNote" in s2.x402), "with the spending wallets unset the manifest publishes no payToByRoute or payToNote");
  for (const p of routerPaths) {
    const named = s2.seen.get(`${s2.origin}${p}`) || {};
    ok(named[BASE] === TREASURY && (!named[ALGO] || named[ALGO] === ALGO_TREASURY), `${p} 402 names the treasury on Base and Algorand with the spending wallets unset`);
  }
} catch (e) {
  ok(false, e?.stack || String(e));
}
done(failed ? 1 : 0);
