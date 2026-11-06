// The router's x402 buyer on every EVM chain src/evm-buyer-chains.js lists:
// Base's protections on each one, the SOR_EVM_CHAINS allowlist, the per-chain
// wallet day and low-balance refusal, and Robinhood's USDG domain.
// Offline: stub sellers (stubbed fetch), a throwaway key, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "evm-buyer-chains-test-"));
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.SOR_ROUTER_PURCHASES_FILE = join(scratch, "router-purchases.json");
delete process.env.SOR_EVM_CHAINS;
delete process.env.SOR_WALLET_DAILY_MAX_USD;
for (const k of Object.keys(process.env)) if (/^(SOR_WALLET_DAILY_MAX_USD_|UPSTREAM_BUYER_LOW_USD)/.test(k)) delete process.env[k];
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");

const chains = await import("../src/evm-buyer-chains.js");
const buyer = await import("../src/x402-buyer.js");
const { payX402, getUpstreamBuyer, __setBuyerAddressGuardForTest, __resetSellerRefusalsForTest, _spentThisWindow } = buyer;
const { KNOWN_ASSETS } = await import("../client/known-assets.js");
const { verifyTypedData } = await import("viem");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
__setBuyerAddressGuardForTest(false);

// --- the table: assets and decimals are known-assets.js's, never the seller's ---
for (const c of Object.values(chains.EVM_BUYER_CHAINS)) {
  const known = (KNOWN_ASSETS[c.caip2] || []).find((a) => a.asset.toLowerCase() === c.asset);
  ok(!!known && known.decimals === c.decimals && known.symbol === c.symbol && c.decimals === 6, `${c.name}: ${c.symbol} at ${c.caip2} is the known-assets row with its decimals (${known?.decimals})`);
}
ok(chains.EVM_BUYER_CHAINS.robinhood.domain.name === "Global Dollar" && chains.EVM_BUYER_CHAINS.robinhood.domain.version === "1", "robinhood: USDG signs under Global Dollar v1");
ok(chains.EVM_BUYER_CHAINS.polygon.domain.name === "USD Coin" && chains.EVM_BUYER_CHAINS.celo.domain.name === "USDC" && chains.EVM_BUYER_CHAINS.arc.domain.name === "USDC", "the USDC rows carry the separator-verified domain names");
ok(JSON.stringify(chains.enabledEvmBuyerChains({})) === '["base"]', "SOR_EVM_CHAINS unset: Base only");
ok(JSON.stringify(chains.enabledEvmBuyerChains({ SOR_EVM_CHAINS: "polygon, eip155:42220,bogus,base" })) === '["base","polygon","celo"]', "names and CAIP-2 ids both read; an unknown entry is ignored");
{
  const { evmRpcUrlFor } = await import("../src/evm-authorization-state.js");
  const { EVM_RPCS } = await import("../src/evm-rpcs.js");
  ok(evmRpcUrlFor("polygon") === EVM_RPCS["eip155:137"] && evmRpcUrlFor("robinhood") === EVM_RPCS["eip155:4663"] && evmRpcUrlFor("arc") === EVM_RPCS["eip155:5042"], "the chain-truth read has an RPC on every non-Base buyer chain");
}

// --- stub seller -------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const PAYTO = "0x" + "4b".repeat(20);
const acceptOn = (chain, over = {}) => {
  const c = chains.EVM_BUYER_CHAINS[chain];
  return { scheme: "exact", network: c.caip2, asset: c.asset, amount: "1000", payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: c.domain.name, version: c.domain.version }, ...over };
};
let paidRequests = 0, lastPayload = null, bareRequests = 0;
const seller = (accepts, { paid = "ok" } = {}) => async (_url, init) => {
  const h = init?.headers || {};
  const sig = h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"];
  const challenge = b64({ x402Version: 2, accepts });
  if (!sig) { bareRequests++; return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? challenge : null) }, json: async () => ({}), text: async () => "{}" }; }
  paidRequests++;
  try { lastPayload = JSON.parse(Buffer.from(sig, "base64").toString("utf8")); } catch { lastPayload = null; }
  if (paid === "refuse") return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? challenge : null) }, json: async () => ({}), text: async () => "{}" };
  return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: accepts[0]?.network }) } });
};
const evm = await getUpstreamBuyer();
const realSign = evm.client.createPaymentPayload.bind(evm.client);
let signs = 0;
// The clock just before and just after the signing call: the scheme stamps
// validBefore = its own now + the accept's maxTimeoutSeconds inside that call,
// so a bound on validBefore is read against this window, never against a
// clock read taken before the seller's 402 (slow under load).
let signWindow = null;
evm.client.createPaymentPayload = async (...a) => {
  signs++;
  const before = Math.floor(Date.now() / 1000);
  const out = await realSign(...a);
  signWindow = { before, after: Math.floor(Date.now() / 1000) };
  return out;
};
const reset = () => { signs = 0; signWindow = null; paidRequests = 0; bareRequests = 0; lastPayload = null; __resetSellerRefusalsForTest(); };
const buy = (chain, accepts, extra = {}, sellerOpts = {}) => {
  globalThis.fetch = seller(accepts, sellerOpts);
  return payX402(`https://${chain}-seller.example/x`, { maxAtomic: 500000n, method: "POST", body: {}, chain, ...extra }).then((r) => ({ r }), (e) => ({ e }));
};

// --- off the list: never paid -------------------------------------------------
reset();
{
  const off = await buy("polygon", [acceptOn("polygon")]);
  ok(off.e?.statusCode === 409 && /not enabled/.test(off.e.message) && signs === 0 && bareRequests === 0 && paidRequests === 0, `polygon not in SOR_EVM_CHAINS: payX402 refuses 409 before any request (${off.e?.statusCode} ${off.e?.message})`);
}
process.env.SOR_EVM_CHAINS = "polygon,celo,arbitrum,arc,robinhood";

// --- a Polygon seller is bought; the signed amount is the quote ---------------
reset();
{
  const p = await buy("polygon", [acceptOn("polygon", { amount: "2500" })]);
  const auth = lastPayload?.payload?.authorization;
  ok(!p.e && p.r?.result?.answer === 42 && signs === 1 && paidRequests === 1, `polygon listed: signed once and settled (${p.e ? p.e.message : "ok"})`);
  ok(auth?.value === "2500" && p.r?.quote?.atomic === "2500" && p.r?.quote?.network === "eip155:137", `polygon: the signed value equals the quote (${auth?.value} / ${p.r?.quote?.atomic}) on ${p.r?.quote?.network}`);
  const vb = Number(auth?.validBefore);
  const win = buyer.refusalWindowSeconds();
  ok(signWindow && Number.isFinite(vb) && vb >= signWindow.before + win && vb <= signWindow.after + win && lastPayload?.accepted?.maxTimeoutSeconds === 300,
    `polygon: validBefore is the signing time plus the ${win} s refusal window (+${signWindow ? vb - signWindow.before : "?"}s from the signing call, ${signWindow ? signWindow.after - signWindow.before : "?"}s inside it) and the echoed accept keeps the seller's 300`);
}

// --- the signed-amount assert runs off Base too --------------------------------
reset();
{
  const tamper = evm.client.createPaymentPayload;
  evm.client.createPaymentPayload = async (...a) => { const pl = await tamper(...a); pl.payload.authorization.value = "999"; return pl; };
  const t = await buy("celo", [acceptOn("celo")]);
  evm.client.createPaymentPayload = tamper;
  ok(t.e?.statusCode === 502 && /does not equal the capped quote/.test(t.e.message) && paidRequests === 0, `celo: a signed authorization for another amount is refused before it is sent (${t.e?.message})`);
}

// --- split price on Arbitrum: refused before anything is signed ---------------
reset();
{
  const held = _spentThisWindow();
  const s = await buy("arbitrum", [acceptOn("arbitrum", { amount: "1000", maxAmountRequired: "400000" })]);
  ok(s.e?.statusCode === 502 && s.e?.refused === true && /ambiguous price/.test(s.e.message) && signs === 0 && paidRequests === 0, `arbitrum: amount != maxAmountRequired is refused, nothing signed (${s.e?.statusCode} ${s.e?.message})`);
  ok(_spentThisWindow() === held, "arbitrum: no window budget was held");
  const c = await buy("arbitrum", [acceptOn("arbitrum", { amount: "1000", maxAmountRequired: "1000" })]);
  ok(!c.e && signs === 1, `CONTROL arbitrum: equal amount fields buy (${c.e?.message || "ok"})`);
}

// --- Arc: an unknown asset or a forged decimals hint is never priced by the seller ---
reset();
{
  const u = await buy("arc", [acceptOn("arc", { asset: "0x" + "77".repeat(20), extra: { name: "USDC", version: "2", decimals: 18 } })]);
  ok(u.e?.statusCode === 502 && /offers no arc\/exact\/USDC accept/.test(u.e.message) && signs === 0, `arc: an asset outside the known-assets table is refused (${u.e?.message})`);
  const d = await buy("arc", [acceptOn("arc", { amount: "5000000", extra: { name: "USDC", version: "2", decimals: 18 } })]);
  ok(d.e && /exceeds the 500000 cap/.test(d.e.message) && signs === 0, `arc: a forged extra.decimals does not reprice the amount; it is read at the table's 6 and refused over the cap (${d.e?.message})`);
  const c = await buy("arc", [acceptOn("arc")]);
  ok(!c.e && signs === 1, `CONTROL arc: the known asset buys (${c.e?.message || "ok"})`);
}

// --- Robinhood USDG signs under its own domain ---------------------------------
reset();
{
  const r = await buy("robinhood", [acceptOn("robinhood", { amount: "6000" })]);
  const auth = lastPayload?.payload?.authorization;
  ok(!r.e && signs === 1 && auth?.value === "6000", `robinhood: the USDG accept is signed and settles (${r.e?.message || "ok"})`);
  const types = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
  const message = auth ? { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce } : null;
  const verifyUnder = (name, version) => (message ? verifyTypedData({ address: evm.address, domain: { name, version, chainId: 4663, verifyingContract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }, types, primaryType: "TransferWithAuthorization", message, signature: lastPayload.payload.signature }) : false);
  ok(await verifyUnder("Global Dollar", "1"), "robinhood: the signature recovers to our wallet under the Global Dollar v1 domain on chain 4663");
  ok(!(await verifyUnder("USD Coin", "2")), "robinhood: and not under the USDC domain");
  reset();
  const w = await buy("robinhood", [acceptOn("robinhood", { extra: { name: "USD Coin", version: "2" } })]);
  ok(w.e?.statusCode === 502 && w.e?.refused === true && /Global Dollar/.test(w.e.message) && signs === 0, `robinhood: an accept advertising the USDC domain is refused before signing (${w.e?.message})`);
  const v = await buy("robinhood", [acceptOn("robinhood", { extra: { name: "Global Dollar", version: "2" } })]);
  ok(v.e?.refused === true && /version/.test(v.e.message) && signs === 0, "robinhood: a wrong domain version is refused too");
  const n = await buy("polygon", [acceptOn("polygon", { extra: {} })]);
  ok(n.e?.refused === true && signs === 0, "polygon: an accept naming no domain is refused, never signed under a guess");
}

// --- evidence wallets and the refusal proof off Base ---------------------------
reset();
{
  const W1 = "0x" + "1a".repeat(20);
  const x = await buy("celo", [acceptOn("celo")], { evidenceWallets: [W1] });
  ok(x.e?.statusCode === 502 && /belongs to a different wallet/.test(x.e.message) && signs === 0, `celo: a 402 paying outside the evidence wallets is refused (${x.e?.message})`);
  const c = await buy("celo", [acceptOn("celo", { payTo: W1 })], { evidenceWallets: [W1] });
  ok(!c.e && signs === 1, "CONTROL celo: paying the evidence wallet buys");
  reset();
  let asked = null;
  const held = _spentThisWindow();
  const r = await buy("polygon", [acceptOn("polygon")], { memoizeDelivery: true, notDebited: async (q) => { asked = q; return { debited: false, observed: 1, expired: true }; } }, { paid: "refuse" });
  ok(r.e?.refused === true && r.e?.committed === false && asked?.chain === "polygon" && asked?.token === chains.EVM_BUYER_CHAINS.polygon.asset && /^0x[0-9a-f]{64}$/i.test(asked?.nonce || ""), `polygon: a refused paid retry is proven unused on the chain's own token and released (${r.e?.message})`);
  ok(_spentThisWindow() === held, "polygon: the hold was given back");
  const u = await buy("polygon", [acceptOn("polygon")], { allowUnproven: true });
  ok(u.e?.statusCode === 409 && /Base only/.test(u.e.message), "the unproven lane is not opened off Base");
}

// --- route-execute: dispatch, per-chain day, per-chain low balance -----------
{
  const { buildRouteExecuteTool, EXEC_TIERS, externalChainsFor, externalChainOfNetwork, cachedSpendingWalletStatus } = await import("../src/tools/route-execute.js");
  const guard = await import("../src/external-spend-guard.js");
  const MAX = EXEC_TIERS.find((t) => t.slug === "route-execute-max");
  const cand = (chain) => ({ seller: `https://${chain}-seller.example`, slug: `${chain}-svc`, url: `https://${chain}-seller.example/x`, method: "POST", price: "$0.001", networks: [chains.EVM_BUYER_CHAINS[chain].caip2] });
  let ipSeq = 0;
  const reqOn = (network) => ({ ip: `198.51.100.${++ipSeq}`, header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network }, payload: {} })).toString("base64") : undefined) });
  const run = async (chain, { wallet = async () => ({ status: "ok" }), supported = ["base", "polygon", "celo", "arbitrum", "arc", "robinhood"] } = {}) => {
    const calls = [];
    const exec = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: MAX, resolveExternal: async (_t, o) => [cand(o.chain)],
      payExternal: async (url, opts) => { calls.push(opts.chain); return payX402(url, { ...opts, memoizeDelivery: true }); },
      externalEnabled: () => true, externalChains: () => supported, spendingWalletStatus: wallet,
    });
    globalThis.fetch = seller([acceptOn(chain)]);
    try { return { r: await exec.handler({ task: "t", include: "external" }, reqOn(chains.EVM_BUYER_CHAINS[chain].caip2)), calls }; }
    catch (e) { return { e, calls }; }
  };
  guard.__reset();
  reset();
  const p = await run("polygon");
  ok(p.r?.receipt?.external === true && p.calls.join() === "polygon" && lastPayload?.payload?.authorization?.value === "1000", `route-execute: a buyer who paid on Polygon buys the Polygon seller from the Polygon wallet, signed at the quote (${p.e?.message || "ok"})`);
  ok(Math.abs(guard.walletDailySpentUsd("polygon") - 0.001) < 1e-9 && guard.walletDailySpentUsd("base") === 0, `route-execute: the buy books on Polygon's day, not Base's (${guard.walletDailySpentUsd("polygon")})`);

  // Off the list: not dispatched even when a caller's supported list names it.
  const saved = process.env.SOR_EVM_CHAINS;
  process.env.SOR_EVM_CHAINS = "celo";
  ok(externalChainOfNetwork("eip155:137") === undefined && externalChainsFor("eip155:137", ["base", "polygon"]).length === 0, "polygon off the list maps to no external chain");
  const off = await run("polygon");
  ok(off.e?.statusCode === 409 && off.calls.length === 0, `route-execute: polygon off SOR_EVM_CHAINS is not dispatched (${off.e?.statusCode} ${off.e?.message?.slice(0, 80)})`);
  process.env.SOR_EVM_CHAINS = saved;

  // Per-chain low balance: Polygon reads low, Celo still buys.
  const lowPolygon = async (c) => ({ status: c === "polygon" ? "low" : "ok" });
  const lp = await run("polygon", { wallet: lowPolygon });
  ok(lp.e?.statusCode === 503 && lp.calls.length === 0, `route-execute: the Polygon wallet reading low refuses 503 before paying (${lp.e?.statusCode})`);
  const lc = await run("celo", { wallet: lowPolygon });
  ok(lc.r?.receipt?.external === true && lc.calls.join() === "celo", "route-execute: Celo still buys while only Polygon reads low");

  // Per-chain day: fill Polygon's $25, Polygon refuses, Arbitrum still buys.
  guard.__reset();
  ok(guard.walletDailyCeilingUsd("polygon") === 25 && guard.walletDailyCeilingUsd("arbitrum") === 25, "every EVM buyer chain has the $25 default day");
  guard.noteSpend(null, 25, { chain: "polygon" });
  reset();
  const full = await run("polygon");
  ok(full.e?.statusCode === 429 && /on polygon is paused/.test(full.e.message) && full.calls.length === 0 && signs === 0, `route-execute: past $25 on Polygon the buy is refused before signing (${full.e?.statusCode} ${full.e?.message?.slice(0, 90)})`);
  const other = await run("arbitrum");
  ok(other.r?.receipt?.external === true && other.calls.join() === "arbitrum" && signs === 1, `route-execute: Arbitrum still buys while Polygon's day is full (${other.e?.message || "ok"})`);

  // The default reader is per chain and keyed on the same wallet.
  const st = await cachedSpendingWalletStatus("polygon");
  ok(st === null || ["ok", "low", "unknown", "unconfigured"].includes(st?.status), `the default wallet reader answers per chain without waiting (${JSON.stringify(st)})`);
}

// --- the low-water words: per chain, never a number ----------------------------
{
  const s = await import("../src/upstream-buyer-status.js");
  s.__resetEvmChainStatusForTest();
  const saved = process.env.SOR_EVM_CHAINS;
  delete process.env.SOR_EVM_CHAINS;
  ok(JSON.stringify(await s.upstreamBuyerEvmStatus()) === '{"status":"off"}', "upstreamBuyerEvm reads off with no chain enabled");
  process.env.SOR_EVM_CHAINS = "polygon,celo";
  let addr = null;
  const readBalance = async (a, cfg) => { addr = a; return cfg.name === "polygon" ? 1.25 : 40; };
  const st = await s.upstreamBuyerEvmStatus({ readBalance });
  ok(st.status === "low" && st.chains.polygon.status === "low" && st.chains.celo.status === "ok", `upstreamBuyerEvm: low on the chain that reads low, ok on the other (${JSON.stringify(st)})`);
  ok(addr && addr.toLowerCase() === evm.address.toLowerCase(), "the balance is read for the same spending wallet address");
  ok(!/\d/.test(JSON.stringify(st)), "upstreamBuyerEvm carries words only, no figure");
  s.__resetEvmChainStatusForTest();
  process.env.UPSTREAM_BUYER_LOW_USD_POLYGON = "1";
  const st2 = await s.upstreamBuyerEvmStatus({ readBalance });
  ok(st2.chains.polygon.status === "ok", "UPSTREAM_BUYER_LOW_USD_<CHAIN> sets that chain's mark");
  delete process.env.UPSTREAM_BUYER_LOW_USD_POLYGON;
  s.__resetEvmChainStatusForTest();
  const st3 = await s.upstreamBuyerEvmStatus({ readBalance: async () => null });
  ok(st3.status === "unknown", "an unreadable balance is unknown, never low");
  // A balance that stays unreadable says for how long, so the heartbeat can
  // page on a dead RPC; a readable read clears it, and "off" carries none.
  ok(st3.unknownForMinutes === 0, `the first unknown read starts the clock (${JSON.stringify(st3)})`);
  {
    s.__resetEvmChainStatusForTest();
    const t0 = Date.now();
    await s.upstreamBuyerEvmStatus({ readBalance: async () => null, now: t0 });
    const st4 = await s.upstreamBuyerEvmStatus({ readBalance: async () => null, now: t0 + 70 * 60_000 });
    ok(st4.status === "unknown" && st4.unknownForMinutes === 70, `a balance unreadable for 70 minutes says so (${JSON.stringify(st4)})`);
    const st5 = await s.upstreamBuyerEvmStatus({ readBalance, now: t0 + 200 * 60_000 });
    ok(st5.status !== "unknown" && !("unknownForMinutes" in st5), `a readable read clears the clock (${JSON.stringify(st5)})`);
    delete process.env.SOR_EVM_CHAINS;
    ok(!("unknownForMinutes" in await s.upstreamBuyerEvmStatus()), "off carries no unknown clock");
  }
  process.env.SOR_EVM_CHAINS = saved;
}

// --- dispatch labels: the same gate on every enabled EVM chain -----------------
{
  const { dispatchEligibility } = await import("../src/dispatch-eligibility.js");
  const base = { routable: true, networks: ["eip155:137"], priceUsd: 0.01, minSettled: 50, minPayers: 3 };
  const only = dispatchEligibility({ ...base, settled: 500, payers: 20, spendChains: ["base"] });
  ok(only.reason === "no_supported_route", "a Polygon-only seller with Polygon not enabled: no_supported_route");
  const yes = dispatchEligibility({ ...base, settled: 500, payers: 20, spendChains: ["base", "polygon"] });
  ok(yes.chains.polygon?.eligible === true && yes.chains.polygon.reason === "eligible", "Polygon enabled and proven: eligible");
  const thin = dispatchEligibility({ ...base, settled: 3, payers: 1, spendChains: ["base", "polygon"] });
  ok(thin.chains.polygon?.reason === "settlement_required" && thin.chains.polygon.unprovenTier === undefined, "Polygon below the floor: settlement_required, no unproven tier");
  const dom = dispatchEligibility({ ...base, settled: 500, payers: 20, spendChains: ["base", "polygon"], usdcDomainByChain: { polygon: { asset: chains.EVM_BUYER_CHAINS.polygon.asset, name: "USDC" } } });
  ok(dom.chains.polygon?.reason === "usdc_domain_mismatch", "Polygon accept with the wrong domain name: usdc_domain_mismatch");
}

// --- the global unsettled ceiling covers every listed chain --------------------
{
  const guard = await import("../src/external-spend-guard.js");
  const saved = process.env.SOR_EVM_CHAINS;
  delete process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD;
  delete process.env.SOR_EVM_CHAINS;
  const before = guard.defaultGlobalUnsettledUsd();
  process.env.SOR_EVM_CHAINS = "polygon";
  ok(guard.defaultGlobalUnsettledUsd() === before + 25, `the default global ceiling adds Polygon's $25 day once Polygon is listed (${before} -> ${guard.defaultGlobalUnsettledUsd()})`);
  process.env.SOR_WALLET_DAILY_MAX_USD_POLYGON = "40";
  ok(guard.defaultGlobalUnsettledUsd() === before + 40, "and follows Polygon's own day ceiling");
  delete process.env.SOR_WALLET_DAILY_MAX_USD_POLYGON;
  guard.__reset();
  const g0 = guard.globalExposureUsd();
  guard.noteSpend("0x" + "c1".repeat(20), 2, { chain: "polygon" });
  ok(Math.abs(guard.globalExposureUsd() - g0 - 2) < 1e-9, "an unsettled Polygon spend counts toward the global ceiling");
  process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD = "3";
  const r = await guard.reserveSpend("0x" + "c2".repeat(20), 2, { chain: "polygon" });
  ok(r.ok === false && r.code === "global_unsettled_ceiling", `a Polygon spend past the global ceiling is refused (${r.code})`);
  delete process.env.EXTERNAL_MAX_UNSETTLED_GLOBAL_USD;
  guard.__reset();
  process.env.SOR_EVM_CHAINS = saved;
}

// --- the public "pays you on" list follows the live router chain set ----------
{
  const { routerPayChains } = await import("../src/tools/route-execute.js");
  const { ledgerHomePage } = await import("../src/ledger-home.js");
  const saved = process.env.SOR_EVM_CHAINS;
  delete process.env.SOR_EVM_CHAINS;
  const off = routerPayChains();
  ok(!off.includes("polygon") && off.includes("base"), `unlisted: the router chain set has no Polygon (${off.join(",")})`);
  const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok(!/pays you on [^.]*Polygon/.test(text(ledgerHomePage("https://example.test", {}, {}, {}, []))), "home page: Polygon is not named while unlisted");
  process.env.SOR_EVM_CHAINS = "polygon,robinhood";
  const on = routerPayChains();
  ok(on.includes("polygon") && on.includes("robinhood") && !on.includes("celo"), `listed: Polygon and Robinhood join, Celo does not (${on.join(",")})`);
  ok(/pays you on [^.]*Polygon[^.]*Robinhood/.test(text(ledgerHomePage("https://example.test", {}, {}, {}, []))), "home page: the listed chains are named on the page");
  process.env.SOR_EVM_CHAINS = saved;
}

globalThis.fetch = undefined;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
