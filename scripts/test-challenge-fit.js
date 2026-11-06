#!/usr/bin/env node
// Every 402 fits a Node client's 16 KB response-header limit with the gated
// Ink rail enabled, offline.
//
// scripts/test-challenge-size.js is the live judge: it reads production and
// projects this tree onto it. This suite is its offline half, for the change
// that makes room for a rail. It boots THIS tree in paid mode with Ink
// graduated through the rails test seam (NODE_ENV=test RAILS_TEST_GRADUATE=ink,
// INK_FACILITATOR_URL set, `ink` in PAYMENT_NETWORKS), the MPP shim on and
// every EVM rail a local stub can stand in for, and measures each 402's whole
// header block. A local boot cannot hold every production rail or the edge's
// own headers, so the verdict is a projection by difference:
//
//   projected = PROD_WITH_INK[route] - (LOCAL_AT_MEASURE[route] - local now)
//
// PROD_WITH_INK is production's 402 projected with Ink added, as
// test-challenge-size measured it on 2026-11-05 (tree 440256cc, the ten
// routes over 16,200 total header bytes then, worst first); LOCAL_AT_MEASURE
// is this suite's own local figure for the same route on that tree. A route
// that grows here grows the projection, a trim shrinks it. Refresh both
// tables together when production's rail set changes.
//
// It also pins the trims themselves:
//   - a 402's Access-Control-Expose-Headers names exactly the listed headers
//     the 402 carries (PAYMENT-REQUIRED and WWW-Authenticate always, and
//     X-Async-Recommended on a slow route), so no header a browser buyer
//     reads on a 402 is dropped, and every other status keeps the full list;
//   - the MPP evm challenge binds the advertised accept without outputSchema,
//     while PAYMENT-REQUIRED's accepts[0].outputSchema and the bazaar
//     extension are untouched.
//   node scripts/test-challenge-fit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { CORS_EXPOSE_HEADERS } from "../src/cors.js";
import { splitChallenges, evmChainOf, mergeEvmChallenges } from "./lib/mpp-challenge-merge.js";
import { Challenge, PaymentRequest } from "mppx";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The ceiling test-challenge-size enforces, and the headroom a rail change
// must leave under it on the worst route.
const MAX_TOTAL_HEADER_BYTES = 16_200;
const MIN_HEADROOM = 300;
const PROD_WITH_INK = {
  "v1-chat": 16_408, "fred-release-observations": 16_282, "nft-metadata": 16_235, "farcaster-by-address": 16_225,
  "sanctions-wallet": 16_211, "extract": 16_210,
};
const LOCAL_AT_MEASURE = {
  "v1-chat": 8_716, "fred-release-observations": 9_011, "nft-metadata": 9_004, "farcaster-by-address": 8_978,
  "sanctions-wallet": 8_944, "extract": 8_965,
};
const PROD_HOST = "agent402.tools";
const INK = "eip155:57073";
const EVM_KINDS = ["eip155:8453", "eip155:137", "eip155:42161", "eip155:143", "eip155:42220", "eip155:43114", "eip155:1329", "eip155:10", INK, "eip155:4663"];
const GATEWAY_BODY = JSON.stringify({ model: "openai/gpt-5", max_tokens: 300, messages: [{ role: "user", content: "Reply with the single word: settled" }] });

let failed = 0, passed = 0;
const check = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

// --- the projection helper test-challenge-size uses (pure) -------------------
{
  const mk = (realm, method, chainId, extra = {}) => Challenge.serialize(Challenge.from({ realm, method, intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "1000", currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipient: "0x000000000000000000000000000000000000dEaD", methodDetails: { chainId, ...extra } }, meta: { x402: "x".repeat(chainId === 8453 ? 600 : 50) }, secretKey: "k" }));
  const prodBase = mk(PROD_HOST, "evm", 8453), prodCelo = mk(PROD_HOST, "evm", 42220), prodTempo = mk(PROD_HOST, "tempo", 4217, { note: "a, Payment b" });
  const localBase = Challenge.serialize(Challenge.from({ realm: "127.0.0.1:1", method: "evm", intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "1000", currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipient: "0x000000000000000000000000000000000000dEaD", methodDetails: { chainId: 8453 } }, meta: { x402: "short" }, secretKey: "k" }));
  const prodHeader = [prodBase, prodTempo, prodCelo].join(", ");
  check(splitChallenges(prodHeader).length === 3 && evmChainOf(prodTempo) === null && evmChainOf(prodCelo) === 42220, "the challenge splitter reads each challenge and its evm chain");
  const merged = splitChallenges(mergeEvmChallenges(prodHeader, localBase));
  check(merged.length === 3 && merged[1] === prodTempo && merged[2] === prodCelo && merged[0] === localBase.replace('realm="127.0.0.1:1"', `realm="${PROD_HOST}"`), "the projection swaps in this tree's evm challenge per chain and keeps production's others");
  check(mergeEvmChallenges("", localBase) === "", "no MPP challenge on production projects none");
}

const [PORT, FAC] = await getFreePorts(2);
const fac = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(req.url === "/supported" || req.url === "/rpc" ? 200 : 404, { "content-type": "application/json" });
    if (req.url === "/supported") return res.end(JSON.stringify({ kinds: EVM_KINDS.map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }));
    if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
    res.end("{}");
  });
});
await new Promise((r) => fac.listen(FAC, "127.0.0.1", r));
const F = `http://127.0.0.1:${FAC}`;
const env = { ...process.env };
for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "TARGET_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY", "NETWORK_PRICE_FLOORS", "NETWORK_PRICE_PREMIUMS", "MPP_CHALLENGE_NETWORKS", "ACCEPT_OUTPUT_SCHEMA", "X402_UPTO_NETWORKS", "TEMPO_API_KEY", "CIRCLE_FACILITATOR_API_KEY"]) delete env[k];
const proc = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
  ...env, ...ownStoreEnv("challenge-fit"), PORT: String(PORT), FREE_MODE: "", NODE_ENV: "test", RAILS_TEST_GRADUATE: "ink",
  WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
  PAYMENT_NETWORKS: "base,polygon,arbitrum,monad,celo,avalanche,sei,optimism,ink,robinhood",
  FACILITATOR_URL: F, PAYAI_FACILITATOR_URL: F, INK_FACILITATOR_URL: F, CELO_FACILITATOR_URL: F, MONAD_FACILITATOR_URL: F, ROBINHOOD_FACILITATOR_URL: F, AGENT402_BASE_RPC: `${F}/rpc`,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "challenge-fit-local-secret", FACILITATOR_GAS_CHECK: "off",
  STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
  // Key-gated routes mount with placeholders (only the unpaid 402 is read).
  X_BEARER_TOKEN: "challenge-fit-placeholder", NEYNAR_API_KEY: "challenge-fit-placeholder", EXA_API_KEY: "challenge-fit-placeholder", TYPESAFE_API_KEY: "challenge-fit-placeholder", RUGCHECK_TOOLS: "on", OPENROUTER_TTS_ENABLED: "true",
} });
let log = ""; proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
const stop = () => { try { proc.kill("SIGKILL"); } catch {} try { fac.close(); } catch {} };
process.on("exit", stop);
const B = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = `127.0.0.1:${PORT}`;

// A raised header limit: an oversized 402 is what this suite measures.
const read = (path, { method = "GET", body } = {}) => new Promise((resolve, reject) => {
  const q = request(`${B}${path}`, { method, headers: { "content-type": "application/json" }, maxHeaderSize: 262144, timeout: 20000 }, (r) => { r.resume(); r.on("end", () => resolve(r)); });
  q.on("timeout", () => q.destroy(new Error("timeout")));
  q.on("error", reject);
  if (body !== undefined) q.write(body);
  q.end();
});
// Header bytes as test-challenge-size counts them, with the local host spelled
// as production's (it rides in the resource URL, the icon URL and the realm).
function headerBytes(r) {
  let n = 20;
  for (let i = 0; i < r.rawHeaders.length; i += 2) {
    const k = r.rawHeaders[i];
    let v = r.rawHeaders[i + 1];
    if (/^payment-required$/i.test(k)) {
      try { v = Buffer.from(Buffer.from(v, "base64").toString("utf8").split(LOCAL_HOST).join(PROD_HOST), "utf8").toString("base64"); } catch { /* measured as sent */ }
    } else v = v.split(LOCAL_HOST).join(PROD_HOST);
    n += k.length + v.length + 4;
  }
  return n;
}
const exposeOf = (r) => String(r.headers["access-control-expose-headers"] || "").split(",").map((s) => s.trim()).filter(Boolean);

try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
  check(up, "paid-mode server booted with Ink graduated and MPP on");
  if (!up) { console.log(log.slice(-1500)); process.exit(1); }
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  check(endpoints.length >= 400, `the catalog lists ${endpoints.length} endpoints`);

  const rows = new Map();
  let exposeWrong = [], exposeLacksPayment = [], withAsync = 0, asyncExposed = 0, inkMissing = [], sampled = null;
  const queue = [...endpoints];
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift();
      const method = e.method || "GET";
      let r;
      try { r = await read(e.path, { method, body: method === "POST" ? (/^\/v1\//.test(e.path) ? GATEWAY_BODY : "{}") : undefined }); } catch { continue; }
      if (r.statusCode !== 402 || !r.headers["payment-required"]) continue;
      rows.set(e.slug, headerBytes(r));
      const listed = exposeOf(r);
      const present = CORS_EXPOSE_HEADERS.filter((h) => r.headers[h.toLowerCase()] !== undefined);
      if (listed.join(",") !== present.join(",")) exposeWrong.push(`${e.slug}: [${listed.join(",")}] vs present [${present.join(",")}]`);
      if (!listed.includes("PAYMENT-REQUIRED") || (r.headers["www-authenticate"] !== undefined && !listed.includes("WWW-Authenticate"))) exposeLacksPayment.push(e.slug);
      if (r.headers["x-async-recommended"] !== undefined) { withAsync++; if (listed.includes("X-Async-Recommended")) asyncExposed++; }
      const pr = JSON.parse(Buffer.from(r.headers["payment-required"], "base64").toString("utf8"));
      if (!(pr.accepts || []).some((a) => a.network === INK) && !e.identityBound) inkMissing.push(e.slug);
      if (e.slug === "v1-chat") sampled = { pr, www: String(r.headers["www-authenticate"] || "") };
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  check(rows.size >= 400, `${rows.size} routes answered a 402 with PAYMENT-REQUIRED`);
  check(inkMissing.length < rows.size * 0.1, `Ink is in the offer (missing on ${inkMissing.length} of ${rows.size}${inkMissing.length ? `: ${inkMissing.slice(0, 3).join(", ")}` : ""})`);

  // --- the expose list on a 402 ---------------------------------------------
  check(exposeWrong.length === 0, `every 402's expose list names exactly the listed headers it carries${exposeWrong.length ? ` (${exposeWrong.length} wrong: ${exposeWrong.slice(0, 2).join("; ")})` : ""}`);
  check(exposeLacksPayment.length === 0, `every 402 exposes PAYMENT-REQUIRED and its WWW-Authenticate${exposeLacksPayment.length ? ` (not on ${exposeLacksPayment.slice(0, 3).join(", ")})` : ""}`);
  check(withAsync > 0 && asyncExposed === withAsync, `a slow route's 402 exposes X-Async-Recommended (${asyncExposed} of ${withAsync})`);
  const ok200 = await read("/api/pricing");
  check(ok200.statusCode === 200 && exposeOf(ok200).join(",") === CORS_EXPOSE_HEADERS.join(","), "a 200 keeps the full expose list");

  // --- the MPP evm challenge and PAYMENT-REQUIRED -----------------------------
  check(!!sampled, "v1-chat answered a 402");
  if (sampled) {
    const first = sampled.pr.accepts?.[0];
    check(first?.network === "eip155:8453" && first.outputSchema && typeof first.outputSchema === "object", "PAYMENT-REQUIRED keeps accepts[0].outputSchema");
    check(!!sampled.pr.extensions?.bazaar?.info && !!sampled.pr.extensions?.bazaar?.schema, "PAYMENT-REQUIRED keeps the bazaar extension");
    const base = splitChallenges(sampled.www).find((c) => evmChainOf(c) === 8453);
    check(!!base, "the 402 carries a Base evm challenge");
    if (base) {
      const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": base }));
      const meta = Challenge.meta?.(ch) ?? (ch?.opaque ? PaymentRequest.deserialize(ch.opaque) : undefined);
      const bound = meta?.x402 ? JSON.parse(meta.x402) : null;
      const { outputSchema: _s, ...rest } = first || {};
      check(bound && JSON.stringify(bound) === JSON.stringify(rest), "the evm challenge binds the advertised accept without outputSchema, every other field byte-exact");
    }
  }

  // --- the verdict ----------------------------------------------------------
  const ceiling = MAX_TOTAL_HEADER_BYTES - MIN_HEADROOM;
  const projected = Object.entries(PROD_WITH_INK).map(([slug, prod]) => {
    const now = rows.get(slug);
    return { slug, prod, now, at: LOCAL_AT_MEASURE[slug], projected: now == null ? null : prod - (LOCAL_AT_MEASURE[slug] - now) };
  });
  for (const p of projected) console.log(`   ${p.slug.padEnd(28)} prod+ink ${p.prod}  local ${p.at} -> ${p.now}  projected ${p.projected}  headroom ${p.projected == null ? "?" : MAX_TOTAL_HEADER_BYTES - p.projected}`);
  const missing = projected.filter((p) => p.now == null);
  check(missing.length === 0, `every measured worst route answered locally${missing.length ? ` (not ${missing.map((p) => p.slug).join(", ")})` : ""}`);
  const over = projected.filter((p) => p.projected != null && p.projected > ceiling);
  check(over.length === 0, `with Ink, every worst route projects at or under ${ceiling} total header bytes (${MIN_HEADROOM} under ${MAX_TOTAL_HEADER_BYTES})${over.length ? `: ${over.map((p) => `${p.slug} ${p.projected}`).join(", ")}` : ""}`);
  const worstLocal = [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`   largest local 402s: ${worstLocal.map(([s, n]) => `${s} ${n}`).join(", ")}`);
} finally {
  stop();
}
console.log(`${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
