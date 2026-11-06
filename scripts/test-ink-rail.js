#!/usr/bin/env node
// Ink (eip155:57073, native Circle USDC) as a gated x402 exact rail settled
// through the operator's ordered INK_FACILITATOR_URL list. Paid-mode boots
// against stub facilitators on 127.0.0.1 (port 0 style free ports), offline:
//  1. Gated by default: Ink is in GATED_RAILS, not RAILS, so every rail list
//     and count derived from RAILS is unchanged, and a default boot's public
//     surfaces (/llms.txt, /.well-known/x402, /api/pricing, /openapi.json,
//     /pricing, /how-to-pay, /api/rails) never name it.
//  2. `ink` in PAYMENT_NETWORKS without INK_FACILITATOR_URL: Ink is not
//     offered and the paywall still answers 402 for Base (the 2026-07-02
//     shape: a network no facilitator settles must never break every 402).
//  3. Enabled: the 402 offers eip155:57073 with the USDC asset at its price
//     (the list, raised to a NETWORK_PRICE_FLOORS floor), extra name "USDC"
//     version "2". A routing facilitator registered earlier that also lists
//     Ink never takes an Ink payment. The first listed Ink facilitator
//     settles; a graceful 200 refusal in words with no verdict goes to the
//     next listed one; a buyer verdict in words is a 402 with no retry.
//  4. The first listed Ink facilitator down at boot: the second settles
//     first, and the public-index disclosure (FACILITATOR_PUBLIC_INDEX_CHAINS
//     =ink) names the facilitator the boot chose.
//  5. The gas runway check keeps each listed-facilitator rail's readings:
//     Ink's check does not erase Robinhood's.
//   node scripts/test-ink-rail.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const INK = "eip155:57073", BASE_NET = "eip155:8453";
const INK_USDC = "0x2D270e6886d130D724215A266106e6832161EAEd";
const SIGNATURE = 'Signature does not authorize this transfer for 0x0000000000000000000000000000000000000e01 (EIP-712 domain "USDC" v2 on chain 57073)';
const NO_VERDICT = "Relay temporarily unavailable, try again";
const PATH = "/api/demand-radar?limit=1";
const json = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const stub = (h) => createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch {} h(req, res, body); }); });
const payerOf = (b) => b?.paymentPayload?.payload?.authorization?.from;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (cond, msg) => { if (cond) console.log(`ok - ${msg}`); else { failed++; console.log(`FAIL - ${msg}`); } };

// --- 1a. offline: the rail tables --------------------------------------------
{
  const rails = await import("../src/rails.js");
  const { NETWORKS } = await import("../src/payments.js");
  check(NETWORKS.ink === INK, "payments.js knows the ink network as eip155:57073");
  check(rails.GATED_RAILS.some((r) => r.caip2 === INK && r.name === "Ink" && r.asset === "USDC" && r.chainId === 57073), "Ink is a gated rail");
  check(!rails.RAILS.some((r) => r.caip2 === INK || /ink/i.test(r.name)), "Ink is not in RAILS, so no static copy names it");
  const statics = [rails.RAILS_AMP, rails.RAILS_OR, rails.RAILS_PAREN, rails.RAILS_SHORT, rails.RAILS_COUNT, rails.RAILS_OS, rails.RAILS_TICKER, rails.RAILS_NOTE, rails.RAIL_CHAIN_NAMES.join(",")];
  check(statics.every((t) => !/\bInk\b|INK|57073/.test(t)), "no RAILS-derived string names Ink");
  check(rails.RAILS_COUNT === `USDC or USDG on ${rails.countWord(rails.RAILS.length)} chains` && rails.liveRails() === rails.RAILS, `the rail count is RAILS' own (${rails.RAILS_COUNT}) and liveRails() is RAILS while Ink is not offered`);
  check(rails.resolveRailCountTokens("{{railCount}}|{{gatedRailBullets}}") === `${rails.countWord(rails.RAILS.length)}|`, "served rail tokens count RAILS only and list no gated bullet");
}

/** A facilitator stub: /supported up or 503, /verify valid, /settle by mode. */
function facilitator(name, st, kindsFor) {
  st[name] = { up: true, mode: "ok", settles: 0, verifies: 0 };
  return stub((q, r, b) => {
    const s = st[name];
    if (q.url === "/supported") return s.up ? json(r, 200, { kinds: kindsFor().map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }) : json(r, 503, { error: "down" });
    if (q.url === "/verify") { s.verifies++; return json(r, 200, { isValid: true, payer: payerOf(b) }); }
    if (q.url === "/settle") {
      s.settles++;
      const net = b?.paymentRequirements?.network;
      if (s.mode === "prose") return json(r, 200, { success: false, transaction: "", payer: "", network: net, errorReason: NO_VERDICT });
      if (s.mode === "signature") return json(r, 200, { success: false, transaction: "", payer: "", network: net, errorReason: SIGNATURE });
      return json(r, 200, { success: true, transaction: "0x" + (name === "ink1" ? "1a" : name === "ink2" ? "2b" : "3c").repeat(32), network: net, payer: payerOf(b) });
    }
    if (q.url === "/rpc") return json(r, 200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return json(r, 404, {});
  });
}

async function boot({ inkUrls = (p) => `http://127.0.0.1:${p.INK1},http://127.0.0.1:${p.INK2}`, setup = () => {}, extraEnv = {}, networks = "base,ink" } = {}) {
  const [PORT, BASE_FAC, INK1, INK2] = await getFreePorts(4);
  const st = {};
  // The generic facilitator (PayAI's client, pointed here so no request
  // leaves 127.0.0.1, registered first) also lists Ink: it must never take
  // an Ink payment.
  const servers = [
    [facilitator("base", st, () => [BASE_NET, INK]), BASE_FAC],
    [facilitator("ink1", st, () => [INK, BASE_NET]), INK1],
    [facilitator("ink2", st, () => [INK]), INK2],
  ];
  setup(st);
  await Promise.all(servers.map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  const urls = inkUrls({ INK1, INK2 });
  const env = { ...process.env }; delete env.STATE_DATABASE_URL; delete env.REDIS_URL; delete env.SOLVADOR_KEY; delete env.ROBINHOOD_RELAYER_KEY; delete env.INK_FACILITATOR_URL; delete env.NETWORK_PRICE_FLOORS; delete env.FACILITATOR_PUBLIC_INDEX_CHAINS;
  const proc = spawn(process.execPath, ["src/server.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...ownStoreEnv("ink-rail"), PORT: String(PORT), FREE_MODE: "", NODE_ENV: "test",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, PAYAI_FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "", PAYMENT_NETWORKS: networks,
    ...(urls ? { INK_FACILITATOR_URL: urls } : {}), ROBINHOOD_FALLBACK_RECHECK_MS: "60000", ...extraEnv,
    PAYMENT_SETTLE_FALLBACK: "true", FACILITATOR_GAS_CHECK: "off", STATS_ALLOW_EPHEMERAL: "true",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
  const log = []; proc.stdout.on("data", (c) => log.push(String(c))); proc.stderr.on("data", (c) => log.push(String(c)));
  const B = `http://127.0.0.1:${PORT}`;
  let up = false; for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
  let required = null;
  if (up) {
    const r402 = await fetch(`${B}${PATH}`);
    const h = r402.headers.get("payment-required");
    required = { status: r402.status, offer: h ? JSON.parse(Buffer.from(h, "base64").toString()) : null };
  }
  const accepted = required?.offer?.accepts?.find((a) => a.network === INK) || null;
  let n = 0;
  const pay = async () => {
    const cred = Buffer.from(JSON.stringify({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from: `0x${(0xe00 + ++n).toString(16).padStart(40, "0")}`, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x5700 + n + Math.floor(Math.random() * 1e6)).toString(16).padStart(64, "0") } } })).toString("base64");
    const r = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred } }); await r.text();
    return r.status;
  };
  const get = async (path) => { const r = await fetch(`${B}${path}`); return { status: r.status, text: await r.text() }; };
  const stop = () => { proc.kill("SIGKILL"); for (const [s] of servers) s.close(); };
  return { up, required, accepted, pay, st, log, stop, get, INK2 };
}

// Every public surface a buyer or an indexer reads, as text.
const SURFACES = ["/llms.txt", "/llms-full.txt", "/.well-known/x402", "/api/pricing", "/openapi.json", "/pricing", "/how-to-pay", "/api/rails", "/privacy", "/terms", "/"];

// --- 1b/2. gated by default, and listed without a URL -------------------------
for (const [label, opts] of [["default boot (no ink listed)", { networks: "base", inkUrls: () => "" }], ["ink listed, INK_FACILITATOR_URL unset", { inkUrls: () => "" }]]) {
  const b = await boot(opts);
  const before = failed;
  try {
    check(b.up, `${label}: the paid-mode server booted`);
    check(b.required?.status === 402 && b.required.offer?.accepts?.some((a) => a.network === BASE_NET), `${label}: the paywall answers 402 with the Base accept (status ${b.required?.status})`);
    check(!b.accepted && !b.required?.offer?.accepts?.some((a) => a.network === INK), `${label}: no eip155:57073 accept`);
    if (opts.networks !== "base") check(b.log.join("").includes("INK_FACILITATOR_URL is unset - Ink is not configured"), `${label}: the boot says why Ink is not offered`);
    if (b.up) {
      for (const p of SURFACES) {
        const r = await b.get(p);
        const m = /\bInk\b|eip155:57073|"ink"|\/ink\b/.exec(r.text);
        check(r.status < 500 && !m, `${label}: ${p} does not name Ink (status ${r.status}${m ? `; names it: ${r.text.slice(Math.max(0, m.index - 80), m.index + 40)}` : ""})`);
      }
      const rails = JSON.parse((await b.get("/api/rails")).text);
      check(!JSON.stringify(rails).includes("ink"), `${label}: /api/rails neither configures nor offers ink`);
    }
  } finally { if (failed > before) console.log(b.log.join("").slice(-2500)); b.stop(); }
}

// --- 3. enabled: the offer, routing, and the listed settle order --------------
{
  const FLOOR = 0.005;
  const b = await boot({ extraEnv: { NETWORK_PRICE_FLOORS: `${INK}=${FLOOR}` } });
  const before = failed;
  try {
    check(b.up, "enabled: the paid-mode server booted with two listed Ink facilitators");
    const a = b.accepted;
    check(!!a, `enabled: the 402 offers eip155:57073 (${JSON.stringify((b.required?.offer?.accepts || []).map((x) => x.network))})`);
    if (a) {
      const baseAmount = Number(b.required.offer.accepts.find((x) => x.network === BASE_NET)?.amount);
      check(a.scheme === "exact" && a.asset.toLowerCase() === INK_USDC.toLowerCase(), `enabled: exact on Ink's native USDC (${a.scheme} ${a.asset})`);
      check(a.extra?.name === "USDC" && a.extra?.version === "2", `enabled: EIP-712 domain "USDC" version "2" (${JSON.stringify(a.extra)})`);
      check(Number(a.amount) === Math.max(baseAmount, Math.round(FLOOR * 1e6)), `enabled: amount is the list raised to the configured floor (${a.amount} vs list ${baseAmount})`);
      check(a.payTo === "0x000000000000000000000000000000000000dEaD", "enabled: settles to the treasury payTo");
    }
    check(/Accepting USDC on: [^\n]*\bink\b/.test(b.log.join("")), "enabled: the boot log lists ink in the offer");
    const pricing = JSON.parse((await b.get("/api/pricing")).text);
    check(pricing?.payment?.minPriceUsdByNetwork?.ink === FLOOR, `enabled: /api/pricing publishes the floor the 402 quotes (${JSON.stringify(pricing?.payment?.minPriceUsdByNetwork)})`);
    // Offered, Ink is named only where a runtime surface lists the live offer,
    // and every surface still renders; static copy derived from RAILS does not change.
    for (const p of SURFACES) { const r = await b.get(p); check(r.status < 500, `enabled: ${p} renders (status ${r.status})`); }
    const manifest = JSON.parse((await b.get("/.well-known/x402")).text);
    check(JSON.stringify(manifest).includes("eip155:57073"), "enabled: /.well-known/x402 names Ink while it is offered (runtime surface)");
    check(!/\bInk\b/.test((await b.get("/llms.txt")).text), "enabled: llms.txt (static rail copy) still does not name Ink");
    let status = a ? await b.pay() : 0;
    check(status === 200 && b.st.ink1.settles === 1 && b.st.ink2.settles === 0 && b.st.base.settles === 0 && b.st.base.verifies === 0, `enabled: the first listed facilitator verifies and settles; the generic one that also lists Ink is never asked (status ${status}, ink1 ${b.st.ink1.settles}, ink2 ${b.st.ink2.settles}, generic ${b.st.base.verifies}/${b.st.base.settles})`);
    b.st.ink1.mode = "prose";
    status = a ? await b.pay() : 0;
    check(status === 200 && b.st.ink1.settles === 2 && b.st.ink2.settles === 1 && b.st.base.settles === 0, `enabled: the first answers 200 success:false in words, no verdict -> the next listed settles it (status ${status}, ink1 ${b.st.ink1.settles}, ink2 ${b.st.ink2.settles})`);
    b.st.ink1.mode = "signature";
    status = a ? await b.pay() : 0;
    check(status === 402 && b.st.ink1.settles === 3 && b.st.ink2.settles === 1 && b.st.base.settles === 0, `enabled: a signature verdict in words -> 402, the next never asked (status ${status}, ink1 ${b.st.ink1.settles}, ink2 ${b.st.ink2.settles})`);
    b.st.ink1.mode = "prose"; b.st.ink2.mode = "prose";
    status = a ? await b.pay() : 0;
    check(status === 402 && b.st.ink2.settles === 2 && b.st.base.settles === 0, `enabled: both listed refuse with no verdict -> 402, no other facilitator is asked (status ${status}, generic ${b.st.base.settles})`);
  } finally { if (failed > before) console.log(b.log.join("").slice(-3000)); b.stop(); }
}

// --- 4. first listed down at boot: the second settles, the disclosure names it -
{
  const b = await boot({ inkUrls: (p) => `http://localhost:${p.INK1},http://127.0.0.1:${p.INK2}`, setup: (st) => { st.ink1.up = false; }, extraEnv: { FACILITATOR_PUBLIC_INDEX_CHAINS: "ink" } });
  const before = failed;
  try {
    check(b.up && !!b.accepted, "boot choice: Ink is still offered with the first listed facilitator down");
    check(b.log.join("").includes(`127.0.0.1:${b.INK2} settles first`), "boot choice: the boot log names the facilitator that settles first");
    const para = ((await b.get("/privacy")).text.match(/<li id="public-settlement-index">([\s\S]*?)<\/li>/) || [])[1] || "";
    check(para.startsWith("On Ink, ") && para.includes("(127.0.0.1)") && !para.includes("localhost"), `boot choice: /privacy discloses Ink's public index naming the chosen host (${para.slice(0, 110)})`);
    const idx = JSON.parse((await b.get("/.well-known/x402")).text)?.payment?.dataHandling?.publicSettlementIndex;
    check(JSON.stringify(idx?.chains) === '["ink"]' && JSON.stringify(idx?.hosts) === '["127.0.0.1"]', `boot choice: /.well-known/x402 names it (${JSON.stringify(idx)})`);
    const status = b.accepted ? await b.pay() : 0;
    check(status === 200 && b.st.ink2.settles === 1 && b.st.ink1.settles === 0, `boot choice: a paid call settles through the second, once (status ${status}, ink1 ${b.st.ink1.settles}, ink2 ${b.st.ink2.settles})`);
  } finally { if (failed > before) console.log(b.log.join("").slice(-2500)); b.stop(); }
}

// --- 5. gas runway readings are kept per network ---------------------------------
{
  const [RPC, FAC] = await getFreePorts(2);
  const SIGNER = "0x00000000000000000000000000000000000000a1";
  const rpc = stub((q, r, b) => json(r, 200, { jsonrpc: "2.0", id: b?.id ?? 1, result: b?.method === "eth_getBalance" ? "0xde0b6b3a7640000" : b?.method === "eth_gasPrice" ? "0x3b9aca00" : "0x1" }));
  const fac = stub((q, r) => (q.url === "/supported" ? json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: INK }, { x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: { "eip155:*": [SIGNER] } }) : json(r, 404, {})));
  await Promise.all([[rpc, RPC], [fac, FAC]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
  process.env.EVM_RPC_57073 = `http://127.0.0.1:${RPC}`;
  process.env.EVM_RPC_4663 = `http://127.0.0.1:${RPC}`;
  try {
    const { startFacilitatorGasCheck } = await import("../src/payments.js");
    const { toolFailureMonitor } = await import("../src/tool-failure-monitor.js");
    const url = `http://127.0.0.1:${FAC}`;
    const rh = await startFacilitatorGasCheck({ network: "eip155:4663", urls: [url], schedule: false, readEthUsd: async () => 3000 });
    const ink = await startFacilitatorGasCheck({ network: INK, urls: [url], schedule: false, readEthUsd: async () => 3000 });
    const r1 = await rh(), r2 = await ink();
    check(r1?.some((r) => r.network === "eip155:4663" && r.signer === SIGNER) && r2?.some((r) => r.network === INK && r.signer === SIGNER), "gas: each check reads the listed facilitator's signer on its own network");
    const rows = () => toolFailureMonitor().snapshot().gas || [];
    const nets = new Set(rows().map((r) => r.network));
    check(nets.has("eip155:4663") && nets.has(INK), `gas: after both checks the monitor holds both networks' readings (${[...nets].join(", ")})`);
    const rhRows = rows().filter((r) => r.network === "eip155:4663").length, inkRows = rows().filter((r) => r.network === INK).length;
    await rh();
    check(rows().filter((r) => r.network === "eip155:4663").length === rhRows && rows().filter((r) => r.network === INK).length === inkRows && inkRows > 0, `gas: a later Robinhood check replaces its own rows only (${rhRows} Robinhood, ${inkRows} Ink)`);
  } finally { rpc.close(); fac.close(); delete process.env.EVM_RPC_57073; delete process.env.EVM_RPC_4663; }
}

console.log(`test-ink-rail: ${failed ? `FAILED (${failed})` : "all passed"}`);
process.exit(failed ? 1 : 0);
