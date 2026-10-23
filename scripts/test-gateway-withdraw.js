#!/usr/bin/env node
// scripts/gateway-withdraw.js, driven offline against a stub Gateway and a
// stub RPC (nothing reaches a network; no key leaves the process):
//   - --amount without --from refuses before any read and names every domain
//     it would have spent from;
//   - the burn intent's maxBlockHeight is the source chain's current block
//     plus the documented window (or --expiry-blocks), never max uint256, in
//     the plan the dry run prints and in the intent --execute signs;
//   - an unreadable block number refuses the run (no unbounded intent);
//   - the dry run is the default and prints no key;
//   - a whole-balance withdrawal leaves room for the fee (value plus maxFee
//     within the balance), an --amount past that is refused, and the
//     --max-fee default is 1% of the default withdraw alert.
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { maxUint256, parseUnits } from "viem";
import { runWithdraw, DEFAULT_EXPIRY_BLOCKS, MAX_EXPIRY_BLOCKS, DEFAULT_MAX_FEE_USD } from "./gateway-withdraw.js";
import { GATEWAY_API_BASE, DEFAULT_WITHDRAW_ALERT_USD } from "../src/gateway-nanopayments.js";

let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n${e?.stack || e}`); process.exitCode = 1; }
};

const KEY = generatePrivateKey();
const SELLER = privateKeyToAccount(KEY).address;
const RPC_BASE = "https://rpc-base.example.invalid/";
const RPC_ARC = "https://rpc-arc.example.invalid/";
const HEAD = { [RPC_BASE]: 0x1234567n, [RPC_ARC]: 0x89abcn };
const env = { GATEWAY_SELLER_KEY: KEY, EVM_RPC_8453: RPC_BASE, EVM_RPC_5042: RPC_ARC };

function stub({ rpcDown = false } = {}) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body });
    if (u === `${GATEWAY_API_BASE}/v1/balances`) return json(200, { token: "USDC", balances: body.sources.map((s) => ({ domain: s.domain, depositor: s.depositor, balance: "12.5" })) });
    if (u === RPC_BASE || u === RPC_ARC) {
      if (rpcDown) return json(503, { error: "down" });
      return json(200, { jsonrpc: "2.0", id: 1, result: `0x${HEAD[u].toString(16)}` });
    }
    if (u === `${GATEWAY_API_BASE}/v1/transfer`) return json(500, { message: "stub: nothing is minted in a test" });
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetchImpl };
}
const run = async (argv, { rpcDown = false, envOver = {} } = {}) => {
  const s = stub({ rpcDown });
  const out = [], err = [];
  const code = await runWithdraw({ argv, env: { ...env, ...envOver }, fetchImpl: s.fetchImpl, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: s.calls };
};

await check("--amount without --from refuses, names the domains it would spend from, and reads nothing", async () => {
  const r = await run(["--amount", "5"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--amount needs --from/);
  assert.match(r.err, /arc \(Gateway domain 26\)/);
  assert.match(r.err, /base \(Gateway domain 6\)/);
  assert.equal(r.calls.length, 0, "no balance or RPC read before the refusal");
  // Control: the same amount with a source is planned.
  const ok = await run(["--amount", "5", "--from", "base"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /plan: 5 USDC from the eip155:8453 domain/);
});

await check("the dry run is the default: the plan carries a bounded expiry (source block + window) and the output never prints the key", async () => {
  const r = await run([]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dry run: pass --execute/);
  const want8453 = HEAD[RPC_BASE] + DEFAULT_EXPIRY_BLOCKS, want5042 = HEAD[RPC_ARC] + DEFAULT_EXPIRY_BLOCKS;
  assert.match(r.out, new RegExp(`eip155:8453 block ${want8453}, ${DEFAULT_EXPIRY_BLOCKS} blocks past ${HEAD[RPC_BASE]}`));
  assert.match(r.out, new RegExp(`eip155:5042 block ${want5042}, `), "each source reads its own chain");
  assert.ok(!r.out.includes(maxUint256.toString()) && !r.err.includes(maxUint256.toString()), "no max uint256 expiry");
  const lower = (r.out + r.err).toLowerCase();
  assert.ok(!lower.includes(KEY.toLowerCase()) && !lower.includes(KEY.slice(2).toLowerCase()), "the key is never printed");
  assert.ok(!r.calls.some((c) => c.url.endsWith("/v1/transfer")), "a dry run submits nothing");
  assert.ok(r.calls.some((c) => c.url === RPC_BASE && c.body?.method === "eth_blockNumber"), "the block came from the chain's RPC (src/evm-rpcs.js)");
  assert.equal(SELLER.length, 42);
});

await check("--execute signs an intent whose maxBlockHeight is the source block plus --expiry-blocks (stub Gateway refuses; nothing minted)", async () => {
  const r = await run(["--from", "base", "--execute", "--expiry-blocks", "500"]);
  assert.equal(r.code, 1, "the stub refuses the transfer");
  const sent = r.calls.find((c) => c.url === `${GATEWAY_API_BASE}/v1/transfer`);
  assert.ok(sent, "the signed intent was submitted to the stub");
  const intent = sent.body[0].burnIntent;
  assert.equal(BigInt(intent.maxBlockHeight), HEAD[RPC_BASE] + 500n);
  assert.match(sent.body[0].signature, /^0x[0-9a-f]{130}$/);
  assert.ok(!JSON.stringify(sent.body).toLowerCase().includes(KEY.slice(2).toLowerCase()), "the key is not in the request");
});

await check("an unreadable block refuses the run; an out-of-range window refuses before any read", async () => {
  const r = await run(["--from", "base", "--execute"], { rpcDown: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /never signed without an expiry/);
  assert.ok(!r.calls.some((c) => c.url.endsWith("/v1/transfer")), "nothing signed or submitted");
  for (const bad of ["0", "99", String(MAX_EXPIRY_BLOCKS + 1n), "abc", "-5"]) {
    const x = await run(["--from", "base", "--expiry-blocks", bad]);
    assert.equal(x.code, 2, bad);
    assert.equal(x.calls.length, 0, bad);
  }
});

await check("a whole-balance withdrawal leaves room for Gateway's fee: value = available - max fee, value + maxFee never above the balance; an --amount past that is refused; the default max fee is 1% of the default alert", async () => {
  assert.equal(DEFAULT_MAX_FEE_USD, DEFAULT_WITHDRAW_ALERT_USD / 100, "the stated rule");
  const r = await run(["--from", "base", "--execute"]);
  assert.equal(r.code, 1, "the stub refuses the transfer");
  const intent = r.calls.find((c) => c.url === `${GATEWAY_API_BASE}/v1/transfer`).body[0].burnIntent;
  const balance = parseUnits("12.5", 6);
  assert.equal(BigInt(intent.maxFee), parseUnits(String(DEFAULT_MAX_FEE_USD), 6), "the default ceiling");
  assert.equal(BigInt(intent.spec.value), balance - BigInt(intent.maxFee), "the whole balance less the fee ceiling");
  assert.ok(BigInt(intent.spec.value) + BigInt(intent.maxFee) <= balance, "value plus fee fits the balance");
  const custom = await run(["--from", "base", "--max-fee", "1"]);
  assert.equal(custom.code, 0, custom.err);
  assert.match(custom.out, /plan: 11\.5 USDC from the eip155:8453 domain/);
  const over = await run(["--from", "base", "--amount", "12.4"]);
  assert.equal(over.code, 2);
  assert.match(over.err, /leaves no room for the fee: at most 12\.25/);
  assert.ok(!over.calls.some((c) => c.url.endsWith("/v1/transfer") || c.url === RPC_BASE), "refused before any block read or signature");
  const fits = await run(["--from", "base", "--amount", "12.25"]);
  assert.equal(fits.code, 0, fits.err);
  const tiny = await run(["--from", "base", "--max-fee", "12.5"]);
  assert.equal(tiny.code, 0);
  assert.match(tiny.out, /does not cover --max-fee/);
  assert.match(tiny.out, /nothing to withdraw/);
});

console.log(process.exitCode ? `FAILED (${pass} passed)` : `${pass} passed`);
