#!/usr/bin/env node
// The paying scripts' guards (scripts/lib/buyer-guard.js), offline.
//
// 1. smoke-buy prices what it signs from the known-assets table and the field
//    the signer signs for the payload version: a seller's decimals hint, a v1
//    challenge, an accept whose two amount fields differ, another chain, or a
//    signed value that is not the checked one never leaves the process. Proven
//    end to end against a stub seller on a loopback port, with a throwaway key.
// 2. The scripts that buy from our own service refuse any other target unless
//    ALLOW_EXTERNAL_PAID_TARGET=1 is set, before reading a key or a network.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { isOwnPaidTarget, assertOwnPaidTarget, signedAtomicOf, checkAccept, guardCappedSigning, capFromEnv, signedEvmValueOf } from "./lib/buyer-guard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "a402-buyer-guard-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const payTo = "0x000000000000000000000000000000000000dEaD";
const v2 = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo, amount: "1000", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over });

// ---- units ----
ok(isOwnPaidTarget("https://agent402.tools") && isOwnPaidTarget("https://agent402.tools/api/x"), "our https origin is ours");
ok(isOwnPaidTarget("http://127.0.0.1:4011") && isOwnPaidTarget("http://localhost:3000") && isOwnPaidTarget("http://[::1]:9"), "loopback is ours");
ok(!isOwnPaidTarget("http://agent402.tools"), "plain http to our host is not");
ok(!isOwnPaidTarget("https://agent402.tools.evil.example") && !isOwnPaidTarget("https://evilagent402.tools"), "a lookalike host is not");
ok(!isOwnPaidTarget("https://u:p@agent402.tools") && !isOwnPaidTarget("not a url") && !isOwnPaidTarget(""), "credentials, junk and empty are not");
let threw = null;
try { assertOwnPaidTarget("https://seller.example", "t", { env: {}, throwOnRefuse: true }); } catch (e) { threw = e.message; }
ok(/not our service/.test(threw || ""), "an outside target is refused without the flag");
ok(assertOwnPaidTarget("https://seller.example", "t", { env: { ALLOW_EXTERNAL_PAID_TARGET: "1" }, throwOnRefuse: true }) === "https://seller.example", "the explicit flag allows it");

ok(signedAtomicOf(2, v2()) === 1000n, "v2 reads amount");
ok(signedAtomicOf(1, { maxAmountRequired: "1000" }) === 1000n, "v1 reads maxAmountRequired");
ok(signedAtomicOf(2, { maxAmountRequired: "1000" }) === "unreadable amount", "v2 never falls back to maxAmountRequired");
ok(signedAtomicOf(1, { amount: "1000" }) === "unreadable amount", "v1 never falls back to amount");
ok(signedAtomicOf(1, { amount: "1000", maxAmountRequired: "1000000000000" }) === "amount and maxAmountRequired differ", "two different amount fields are refused");
ok(signedAtomicOf(3, v2()) === "unreadable amount", "an unknown version prices nothing");

const opts = { maxUsd: 0.05, networks: ["eip155:8453"] };
ok(checkAccept(2, v2(), opts).ok, "a $0.001 Base USDC accept passes");
ok(!checkAccept(2, v2({ amount: "1000000000000", extra: { name: "USD Coin", version: "2", decimals: 18 } }), opts).ok, "a seller decimals hint does not shrink the price");
ok(checkAccept(2, v2({ amount: "50000" }), opts).ok && !checkAccept(2, v2({ amount: "50001" }), opts).ok, "the cap is exact in base units");
ok(!checkAccept(2, v2({ asset: "0x0000000000000000000000000000000000000001" }), opts).ok, "an asset not in the table is refused");
ok(!checkAccept(2, v2({ network: "eip155:137", asset: USDC_POLYGON }), opts).ok, "a network not registered is refused");
ok(!checkAccept(2, v2({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), opts).ok, "a non-EIP-3009 transfer method is refused");

// The post-signing check: a scheme that signs more than the checked accept.
async function payloadWith(signValue) {
  const client = new x402Client();
  if (typeof client.setSpendControls === "function") client.setSpendControls(false);
  client.register("eip155:8453", { scheme: "exact", async createPaymentPayload(version, r) {
    return { x402Version: version, payload: { authorization: { value: signValue ?? r.amount }, signature: "0x" } };
  } });
  guardCappedSigning(client, { ...opts, log: () => {} });
  try { await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://x/y" }, accepts: [v2()] }); return "sent"; }
  catch (e) { return e.message; }
}
ok(await payloadWith(null) === "sent", "a payload signing the checked amount is sent");
ok(/refused before sending/.test(await payloadWith("1000000000000")), "a payload signing more than the checked amount is refused before sending");
ok(/refused before sending/.test(await payloadWith("999")), "a payload signing a different amount is refused before sending");

// The installed guard, end to end through the client: the scheme default, the
// recheck of the selected accept before the signer runs, and the payload
// version after it.
async function guarded({ accepts, guardOpts = opts, schemes = ["exact"], payloadVersion = null }) {
  const client = new x402Client();
  if (typeof client.setSpendControls === "function") client.setSpendControls(false);
  let signerRuns = 0;
  for (const scheme of schemes) {
    client.register("eip155:8453", { scheme, async createPaymentPayload(version, r) {
      signerRuns++;
      return { x402Version: payloadVersion ?? version, payload: { authorization: { value: r.amount }, signature: "0x" } };
    } });
  }
  guardCappedSigning(client, { ...guardOpts, log: () => {} });
  try { await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://x/y" }, accepts }); return { result: "sent", signerRuns }; }
  catch (e) { return { result: e.message, signerRuns }; }
}
ok(!checkAccept(2, v2({ scheme: "upto", extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), opts).ok, "with no schemes option only exact is allowed");
let g = await guarded({ accepts: [v2({ scheme: "upto", extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } })], schemes: ["upto"] });
ok(g.result !== "sent" && g.signerRuns === 0, `the installed guard signs only exact by default (${g.result})`);
g = await guarded({ accepts: [v2({ scheme: "upto", extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } })], schemes: ["upto"], guardOpts: { ...opts, schemes: ["upto"] } });
ok(g.result === "sent" && g.signerRuns === 1, `control: an upto accept is signed when the caller allows upto (${g.result})`);
let reads = 0;
g = await guarded({ accepts: [v2()], guardOpts: { maxUsd: () => (++reads === 1 ? 0.05 : 0.0001), networks: ["eip155:8453"] } });
ok(/selected accept refused/.test(g.result) && g.signerRuns === 0, `the selected accept is checked again before the signer runs (${g.result}; signer runs ${g.signerRuns})`);
g = await guarded({ accepts: [v2()], payloadVersion: 1 });
ok(/payload version differs from the challenge/.test(g.result) && g.signerRuns === 1, `a payload whose version is not the challenge's is refused before sending (${g.result})`);
g = await guarded({ accepts: [v2()] });
ok(g.result === "sent" && g.signerRuns === 1, "control: the same accept and version is sent");

// ---- the options the own-service buyers use ----
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sol = (over = {}) => ({ scheme: "exact", network: SOL, asset: SOL_USDC, payTo: "x", amount: "1000", maxTimeoutSeconds: 60, extra: { feePayer: "y" }, ...over });
ok(checkAccept(2, sol(), { maxUsd: 0.01, networks: [SOL] }).ok && !checkAccept(2, sol({ amount: "10001" }), { maxUsd: 0.01, networks: [SOL] }).ok, "a Solana USDC accept is priced from the table and capped");
ok(!checkAccept(2, sol({ extra: { assetTransferMethod: "eip3009" } }), { maxUsd: 0.01, networks: [SOL] }).ok, "a transfer method named on a non-EVM accept is refused");
ok(!checkAccept(2, v2({ scheme: "upto" }), opts).ok && checkAccept(2, v2({ scheme: "upto" }), { ...opts, schemes: ["upto"] }).ok, "upto is refused unless the caller allows it");
ok(!checkAccept(2, v2({ scheme: "upto", extra: { assetTransferMethod: "eip3009" } }), { ...opts, schemes: ["upto"] }).ok && checkAccept(2, v2({ scheme: "upto", extra: { assetTransferMethod: "permit2" } }), { ...opts, schemes: ["upto"] }).ok, "an upto accept signs only through Permit2");
// A chain and asset the shared table does not list (every live rail is in it).
const INK = "eip155:999001", INK_USDC = "0x00000000000000000000000000000000000A5E71";
ok(!checkAccept(2, v2({ network: INK, asset: INK_USDC }), { maxUsd: 0.05, networks: [INK] }).ok && checkAccept(2, v2({ network: INK, asset: INK_USDC.toLowerCase() }), { maxUsd: 0.05, networks: [INK], extraAssets: { [INK]: [{ asset: INK_USDC, decimals: 6 }] } }).ok, "an asset the caller names in code prices; a seller cannot add one");
let legCap = 0.0005;
ok(!checkAccept(2, v2(), { maxUsd: () => legCap, networks: ["eip155:8453"] }).ok && ((legCap = 0.002), checkAccept(2, v2(), { maxUsd: () => legCap, networks: ["eip155:8453"] }).ok), "a per-purchase cap is read at each check");
ok(!checkAccept(2, v2(), { maxUsd: () => 0, networks: ["eip155:8453"] }).ok, "a zero cap refuses everything");
ok(signedEvmValueOf({ payload: { permit2Authorization: { permitted: { amount: "77" } } } }) === "77" && signedEvmValueOf({ payload: { authorization: { value: "5" } } }) === "5" && signedEvmValueOf({ payload: { transaction: "AA" } }) === null, "the signed EVM value is read from EIP-3009 or Permit2, nothing else");
ok(capFromEnv("X", 0.5, { env: {} }) === 0.5 && capFromEnv("X", 0.5, { env: { X: "0.2" } }) === 0.2, "an env cap falls back to its default");
let capErr = null;
try { capFromEnv("X", 0.5, { env: { X: "abc" }, throwOnRefuse: true }); } catch (e) { capErr = e.message; }
ok(/must be a positive number/.test(capErr || ""), "a cap typo refuses instead of paying uncapped");
async function nonEvmSigned(signedAmount) {
  const client = new x402Client();
  if (typeof client.setSpendControls === "function") client.setSpendControls(false);
  client.register(SOL, { scheme: "exact", async createPaymentPayload(version) { return { x402Version: version, payload: { transaction: "AA" } }; } });
  guardCappedSigning(client, { maxUsd: 0.01, networks: [SOL], log: () => {} });
  try { await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://x/y" }, accepts: [sol({ amount: signedAmount })] }); return "sent"; }
  catch (e) { return e.message; }
}
ok(await nonEvmSigned("1000") === "sent", "a Solana payload under the cap is sent (its amount has no plaintext field)");
ok(/filtered out|refused/.test(await nonEvmSigned("20000")), "a Solana accept over the cap is never signed");

// ---- smoke-buy end to end against a stub seller ----
function runSmoke(challenge) {
  return new Promise((resolve) => {
    let signed = null;
    const srv = http.createServer((req, res) => {
      const ph = req.headers["payment-signature"] || req.headers["x-payment"];
      if (ph) {
        try { signed = JSON.parse(Buffer.from(ph, "base64").toString()).payload?.authorization?.value ?? "?"; } catch { signed = "?"; }
        res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: "EXPECTED" }));
      }
      const headers = { "content-type": "application/json" };
      if (challenge.x402Version === 2) headers["payment-required"] = Buffer.from(JSON.stringify(challenge)).toString("base64");
      res.writeHead(402, headers); res.end(JSON.stringify(challenge));
    });
    srv.listen(0, "127.0.0.1", () => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_TARGET: `http://127.0.0.1:${srv.address().port}`, SMOKE_ROUTE: "/paid", SMOKE_EXPECT: "EXPECTED", BURNER_KEY: generatePrivateKey(), SMOKE_MAX_USD: "0.05" };
      const ch = spawn(process.execPath, ["--import", join(ROOT, "scripts/lib/loopback-only-preload.js"), join(ROOT, "scripts/smoke-buy.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
      ch.on("exit", (code) => { srv.close(); resolve({ code, signed, out }); });
    });
  });
}
const pr2 = (accepts) => ({ x402Version: 2, resource: { url: "http://x/y" }, accepts });
const tail = (r) => r.out.split("\n").filter((l) => /refus|SMOKE|status|rror/.test(l)).slice(-3).join(" | ");

// ---- x402scan-seed pays an outside registry through the same guard ----
// The real exact signer with a throwaway key: what it would sign, or why not.
{
  const { seedPaymentClient } = await import("./x402scan-seed.js");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const signer = privateKeyToAccount(generatePrivateKey());
  const seedPay = async (challenges, { maxUsd = 0.5 } = {}) => {
    const { client, spentUsd } = seedPaymentClient(signer, { maxUsd, log: () => {} });
    const out = [];
    for (const ch of challenges) {
      try { out.push(signedEvmValueOf(await client.createPaymentPayload(ch))); } catch (e) { out.push(`refused: ${e.message}`); }
    }
    return { out, spent: spentUsd() };
  };
  let s = await seedPay([pr2([v2()])]);
  ok(s.out[0] === "1000" && s.spent === 0.001, `control: a $0.001 Base USDC page is signed for exactly 1000 and counted (${s.out[0]}, ${s.spent})`);
  s = await seedPay([pr2([v2({ asset: "0x0000000000000000000000000000000000000001" })])]);
  ok(/^refused/.test(s.out[0]) && s.spent === 0, "seed: an asset the table does not know is never signed");
  s = await seedPay([pr2([v2({ amount: undefined, maxAmountRequired: "1000" })])]);
  ok(/^refused/.test(s.out[0]) && s.spent === 0, "seed: a version 2 accept naming only maxAmountRequired is never signed");
  s = await seedPay([pr2([v2({ maxAmountRequired: "1000000000000" })])]);
  ok(/^refused/.test(s.out[0]) && s.spent === 0, "seed: an accept whose two amount fields differ is never signed");
  s = await seedPay([pr2([v2({ amount: "20000" })]), pr2([v2({ amount: "20001" })])]);
  ok(s.out[0] === "20000" && /^refused/.test(s.out[1]) && s.spent === 0.02, "seed: the per-page cap is exact in base units");
  s = await seedPay([pr2([v2()]), pr2([v2()])], { maxUsd: 0.0015 });
  ok(s.out[0] === "1000" && /^refused/.test(s.out[1]) && s.spent === 0.001, "seed: a page is capped by what is left of --max-usd");
  s = await seedPay([{ x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: USDC_BASE, payTo, maxAmountRequired: "1000", resource: "http://x/y", description: "", mimeType: "application/json", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] }]);
  ok(/^refused/.test(s.out[0]) && s.spent === 0, "seed: a version 1 challenge outside the registered network is never signed");
  const orig = ExactEvmScheme.prototype.createPaymentPayload;
  try {
    ExactEvmScheme.prototype.createPaymentPayload = function (v, r, ctx) { return orig.call(this, v, { ...r, amount: "1000000" }, ctx); };
    s = await seedPay([pr2([v2()])]);
    ok(/refused: signed payment refused before sending/.test(s.out[0]) && s.spent === 0, `seed: a payload signing another amount is refused before sending and not counted (${s.out[0]})`);
  } finally { ExactEvmScheme.prototype.createPaymentPayload = orig; }
  let maxErr = null;
  try { seedPaymentClient(signer, { maxUsd: Number("abc") }); } catch (e) { maxErr = e.message; }
  ok(/must be a positive number/.test(maxErr || ""), "seed: a --max-usd typo refuses instead of paying unbounded");
}

let r = await runSmoke(pr2([v2()]));
ok(r.code === 0 && r.signed === "1000", `control: a $0.001 Base accept is signed for exactly 1000 (${r.code}, ${r.signed}; ${tail(r)})`);
r = await runSmoke(pr2([v2({ amount: "1000000000000", extra: { name: "USD Coin", version: "2", decimals: 18 } })]));
ok(r.code !== 0 && r.signed === null, `a huge amount with a decimals-18 hint is never signed (${r.code}, ${r.signed}; ${tail(r)})`);
r = await runSmoke({ x402Version: 1, error: "pay", accepts: [{ scheme: "exact", network: "base", asset: USDC_BASE, payTo, amount: "1000", maxAmountRequired: "1000000000000", resource: "http://x/y", description: "", mimeType: "application/json", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] });
ok(r.code !== 0 && r.signed === null, `a v1 challenge is never signed (${r.code}, ${r.signed}; ${tail(r)})`);
r = await runSmoke(pr2([v2({ maxAmountRequired: "1000000000000" })]));
ok(r.code !== 0 && r.signed === null, `a v2 accept whose two amount fields differ is never signed (${r.code}, ${r.signed}; ${tail(r)})`);
r = await runSmoke(pr2([v2({ network: "eip155:137", asset: USDC_POLYGON })]));
ok(r.code !== 0 && r.signed === null, `an accept on a chain the check does not register is never signed (${r.code}, ${r.signed}; ${tail(r)})`);

// ---- own-target guard on the scripts that buy from our service ----
const SCRIPTS = ["capture-bestsellers.js", "base-list-sweep.js", "challenge-sweep.js", "cross-chain-matrix.js", "catalog-buy.js", "payai-listing-pass.js", "drain-burner.js", "sweep-burner.js",
  "paid-canary.js", "agent-e2e.js", "mint-bazaar-rows.js", "mpp-probe.js", "tempo-volume.js", "mpp-new-agent-e2e.js", "tempo-canary-verify.js",
  "algorand-rail-canary.js", "decide-paid-e2e.mjs", "evm-settle-test.js", "rh-settle-test.js", "solana-sor-live.js", "tempo-sor-live.js",
  "tempo-subscription-canary.js", "test-client-paid-live.js", "test-treasury-paid-live.js", "smoke-buy.js"];
// The demos check the target only when they hold a key to pay with.
const WITH_KEY = ["demo-payment.js", "demo-company-onepager.js", "demo-market-monitor.js"];
function runScript(file, extraEnv) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TARGET_URL: "https://seller.example", KEY_FILE: join(TMP, "missing-key"), FUND_WAIT_MINUTES: "0", ...extraEnv };
    const ch = spawn(process.execPath, ["--import", join(ROOT, "scripts/lib/loopback-only-preload.js"), join(ROOT, "scripts", file)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => ch.kill("SIGKILL"), 30_000);
    ch.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
for (const f of [...SCRIPTS, ...WITH_KEY]) {
  const keyEnv = WITH_KEY.includes(f) ? { AGENT_KEY: generatePrivateKey() } : {};
  const res = await runScript(f, keyEnv);
  ok(res.code === 2 && /refusing to pay "https:\/\/seller\.example": not our service/.test(res.out), `${f} refuses an outside TARGET_URL (${res.code}; ${res.out.trim().split("\n").slice(-1)[0]})`);
  const allowed = await runScript(f, { ...keyEnv, ALLOW_EXTERNAL_PAID_TARGET: "1" });
  ok(!/refusing to pay/.test(allowed.out), `${f} passes the target guard with the explicit flag`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
