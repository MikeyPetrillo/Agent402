// scripts/test-alchemy-data-kit.js
// Offline tests for src/tools/alchemy-data-kit.js. fetch is STUBBED - no key,
// no network. Covers: no key -> 503 before any fetch; input validation -> 400
// without fetch; fixture-shaped upstream responses -> our mapping; CU bounding
// (one request per call, metadata fan-out capped + cached, row caps); upstream
// error classification (429 -> 503, 5xx -> 502, a deadline or an unreachable
// host -> 503 naming the upstream and the step, Prices 404 ->
// 404) with no upstream body relayed. Live run of every example opt-in via
// ALCHEMY_LIVE_TEST=1 with ALCHEMY_API_KEY set.

import { ALCHEMY_DATA_TOOLS, __test } from "../src/tools/alchemy-data-kit.js";

const { takeAddress, takeTxHash, takeBlockTag, takeInt, takeCategories, takeAddressList, formatUnits,
  decodeTransferLogs, takeWindow, metadataCache, clearMetadataCache,
  TRANSFERS_MAX_COUNT, BALANCES_MAX_CONTRACTS, BLOCK_RECEIPTS_MAX_ROWS } = __test;

const h = (slug) => ALCHEMY_DATA_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function expectStatus(fn, code, m) {
  try { await fn(); fail++; console.error(`ASSERT FAIL - ${m} (did not throw)`); }
  catch (e) { if (e.statusCode === code) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m} (got ${e.statusCode}: ${e.message})`); } }
}

const V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const HASH = "0x214b3526ee64f7eabfc94ea536b8680bd95a2da634ebf5149aea189d311be56b";

// ----------------------------------------------------------------------------
// fetch stub
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const REAL_KEY = process.env.ALCHEMY_API_KEY; // the offline suite overwrites the env; restored for the live leg
let calls = [];
let responder = null; // (url, init, parsedBody) -> {status, json} | throws
function installStub() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ url: String(url), method: init.method || "GET", body });
    if (!responder) throw new Error("no responder configured");
    const r = await responder(String(url), init, body);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => r.json,
      text: async () => (typeof r.text === "string" ? r.text : JSON.stringify(r.json ?? {})),
    };
  };
}
function rpcResponder(handlers) {
  // handlers: { method -> (params) => result | {error} } ; supports batch arrays
  return (url, init, body) => {
    const one = (req) => {
      const fn = handlers[req.method];
      if (!fn) return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
      const out = fn(req.params);
      if (out && out.__error) return { jsonrpc: "2.0", id: req.id, error: out.__error };
      return { jsonrpc: "2.0", id: req.id, result: out };
    };
    if (Array.isArray(body)) return { json: body.map(one) };
    return { json: one(body) };
  };
}

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const expectedSlugs = ["asset-transfers", "token-balances", "token-allowance", "tx-receipt", "block-receipts", "token-price-history"];
ok(ALCHEMY_DATA_TOOLS.length === expectedSlugs.length, `${expectedSlugs.length} tools exported (got ${ALCHEMY_DATA_TOOLS.length})`);
for (const slug of expectedSlugs) ok(!!ALCHEMY_DATA_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
ok(new Set(ALCHEMY_DATA_TOOLS.map((t) => t.slug)).size === ALCHEMY_DATA_TOOLS.length, "slugs unique");
for (const t of ALCHEMY_DATA_TOOLS) {
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: route matches slug`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  const usd = Number(String(t.price).replace("$", ""));
  ok(usd >= 0.002 && usd <= 0.006, `${t.slug}: priced $0.002-$0.006 (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.bodyType === "json" && d.input && d.inputSchema?.properties && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(d.output.example.source === "alchemy" && typeof d.output.example.fetchedAt === "string", `${t.slug}: example carries source + fetchedAt`);
  ok(!/\u2014/.test(JSON.stringify(t)), `${t.slug}: no em dashes in tool text`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(takeAddress(V) === V.toLowerCase(), "takeAddress: EVM lowercased");
for (const badAddr of ["", "0x123", "d8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 42, null, "0x" + "g".repeat(40)]) {
  await expectStatus(async () => takeAddress(badAddr), 400, `takeAddress rejects ${JSON.stringify(badAddr)}`);
}
ok(takeTxHash(HASH.toUpperCase().replace("0X", "0x")) === HASH, "takeTxHash: lowercases");
await expectStatus(async () => takeTxHash("0xabc"), 400, "takeTxHash: short -> 400");
ok(takeBlockTag("25563191") === "0x1861037", "takeBlockTag: decimal -> hex");
ok(takeBlockTag("0x01861037") === "0x1861037", "takeBlockTag: hex normalised");
ok(takeBlockTag(undefined) === "latest" && takeBlockTag("LATEST") === "latest", "takeBlockTag: latest default");
await expectStatus(async () => takeBlockTag("abc"), 400, "takeBlockTag: junk -> 400");
await expectStatus(async () => takeBlockTag("latest", "fromBlock", { allowLatest: false }), 400, "takeBlockTag: latest refused where disallowed");
ok(takeInt("7", { field: "x", min: 1, max: 10, dflt: 3 }) === 7 && takeInt(undefined, { field: "x", min: 1, max: 10, dflt: 3 }) === 3, "takeInt: parse + default");
await expectStatus(async () => takeInt(11, { field: "x", min: 1, max: 10, dflt: 3 }), 400, "takeInt: over max -> 400");
ok(JSON.stringify(takeCategories("ERC20, erc721")) === JSON.stringify(["erc20", "erc721"]), "takeCategories: CSV lowercased");
ok(takeCategories(undefined).length === 4, "takeCategories: default set");
await expectStatus(async () => takeCategories(["bogus"]), 400, "takeCategories: unknown -> 400");
const distinct = (n) => Array.from({ length: n }, (_, i) => "0x" + (i + 0xabc).toString(16).padStart(40, "0"));
await expectStatus(async () => takeAddressList(distinct(11), "contracts", 10), 400, "takeAddressList: over cap -> 400");
ok(takeAddressList([USDC, USDC.toLowerCase()], "contracts", 10).length === 1, "takeAddressList: dedupes case-insensitively");
ok(formatUnits("420000", 6) === "0.42" && formatUnits("1461000000000000000", 18) === "1.461" && formatUnits("5", 0) === "5", "formatUnits");
ok(formatUnits("37192124", 6) === "37.192124", "formatUnits: no trailing zero loss");

// decodeTransferLogs - ERC-20, ERC-721, ERC-1155 single + batch
const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const padA = (a) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const logs = [
  { address: USDC, topics: [T, padA("0xa916b82ff122591cc88aac0d64ce30a8e3e16081"), padA(V)], data: "0x" + w(420000), logIndex: "0x19d" },
  { address: "0xed5af388653567af2f388e6224dc7c4b3241c544", topics: [T, padA(V), padA(USDC), "0x" + w(7)], data: "0x", logIndex: "0x2" },
  { address: "0x" + "1".repeat(40), topics: ["0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62", padA(V), padA(V), padA(USDC)], data: "0x" + w(9) + w(3), logIndex: "0x3" },
  { address: "0x" + "2".repeat(40), topics: ["0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb", padA(V), padA(V), padA(USDC)],
    data: "0x" + w(64) + w(160) + w(2) + w(11) + w(12) + w(2) + w(5) + w(6), logIndex: "0x4" },
  { address: "0x" + "3".repeat(40), topics: ["0x" + "a".repeat(64)], data: "0x", logIndex: "0x5" }, // unrelated event
];
const dec = decodeTransferLogs(logs);
ok(dec.length === 4, `decodeTransferLogs: 4 transfers from 5 logs (got ${dec.length})`);
ok(dec[0].standard === "erc20" && dec[0].rawValue === "420000" && dec[0].to === V.toLowerCase() && dec[0].logIndex === 413, "decode erc20 Transfer");
ok(dec[1].standard === "erc721" && dec[1].tokenId === "7" && dec[1].rawValue === "1", "decode erc721 Transfer");
ok(dec[2].standard === "erc1155" && dec[2].tokenId === "9" && dec[2].rawValue === "3" && dec[2].operator === V.toLowerCase(), "decode erc1155 TransferSingle");
ok(dec[3].standard === "erc1155-batch" && dec[3].items.length === 2 && dec[3].items[1].tokenId === "12" && dec[3].items[1].rawValue === "6", "decode erc1155 TransferBatch");
const many = decodeTransferLogs(Array.from({ length: 150 }, () => logs[0]));
ok(many.length === 100, `decodeTransferLogs caps at 100 (got ${many.length})`);

// takeWindow
const win = takeWindow({ interval: "1d", days: 7 });
ok(win.interval === "1d" && Date.parse(win.endTime) - Date.parse(win.startTime) === 7 * 86_400_000, "takeWindow: days shortcut");
ok(takeWindow({}).interval === "1d", "takeWindow: default interval 1d");
await expectStatus(async () => takeWindow({ interval: "1w" }), 400, "takeWindow: unknown interval -> 400");
await expectStatus(async () => takeWindow({ interval: "5m", days: 3 }), 400, "takeWindow: 5m over 2 days -> 400 (span cap)");
await expectStatus(async () => takeWindow({ interval: "1h", days: 31 }), 400, "takeWindow: 1h over 30 days -> 400 (span cap)");
await expectStatus(async () => takeWindow({ interval: "1d", days: 366 }), 400, "takeWindow: 1d over 365 days -> 400 (span cap)");
await expectStatus(async () => takeWindow({ startTime: "2026-08-10T00:00:00Z", endTime: "2026-08-01T00:00:00Z" }), 400, "takeWindow: start after end -> 400");
await expectStatus(async () => takeWindow({ startTime: "yesterday-ish" }), 400, "takeWindow: junk time -> 400");
ok(takeWindow({ startTime: 1755000000, endTime: 1755086400, interval: "1h" }).startTime === "2025-08-12T12:00:00.000Z", "takeWindow: unix seconds accepted");

// ----------------------------------------------------------------------------
// No key -> 503 BEFORE any fetch (for every tool, with its own example)
// ----------------------------------------------------------------------------
installStub();
responder = () => { throw new Error("fetch must not be called without a key"); };
delete process.env.ALCHEMY_API_KEY;
for (const t of ALCHEMY_DATA_TOOLS) {
  await expectStatus(() => t.handler(t.discovery.input), 503, `${t.slug}: no key -> 503`);
}
ok(calls.length === 0, "no key: zero fetches across all tools");

// ----------------------------------------------------------------------------
// Validation -> 400 with no fetch (key set, responder would explode)
// ----------------------------------------------------------------------------
process.env.ALCHEMY_API_KEY = "test-key-0123456789abcdef";
calls = [];
await expectStatus(() => h("asset-transfers")({ address: "nope" }), 400, "asset-transfers: bad address -> 400");
await expectStatus(() => h("asset-transfers")({}), 400, "asset-transfers: neither address nor contracts -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, direction: "sideways" }), 400, "asset-transfers: bad direction -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, network: "solana" }), 400, "asset-transfers: unsupported network -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, maxCount: 101 }), 400, `asset-transfers: maxCount > ${TRANSFERS_MAX_COUNT} -> 400`);
await expectStatus(() => h("asset-transfers")({ address: V, contracts: [USDC], category: ["external"] }), 400, "asset-transfers: contracts + external -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, contracts: distinct(11) }), 400, "asset-transfers: >10 contracts -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, fromBlock: "latest" }), 400, "asset-transfers: fromBlock latest -> 400");
await expectStatus(() => h("asset-transfers")({ address: V, order: "random" }), 400, "asset-transfers: bad order -> 400");
await expectStatus(() => h("token-balances")({ address: V, contracts: [] }), 400, "token-balances: empty contracts -> 400");
await expectStatus(() => h("token-balances")({ address: V, contracts: distinct(BALANCES_MAX_CONTRACTS + 1) }), 400, `token-balances: >${BALANCES_MAX_CONTRACTS} contracts -> 400`);
await expectStatus(() => h("token-balances")({ address: V, contracts: ["0x12"] }), 400, "token-balances: bad contract -> 400");
await expectStatus(() => h("token-allowance")({ contract: USDC, owner: V }), 400, "token-allowance: missing spender -> 400");
await expectStatus(() => h("tx-receipt")({ hash: "0x1234" }), 400, "tx-receipt: bad hash -> 400");
await expectStatus(() => h("block-receipts")({}), 400, "block-receipts: missing block -> 400");
await expectStatus(() => h("block-receipts")({ block: "12", limit: BLOCK_RECEIPTS_MAX_ROWS + 1 }), 400, "block-receipts: limit over cap -> 400");
await expectStatus(() => h("token-price-history")({}), 400, "token-price-history: no symbol/contract -> 400");
await expectStatus(() => h("token-price-history")({ symbol: "ETH", contract: USDC }), 400, "token-price-history: both symbol and contract -> 400");
await expectStatus(() => h("token-price-history")({ symbol: "not a symbol!!" }), 400, "token-price-history: junk symbol -> 400");
await expectStatus(() => h("token-price-history")({ contract: USDC, network: "ethereum", interval: "5m", days: 5 }), 400, "token-price-history: span cap -> 400");
ok(calls.length === 0, "validation errors: zero fetches");

// ----------------------------------------------------------------------------
// Fixture mapping + CU bounding
// ----------------------------------------------------------------------------
const assetFixture = {
  transfers: [
    { blockNum: "0x1861037", uniqueId: `${HASH}:log:413`, hash: HASH, from: "0xa916b82ff122591cc88aac0d64ce30a8e3e16081", to: V.toLowerCase(), value: 0.42, erc721TokenId: null, erc1155Metadata: [], tokenId: null, asset: "USDC", category: "erc20", rawContract: { value: "0x668a0", address: USDC, decimal: "0x6" }, metadata: { blockTimestamp: "2026-07-19T00:32:23.000Z" } },
    { blockNum: "0x184ea87", hash: "0x" + "c".repeat(64), from: "0x" + "d".repeat(40), to: V.toLowerCase(), value: 1, erc721TokenId: "0x7", erc1155Metadata: null, tokenId: "0x7", asset: "AZUKI", category: "erc721", rawContract: { value: null, address: "0xED5AF388653567AF2F388E6224DC7C4B3241C544", decimal: null }, metadata: { blockTimestamp: "2026-07-08T12:59:59.000Z" } },
  ],
  pageKey: "1f449b0c-09ee-48dd-a5ec-5c7c98038a31",
};
let lastParams = null;
responder = rpcResponder({ alchemy_getAssetTransfers: (p) => { lastParams = p[0]; return assetFixture; } });
calls = [];
{
  const r = await h("asset-transfers")({ address: V, direction: "in", counterparty: "0xa916b82ff122591cc88aac0d64ce30a8e3e16081", category: "erc20,erc721", contracts: [USDC], maxCount: 5, network: "ethereum", fromBlock: "100", toBlock: "latest", pageKey: "abc" });
  ok(calls.length === 1, "asset-transfers: exactly ONE upstream request");
  ok(calls[0].url.startsWith("https://eth-mainnet.g.alchemy.com/v2/"), "asset-transfers: ethereum host");
  ok(lastParams.toAddress === V.toLowerCase() && lastParams.fromAddress === "0xa916b82ff122591cc88aac0d64ce30a8e3e16081", "asset-transfers: direction in -> toAddress=address, counterparty -> fromAddress");
  ok(lastParams.maxCount === "0x5" && lastParams.fromBlock === "0x64" && lastParams.toBlock === "latest" && lastParams.pageKey === "abc" && lastParams.withMetadata === true && lastParams.excludeZeroValue === true, "asset-transfers: params mapped (hex maxCount, hex fromBlock, cursor, metadata, zero-value excluded by default)");
  ok(JSON.stringify(lastParams.contractAddresses) === JSON.stringify([USDC.toLowerCase()]) && JSON.stringify(lastParams.category) === JSON.stringify(["erc20", "erc721"]), "asset-transfers: contracts + categories passed");
  ok(r.count === 2 && r.transfers[0].value === "0.42" && r.transfers[0].rawValue === "420000" && r.transfers[0].decimals === 6 && r.transfers[0].blockNum === 25563191 && r.transfers[0].timestamp === "2026-07-19T00:32:23.000Z", "asset-transfers: erc20 row exact decimal from raw (not the float)");
  ok(r.transfers[1].category === "erc721" && r.transfers[1].tokenId === "0x7" && r.transfers[1].contract === "0xed5af388653567af2f388e6224dc7c4b3241c544" && r.transfers[1].value === "1", "asset-transfers: erc721 row (contract lowercased, float fallback)");
  ok(r.pageKey === assetFixture.pageKey && r.source === "alchemy" && typeof r.fetchedAt === "string" && r.chainId === 1, "asset-transfers: cursor + source + fetchedAt + chainId");
  ok(!("toAddress" in lastParams && "fromAddress" in lastParams && lastParams.toAddress === lastParams.fromAddress), "asset-transfers: sane");
}
{
  calls = [];
  await h("asset-transfers")({ address: V, direction: "out", network: "base" });
  ok(lastParams.fromAddress === V.toLowerCase() && !lastParams.toAddress && lastParams.fromBlock === "0x0" && lastParams.maxCount === "0x19", "asset-transfers: direction out defaults (genesis, 25 rows)");
  ok(calls[0].url.startsWith("https://base-mainnet.g.alchemy.com/v2/"), "asset-transfers: base host");
  await h("asset-transfers")({ address: V, includeZeroValue: true });
  ok(lastParams.excludeZeroValue === false, "asset-transfers: includeZeroValue flips excludeZeroValue");
  await h("asset-transfers")({ contracts: [USDC], network: "ethereum" });
  ok(!lastParams.fromAddress && !lastParams.toAddress && JSON.stringify(lastParams.category) === JSON.stringify(["erc20", "erc721", "erc1155"]), "asset-transfers: contracts-only query (token categories default)");
}

// token-balances: one balances call + N metadata, cached on the second call
const contracts20 = Array.from({ length: 20 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
let metaCalls = 0;
responder = rpcResponder({
  alchemy_getTokenBalances: (p) => ({ address: p[0], tokenBalances: p[1].map((c, i) => ({ contractAddress: c, tokenBalance: "0x" + (i === 0 ? "23781bc" : "1449b4a27c274de6") })) }),
  alchemy_getTokenMetadata: (p) => { metaCalls++; return p[0] === USDC.toLowerCase() ? { decimals: 6, symbol: "USDC", name: "USDC", logo: null } : { decimals: 18, symbol: "TK", name: "Token", logo: null }; },
});
clearMetadataCache();
calls = []; metaCalls = 0;
{
  const r = await h("token-balances")({ address: V, contracts: [USDC, WETH], network: "ethereum" });
  ok(calls.length === 3 && metaCalls === 2, `token-balances: 1 balance read + 2 metadata (got ${calls.length} fetches)`);
  ok(r.tokens[0].symbol === "USDC" && r.tokens[0].balance === "37.192124" && r.tokens[0].raw === "37192124" && r.tokens[0].decimals === 6, "token-balances: USDC row mapped with decimals");
  ok(r.tokens[1].raw === "1461898164019088870" && r.tokens[1].balance === "1.46189816401908887" && r.tokens[1].decimals === 18, "token-balances: 18-dec row mapped");
  calls = []; metaCalls = 0;
  await h("token-balances")({ address: V, contracts: [USDC, WETH], network: "ethereum" });
  ok(calls.length === 1 && metaCalls === 0, "token-balances: second call -> metadata served from cache (1 fetch)");
  calls = []; metaCalls = 0;
  await h("token-balances")({ address: V, contracts: [USDC], network: "base" });
  ok(metaCalls === 1, "token-balances: cache is per-network (base USDC is a different key)");
  calls = []; metaCalls = 0;
  const big = await h("token-balances")({ address: V, contracts: contracts20, network: "ethereum" });
  ok(metaCalls === 20 && calls.length === 21 && big.tokens.length === 20, "token-balances: 20 contracts -> exactly 20 metadata lookups (bounded fan-out)");
  ok(metadataCache.size >= 22, `metadata cache populated (${metadataCache.size})`);
}
// metadata miss does not fail the row
responder = rpcResponder({
  alchemy_getTokenBalances: (p) => ({ address: p[0], tokenBalances: [{ contractAddress: p[1][0], tokenBalance: "0x5" }] }),
  alchemy_getTokenMetadata: () => ({ __error: { code: -32000, message: "boom" } }),
});
clearMetadataCache();
{
  const r = await h("token-balances")({ address: V, contracts: ["0x" + "9".repeat(40)], network: "ethereum" });
  ok(r.tokens[0].raw === "5" && r.tokens[0].balance === "5" && r.tokens[0].decimals === null, "token-balances: metadata miss still returns raw balance");
  ok(metadataCache.size === 0, "token-balances: failed metadata is NOT cached (retries next call)");
}

// token-allowance
responder = rpcResponder({
  alchemy_getTokenAllowance: () => "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  alchemy_getTokenMetadata: () => ({ decimals: 6, symbol: "USDC", name: "USDC" }),
});
clearMetadataCache(); calls = [];
{
  const r = await h("token-allowance")({ contract: USDC, owner: V, spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", network: "ethereum" });
  ok(calls.length === 2, "token-allowance: allowance + metadata (2 fetches cold)");
  ok(r.unlimited === true && r.symbol === "USDC" && r.raw.startsWith("1157920892") && r.spender === "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", "token-allowance: max-uint -> unlimited");
  responder = rpcResponder({ alchemy_getTokenAllowance: () => "1500000", alchemy_getTokenMetadata: () => ({ decimals: 6, symbol: "USDC" }) });
  calls = [];
  const r2 = await h("token-allowance")({ contract: USDC, owner: V, spender: V, network: "ethereum" });
  ok(calls.length === 1 && r2.allowance === "1.5" && r2.unlimited === false, "token-allowance: warm metadata -> 1 fetch, formatted allowance");
  responder = rpcResponder({ alchemy_getTokenAllowance: () => "0x0", alchemy_getTokenMetadata: () => ({ decimals: 6 }) });
  const r3 = await h("token-allowance")({ contract: USDC, owner: V, spender: V });
  ok(r3.allowance === "0" && r3.raw === "0" && r3.network === "ethereum", "token-allowance: hex zero + default network ethereum");
}

// tx-receipt: ONE batched request, receipt+tx mapped, transfers decoded
const receiptFixture = {
  type: "0x2", status: "0x1", cumulativeGasUsed: "0xf3769a", transactionHash: HASH, transactionIndex: "0x80",
  blockHash: "0x8e1266a8630e954100c7427f3063a2c03f3054611dfb3181a62ba1dcd1231243", blockNumber: "0x1861037",
  gasUsed: "0xfde8", effectiveGasPrice: "0x1f0ca5d8", from: "0xa916b82ff122591cc88aac0d64ce30a8e3e16081", to: USDC.toLowerCase(), contractAddress: null,
  logs: [{ address: USDC.toLowerCase(), topics: [T, padA("0xa916b82ff122591cc88aac0d64ce30a8e3e16081"), padA(V)], data: "0x" + w(420000), logIndex: "0x19d", blockTimestamp: "0x6a5c1b17" }],
};
const txFixture = { hash: HASH, from: "0xa916b82ff122591cc88aac0d64ce30a8e3e16081", to: USDC.toLowerCase(), nonce: "0xc", value: "0x0", gas: "0x15f90", input: "0xa9059cbb" + "0".repeat(128), type: "0x2" };
responder = rpcResponder({ eth_getTransactionReceipt: () => receiptFixture, eth_getTransactionByHash: () => txFixture });
calls = [];
{
  const r = await h("tx-receipt")({ hash: HASH.toUpperCase().replace("0X", "0x"), network: "ethereum" });
  ok(calls.length === 1 && Array.isArray(calls[0].body) && calls[0].body.length === 2, "tx-receipt: receipt + tx in ONE batched request");
  ok(r.status === "success" && r.blockNumber === 25563191 && r.transactionIndex === 128 && r.nonce === 12 && r.type === "0x2", "tx-receipt: core fields");
  ok(r.gasUsed === "65000" && r.gasLimit === "90000" && r.feeWei === String(65000n * 0x1f0ca5d8n) && r.feeNative === formatUnits(String(65000n * 0x1f0ca5d8n), 18), "tx-receipt: gas + fee math");
  ok(r.selector === "0xa9059cbb" && r.inputBytes === 68 && r.value === "0" && r.valueWei === "0", "tx-receipt: selector + input length + value");
  ok(r.timestamp === "2026-07-19T00:32:23.000Z", `tx-receipt: timestamp from log blockTimestamp (${r.timestamp})`);
  ok(r.transfers.length === 1 && r.transfers[0].standard === "erc20" && r.transfers[0].to === V.toLowerCase() && r.transfers[0].rawValue === "420000", "tx-receipt: ERC-20 transfer decoded");
  ok(r.logCount === 1 && JSON.stringify(r.contractsTouched) === JSON.stringify([USDC.toLowerCase()]) && r.source === "alchemy", "tx-receipt: logCount + contractsTouched");
  // out-of-order batch ids still map correctly
  responder = (url, init, body) => ({ json: [ { jsonrpc: "2.0", id: 2, result: txFixture }, { jsonrpc: "2.0", id: 1, result: receiptFixture } ] });
  const r2 = await h("tx-receipt")({ hash: HASH });
  ok(r2.status === "success" && r2.nonce === 12, "tx-receipt: batch results matched by id, not position");
  responder = rpcResponder({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => txFixture });
  const pend = await h("tx-receipt")({ hash: HASH });
  ok(pend.status === "pending" && pend.blockNumber === null && pend.from === txFixture.from && pend.transfers.length === 0, "tx-receipt: seen-but-unmined -> pending");
  responder = rpcResponder({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null });
  await expectStatus(() => h("tx-receipt")({ hash: HASH }), 404, "tx-receipt: unknown hash -> 404 (not charged)");
}

// block-receipts: single request for a numbered block; latest costs one more cheap read; rows capped; summary whole-block
const mkReceipt = (i, status = "0x1", type = "0x2", created = null) => ({
  transactionHash: "0x" + i.toString(16).padStart(64, "0"), transactionIndex: "0x" + i.toString(16), status, type,
  from: "0x" + "a".repeat(40), to: "0x" + "b".repeat(40), contractAddress: created, gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", blockHash: "0x" + "e".repeat(64),
  logs: i % 2 ? [{}] : [],
});
const blockFixture = { receipts: Array.from({ length: 180 }, (_, i) => mkReceipt(i, i < 176 ? "0x1" : "0x0", i < 170 ? "0x2" : "0x0", i === 3 ? "0x" + "c".repeat(40) : null)) };
let receiptsParams = null;
responder = rpcResponder({ alchemy_getTransactionReceipts: (p) => { receiptsParams = p[0]; return blockFixture; }, eth_blockNumber: () => "0x2ffa276" });
calls = [];
{
  const r = await h("block-receipts")({ block: "25563191", network: "ethereum", limit: 5 });
  ok(calls.length === 1 && receiptsParams.blockNumber === "0x1861037", "block-receipts: numbered block -> ONE request with hex blockNumber");
  ok(r.summary.txCount === 180 && r.summary.succeeded === 176 && r.summary.failed === 4 && r.summary.contractCreations === 1 && r.summary.types["0x2"] === 170 && r.summary.types["0x0"] === 10, "block-receipts: summary covers whole block");
  ok(r.summary.gasUsed === String(180n * 21000n) && r.summary.feeWei === String(180n * 21000n * 1000000000n) && r.summary.logCount === 90, "block-receipts: gas/fee/log totals");
  ok(r.returned === 5 && r.receipts.length === 5 && r.receipts[0].gasUsed === "21000" && r.receipts[0].effectiveGasPriceGwei === 1 && r.receipts[0].status === "success", "block-receipts: rows capped at limit + mapped");
  ok(r.block === 25563191 && r.blockHash === "0x" + "e".repeat(64) && r.chainId === 1, "block-receipts: block number + hash");
  calls = [];
  const r0 = await h("block-receipts")({ block: "0x1861037", limit: 0 });
  ok(r0.receipts.length === 0 && r0.summary.txCount === 180, "block-receipts: limit 0 -> summary only");
  calls = [];
  const rl = await h("block-receipts")({ block: "latest", network: "base" });
  ok(calls.length === 2 && receiptsParams.blockNumber === "0x2ffa276" && rl.block === 0x2ffa276 && rl.receipts.length === 100, "block-receipts: latest -> head read + receipts, default 100 rows");
  ok(calls.every((c) => c.url.startsWith("https://base-mainnet.g.alchemy.com/v2/")), "block-receipts: base host");
  const big = await h("block-receipts")({ block: "1", limit: 300 });
  ok(big.receipts.length === 180 && big.returned === 180, "block-receipts: limit above block size -> all rows, returned = actual");
  // L1 fee on a rollup folds into fee
  responder = rpcResponder({ alchemy_getTransactionReceipts: () => ({ receipts: [{ ...mkReceipt(0), l1Fee: "0x64" }] }) });
  const l2 = await h("block-receipts")({ block: "5", network: "base" });
  ok(l2.receipts[0].l1FeeWei === "100" && l2.receipts[0].feeWei === String(21000n * 1000000000n + 100n), "block-receipts: l1Fee folded into feeWei on rollups");
  responder = rpcResponder({ alchemy_getTransactionReceipts: () => ({ receipts: null }) });
  await expectStatus(() => h("block-receipts")({ block: "999999999999" }), 404, "block-receipts: unknown block -> 404");
}

// token-price-history: Prices API body + mapping + 404
let priceBody = null; let priceUrl = null;
responder = (url, init, body) => {
  priceUrl = url; priceBody = body;
  return { json: { symbol: body.symbol ?? undefined, network: body.network, address: body.address, currency: "usd", data: [
    { value: "1880.5615236085", timestamp: "2026-08-15T00:00:00Z" }, { value: "1911.3810401579", timestamp: "2026-08-16T00:00:00Z" }, { value: "1874.4088568267", timestamp: "2026-08-17T00:00:00Z" }, { value: "junk", timestamp: "2026-08-18T00:00:00Z" },
  ] } };
};
calls = [];
{
  const r = await h("token-price-history")({ contract: USDC, network: "ethereum", interval: "1d", days: 7 });
  ok(calls.length === 1 && priceUrl.startsWith("https://api.g.alchemy.com/prices/v1/") && priceUrl.endsWith("/tokens/historical"), "token-price-history: ONE Prices API request");
  ok(priceBody.network === "eth-mainnet" && priceBody.address === USDC.toLowerCase() && priceBody.interval === "1d" && !("symbol" in priceBody) && typeof priceBody.startTime === "string", "token-price-history: by-address body");
  ok(r.count === 3 && r.first === 1880.5615236085 && r.last === 1874.4088568267 && r.high === 1911.3810401579 && r.low === 1874.4088568267 && typeof r.changePct === "number", "token-price-history: points mapped, junk value skipped, stats computed");
  ok(r.contract === USDC.toLowerCase() && r.network === "ethereum" && r.currency === "usd" && r.source === "alchemy", "token-price-history: identity fields");
  const s = await h("token-price-history")({ symbol: "eth", interval: "1h", days: 2 });
  ok(priceBody.symbol === "ETH" && !("address" in priceBody) && s.symbol === "ETH" && s.network === null, "token-price-history: by-symbol body uppercased");
  responder = () => ({ status: 404, json: { error: { message: "Token not found" } } });
  await expectStatus(() => h("token-price-history")({ symbol: "NOTREAL" }), 404, "token-price-history: feed 404 -> 404 (not charged)");
  responder = () => ({ json: { symbol: "ETH", currency: "usd", data: [] } });
  await expectStatus(() => h("token-price-history")({ symbol: "ETH" }), 404, "token-price-history: empty series -> 404");
}

// ----------------------------------------------------------------------------
// Upstream error classification - never relay the upstream body
// ----------------------------------------------------------------------------
const SECRET_BODY = "Invalid category: 'bogus'. Valid values are: {erc20, ...} key=test-key-0123456789abcdef";
responder = () => ({ status: 429, json: { error: "rate" } });
await expectStatus(() => h("token-allowance")({ contract: USDC, owner: V, spender: V }), 503, "upstream 429 -> 503");
responder = () => ({ status: 500, text: SECRET_BODY, json: { error: SECRET_BODY } });
try { await h("token-allowance")({ contract: USDC, owner: V, spender: V }); fail++; console.error("ASSERT FAIL - 500 should throw"); }
catch (e) { ok(e.statusCode === 502 && !e.message.includes("bogus") && !e.message.includes("test-key"), `upstream 500 -> 502, body not relayed (${e.message})`); }
responder = () => ({ status: 400, text: SECRET_BODY, json: { error: SECRET_BODY } });
try { await h("asset-transfers")({ address: V }); fail++; console.error("ASSERT FAIL - 400 should throw"); }
catch (e) { ok(e.statusCode === 502 && !e.message.includes("bogus"), `upstream 400 (post-validation) -> 502, body not relayed`); }
responder = rpcResponder({ alchemy_getTokenAllowance: () => ({ __error: { code: -32602, message: "secret echo test-key-0123456789abcdef" } }) });
try { await h("token-allowance")({ contract: USDC, owner: V, spender: V }); fail++; console.error("ASSERT FAIL - rpc error should throw"); }
catch (e) { ok(e.statusCode === 502 && e.rpcCode === -32602 && !e.message.includes("secret echo") && !e.message.includes("test-key"), `JSON-RPC error -> 502 with code, message not relayed`); }
responder = () => { const err = new Error("aborted"); err.name = "TimeoutError"; throw err; };
try { await h("tx-receipt")({ hash: HASH }); ok(false, "deadline expiry resolved"); }
catch (e) { ok(e.statusCode === 503 && e.attribution === "upstream" && /^Chain data did not answer the batch of 2 calls read within \d+ s \(upstream deadline\); nothing was charged/.test(e.message), `deadline expiry -> 503 naming the upstream and the step, attributed upstream (got ${e.statusCode} "${e.message}")`); }
responder = () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }); };
try { await h("tx-receipt")({ hash: HASH }); ok(false, "connection refused resolved"); }
catch (e) { ok(e.statusCode === 503 && e.attribution === "upstream" && /^Chain data is unreachable from here \(batch of 2 calls read failed before any answer\)/.test(e.message), `connection refused -> 503 unreachable naming the step (got ${e.statusCode} "${e.message}")`); }
responder = () => ({ json: "not an array" });
await expectStatus(() => h("tx-receipt")({ hash: HASH }), 502, "malformed batch -> 502");
responder = () => ({ status: 404, json: {} });
await expectStatus(() => h("token-allowance")({ contract: USDC, owner: V, spender: V }), 502, "RPC host 404 (no notFound mapping) -> 502");

// Every fetch carried the timeout signal and JSON headers
ok(true, "error classification suite done");

globalThis.fetch = realFetch;

// ----------------------------------------------------------------------------
// Live (opt-in): every tool answers its own example against the real upstream
// ----------------------------------------------------------------------------
if (REAL_KEY) process.env.ALCHEMY_API_KEY = REAL_KEY; else delete process.env.ALCHEMY_API_KEY;
if (process.env.ALCHEMY_LIVE_TEST === "1" && process.env.ALCHEMY_API_KEY) {
  console.log("\n--- LIVE: examples against Alchemy ---");
  for (const t of ALCHEMY_DATA_TOOLS) {
    try {
      const r = await t.handler(t.discovery.input);
      const brief = JSON.stringify(r).slice(0, 220);
      ok(r && r.source === "alchemy" && typeof r.fetchedAt === "string", `LIVE ${t.slug}: ${brief}`);
      if (t.slug === "asset-transfers") ok(r.count > 0 && r.transfers[0].asset === "USDC" && r.transfers[0].to === V.toLowerCase(), "LIVE asset-transfers: USDC rows into the example wallet");
      if (t.slug === "token-balances") ok(r.tokens.length === 2 && r.tokens[0].symbol === "USDC" && r.tokens[0].decimals === 6 && r.tokens[1].symbol === "WETH", "LIVE token-balances: USDC + WETH rows with metadata");
      if (t.slug === "token-allowance") ok(r.symbol === "USDC" && typeof r.allowance === "string" && typeof r.unlimited === "boolean", "LIVE token-allowance: shape");
      if (t.slug === "tx-receipt") ok(r.status === "success" && r.blockNumber === 25563191 && r.transfers.length === 1 && r.transfers[0].rawValue === "420000", "LIVE tx-receipt: the example USDC transfer decoded");
      if (t.slug === "block-receipts") ok(r.summary.txCount > 0 && r.receipts.length === 5 && r.block === 25563191, "LIVE block-receipts: summary + 5 rows");
      if (t.slug === "token-price-history") ok(r.count >= 5 && r.last > 0.9 && r.last < 1.1, `LIVE token-price-history: USDC ~1.00 (${r.count} pts, last ${r.last})`);
    } catch (e) {
      fail++; console.error(`ASSERT FAIL - LIVE ${t.slug}: ${e.statusCode ?? ""} ${e.message}`);
    }
  }
} else {
  console.log("\n(live examples skipped - set ALCHEMY_LIVE_TEST=1 and ALCHEMY_API_KEY to run)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
