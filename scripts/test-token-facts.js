// The token-facts probe (src/tools/token-facts.js), offline: a fake chain
// RPC, Sourcify and DexScreener answer every read, and each field is pinned
// both ways: computed when its source answers, null with its reason when it
// does not. Nothing here reaches the network.
//
//   node scripts/test-token-facts.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { encodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import {
  readTokenFacts, readSourcify, probeDexPairs, simulateTrade, rpcBatch, holderIndex, taxPct, decodeText, abiFlags, minimalProxyTarget,
  tokenRpcLanes, TOKEN_CHAINS, SLOTS, SIM_BUYER, MAX_RPC_REQUESTS, HOLDER_LOG_CAP, HOLDER_LOG_MAX_BYTES,
  RPC_MAX_BYTES, SOURCIFY_MAX_BYTES, DEX_MAX_BYTES,
} from "../src/tools/token-facts.js";
import { isNonCommercialRpc } from "../src/rpc-terms.js";

// A URL whose host is `domain` or a subdomain of it (never a substring match).
const hostIs = (url, domain) => { try { const h = new URL(url).hostname; return h === domain || h.endsWith(`.${domain}`); } catch { return false; } };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const TOKEN = "0x1000000000000000000000000000000000000001";
const POOL = "0x2000000000000000000000000000000000000002";
const OWNER = "0x3000000000000000000000000000000000000003";
const IMPL = "0x4000000000000000000000000000000000000004";
const ADMIN = "0x5000000000000000000000000000000000000005";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ABI = parseAbi([
  "function name()", "function symbol()", "function decimals()", "function totalSupply()", "function owner()", "function getOwner()",
  "function pendingOwner()", "function balanceOf(address)", "function transfer(address,uint256)", "function implementation()", "function getReserves()",
]);
const u = (v) => encodeAbiParameters([{ type: "uint256" }], [BigInt(v)]);
const addr = (a) => encodeAbiParameters([{ type: "address" }], [a]);
const str = (s) => encodeAbiParameters([{ type: "string" }], [s]);
const topicOf = (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const E18 = 10n ** 18n;

// ---- the fake chain --------------------------------------------------------------
// A scenario: the token's calls, its storage slots, the pool's balance and the
// tax/revert rules the simulated transfers follow.
function scenario(over = {}) {
  return {
    code: "0x6080604052", name: str("Test Token"), symbol: str("TST"), decimals: u(18), totalSupply: u(1_000_000n * E18),
    owner: addr(OWNER), getOwner: null, pendingOwner: null, slots: {},
    balances: { [POOL]: 100_000n * E18, [OWNER]: 250_000n * E18 },
    pool: { reserves: true, lpSupply: 1000n * E18, lpBurned: { [ZERO]: 1000n, [DEAD]: 400n * E18 } },
    buyTaxBps: 500n, sellTaxBps: 1000n, buyReverts: false, sellRevertsAbove: null, sellRevertsAll: false,
    simulateError: null, beaconImpl: null, logs: [], logsError: null, ...over,
  };
}
function fakeChain(sc, seen) {
  const callAnswer = (to, data, balances) => {
    to = to.toLowerCase();
    let d;
    try { d = decodeFunctionData({ abi: ABI, data }); } catch { return { error: { code: 3, message: "execution reverted" } }; }
    const fn = d.functionName;
    if (to === TOKEN) {
      if (fn === "balanceOf") return { result: u(balances[d.args[0].toLowerCase()] || 0n) };
      const v = sc[fn];
      return v == null ? { error: { code: 3, message: "execution reverted" } } : { result: v };
    }
    if (to === POOL && sc.pool) {
      if (fn === "getReserves") return sc.pool.reserves ? { result: encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], [1n, 2n, 3]) } : { error: { code: 3, message: "execution reverted" } };
      if (fn === "totalSupply") return { result: u(sc.pool.lpSupply) };
      if (fn === "balanceOf") return { result: u(sc.pool.lpBurned[d.args[0].toLowerCase()] || 0n) };
    }
    if (sc.beaconImpl && to === sc.beacon && fn === "implementation") return { result: addr(sc.beaconImpl) };
    return { error: { code: 3, message: "execution reverted" } };
  };
  const simulate = (blocks) => {
    const balances = { ...sc.balances };
    return blocks.map((b) => ({ calls: b.calls.map((c) => {
      const d = decodeFunctionData({ abi: ABI, data: c.data });
      if (d.functionName === "balanceOf") return { status: "0x1", returnData: u(balances[d.args[0].toLowerCase()] || 0n), logs: [] };
      const from = String(c.from).toLowerCase(), to = d.args[0].toLowerCase(), amount = d.args[1];
      const fail = { status: "0x0", returnData: "0x", logs: [], error: { message: "execution reverted" } };
      if ((balances[from] || 0n) < amount) return fail;
      let net = amount;
      if (from === POOL) { if (sc.buyReverts) return fail; net = amount - (amount * sc.buyTaxBps) / 10_000n; }
      if (to === POOL) {
        if (sc.sellRevertsAll) return fail;
        if (sc.sellRevertsAbove != null && amount > sc.sellRevertsAbove(balances[from])) return fail;
        net = amount - (amount * sc.sellTaxBps) / 10_000n;
      }
      balances[from] -= amount;
      balances[to] = (balances[to] || 0n) + net;
      const logs = [{ address: TOKEN, topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)], data: u(net) }];
      if (net < amount) logs.push({ address: TOKEN, topics: [TRANSFER_TOPIC, topicOf(from), topicOf(TOKEN)], data: u(amount - net) });
      return { status: "0x1", returnData: u(1), logs };
    }) }));
  };
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.requests.push({ url, methods: body.map((b) => b.method) });
    if (seen.refuseLane?.includes(url)) return new Response(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "rate limit exceeded" } }))), { status: 200 });
    if (seen.httpFail?.includes(url)) return new Response("busy", { status: 503 });
    const out = body.map((b) => {
      seen.methods.push(b.method);
      const p = b.params;
      let r;
      if (b.method === "eth_getCode") r = { result: p[0].toLowerCase() === TOKEN ? sc.code : (sc.contracts || []).includes(p[0].toLowerCase()) ? "0x60" : "0x" };
      else if (b.method === "eth_call") r = callAnswer(p[0].to, p[0].data, sc.balances);
      else if (b.method === "eth_getStorageAt") r = { result: sc.slots[p[1]] || `0x${"0".repeat(64)}` };
      else if (b.method === "eth_simulateV1") r = sc.simulateError ? { error: sc.simulateError } : { result: simulate(p[0].blockStateCalls) };
      else if (b.method === "eth_getLogs") r = sc.logsError ? { error: sc.logsError } : { result: sc.logs };
      else r = { error: { code: -32601, message: "method not found" } };
      return { jsonrpc: "2.0", id: b.id, ...r };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const dexOf = (pairs) => async () => ({ totalPairs: pairs.length, liquidityUsd: 0, volume24h: 0, txns24h: 0, pairs });
const POOL_PAIR = { dex: "uniswap", labels: ["v2"], pair: POOL, baseAddress: TOKEN, quoteAddress: "0x9000000000000000000000000000000000000009", liquidityUsd: 1e6, volume24h: 0 };
const VERIFIED = (abiNames, sourceText = "pragma solidity ^0.8.0; contract T { function a() public {} }") => async () => ({
  verified: true, match: "exact_match", compiler: "0.8.20", verifiedAt: "2024-01-01T00:00:00Z", sourceText, isProxy: false, proxyImplementations: [],
  abi: abiNames.map((n) => (typeof n === "string" ? { type: "function", name: n, stateMutability: "nonpayable" } : n)),
});

const realFetch = globalThis.fetch;
async function run(sc, deps = {}, { refuseLane, httpFail } = {}) {
  const seen = { requests: [], methods: [], refuseLane, httpFail };
  globalThis.fetch = fakeChain(sc, seen);
  try {
    const f = await readTokenFacts({ chain: "base", address: TOKEN }, { lanes: ["https://rpc.test/a"], holderLane: null, probeDexPairs: dexOf([POOL_PAIR]), readSourcify: VERIFIED(["transfer"]), ...deps });
    return { f, seen };
  } catch (e) { return { e, seen }; } finally { globalThis.fetch = realFetch; }
}
const reason = (f, field) => f.limits.find((l) => l.field === field)?.reason || null;

// ---- 1. a taxed, owned, verified token with a V2 pool ------------------------------
{
  const { f, seen } = await run(scenario(), {
    readSourcify: VERIFIED(["transfer", "mint", "pause", "blacklist", "setFees", "setMaxWallet", "setCooldown", "setWhitelist",
      { type: "function", name: "maxWallet", stateMutability: "view" }], "pragma solidity ^0.8.0; contract T { function k() public { selfdestruct(payable(msg.sender)); } }"),
  });
  ok(!!f, `a readable token answers (${seen.requests.length} requests)`);
  ok(f.tokenName === "Test Token" && f.tokenSymbol === "TST" && f.decimals === 18 && f.totalSupply === "1000000", "name, symbol, decimals and supply come from the ERC-20 calls");
  ok(f.ownerAddress === OWNER.toLowerCase() && f.ownerRenounced === false && f.ownerPct === 25, `owner from owner(), not renounced, owner share of supply (${f.ownerPct})`);
  ok(f.buyTaxPct === 5 && f.sellTaxPct === 10 && f.honeypot === false && f.cannotSellAll === false && f.cannotBuy === false, `buy and sell tax from the simulated trade (${f.buyTaxPct}/${f.sellTaxPct})`);
  ok(f.openSource === true && f.verification.match === "exact_match", "verified on Sourcify");
  ok(f.mintable === true && f.transferPausable === true && f.blacklist === true && f.slippageModifiable === true && f.whitelist === true && f.tradingCooldown === true && f.antiWhale === true && f.antiWhaleModifiable === true, "ABI flags: mint, pause, blacklist, fee setter, whitelist, cooldown, max-wallet");
  ok(f.selfdestruct === true, "selfdestruct read from the verified source");
  ok(f.proxy === false && reason(f, "proxy")?.includes("EIP-1967"), "no proxy slot set: proxy false, and limits says which patterns were checked");
  ok(f.lpLockedPct === 40 && f.lpTotalSupply === 1000 && reason(f, "lpLockedPct")?.includes("burn addresses"), `LP burn share of a V2 pool (${f.lpLockedPct}%), named for what it is`);
  ok(f.abiInfo.privileged.includes("mint") && f.abiInfo.privileged.includes("pause"), "privileged functions listed from the ABI");
  ok(f.hiddenOwner === null && reason(f, "hiddenOwner") && f.ownerChangeBalance === null && reason(f, "ownerChangeBalance") && f.externalCall === null && reason(f, "externalCall"), "facts not derivable are null with a reason");
  ok(f.holderCount === null && reason(f, "holderCount") === "holder index not available for this token", "no keyed log lane: holders null with the stated reason");
  ok(f.sources.some((s) => /eth_simulateV1/.test(s)) && f.sources.some((s) => /Sourcify/.test(s)) && f.sources.some((s) => /DexScreener/.test(s)), "sources name each read that answered");
  ok(!seen.methods.some((m) => /send/i.test(m)), `nothing is ever sent: only reads and simulations (${[...new Set(seen.methods)].join(", ")})`);
  ok(seen.requests.length <= MAX_RPC_REQUESTS, `requests stay inside the budget (${seen.requests.length} <= ${MAX_RPC_REQUESTS})`);
}

// ---- 2. honeypot, cannot sell all, cannot buy, tiny buys ------------------------
{
  const hp = (await run(scenario({ sellRevertsAll: true }))).f;
  ok(hp.honeypot === true && hp.cannotSellAll === true && hp.sellTaxPct === null && /reverted at the full and at half/.test(reason(hp, "sellTaxPct")), "a sell that reverts at full and half is a honeypot; its tax is null with the reason");
  ok(hp.buyTaxPct === 5, "...and the buy tax is still measured");
  const half = (await run(scenario({ sellRevertsAbove: (bal) => bal / 2n }))).f;
  ok(half.honeypot === false && half.cannotSellAll === true && half.sellTaxPct === 10, "a full sell that reverts while half sells: cannot sell all, not a honeypot, tax read from the half");
  const nb = (await run(scenario({ buyReverts: true }))).f;
  ok(nb.cannotBuy === true && nb.honeypot === null && /buy transfer from the pool reverted/.test(reason(nb, "honeypot")) && nb.buyTaxPct === null, "a buy that reverts: cannot buy, honeypot not simulated with the reason");
  const tiny = (await run(scenario({ buyTaxBps: 9_999n }))).f;
  ok(tiny.buyTaxPct === 99.99 && tiny.sellTaxPct === null && /delivered too little to sell/.test(reason(tiny, "sellTaxPct")), "a buy that delivers almost nothing: buy tax measured, sell not read from a few units");
}

// ---- 3. each null path of the simulation -------------------------------------------
{
  const none = (await run(scenario(), { probeDexPairs: dexOf([]) })).f;
  ok(none.honeypot === null && none.buyTaxPct === null && reason(none, "buyTaxPct") === "not simulated: no DEX pool with this token was listed" && reason(none, "lpLockedPct") === "no DEX pool with this token was listed", "no pool listed: taxes, honeypot and LP share are null with the reason");
  const dexDown = (await run(scenario(), { probeDexPairs: async () => { throw Object.assign(new Error("upstream HTTP 503"), { statusCode: 503 }); } })).f;
  ok(dexDown.honeypot === null && reason(dexDown, "honeypot") === "not simulated: the DEX pairs read did not complete" && !dexDown.sources.some((s) => /DexScreener/.test(s)), "the pairs read failing: not simulated, said so, and DexScreener is not listed as a source");
  const v4 = (await run(scenario(), { probeDexPairs: dexOf([{ ...POOL_PAIR, pair: `0x${"ab".repeat(32)}` }]) })).f;
  ok(v4.honeypot === null && /no DEX pool/.test(reason(v4, "honeypot")), "a pool id that is not a contract address (a singleton pool's id) is never simulated against");
  const empty = (await run(scenario({ balances: { [OWNER]: 1n } }))).f;
  ok(empty.honeypot === null && reason(empty, "honeypot") === "not simulated: the listed pool holds none of this token", "a pool holding none of the token: not simulated");
  const noSim = (await run(scenario({ simulateError: { code: -32601, message: "the method eth_simulateV1 does not exist" } }))).f;
  ok(noSim.honeypot === null && /not simulated: the simulation did not complete/.test(reason(noSim, "honeypot")), "a lane without eth_simulateV1: not simulated, with the reason");
  const v3 = (await run(scenario({ pool: { reserves: false, lpSupply: 0n, lpBurned: {} } }))).f;
  ok(v3.lpLockedPct === null && reason(v3, "lpLockedPct") === "the deepest pool is not a V2-style pool with LP tokens" && v3.honeypot === false, "a pool without LP tokens: LP share null with the reason, the trade still simulated");
}

// ---- 4. owner ---------------------------------------------------------------------------
{
  const ren = (await run(scenario({ owner: addr(ZERO) }))).f;
  ok(ren.ownerRenounced === true && ren.ownerPct === 0 && ren.canTakeBackOwnership === false, "owner() zero: renounced, owner share 0, no take-back function");
  const pend = (await run(scenario({ owner: addr(ZERO), pendingOwner: addr(OWNER) }))).f;
  ok(pend.ownerRenounced === false && pend.canTakeBackOwnership === true && pend.pendingOwner === OWNER.toLowerCase(), "owner zero with a pending owner (two-step ownership): not renounced, can be taken back");
  const bep = (await run(scenario({ owner: null, getOwner: addr(OWNER) }))).f;
  ok(bep.ownerAddress === OWNER.toLowerCase(), "getOwner() answers when owner() does not");
  const no = (await run(scenario({ owner: null }))).f;
  ok(no.ownerAddress === null && no.ownerRenounced === null && reason(no, "ownerAddress") === "the contract answers neither owner() nor getOwner()" && reason(no, "ownerPct"), "no owner function: owner null with the reason");
  const unlock = (await run(scenario({ owner: addr(ZERO) }), { readSourcify: VERIFIED(["transfer", "unlock"]) })).f;
  ok(unlock.canTakeBackOwnership === true, "a renounced owner with an unlock() function can take ownership back");
}

// ---- 5. proxy ---------------------------------------------------------------------------
{
  const calls = [];
  const sourcify = async (id, a) => { calls.push(a); return a === IMPL ? { verified: true, match: "match", abi: [{ type: "function", name: "mint", stateMutability: "nonpayable" }], sourceText: "pragma x; contract I {}", proxyImplementations: [] } : { verified: true, match: "match", abi: [{ type: "function", name: "upgradeTo", stateMutability: "nonpayable" }], sourceText: "pragma y; contract P {}", proxyImplementations: [] }; };
  const p = (await run(scenario({ slots: { [SLOTS.eip1967Implementation]: addr(IMPL), [SLOTS.eip1967Admin]: addr(ADMIN) } }), { readSourcify: sourcify })).f;
  ok(p.proxy === true && p.proxyImplementation === IMPL && p.proxyAdmin === ADMIN && !reason(p, "proxy"), "EIP-1967 slots: proxy, implementation and admin");
  ok(calls.includes(IMPL) && p.mintable === true, "the implementation's ABI is read too: a mint on the implementation makes the proxy mintable");
  const zos = (await run(scenario({ slots: { [SLOTS.zosImplementation]: addr(IMPL) } }))).f;
  ok(zos.proxy === true && zos.proxyImplementation === IMPL, "the ZeppelinOS implementation slot reads as a proxy");
  const uups = (await run(scenario({ slots: { [SLOTS.eip1822Proxiable]: addr(IMPL) } }))).f;
  ok(uups.proxy === true, "the EIP-1822 slot reads as a proxy");
  const beacon = "0x6000000000000000000000000000000000000006";
  const b = (await run(scenario({ slots: { [SLOTS.eip1967Beacon]: addr(beacon) }, beacon, beaconImpl: IMPL }))).f;
  ok(b.proxy === true && b.proxyImplementation === IMPL, "a beacon proxy's implementation is read from the beacon");
  const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  ok(minimalProxyTarget(clone) === IMPL && minimalProxyTarget("0x6080") === null, "an EIP-1167 clone's target is read from its code");
  const c = (await run(scenario({ code: clone }))).f;
  ok(c.proxy === true && c.proxyImplementation === IMPL, "an EIP-1167 clone reads as a proxy");
  const byAbi = (await run(scenario(), { readSourcify: VERIFIED(["transfer", "upgradeToAndCall"]) })).f;
  ok(byAbi.proxy === true, "an upgrade function in the ABI reads as upgradeable");
}

// ---- 6. verification ---------------------------------------------------------------------
{
  const unv = (await run(scenario(), { readSourcify: async () => ({ verified: false }) })).f;
  ok(unv.openSource === false && /reads Sourcify only/.test(reason(unv, "openSource")), "not on Sourcify: open source false, and limits says only Sourcify was read");
  ok(unv.mintable === null && reason(unv, "mintable") === "the contract's ABI is not verified on Sourcify" && unv.blacklist === null && unv.transferPausable === null && unv.selfdestruct === null, "no verified ABI: every ABI flag is null with the reason, never false");
  ok(unv.honeypot === false && unv.buyTaxPct === 5, "...and the simulation still runs: it needs no ABI");
  const down = (await run(scenario(), { readSourcify: async () => { throw Object.assign(new Error("Sourcify answered HTTP 503"), { statusCode: 502 }); } })).f;
  ok(down.openSource === null && reason(down, "openSource") === "the Sourcify verification read did not complete" && reason(down, "mintable") === "the Sourcify read did not complete", "Sourcify down: open source null with the reason, never false");
  const seenUrls = [];
  globalThis.fetch = async (url) => { seenUrls.push(url); return url.includes("/404/") ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ match: "exact_match", abi: [], sources: { "a.sol": { content: "pragma solidity 0.8.0;" } }, compilation: { compilerVersion: "0.8.0" }, proxyResolution: { isProxy: true, implementations: [{ address: IMPL }] } }), { status: 200 }); };
  try {
    const r = await readSourcify(8453, TOKEN);
    ok(r.verified && r.sourceText.includes("pragma") && r.isProxy && r.proxyImplementations[0] === IMPL && r.compiler === "0.8.0", "readSourcify reads the match, source, compiler and proxy reading");
    ok(/^https:\/\/sourcify\.dev\/server\/v2\/contract\/8453\//.test(seenUrls[0]), "it reads Sourcify's v2 contract API");
    ok((await readSourcify(404, TOKEN)).verified === false, "a 404 is a clean miss, not an error");
  } finally { globalThis.fetch = realFetch; }
}

// ---- 7. refusals and lanes --------------------------------------------------------------
{
  const eoa = await run(scenario({ code: "0x" }));
  ok(eoa.e?.statusCode === 422 && /no contract code: it is not a token contract/.test(eoa.e.message), "an address with no code is refused 422");
  const nonToken = await run(scenario({ decimals: null }));
  ok(nonToken.e?.statusCode === 422 && /does not answer the ERC-20 decimals and totalSupply calls/.test(nonToken.e.message), "a contract that is not an ERC-20 is refused 422");
  const failover = await run(scenario(), { lanes: ["https://rpc.test/a", "https://rpc.test/b"] }, { refuseLane: ["https://rpc.test/a"] });
  ok(failover.f?.totalSupply === "1000000" && failover.seen.requests.some((r) => r.url === "https://rpc.test/b"), "a lane that answers with a rate limit is passed over for the next");
  const allDown = await run(scenario(), { lanes: ["https://rpc.test/a", "https://rpc.test/b"] }, { httpFail: ["https://rpc.test/a", "https://rpc.test/b"] });
  ok(allDown.e && [502, 503].includes(allDown.e.statusCode) && allDown.e.attribution === "upstream", `every lane failing is the source's 502/503, never the buyer's 422 (${allDown.e?.statusCode})`);
  const badChain = await readTokenFacts({ chain: "avalanche", address: TOKEN }).catch((e) => e);
  ok(badChain.statusCode === 422 && /celo/.test(badChain.message) && /base/.test(badChain.message), "an unsupported chain is a 422 naming the supported ones");
}

// ---- 8. holders from the Transfer history --------------------------------------------------
{
  const A = "0xa00000000000000000000000000000000000000a", Bb = "0xb00000000000000000000000000000000000000b";
  const log = (from, to, v) => ({ address: TOKEN, topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)], data: u(v) });
  const logs = [log(ZERO, A, 600_000n * E18), log(ZERO, Bb, 400_000n * E18), log(A, Bb, 100_000n * E18), log(Bb, DEAD, 50_000n * E18)];
  const h = (await run(scenario({ logs, contracts: [Bb] }), { holderLane: "https://keyed.test/k" })).f;
  ok(h.holderCount === 3 && h.topHolders.length === 3, `holder count and the top holders from the Transfer history (${h.holderCount})`);
  ok(h.topHolders[0].address === A && h.topHolders[0].percent === 50 && h.topHolders[1].address === Bb && h.topHolders[1].percent === 45 && h.topHolders[1].isContract === true && h.topHolders[0].isContract === false, "balances, shares of supply and contract flags are computed");
  ok(h.sources.some((s) => /eth_getLogs/.test(s)) && !reason(h, "holderCount"), "the log read is listed as a source");
  const big = (await run(scenario({ logs: Array.from({ length: HOLDER_LOG_CAP }, () => log(ZERO, A, 1n)) }), { holderLane: "https://keyed.test/k" })).f;
  ok(big.holderCount === null && reason(big, "holderCount") === "holder index not available for this token" && /or more transfers/.test(big.limits.find((l) => l.field === "holderCount").detail), "a history at the cap is not indexed: null with the reason");
  const refused = (await run(scenario({ logsError: { code: -32600, message: "query exceeds max results" } }), { holderLane: "https://keyed.test/k" })).f;
  ok(refused.holderCount === null && reason(refused, "topHolders") === "holder index not available for this token", "a refused history read: null with the reason");
  // A history whose declared size is over the bound is refused before its body is read.
  {
    let read = false;
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": String(HOLDER_LOG_MAX_BYTES + 1) }), body: { cancel: async () => {} }, json: async () => { read = true; return []; } });
    try {
      const st2 = { lanes: ["x"], requests: 0, deadline: Date.now() + 10_000 };
      const r = await holderIndex(st2, { chain: "base", token: TOKEN, supplyBig: 1n, env: {}, lane: "https://keyed.test/k" });
      ok(r.ok === false && /or more transfers/.test(r.why) && read === false && st2.requests === 1, `an oversized history is refused unread, in one request (${JSON.stringify(r)})`);
    } finally { globalThis.fetch = realFetch; }
  }
  const st = { lanes: ["x"], requests: 0, deadline: Date.now() + 10_000 };
  ok((await holderIndex(st, { chain: "base", token: TOKEN, supplyBig: 1n, env: {}, lane: undefined })).ok === false, "with no keyed lane configured, no history read is attempted");
}

// ---- 9. units ---------------------------------------------------------------------------
{
  ok(taxPct(1000n, 950n) === 5 && taxPct(1000n, 1000n) === 0 && taxPct(1000n, 1200n) === 0 && taxPct(0n, 1n) === null && taxPct(10_000_000n, 9_999_999n) === 0, "tax is the share that did not arrive, rounded to two places; under 0.01% reads 0");
  ok(decodeText(str("Hello")) === "Hello" && decodeText(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`) === "MKR" && decodeText("0x") === null, "names read as string() or bytes32");
  const flags = abiFlags(null);
  ok(Object.values(flags).every((v) => v === null), "no ABI: every flag null, never false");
  ok(abiFlags([{ type: "function", name: "maxTxAmount", stateMutability: "view" }]).antiWhale === true && abiFlags([{ type: "function", name: "maxTxAmount", stateMutability: "view" }]).antiWhaleModifiable === false, "a max-transaction view without a setter: limited, not modifiable");
  ok(abiFlags([{ type: "function", name: "mint", stateMutability: "view" }]).mintable === false, "a view function never counts as a privilege");
  for (const c of Object.keys(TOKEN_CHAINS)) {
    const lanes = tokenRpcLanes(c, {});
    ok(lanes.length >= 1 && lanes.every((l) => !isNonCommercialRpc(l)), `${c}: a permitted lane with no key set (${lanes.join(", ")})`);
  }
  ok(hostIs(tokenRpcLanes("base", { ALCHEMY_API_KEY: "k" }).at(-1), "alchemy.com") && hostIs(tokenRpcLanes("base", {})[0], "publicnode.com"), "the public lanes are tried first and the keyed lane last");
  const st = { lanes: ["https://rpc.test/a"], requests: 0, deadline: Date.now() + 10_000 };
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const s0 = await simulateTrade(st, { token: TOKEN, pool: POOL, poolBal: 100n, why: null }).finally(() => { globalThis.fetch = realFetch; });
  ok(s0.ran === false && /did not complete/.test(s0.reasons.honeypot) && st.requests === 1, "a simulation whose lane does not answer is reported as not completed, after one request");
  const late = await simulateTrade({ lanes: ["x"], requests: 0, deadline: Date.now() + 1000 }, { token: TOKEN, pool: POOL, poolBal: 100n });
  ok(late.ran === false && /time budget was spent/.test(late.reasons.honeypot), "with the time budget nearly spent, the simulation is skipped and says so");
  let sent = 0;
  globalThis.fetch = async () => { sent++; return new Response("[]", { status: 200 }); };
  const spent = await rpcBatch({ lanes: ["https://rpc.test/a"], requests: MAX_RPC_REQUESTS, deadline: Date.now() + 10_000 }, [{ method: "eth_blockNumber", params: [] }], "a read").then(() => null, (e) => e).finally(() => { globalThis.fetch = realFetch; });
  ok(spent?.statusCode === 503 && spent.budgetSpent === true && sent === 0, "a call whose request budget is spent sends nothing and says so");
  ok(SIM_BUYER === SIM_BUYER.toLowerCase() && /^0x[0-9a-f]{40}$/.test(SIM_BUYER), "the simulated buyer is a fixed address");
}

// ---- 10. body caps on every read ----------------------------------------------------------
// Each read is steered by the caller's contract, so each body is counted as it
// arrives and refused past its cap, with or without a declared Content-Length.
{
  // A body of `size` bytes served lazily in 64 KB chunks; `pulled` counts what was read.
  const lazy = (size, { declare = false, prefix = "" } = {}) => {
    const state = { pulled: 0 };
    let sent = 0;
    const head = Buffer.from(prefix);
    const stream = new ReadableStream({
      pull(ctrl) {
        if (sent >= size) { ctrl.close(); return; }
        const n = Math.min(65_536, size - sent);
        const chunk = Buffer.alloc(n, 0x20);
        if (sent === 0) head.copy(chunk, 0, 0, Math.min(head.length, n));
        sent += n; state.pulled += n;
        ctrl.enqueue(new Uint8Array(chunk));
      },
    });
    const headers = new Headers({ "content-type": "application/json" });
    if (declare) headers.set("content-length", String(size));
    return { res: new Response(stream, { status: 200, headers }), state };
  };
  const withFetch = async (make, fn) => {
    let calls = 0;
    globalThis.fetch = async (url) => { calls++; return make(url); };
    try { return { r: await fn().then((v) => v, (e) => e), calls }; } finally { globalThis.fetch = realFetch; }
  };
  const call = [{ method: "eth_call", params: [{ to: TOKEN, data: "0x06fdde03" }, "latest"] }];
  const st = () => ({ lanes: ["https://rpc.test/a", "https://rpc.test/b"], requests: 0, deadline: Date.now() + 10_000 });
  for (const declare of [false, true]) {
    const how = declare ? "declared" : "undeclared";
    let s;
    const rpc = await withFetch(() => { const l = lazy(RPC_MAX_BYTES * 4, { declare, prefix: "[" }); s = l.state; return l.res; }, () => rpcBatch(st(), call, "token reads"));
    ok(rpc.r?.statusCode === 502 && rpc.r.tooLarge === true && rpc.r.attribution === "upstream" && rpc.calls === 1 && s.pulled <= RPC_MAX_BYTES + 4 * 65_536, `${how === "declared" ? "a" : "an"} ${how} oversized JSON-RPC answer is refused 502 after one lane, read no further than its cap (${rpc.r?.statusCode}, ${s.pulled} bytes)`);
    const sim = await withFetch(() => { const l = lazy(RPC_MAX_BYTES * 4, { declare, prefix: "[" }); s = l.state; return l.res; }, () => simulateTrade({ lanes: ["https://rpc.test/a"], requests: 0, deadline: Date.now() + 10_000 }, { token: TOKEN, pool: POOL, poolBal: 100n }));
    ok(sim.r?.ran === false && sim.calls === 1 && s.pulled <= RPC_MAX_BYTES + 4 * 65_536, `${how === "declared" ? "a" : "an"} ${how} oversized simulation answer is not parsed: the simulation reports not run`);
    const logs = await withFetch(() => { const l = lazy(HOLDER_LOG_MAX_BYTES + 1_000_000, { declare, prefix: "[" }); s = l.state; return l.res; }, () => holderIndex({ lanes: ["x"], requests: 0, deadline: Date.now() + 10_000 }, { chain: "base", token: TOKEN, supplyBig: 1n, env: {}, lane: "https://keyed.test/k" }));
    ok(logs.r?.ok === false && /or more transfers/.test(logs.r.why) && s.pulled <= HOLDER_LOG_MAX_BYTES + 4 * 65_536, `${how === "declared" ? "a" : "an"} ${how} oversized Transfer history is refused at the log cap (${s.pulled} bytes)`);
    const src = await withFetch(() => { const l = lazy(SOURCIFY_MAX_BYTES * 2, { declare, prefix: "{" }); s = l.state; return l.res; }, () => readSourcify(8453, TOKEN));
    ok(src.r?.statusCode === 502 && src.r.tooLarge === true && src.r.attribution === "upstream" && s.pulled <= SOURCIFY_MAX_BYTES + 4 * 65_536, `${how === "declared" ? "a" : "an"} ${how} oversized Sourcify answer is refused 502 (${s.pulled} bytes)`);
    const dex = await withFetch(() => { const l = lazy(DEX_MAX_BYTES * 4, { declare, prefix: "[" }); s = l.state; return l.res; }, () => probeDexPairs({ chain: "base", address: TOKEN }));
    ok(dex.r?.statusCode === 502 && dex.r.tooLarge === true && dex.r.attribution === "upstream" && s.pulled <= DEX_MAX_BYTES + 4 * 65_536, `${how === "declared" ? "a" : "an"} ${how} oversized DEX pairs answer is refused 502 (${s.pulled} bytes)`);
  }
  // Real-size answers still pass: a code batch near ten 24 KB contracts, a 2.1 MB Sourcify record, 30 pairs.
  const code = `0x${"ab".repeat(24_576)}`;
  const big = await withFetch(() => new Response(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, result: code }))), { status: 200 }), () => rpcBatch(st(), Array.from({ length: 10 }, () => ({ method: "eth_getCode", params: [TOKEN, "latest"] })), "holder code"));
  ok(Array.isArray(big.r) && big.r.length === 10 && big.r[9].result === code, "ten full-size contract codes in one batch still read");
  const srcBody = JSON.stringify({ match: "exact_match", abi: [], sources: { "a.sol": { content: `pragma solidity 0.8.0; ${"x".repeat(2_200_000)}` } }, compilation: { compilerVersion: "0.8.0" } });
  const srcOk = await withFetch(() => new Response(srcBody, { status: 200 }), () => readSourcify(8453, TOKEN));
  ok(srcOk.r?.verified === true && srcOk.r.sourceText.startsWith("pragma"), "a 2.2 MB Sourcify record still reads");
  const pair = { dexId: "uniswap", pairAddress: POOL, baseToken: { address: TOKEN }, quoteToken: { address: IMPL, symbol: "WETH" }, liquidity: { usd: 1 }, info: { websites: [{ url: "https://x.test" }] }, labels: ["v2"] };
  const dexOk = await withFetch(() => new Response(JSON.stringify(Array.from({ length: 30 }, () => pair)), { status: 200 }), () => probeDexPairs({ chain: "base", address: TOKEN }));
  ok(dexOk.r?.totalPairs === 30, "thirty DEX pairs still read");
}

console.log(`\ntest-token-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
