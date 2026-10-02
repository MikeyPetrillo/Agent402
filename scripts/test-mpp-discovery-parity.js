// The MPP offer every discovery surface publishes is the offer the 402 makes.
//
// Boots the real server with the evm shim, native Tempo (two currencies) and
// two EVM rails switched on, then for EVERY paid operation in /openapi.json
// reads the unpaid 402 and requires its WWW-Authenticate: Payment challenges
// to match the operation's x-payment-info.offers entry for entry: same
// method, same currency, same chain, same order, same amount on a fixed-price
// route. /.well-known/x402 must carry the same method order and /llms.txt the
// same sentence (all three read src/mpp-offers.js). A second boot with MPP
// switched off must publish no MPP offer anywhere.
//
// Why: /openapi.json once advertised tempo on routes whose 402 withheld it,
// and listed evm first after the 402 had moved tempo to the front, with one
// currency per method while the 402 offered two. A buyer (or an index) that
// reads the document and then meets a different 402 learns not to trust it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Challenge } from "mppx";
import { getFreePorts } from "./lib/free-port.js";
import { mppMethodsProse } from "../src/mpp-offers.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";

const facilitator = createServer((req, res) => {
  if (req.url === "/supported") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "exact", network: "eip155:42220" },
    ], extensions: [], signers: {} }));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const MPP_ENV = {
  MPP_SECRET_KEY: "test-mpp-secret",
  TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: "usdc,pathusd",
  PAYMENT_NETWORKS: "base,celo", CELO_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CELO_FACILITATOR_KEY: "test-celo-key",
  MPP_CHALLENGE_NETWORKS: "",
};
const baseEnv = {
  ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
  STRIPE_SECRET_KEY: "", STRIPE_PROFILE_ID: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
  UNPAID_QUOTE_BUDGET_PER_HOUR: "off", POSTHOG_API_KEY: "",
};

async function boot(extra) {
  const proc = spawn("node", ["src/server.js"], { env: { ...baseEnv, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return proc; } catch {}
    if (proc.exitCode !== null) break;
    await sleep(500);
  }
  proc.kill("SIGKILL");
  throw new Error(`server never became healthy: ${err}`);
}

const pathOf = (p) => p.replace(/\{[^}]+\}/g, "x");
const offerKey = (o) => `${o.method}:${String(o.currency).toLowerCase()}:${o.chainId ?? ""}`;
const challengeKey = (c) => `${c.method}:${String(c.request?.currency).toLowerCase()}:${c.request?.methodDetails?.chainId ?? ""}`;

// ---- 1. MPP on: every paid operation's 402 == its x-payment-info.offers
let proc = await boot(MPP_ENV);
try {
  // The helper runs in THIS process too, so give it the same env.
  Object.assign(process.env, MPP_ENV, { WALLET_ADDRESS: TREASURY, NETWORK: "base", STRIPE_SECRET_KEY: "", STRIPE_PROFILE_ID: "" });
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  const ops = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(item)) if (op?.["x-payment-info"]) ops.push({ method: method.toUpperCase(), path, info: op["x-payment-info"] });
  }
  ok(ops.length >= 400, `openapi lists the paid catalog (${ops.length} paid operations)`);
  const mismatches = [];
  let tempoRoutes = 0, withheld = 0, checked = 0;
  // Bounded concurrency: hundreds of unpaid 402s, nothing runs a handler.
  const queue = [...ops];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const { method, path, info } = queue.shift();
      const url = `${B}${pathOf(path)}`;
      const r = await fetch(url, method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status !== 402) { mismatches.push(`${method} ${path}: unpaid request answered ${r.status}, not 402`); continue; }
      const www = r.headers.get("www-authenticate") || "";
      const ch = www ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })) : [];
      const want = (info.offers || []).map(offerKey);
      const got = ch.map(challengeKey);
      checked++;
      if (want.join(",") !== got.join(",")) { mismatches.push(`${method} ${path}: document [${want.join(" | ")}] vs 402 [${got.join(" | ")}]`); continue; }
      if (info.price?.mode === "fixed") {
        for (let i = 0; i < ch.length; i++) {
          if (String(ch[i].request?.amount) !== String(info.offers[i].amount)) mismatches.push(`${method} ${path}: ${info.offers[i].method} amount ${info.offers[i].amount} vs 402 ${ch[i].request?.amount}`);
        }
      }
      const protoMethods = (info.protocols || []).filter((p) => p.mpp).map((p) => p.mpp.method);
      const offerMethods = [...new Set((info.offers || []).map((o) => o.method))];
      if (protoMethods.join(",") !== offerMethods.join(",")) mismatches.push(`${method} ${path}: protocols [${protoMethods}] vs offers [${offerMethods}]`);
      if (got.some((k) => k.startsWith("tempo:"))) tempoRoutes++; else withheld++;
    }
  }));
  ok(checked === ops.length && mismatches.length === 0, `every paid operation's 402 challenges equal its x-payment-info offers (method, currency, chain, order, amount)${mismatches.length ? ` - ${mismatches.length} differ: ${mismatches.slice(0, 5).join("; ")}` : ""}`);
  ok(tempoRoutes > 0 && withheld > 0, `tempo offered where the 402 offers it (${tempoRoutes} routes) and withheld where it is withheld (${withheld} routes), in both surfaces`);

  const hash = ops.find((o) => o.path === "/api/hash");
  ok(hash && hash.info.offers.map((o) => o.method).join(",") === "tempo,tempo,evm,evm", `a plain route lists tempo (two currencies) then evm (two chains) (got ${hash?.info.offers.map((o) => o.method)})`);
  const memory = ops.find((o) => o.path === "/api/memory");
  ok(memory && !memory.info.offers.some((o) => o.method === "tempo"), "an identity-bound route publishes no tempo offer");

  const wk = await (await fetch(`${B}/.well-known/x402`)).json();
  ok(JSON.stringify(wk.mpp?.order) === JSON.stringify(["tempo", "evm"]), `/.well-known/x402 mpp.order is the 402's order (got ${JSON.stringify(wk.mpp?.order)})`);
  ok(wk.mpp?.tempo?.currencies?.map((c) => c.label).join(",") === "USDC.e,PathUSD" && wk.mpp?.evm?.rails?.map((r) => r.chain).join(",") === "Base,Celo", "/.well-known/x402 names the same currencies and chains");
  const llms = await (await fetch(`${B}/llms.txt`)).text();
  const prose = mppMethodsProse();
  ok(prose && llms.includes(prose), "/llms.txt carries the same method sentence the helper derives");
} finally {
  proc.kill("SIGKILL");
}

// ---- 2. MPP off: no MPP offer published anywhere
proc = await boot({ MPP_SECRET_KEY: "", TEMPO_API_KEY: "", PAYMENT_NETWORKS: "base" });
try {
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  let mppOffers = 0;
  for (const item of Object.values(openapi.paths)) for (const op of Object.values(item)) {
    const info = op?.["x-payment-info"];
    if (info) mppOffers += (info.offers || []).length + (info.protocols || []).filter((p) => p.mpp).length;
  }
  ok(mppOffers === 0, `with MPP switched off, /openapi.json publishes no MPP offer (found ${mppOffers})`);
  const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(r.status === 402 && !r.headers.get("www-authenticate"), "and the 402 carries no Payment challenge");
  const wk = await (await fetch(`${B}/.well-known/x402`)).json();
  ok(wk.mpp?.enabled === false, "/.well-known/x402 says MPP is off");
} finally {
  proc.kill("SIGKILL");
  facilitator.close();
}
console.log(`\n${pass} passed`);
process.exit(0);
