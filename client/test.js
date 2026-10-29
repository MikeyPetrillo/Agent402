// agent402-client tested against a server with the x402 paywall ACTIVE, so the
// client really exercises the proof-of-work auto-payment path. The facilitator
// is never contacted (X402_SYNC_ON_START=false); PoW bypasses settlement.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent402, OutputValidationError, withNetworkPreference, withPayeeAllowlist, NETWORK_CAIP2, quoted402Usd, acceptUsd } from "./index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3081;
const proc = spawn("node", ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    // The seller index is not under test: a crawl filling it while the offline
    // cases run would change what route() ranks by the time they finish.
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
// The advisory-caps warning is captured (and still printed) so a test can count it.
const advisoryWarnings = [];
{ const warn = console.warn; console.warn = (...args) => { const line = args.join(" "); if (line.includes("[agent402-client] spending caps")) advisoryWarnings.push(line); warn(...args); }; }

// Offline: withNetworkPreference pins the settlement chain (e.g. USDG on
// Robinhood Chain) on any duck-typed x402 client - no @x402 dependency here.
{
  ok(NETWORK_CAIP2.robinhood === "eip155:4663", "NETWORK_CAIP2 knows robinhood -> eip155:4663");
  ok(NETWORK_CAIP2.arc === "eip155:5042", "NETWORK_CAIP2 knows arc -> eip155:5042");
  const accepts = [{ network: "eip155:8453", a: "base" }, { network: "eip155:4663", a: "usdg" }];
  const seen = [];
  const fake = { createPaymentPayload: (pr) => { seen.push(pr.accepts.map((x) => x.a)); return "ok"; } };
  withNetworkPreference(fake, ["robinhood"]);
  ok(fake.createPaymentPayload({ accepts }) === "ok", "wrapped client delegates");
  ok(JSON.stringify(seen[0]) === '["usdg"]', "preference filters accepts to the pinned chain");
  let threw = false;
  const none = { createPaymentPayload: () => "x" };
  withNetworkPreference(none, ["eip155:1"]);
  try { none.createPaymentPayload({ accepts }); } catch { threw = true; }
  ok(threw, "no-match preference throws before paying");
  const untouched = { createPaymentPayload: (pr) => pr.accepts.length };
  withNetworkPreference(untouched, []);
  ok(untouched.createPaymentPayload({ accepts }) === 2, "empty preference leaves the client untouched");
  // Algorand mainnet is spelled two ways on the wire: the 32-character CAIP-2
  // reference and the full base64 genesis hash. One preference matches both.
  const algoAccepts = [{ network: "eip155:8453", a: "base" }, { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", a: "caip2" }, { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", a: "hash" }];
  const algoSeen = [];
  const algo = { createPaymentPayload: (pr) => { algoSeen.push(pr.accepts.map((x) => x.a)); return "ok"; } };
  withNetworkPreference(algo, ["algorand"]);
  algo.createPaymentPayload({ accepts: algoAccepts });
  ok(JSON.stringify(algoSeen[0]) === '["caip2","hash"]', "an algorand preference matches the CAIP-2 id and the full-hash spelling");
  const byHash = { createPaymentPayload: (pr) => { algoSeen.push(pr.accepts.map((x) => x.a)); return "ok"; } };
  withNetworkPreference(byHash, ["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="]);
  byHash.createPaymentPayload({ accepts: algoAccepts.slice(0, 2) });
  ok(JSON.stringify(algoSeen[1]) === '["caip2"]', "a preference typed as the full hash still matches a seller's CAIP-2 accept");
}

// Offline: withPayeeAllowlist refuses a 402 whose payTo is not allowlisted -
// the buyer-side "who gets paid" control (filters accepts before any signature).
{
  const calls = [];
  const fake = { createPaymentPayload: async (pr) => { calls.push(pr); return { ok: true }; } };
  withPayeeAllowlist(fake, ["0xABCDEF0000000000000000000000000000000001"]);
  await fake.createPaymentPayload({ accepts: [
    { network: "eip155:8453", payTo: "0xabcdef0000000000000000000000000000000001" },
    { network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" },
  ] });
  if (calls.length !== 1 || calls[0].accepts.length !== 1 || calls[0].accepts[0].payTo !== "0xabcdef0000000000000000000000000000000001") { console.error("FAIL: withPayeeAllowlist should keep only the allowlisted payee (case-insensitive 0x)"); process.exit(1); }
  let refused = null;
  try { await fake.createPaymentPayload({ accepts: [{ network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" }] }); } catch (e) { refused = e; }
  if (!refused || !/payee allowlist refused/.test(refused.message)) { console.error("FAIL: withPayeeAllowlist must refuse a quote with no allowlisted payee"); process.exit(1); }
  let empty = null; try { withPayeeAllowlist({ createPaymentPayload: async () => {} }, []); } catch (e) { empty = e; }
  if (!empty) { console.error("FAIL: withPayeeAllowlist with no payees must throw"); process.exit(1); }
  console.log("ok - withPayeeAllowlist filters accepts to allowlisted payees and refuses otherwise");
}
// Offline: buyer spending caps refuse to overpay BEFORE signing (defends the
// x402 "wallet drain via uncapped spending" failure mode). No server needed  - 
// stub the catalog and a paying fetch.
{
  const okResp = { ok: true, json: async () => ({ ok: true }) };
  const mk = (opts) => {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { paid++; return okResp; },     // x402 payFetch (wallet-only path)
      fetchImpl: async () => okResp,                       // plain fetch (unused; catalog is stubbed)
      ...opts,
    });
    c._catalog = new Map([
      ["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }],
      ["pricey", { method: "POST", path: "/api/pricey", computePayable: false, price: "$1.00" }],
    ]);
    return { c, paid: () => paid };
  };

  // per-call cap refuses an over-price tool before any payment
  {
    const { c, paid } = mk({ maxPerCallUsd: 0.05 });
    let e = null; try { await c.call("pricey"); } catch (err) { e = err; }
    ok(e && e.name === "SpendingLimitError" && e.limit === "maxPerCallUsd", "maxPerCallUsd blocks an over-price tool");
    ok(paid() === 0, "blocked call never paid (refused before signing)");
    await c.call("cheap");
    ok(paid() === 1, "under-cap tool pays normally");
    ok(c.spendingSummary().dailyUsd === 0.01, "settled spend is recorded");
  }

  // a refusal is something to branch on, not to regex out of the message
  {
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({ error: "payment required" }), text: async () => "payment required", headers: new Map() }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.status === 402 && e.slug === "cheap" && e.paid === false, "a wallet-only refusal with no payer carries status 402, the slug and paid:false on the Error");
    ok(/wallet-only/.test(e?.message || ""), "...and the message still says what to construct");
  }

  // daily cap sums across calls and blocks the one that would cross it
  {
    const { c, paid } = mk({ dailyLimitUsd: 0.025 });
    await c.call("cheap"); await c.call("cheap"); // 0.02 total
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "dailyLimitUsd", "dailyLimitUsd blocks the call that would cross the ceiling");
    ok(paid() === 2, "exactly the two under-budget calls paid");
  }

  // per-host cap bounds spend to a single seller host
  {
    const { c } = mk({ maxPerHostUsd: 0.015 });
    await c.call("cheap");
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "maxPerHostUsd", "maxPerHostUsd bounds per-seller spend");
  }

  // no caps configured → behavior unchanged (pays regardless of price)
  {
    const { c, paid } = mk({});
    await c.call("pricey");
    ok(paid() === 1, "no caps → default behavior, pays any price");
  }

  // a failed paid call does NOT count against the budget (commit only on settle)
  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false, dailyLimitUsd: 0.05,
      fetch: async () => { paid++; return { ok: false, status: 500 }; },
      fetchImpl: async () => okResp,
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let failed = false; try { await c.call("cheap"); } catch { failed = true; }
    ok(failed && paid === 1, "a failed paid call throws");
    ok(c.spendingSummary().dailyUsd === 0, "a failed paid call does not count against the budget");
  }
}

// Offline: the cap is enforced against the amount the 402 ACTUALLY QUOTES, not
// the catalog price. A route may quote per request from the body (a token-
// metered route, or a chat route priced by the model named in it), so a client
// that budgets from the catalog would sign whatever the seller asked for. x402
// v2 carries the challenge base64 in the PAYMENT-REQUIRED header and leaves the
// body `{}`, which is why reading the body alone learned nothing.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
{
  const okResp = { ok: true, json: async () => ({ ok: true }) };
  const challengeHeader = (usd) => Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "eip155:8453", amount: String(Math.round(usd * 1e6)), asset: BASE_USDC, payTo: "0xdead", extra: { name: "USD Coin" } },
      { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: String(Math.round(usd * 1e6)), asset: SOL_USDC, payTo: "sol" },
    ],
  })).toString("base64");
  // 402 to an unauthenticated send (the preflight), served to one carrying a
  // credits key - so the same stub drives both the preflight and the real call.
  const seller = (quotedUsd, counters) => async (_url, init = {}) => {
    if (init.headers?.Authorization) { counters.paid++; return okResp; }
    counters.preflights++;
    return { ok: false, status: 402, headers: new Headers({ "payment-required": challengeHeader(quotedUsd) }), json: async () => ({}) };
  };
  const mk = (quotedUsd, opts = {}) => {
    const counters = { paid: 0, preflights: 0 };
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { counters.paid++; return okResp; },   // wallet payFetch
      fetchImpl: seller(quotedUsd, counters),
      ...opts,
    });
    c._catalog = new Map([["chat", { method: "POST", path: "/v1/chat/completions", computePayable: false, price: "$0.02" }]]);
    return { c, counters };
  };

  // wallet: a 402 quoting more than the cap is refused BEFORE signing
  {
    const { c, counters } = mk(0.5, { maxPerCallUsd: 0.1 });
    let e = null; try { await c.call("chat", { model: "premium-model" }); } catch (err) { e = err; }
    ok(e?.name === "SpendingLimitError" && e.limit === "maxPerCallUsd", "a 402 quoting over the cap raises SpendingLimitError");
    ok(e?.priceUsd === 0.5 && e?.cap === 0.1 && e?.listPriceUsd === 0.02, "the refusal carries the quoted amount, the cap and the catalog price");
    ok(/\$0\.5\b/.test(e?.message || "") && /\$0\.1\b/.test(e?.message || ""), `the message names both numbers (${e?.message})`);
    ok(counters.paid === 0, "nothing was signed - the wallet was never asked");
    ok(counters.preflights === 1, "exactly one unpaid preflight");
  }

  // wallet: a quote INSIDE the cap still pays, and is booked at the quote
  {
    const { c, counters } = mk(0.05, { maxPerCallUsd: 0.1 });
    const out = await c.call("chat", { model: "mid-model" });
    ok(out?.ok === true && counters.paid === 1, "a quote under the cap pays normally");
    ok(c.spendingSummary().dailyUsd === 0.05, `settled spend is the quote, not the catalog price (${c.spendingSummary().dailyUsd})`);
  }

  // no caps configured -> no preflight at all (the round trip buys nothing)
  {
    const { c, counters } = mk(0.5, {});
    await c.call("chat", {});
    ok(counters.preflights === 0 && counters.paid === 1, "with no cap configured nothing is preflighted");
  }

  // credits: the gate holds and debits the quote too, so the cap reads it
  {
    const { c, counters } = mk(0.5, { creditsKey: `a402_${"k".repeat(40)}`, maxPerCallUsd: 0.1, fetch: undefined });
    let e = null; try { await c.call("chat", { model: "premium-model" }); } catch (err) { e = err; }
    ok(e?.name === "SpendingLimitError" && e.priceUsd === 0.5, "credits: an over-cap quote is refused before the key is spent");
    ok(counters.paid === 0, "credits: no authorized call was made");
  }
  {
    const { c, counters } = mk(0.05, { creditsKey: `a402_${"k".repeat(40)}`, maxPerCallUsd: 0.1, fetch: undefined });
    const out = await c.call("chat", {});
    ok(out?.ok === true && counters.paid === 1, "credits: a quote under the cap still pays");
  }

  // Another chain's price floor in the offer is not what this buyer pays: a
  // $0.001 route whose 402 also carries a $0.005 Robinhood (USDG) accept.
  {
    const RH_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    const flooredHeader = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [
      { scheme: "exact", network: "eip155:8453", amount: "1000", asset: BASE_USDC, payTo: "0xdead", extra: { name: "USD Coin" } },
      { scheme: "exact", network: "eip155:4663", amount: "5000", asset: RH_USDG, payTo: "0xdead", extra: { name: "Global Dollar" } },
    ] })).toString("base64");
    const mkFloored = (opts = {}) => {
      const counters = { paid: 0, preflights: 0 };
      const c = new Agent402({
        baseUrl: "https://seller.example", cache: false,
        fetch: async () => { counters.paid++; return okResp; },
        fetchImpl: async (_url, init = {}) => {
          if (init.headers?.Authorization) { counters.paid++; return okResp; }
          counters.preflights++;
          return { ok: false, status: 402, headers: new Headers({ "payment-required": flooredHeader }), json: async () => ({}) };
        },
        ...opts,
      });
      c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.001" }]]);
      return { c, counters };
    };
    const credits = `a402_${"k".repeat(40)}`;
    {
      const { c, counters } = mkFloored({ creditsKey: credits, maxPerCallUsd: 0.004, fetch: undefined });
      let e = null; try { await c.call("cheap", {}); } catch (err) { e = err; }
      ok(!e && counters.paid === 1, `credits: a $0.004 per-call cap serves the $0.001 route despite a $0.005 floor on another chain (${e?.message || "served"})`);
    }
    {
      // $0.0505, not $0.05: fifty floating-point $0.001s sum a hair over 0.05.
      const { c, counters } = mkFloored({ creditsKey: credits, dailyLimitUsd: 0.0505, fetch: undefined });
      for (let i = 0; i < 60; i++) { try { await c.call("cheap", {}); } catch { break; } }
      ok(counters.paid === 50, `credits: a $0.05 budget pays fifty $0.001 calls, not ten (${counters.paid})`);
    }
    {
      const { c, counters } = mkFloored({ maxPerCallUsd: 0.004, payNetworks: ["base"] });
      let e = null; try { await c.call("cheap", {}); } catch (err) { e = err; }
      ok(!e && counters.paid === 1, `a pre-wrapped fetch paying on Base counts the Base accept ($0.001), not the Robinhood floor (${e?.message || "served"})`);
    }
    {
      const { c, counters } = mkFloored({ maxPerCallUsd: 0.004, payNetworks: ["robinhood"] });
      let e = null; try { await c.call("cheap", {}); } catch (err) { e = err; }
      ok(e?.name === "SpendingLimitError" && e.priceUsd === 0.005 && counters.paid === 0, "a pre-wrapped fetch paying on Robinhood still counts the floored $0.005 and is refused over a $0.004 cap");
    }
    {
      const { c, counters } = mkFloored({ maxPerCallUsd: 0.004 });
      let e = null; try { await c.call("cheap", {}); } catch (err) { e = err; }
      ok(e?.name === "SpendingLimitError" && counters.paid === 0, "a pre-wrapped fetch with no payNetworks keeps counting the dearest accept (it may sign any of them)");
    }
    {
      // A 402 with no option on the declared chains: the wallet may still sign
      // any of them, so the dearest of ALL counts (never the list price).
      const onlyRh = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [
        { scheme: "exact", network: "eip155:4663", amount: "6000", asset: RH_USDG, payTo: "0xdead", extra: { name: "Global Dollar" } } ] })).toString("base64");
      for (const payNetworks of [["base"], ["optimism"], ["nosuchchain"]]) {
        let paid = 0;
        const c = new Agent402({ baseUrl: "https://seller.example", cache: false, maxPerCallUsd: 0.004, payNetworks,
          fetch: async () => { paid++; return okResp; },
          fetchImpl: async () => ({ ok: false, status: 402, headers: new Headers({ "payment-required": onlyRh }), json: async () => ({}) }) });
        c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.001" }]]);
        let e = null; try { await c.call("cheap", {}); } catch (err) { e = err; }
        ok(e?.name === "SpendingLimitError" && e.priceUsd === 0.006 && paid === 0, `payNetworks ${JSON.stringify(payNetworks)} with no option on those chains counts the dearest of all ($0.006) and is refused over a $0.004 cap`);
      }
    }
    for (const [name, caip2] of [["optimism", "eip155:10"], ["monad", "eip155:143"], ["celo", "eip155:42220"], ["avalanche", "eip155:43114"], ["sei", "eip155:1329"], ["stellar", "stellar:pubnet"], ["algorand", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"]]) {
      ok(NETWORK_CAIP2[name] === caip2, `NETWORK_CAIP2 maps ${name} -> ${caip2}`);
    }
  }

  // the decoder itself: v2 `amount`, v1 `maxAmountRequired`, body fallback, and
  // the max across accepts (the wallet picks the chain, so the dearest bounds it)
  {
    const hdr = (obj) => ({ headers: new Headers({ "payment-required": Buffer.from(JSON.stringify(obj)).toString("base64") }), json: async () => ({}) });
    const base = (amount, extra) => ({ network: "eip155:8453", asset: BASE_USDC, amount, ...(extra ? { extra } : {}) });
    ok(await quoted402Usd(hdr({ accepts: [base("20000"), base("500000")] })) === 0.5, "the quote is the dearest accept");
    ok(await quoted402Usd(hdr({ accepts: [{ network: "eip155:8453", asset: BASE_USDC, maxAmountRequired: "3000" }] })) === 0.003, "a v1 maxAmountRequired is read");
    ok(await quoted402Usd({ headers: new Headers(), json: async () => ({ accepts: [base("1000")] }) }) === 0.001, "a body-carried challenge is read when the header has none");
    ok(await quoted402Usd({ headers: new Headers(), json: async () => ({}) }) === null, "an unreadable 402 quotes null, never a guess");
    // The price comes from the known-asset table, never from a decimals value
    // the seller sends: the signer signs the raw amount whatever the hint says.
    ok(await quoted402Usd(hdr({ accepts: [base("5000000", { decimals: 18 })] })) === 5, "a decimals hint is ignored: 5000000 base units of Base USDC is $5");
    ok(await quoted402Usd(hdr({ accepts: [{ network: "eip155:8453", asset: "0x000000000000000000000000000000000000bEEF", amount: "5000000", extra: { decimals: 18 } }] })) === null,
      "an accept in an asset that is not known cannot be priced (null), whatever decimals it declares");
    ok(await quoted402Usd(hdr({ accepts: [{ network: "eip155:137", asset: BASE_USDC, amount: "1000" }] })) === null, "a known address on the wrong network is not a known asset");
    ok(acceptUsd({ network: "stellar:pubnet", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", amount: "10000000" }) === 1, "Stellar USDC is priced at its 7 decimals");
    ok(acceptUsd({ network: "eip155:8453", asset: BASE_USDC.toLowerCase(), amount: "1000" }) === 0.001, "an EVM address matches without case");
    ok(acceptUsd({ network: "eip155:8453", asset: BASE_USDC, amount: "1e6" }) === null, "an amount that is not whole base units cannot be priced");
  }

  // wallet, no signing guard: an accept in an asset this client cannot price
  // is skipped beside one it can (the priced one is the quote the cap is
  // checked against); only an offer with nothing priceable is refused.
  {
    const mkOffer = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
    const unknown = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x000000000000000000000000000000000000bEEF", payTo: "0xdead", extra: { decimals: 18 } };
    const build = (offer, caps = { maxPerCallUsd: 0.1 }) => {
      const counters = { paid: 0, preflights: 0 };
      const c = new Agent402({
        baseUrl: "https://seller.example", cache: false, ...caps,
        fetch: async () => { counters.paid++; return okResp; },
        fetchImpl: async () => { counters.preflights++; return { ok: false, status: 402, headers: new Headers({ "payment-required": offer }), json: async () => ({}) }; },
      });
      c._catalog = new Map([["chat", { method: "POST", path: "/v1/chat/completions", computePayable: false, price: "$0.001" }]]);
      return { c, counters };
    };
    {
      const { c, counters } = build(mkOffer([{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: BASE_USDC, payTo: "0xdead" }, unknown]));
      const r = await c.call("chat", {});
      ok(r && counters.paid === 1 && counters.preflights === 1, "an unknown-asset accept beside a priced Base accept is skipped: the call is paid under the cap");
      ok(c.spendingSummary().dailyUsd === 0.001, `the ledger books the priced accept (${c.spendingSummary().dailyUsd})`);
    }
    {
      const { c, counters } = build(mkOffer([{ scheme: "exact", network: "eip155:8453", amount: "5000000", asset: BASE_USDC, payTo: "0xdead" }, unknown]));
      let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
      ok(e?.name === "SpendingLimitError" && e.limit === "maxPerCallUsd" && counters.paid === 0, `the cap is still checked against the priced accept ($5 over $0.1: ${e?.limit})`);
    }
    {
      const { c, counters } = build(mkOffer([unknown, { ...unknown, network: "eip155:999" }]));
      let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
      ok(e?.name === "SpendingLimitError" && e.limit === "knownAsset" && e.unknownOptions === 2, `an offer with no priceable accept is refused under a cap (${e?.message})`);
      ok(counters.paid === 0, "nothing was signed for it");
    }
  }
}

// Offline: a chain name resolves through the known-asset table to every id
// the chain is spelled with; the short-name map agrees with it.
{
  const { NETWORK_NAMES, networkIdsOf, KNOWN_ASSETS } = await import("./index.js");
  const listed = new Set(Object.values(NETWORK_NAMES).flat());
  ok(Object.keys(KNOWN_ASSETS).every((id) => listed.has(id)), "every network in the known-asset table belongs to a named chain");
  ok(Object.entries(NETWORK_CAIP2).every(([name, id]) => NETWORK_NAMES[name]?.[0] === id), "NETWORK_CAIP2 names each chain's canonical id");
  ok(JSON.stringify(networkIdsOf("Algorand")) === JSON.stringify(NETWORK_NAMES.algorand) && networkIdsOf("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=").length === 2 && JSON.stringify(networkIdsOf("eip155:1")) === '["eip155:1"]' && networkIdsOf("").length === 0, "a name, either spelling of a chain, an unknown id and an empty preference resolve as expected");
}

// Offline: the caps hold on the payment that is SIGNED. A real @x402/core
// client and @x402/fetch wrapper with a throwaway key, against an in-process
// seller that quotes one price on the unpaid preflight and another on the
// request the wallet signs for. No network, no facilitator, no funds.
{
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount("0x" + "22".repeat(32));
  const offer = (accepts) => Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: "https://seller.example/v1/chat/completions", description: "chat", mimeType: "application/json" },
    accepts: accepts.map((a) => ({ scheme: "exact", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...a })),
  })).toString("base64");
  // The seller: the client's own preflight (fetchImpl) sees `preflight`; the
  // payFetch's unpaid request sees `paid`; a request carrying a signature is
  // recorded and answered 200.
  const seller = ({ preflight, paid }) => {
    const seen = { preflights: 0, unpaid: 0, signed: [] };
    const answer402 = (accepts) => new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": offer(accepts) } });
    const preflightFetch = async () => { seen.preflights++; return answer402(preflight); };
    const payInner = async (req) => {
      const sig = req.headers.get("payment-signature");
      if (sig) {
        const payload = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
        seen.signed.push({ network: payload.accepted?.network, amount: payload.accepted?.amount });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      seen.unpaid++;
      return answer402(paid);
    };
    return { seen, preflightFetch, payInner };
  };
  const build = ({ preflight, paid, guard = true, ...caps }) => {
    const s = seller({ preflight, paid });
    const xc = new x402Client();
    xc.setSpendControls?.(false);
    registerExactEvmScheme(xc, { signer: account });
    const payFetch = wrapFetchWithPayment(s.payInner, xc);
    const c = new Agent402({ baseUrl: "https://seller.example", cache: false, fetch: payFetch, fetchImpl: s.preflightFetch, ...(guard ? { x402Client: xc } : {}), ...caps });
    c._catalog = new Map([["chat", { method: "POST", path: "/v1/chat/completions", computePayable: false, price: "$0.01" }]]);
    return { c, seen: s.seen };
  };
  const cheap = [{ network: "eip155:8453", asset: BASE_USDC, amount: "10000" }]; // $0.01
  const dear = [{ network: "eip155:8453", asset: BASE_USDC, amount: "5000000" }]; // $5

  // Control: the same exchange with no guard registered signs the dearer quote.
  // This is what the guard exists to stop, and it shows the fixture really signs.
  {
    const { c, seen } = build({ preflight: cheap, paid: dear, guard: false, maxPerCallUsd: 0.1 });
    await c.call("chat", {});
    ok(seen.signed.length === 1 && seen.signed[0].amount === "5000000", "control: without the guard, a 402 that changes after the preflight gets the dearer one signed");
  }
  {
    const { c, seen } = build({ preflight: cheap, paid: dear, maxPerCallUsd: 0.1 });
    let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
    ok(seen.preflights === 1 && seen.unpaid === 1, "the preflight read $0.01 and the paid request drew its own 402");
    ok(seen.signed.length === 0, "with the guard, the $5 the paid request asked for was never signed");
    ok(e?.name === "SpendingLimitError" && e.atSigning === true && e.limit === "maxPerCallUsd" && e.priceUsd === 5 && /\$5\b/.test(e.message) && /\$0\.1\b/.test(e.message), `the refusal is a SpendingLimitError at signing naming the cap (${e?.message})`);
    ok(c.spendingSummary().calls === 0, "nothing was booked as spent");
  }
  // The pre-wrapped-fetch mode (no x402Client) is the one where caps are
  // advisory, and says so once per process; a guarded client never warns.
  {
    ok(advisoryWarnings.length === 1 && /not on the payment that is signed/.test(advisoryWarnings[0]), `capped calls through a pre-wrapped fetch warned exactly once (saw ${advisoryWarnings.length})`);
    const before = advisoryWarnings.length;
    const { c } = build({ preflight: cheap, paid: cheap, maxPerCallUsd: 0.1 });
    await c.call("chat", {});
    ok(advisoryWarnings.length === before, "a client given its x402Client does not warn");
  }
  // A mixed offer pays the option that fits.
  {
    const mixed = [...dear, { network: "eip155:137", asset: POLYGON_USDC, amount: "20000" }];
    const { c, seen } = build({ preflight: mixed, paid: mixed, maxPerCallUsd: 0.1 });
    await c.call("chat", {});
    ok(seen.signed.length === 1 && seen.signed[0].network === "eip155:137" && seen.signed[0].amount === "20000", "with an over-cap and an in-cap option, the in-cap one is signed");
    ok(c.spendingSummary().dailyUsd === 0.02, `the ledger books the signed amount (${c.spendingSummary().dailyUsd})`);
  }
  // A seller decimals hint does not lower the price the guard reads.
  {
    const hinted = [{ network: "eip155:8453", asset: BASE_USDC, amount: "5000000", extra: { name: "USD Coin", version: "2", decimals: 18 } }];
    const { c, seen } = build({ preflight: cheap, paid: hinted, maxPerCallUsd: 0.1 });
    let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
    ok(seen.signed.length === 0 && e?.name === "SpendingLimitError", "5000000 base units of USDC declared as 18 decimals is still $5, and is refused");
  }
  // An unknown asset is never signed under the guard.
  {
    const odd = [{ network: "eip155:8453", asset: "0x000000000000000000000000000000000000bEEF", amount: "1", extra: { name: "Odd", version: "1", decimals: 18 } }];
    const { c, seen } = build({ preflight: cheap, paid: odd, maxPerCallUsd: 0.1 });
    let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
    ok(seen.signed.length === 0 && e?.name === "SpendingLimitError", `an accept in an unknown asset is not signed (${e?.message})`);
  }
  // The rolling cap is checked at signing against what is left.
  {
    const { c, seen } = build({ preflight: cheap, paid: [{ network: "eip155:8453", asset: BASE_USDC, amount: "60000" }], dailyLimitUsd: 0.1 });
    await c.call("chat", {});
    let e = null; try { await c.call("chat", {}); } catch (err) { e = err; }
    ok(seen.signed.length === 1 && e?.name === "SpendingLimitError" && e.limit === "dailyLimitUsd" && e.atSigning === true,
      `a second $0.06 signature is refused with $0.04 of the daily cap left (${e?.message})`);
  }
}

// Offline: a paid call never follows a redirect. Two real loopback servers, a
// real @x402/fetch wrapper and a throwaway key, nothing on chain. Followed, a
// redirect before the 402 would pay the other origin's payee, and a redirect
// of the signed retry would hand the signature to the other origin; either way
// the other origin's answer would come back as this route's. The control: the
// same client pays a route that does not redirect.
{
  const { createServer } = await import("node:http");
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { PaymentRedirectError } = await import("./index.js");
  const account = privateKeyToAccount("0x" + "22".repeat(32));
  const listen = (handler) => new Promise((res) => { const srv = createServer(handler); srv.listen(0, "127.0.0.1", () => res(srv)); });
  const offerFor = (url, payTo) => Buffer.from(JSON.stringify({ x402Version: 2,
    resource: { url, description: "chat", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: BASE_USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] })).toString("base64");
  const elsewhereSeen = { unpaid: 0, signed: 0 };
  const elsewhere = await listen((req, res) => {
    req.resume();
    if (req.headers["payment-signature"]) { elsewhereSeen.signed++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"from":"elsewhere"}'); }
    elsewhereSeen.unpaid++;
    res.writeHead(402, { "content-type": "application/json", "payment-required": offerFor(`http://127.0.0.1:${elsewhere.address().port}${req.url}`, "0x000000000000000000000000000000000000bEEF") });
    res.end("{}");
  });
  const OTHER = `http://127.0.0.1:${elsewhere.address().port}`;
  const sellerSeen = { signedRedirected: 0, signedServed: 0 };
  const seller = await listen((req, res) => {
    req.resume();
    const signed = Boolean(req.headers["payment-signature"]);
    const here = `http://127.0.0.1:${seller.address().port}${req.url}`;
    if (req.url === "/first") { res.writeHead(307, { location: `${OTHER}${req.url}` }); return res.end(); }
    if (req.url === "/paid" && signed) { sellerSeen.signedRedirected++; res.writeHead(307, { location: `${OTHER}${req.url}` }); return res.end(); }
    if (req.url === "/plain" && signed) { sellerSeen.signedServed++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"from":"seller"}'); }
    res.writeHead(402, { "content-type": "application/json", "payment-required": offerFor(here, "0x000000000000000000000000000000000000dEaD") });
    res.end("{}");
  });
  const SELLER = `http://127.0.0.1:${seller.address().port}`;
  const build = (caps = {}) => {
    const xc = new x402Client();
    xc.setSpendControls?.(false);
    registerExactEvmScheme(xc, { signer: account });
    const c = new Agent402({ baseUrl: SELLER, cache: false, tlsDistrust: false, fetch: wrapFetchWithPayment(fetch, xc), x402Client: xc, ...caps });
    c._catalog = new Map([
      ["first", { method: "POST", path: "/first", computePayable: false, price: "$0.001" }],
      ["paid", { method: "POST", path: "/paid", computePayable: false, price: "$0.001" }],
      ["plain", { method: "POST", path: "/plain", computePayable: false, price: "$0.001" }],
    ]);
    return c;
  };
  try {
    for (const caps of [{}, { maxPerCallUsd: 0.01, dailyLimitUsd: 1 }]) {
      const label = Object.keys(caps).length ? "capped" : "uncapped";
      const c = build(caps);
      const plain = await c.call("plain", { q: 1 });
      ok(plain?.from === "seller" && sellerSeen.signedServed > 0, `${label}: control, a route that does not redirect is paid and answers`);
      let e = null; try { await c.call("first", { q: 1 }); } catch (err) { e = err; }
      ok(e instanceof PaymentRedirectError && e.location === `${OTHER}/first` && e.message.includes(`set baseUrl to ${OTHER}`),
        `${label}: a redirect before the 402 is refused, naming where it pointed (${e?.message})`);
      const before = sellerSeen.signedRedirected;
      e = null; try { await c.call("paid", { q: 1 }); } catch (err) { e = err; }
      ok(sellerSeen.signedRedirected === before + 1, `${label}: control, the route received the signed retry it redirected`);
      ok(e instanceof PaymentRedirectError, `${label}: a redirect of the signed retry is refused (${e?.message})`);
      ok(elsewhereSeen.unpaid === 0 && elsewhereSeen.signed === 0, `${label}: the other origin got no request (${elsewhereSeen.unpaid} unpaid, ${elsewhereSeen.signed} signed)`);
      if (caps.dailyLimitUsd) {
        const spent = c._spend.log.reduce((t, x) => t + x.usd, 0);
        ok(Math.abs(spent - 0.002) < 1e-9, `${label}: the signed-then-redirected payment counts against the caps beside the paid control ($${spent})`);
      }
    }
    // Caps with a pre-wrapped fetch and no x402Client: the client cannot see
    // what was signed, so a redirect on the unpaid preflight must stop the
    // call before anything is reserved, not book the list price as spent.
    {
      const xc = new x402Client();
      xc.setSpendControls?.(false);
      registerExactEvmScheme(xc, { signer: account });
      const c = new Agent402({ baseUrl: SELLER, cache: false, tlsDistrust: false, fetch: wrapFetchWithPayment(fetch, xc), maxPerCallUsd: 0.01, dailyLimitUsd: 0.002 });
      c._catalog = new Map([["first", { method: "POST", path: "/first", computePayable: false, price: "$0.001" }]]);
      let last = null;
      for (let i = 0; i < 3; i++) { try { await c.call("first", { q: i }); } catch (err) { last = err; } }
      ok(last instanceof PaymentRedirectError, `unguarded caps: every redirected call is refused as a redirect, never as a spent cap (${last?.name}: ${last?.message})`);
      ok(c._spend.log.length === 0, `unguarded caps: a refused redirect books no spend (${c._spend.log.length} entries)`);
      ok(elsewhereSeen.unpaid === 0 && elsewhereSeen.signed === 0, "unguarded caps: the other origin got no request");
    }
  } finally { seller.close(); elsewhere.close(); }
}

// Offline: the same refusal on the MPP wire. A real mppx `Fetch.from` client
// (evm charge, throwaway key) is the SDK's `fetch`; the seller answers a real
// HMAC-bound MPP challenge (WWW-Authenticate: Payment) and redirects either
// the unpaid request or the credentialed retry to another origin. The other
// origin must receive nothing and the SDK must refuse with
// PaymentRedirectError. Control: a route that does not redirect is paid.
{
  const { createServer } = await import("node:http");
  const { Challenge } = await import("mppx");
  const { Fetch: MppFetch, evm } = await import("mppx/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { PaymentRedirectError } = await import("./index.js");
  const account = privateKeyToAccount("0x" + "33".repeat(32));
  const listen = (handler) => new Promise((res) => { const srv = createServer(handler); srv.listen(0, "127.0.0.1", () => res(srv)); });
  const challengeFor = (realm, recipient) => Challenge.serialize(Challenge.from({
    realm, method: "evm", intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "1000", currency: BASE_USDC, recipient, methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 } },
    secretKey: "client-test-mpp-redirect",
  }));
  const credentialed = (req) => /^Payment\s/i.test(String(req.headers.authorization || ""));
  const elsewhereSeen = { unpaid: 0, credentialed: 0 };
  const elsewhere = await listen((req, res) => {
    req.resume();
    if (credentialed(req)) { elsewhereSeen.credentialed++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"from":"elsewhere"}'); }
    elsewhereSeen.unpaid++;
    res.writeHead(402, { "content-type": "application/json", "www-authenticate": challengeFor("elsewhere.test", "0x000000000000000000000000000000000000bEEF") });
    res.end("{}");
  });
  const OTHER = `http://127.0.0.1:${elsewhere.address().port}`;
  const sellerSeen = { credentialedRedirected: 0, credentialedServed: 0 };
  const seller = await listen((req, res) => {
    req.resume();
    const paidReq = credentialed(req);
    if (req.url === "/first") { res.writeHead(307, { location: `${OTHER}${req.url}` }); return res.end(); }
    if (req.url === "/paid" && paidReq) { sellerSeen.credentialedRedirected++; res.writeHead(307, { location: `${OTHER}${req.url}` }); return res.end(); }
    if (req.url === "/plain" && paidReq) { sellerSeen.credentialedServed++; res.writeHead(200, { "content-type": "application/json" }); return res.end('{"from":"seller"}'); }
    res.writeHead(402, { "content-type": "application/json", "www-authenticate": challengeFor("seller.test", "0x000000000000000000000000000000000000dEaD") });
    res.end("{}");
  });
  const SELLER = `http://127.0.0.1:${seller.address().port}`;
  try {
    const mppFetch = MppFetch.from({ fetch, methods: [evm.charge({ account, currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
    const c = new Agent402({ baseUrl: SELLER, cache: false, tlsDistrust: false, fetch: mppFetch });
    c._catalog = new Map([
      ["first", { method: "POST", path: "/first", computePayable: false, price: "$0.001" }],
      ["paid", { method: "POST", path: "/paid", computePayable: false, price: "$0.001" }],
      ["plain", { method: "POST", path: "/plain", computePayable: false, price: "$0.001" }],
    ]);
    const plain = await c.call("plain", { q: 1 });
    ok(plain?.from === "seller" && sellerSeen.credentialedServed === 1, "mpp: control, a route that does not redirect is paid with an MPP credential and answers");
    let e = null; try { await c.call("first", { q: 1 }); } catch (err) { e = err; }
    ok(e instanceof PaymentRedirectError && e.location === `${OTHER}/first`, `mpp: a redirect before the 402 is refused, naming where it pointed (${e?.name}: ${e?.message})`);
    e = null; try { await c.call("paid", { q: 1 }); } catch (err) { e = err; }
    ok(sellerSeen.credentialedRedirected === 1, "mpp: control, the route received the credentialed retry it redirected");
    ok(e instanceof PaymentRedirectError && e.location === `${OTHER}/paid`, `mpp: a redirect of the credentialed retry is refused (${e?.name}: ${e?.message})`);
    ok(elsewhereSeen.unpaid === 0 && elsewhereSeen.credentialed === 0, `mpp: the other origin got no request (${elsewhereSeen.unpaid} unpaid, ${elsewhereSeen.credentialed} credentialed)`);
  } finally { seller.close(); elsewhere.close(); }
}

// Offline: caller-supplied output validators bind buyer intent without a peer
// dependency. Validation happens before cache admission, contracted cache hits
// are revalidated, and settled spend survives invalid delivery.
{
  const bodyResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  const paidClient = ({ outputValidator, creditsKey } = {}) => {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example",
      outputValidator,
      creditsKey,
      fetch: creditsKey ? undefined : async () => { paid++; return bodyResponse({ value: 42 }); },
      fetchImpl: async () => { paid++; return bodyResponse({ value: 42 }); },
    });
    c._catalog = new Map([["answer", { method: "POST", path: "/answer", computePayable: false, price: "$0.01" }]]);
    return { c, paid: () => paid };
  };

  // Invalid controls fail before catalog/network work.
  {
    let touched = 0;
    const c = new Agent402({ fetchImpl: async () => { touched++; return bodyResponse({}); } });
    let err = null;
    try { await c.call("answer", {}, { outputValidator: { id: "", validate: () => true } }); } catch (e) { err = e; }
    ok(err instanceof TypeError && touched === 0 && c._catalog === null,
      "invalid per-call outputValidator fails before catalog or network access");
  }

  // A buyer-owned validator is caller code we AWAIT inside call(), and on a paid
  // route the money has already moved by the time it runs - so one that never
  // settles would hang the call forever holding a paid-but-undelivered result.
  // Bounded, and a timeout REJECTS: an unfinished contract is not a satisfied one.
  {
    const c = new Agent402({ fetchImpl: async () => ({}) });
    const started = Date.now();
    let err = null;
    try { await c._assertOutput("slow", { a: 1 }, { id: "hangs/v1", validate: () => new Promise(() => {}), timeoutMs: 200 }, { paid: true }); } catch (e) { err = e; }
    ok(err?.name === "OutputValidationError", `a validator that never settles rejects rather than hanging (got ${err?.name})`);
    ok(err?.paid === true, "and still reports the call WAS paid, so the buyer knows money moved");
    ok(Date.now() - started < 2000, `it gives up promptly (${Date.now() - started}ms)`);
    ok(!!(await c._assertOutput("ok", { a: 1 }, { id: "fine/v1", validate: () => true })), "a normal validator is unaffected");
    ok(!!(await c._assertOutput("ok", { a: 1 }, { id: "slowish/v1", validate: () => new Promise((r) => setTimeout(() => r(true), 30)) })),
      "a slow but finishing validator still passes - the bound is a ceiling, not a race");
  }

  // A valid paid result is admitted and namespaced by its semantic id.
  {
    const { c, paid } = paidClient({ outputValidator: { id: "answer-number/v1", validate: (v) => v.value === 42 } });
    const first = await c.call("answer");
    const second = await c.call("answer");
    ok(first === second && paid() === 1, "valid contracted paid result is cached under its contract identity");
  }

  // A different id never consumes the first contract's cache entry.
  {
    const { c, paid } = paidClient();
    await c.call("answer", {}, { outputValidator: { id: "answer/v1", validate: () => true } });
    await c.call("answer", {}, { outputValidator: { id: "answer/v2", validate: () => true } });
    ok(paid() === 2 && c._cache.size === 2, "different validator ids have disjoint cache entries");
  }

  // Mutating a returned object cannot turn a cache hit into invalid success.
  {
    const validator = { id: "answer-number/v1", validate: (v) => v.value === 42 };
    const { c, paid } = paidClient({ outputValidator: validator });
    const first = await c.call("answer");
    first.value = "wrong";
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.cacheHit && !err.paid,
      "mutated contracted cache hit is rejected and labelled as an unpaid cache hit");
    ok(paid() === 1 && c._cache.size === 0, "invalid cache hit is evicted without another payment");
  }

  // Validation failure occurs after HTTP success and must not erase settled spend.
  {
    const { c, paid } = paidClient({ outputValidator: { id: "answer-impossible/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid && err.contractId === "answer-impossible/v1",
      "false validator result is failed paid delivery with contract identity");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01,
      "invalid paid delivery remains in settled-spend accounting");
    ok(c._cache.size === 0, "invalid paid delivery is never cached");
  }

  // Async callbacks and thrown validation errors have the same fail-closed path.
  {
    const { c } = paidClient({ outputValidator: { id: "async/v1", validate: async () => { throw new Error("bad shape"); } } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.cause?.message === "bad shape" && err.paid,
      "async validator exceptions are wrapped without losing paid-delivery state");
  }

  // Credits are another settled paid path and retain spend on invalid output.
  {
    const creditsKey = `a402_${"A".repeat(32)}`;
    const { c } = paidClient({ creditsKey, outputValidator: { id: "credits/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer"); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid && c.spendingSummary().dailyUsd === 0.01,
      "credits-paid invalid delivery retains settled spend and fails closed");
  }

  // Null cannot silently weaken an inherited constructor validator.
  {
    const { c } = paidClient({ outputValidator: { id: "deny/v1", validate: () => false } });
    let err = null;
    try { await c.call("answer", {}, { outputValidator: null }); } catch (e) { err = e; }
    ok(err instanceof OutputValidationError && err.paid,
      "per-call null preserves the inherited constructor validator");
  }
}

// Offline (#1126): the default Idempotency-Key survives an AGENT-LEVEL retry.
// A lost response is retried one level up - the framework calls call() again -
// so the key must be stable across call() invocations on one client, fresh per
// invocation only when the caller opted out of caching, and distinct between
// client instances. Driven on the credits path, where the server binds the key
// to the credits key hash and replays the paid answer (the wallet path signs a
// fresh authorization per call() and is documented as a new payment).
{
  const creditsKey = `a402_${"B".repeat(32)}`;
  const mk = () => {
    const keys = [];
    let n = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example",
      creditsKey,
      fetchImpl: async (url, init) => {
        keys.push(init.headers["Idempotency-Key"]);
        // First send: the response is LOST after the server has charged.
        if (++n === 1) throw new Error("socket hang up");
        return { ok: true, status: 200, json: async () => ({ value: 7 }) };
      },
    });
    c._catalog = new Map([["answer", { method: "POST", path: "/answer", computePayable: false, price: "$0.01" }]]);
    return { c, keys };
  };
  {
    const { c, keys } = mk();
    let lost = false;
    try { await c.call("answer", { q: 1 }); } catch { lost = true; }
    const out = await c.call("answer", { q: 1 }); // the framework's retry
    ok(lost && out.value === 7 && keys.length === 2 && keys[0] === keys[1] && /^a402-[0-9a-f]{24}$/.test(keys[0]),
      "a retried call() after a lost response reuses the same default Idempotency-Key");
    const other = await c.call("answer", { q: 2 });
    ok(other.value === 7 && keys[2] !== keys[0], "different params on the same client get a different key");
  }
  {
    const { c, keys } = mk();
    try { await c.call("answer", { q: 1 }, { cache: false }); } catch { /* lost */ }
    await c.call("answer", { q: 1 }, { cache: false });
    ok(keys[0] !== keys[1], "{ cache: false } means distinct purchases: a fresh key per invocation");
  }
  {
    const { c, keys } = mk();
    try { await c.call("answer", { q: 1 }, { idempotencyKey: "mine-1" }); } catch { /* lost */ }
    await c.call("answer", { q: 1 }, { idempotencyKey: "mine-1" });
    ok(keys[0] === "mine-1" && keys[1] === "mine-1", "an explicit idempotencyKey always wins");
  }
  {
    const a = mk(), b = mk();
    try { await a.c.call("answer", { q: 1 }); } catch { /* lost */ }
    try { await b.c.call("answer", { q: 1 }); } catch { /* lost */ }
    ok(a.keys[0] !== b.keys[0], "two client instances buying the same thing are two purchases (per-client salt)");
  }
}

// Offline: route() is read-only discovery - exact query encoding, bounded k,
// include/network filters, empty results, non-2xx errors, and no /api/pricing.
{
  const calls = [];
  const routeBody = (task, { k = 5, include = "all", network } = {}) => ({
    query: String(task ?? ""),
    include: include === "external" || include === "local" ? include : "all",
    count: 0,
    sellers: 0,
    results: [],
    ...(network ? { network: String(network) } : {}),
  });
  const mkRoute = () => new Agent402({
    baseUrl: "https://router.example",
    cache: false,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = new URL(url);
      if (u.pathname !== "/api/route") return { ok: false, status: 404, json: async () => ({}) };
      const task = u.searchParams.get("q") ?? "";
      const k = Number(u.searchParams.get("k"));
      const include = u.searchParams.get("include") ?? "all";
      const network = u.searchParams.get("network");
      return { ok: true, json: async () => routeBody(task, { k, include, network }) };
    },
  });

  {
    const c = mkRoute();
    await c.route("screenshot webpage", { k: 3, include: "external", network: "robinhood" });
    ok(calls.length === 1, "route() makes one request");
    const u = new URL(calls[0]);
    ok(u.pathname === "/api/route", "route() hits /api/route");
    ok(u.searchParams.get("q") === "screenshot webpage", "route() encodes task as q");
    ok(u.searchParams.get("k") === "3", "route() encodes bounded k");
    ok(u.searchParams.get("include") === "external", "route() encodes include=external");
    ok(u.searchParams.get("network") === "robinhood", "route() encodes network filter");
    ok(!calls.some((x) => x.includes("/api/pricing")), "route() does not load /api/pricing");
  }

  {
    const c = mkRoute();
    const out = await c.route("", { k: 99, include: "bogus" });
    ok(out.count === 0 && out.results.length === 0, "route() returns empty results for blank task");
    ok(new URL(calls.at(-1)).searchParams.get("k") === "25", "route() caps k at 25");
    ok(new URL(calls.at(-1)).searchParams.get("include") === "all", "route() normalizes unknown include to all");
  }

  {
    const c = mkRoute();
    await c.route("hash", { include: "local" });
    ok(new URL(calls.at(-1)).searchParams.get("include") === "local", "route() passes include=local");
  }

  {
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "busy" }) }),
    });
    let err = null;
    try { await c.route("ocr"); } catch (e) { err = e; }
    ok(err && /route failed: HTTP 503/.test(err.message), "route() throws on non-2xx");
  }

  {
    // A seller's error detail reaches the caller WHOLE. 0.8.4 cut it at 2,000
    // characters and 0.8.5 appended "[N more characters not shown]"; an agent
    // reading the message could not act on the part that was cut. The response
    // body is bounded before parse (maxResponseBytes), which is the real guard.
    const long = `bad input: ${"x".repeat(2_600)} END`;
    const bad = { ok: false, status: 400, json: async () => ({ error: long, expected: { text: "string" } }) };
    const c = new Agent402({ baseUrl: "https://seller.example", cache: false, fetch: async () => bad, fetchImpl: async () => bad });
    c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
    let err = null;
    try { await c.call("t", { text: "a" }); } catch (e) { err = e; }
    ok(err && err.message.includes(long) && err.message.endsWith(`(expected: {"text":"string"})`) && !/more characters not shown/.test(err.message), "a 2,600-character seller error reaches the caller whole, nothing sliced, expected block intact");
  }

  {
    // A refused payment explains itself in `hint` (an x402 refusal) or
    // `detail` (an RFC 9457 problem) and carries no `error`, beside the
    // mirrored offer. The failure text is that sentence, never the bare status
    // and never the offer; a seller's own `error` still comes first.
    const detailOf = (body) => new Agent402({ baseUrl: "https://seller.example", cache: false })
      ._failureDetail("t", { status: 402, json: async () => body });
    const offer = { x402Version: 2, resource: { url: "https://seller.example/api/t" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000" }], extensions: {} };
    const hinted = await detailOf({ reason: "unsupported-scheme", hint: "Scheme \"lightning\" is not offered on this route.", retry: "choose-offered-option", ...offer });
    ok(hinted === 'call "t" failed: HTTP 402 - Scheme "lightning" is not offered on this route.', `an x402 refusal reads as its hint (${hinted})`);
    const problem = await detailOf({ type: "https://paymentauth.org/problems/invalid-challenge", title: "Invalid Challenge", status: 402, detail: "Challenge is invalid.", hint: "Request a fresh challenge.", ...offer });
    ok(problem === 'call "t" failed: HTTP 402 - Challenge is invalid.', `a problem document reads as its detail before its hint (${problem})`);
    const plain = await detailOf({ error: "bad input", hint: "send text" });
    ok(plain === 'call "t" failed: HTTP 402 - bad input', `a body's own error still comes first (${plain})`);
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetch: async () => { paid++; return { ok: true, json: async () => ({}) }; },
      fetchImpl: async (url) => {
        if (String(url).includes("/api/pricing")) return { ok: true, json: async () => ({ endpoints: [] }) };
        return { ok: true, json: async () => ({ query: "x", include: "all", count: 0, sellers: 0, results: [] }) };
      },
    });
    await c.route("summarize pdf");
    ok(paid === 0, "route() does not invoke the payment fetch");
    ok(!c._catalog, "route() does not warm the paid-tool catalog");
  }

  {
    const serverRow = {
      seller: "https://external.example",
      sellerHome: "https://external.example",
      sellerName: "External",
      slug: "render-page",
      name: "render",
      method: "POST",
      route: "/api/render",
      url: "https://external.example/api/render",
      price: "$0.004",
      priceUsd: 0.004,
      executeVia: { tool: "route-execute", price: "$0.01", underlyingPriceUsd: 0.004, routingFeeUsd: 0.006 },
      untrustedContent: true,
      source: "https://external.example",
    };
    const serverBody = {
      query: "screenshot webpage",
      include: "external",
      count: 1,
      sellers: 1,
      results: [serverRow],
      containsUntrustedContent: true,
    };
    const c = new Agent402({
      baseUrl: "https://router.example",
      cache: false,
      fetchImpl: async () => ({ ok: true, json: async () => serverBody }),
    });
    const out = await c.route("screenshot webpage", { include: "external" });
    ok(JSON.stringify(out.results[0]) === JSON.stringify(serverRow),
      "route() returns an opaque server-owned result row unchanged (including executeVia)");
  }
}

// Offline: a discovery read retries a load-shed 503 that names its own delay
// (Retry-After header or retryAfterSeconds body), at most 3 tries with each
// wait capped, then throws naming the surface and the last status. A paid
// call is never repeated by this path.
{
  const shed = (seconds, { header = false } = {}) => new Response(
    JSON.stringify({ error: "The server is busy", ...(header ? {} : { retryAfterSeconds: seconds }) }),
    { status: 503, headers: { "content-type": "application/json", ...(header ? { "retry-after": String(seconds) } : {}) } },
  );
  const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const mk = (answers, extra = {}) => {
    const calls = [];
    const c = new Agent402({ baseUrl: "https://shed.example", cache: false, ...extra, fetchImpl: async (url) => { calls.push(String(url)); return answers.length > 1 ? answers.shift() : answers[0]; } });
    const waits = [];
    c._sleep = async (ms) => { waits.push(ms); };
    return { c, calls, waits };
  };

  {
    const { c, calls, waits } = mk([shed(2), okJson({ results: [{ slug: "hash" }] })]);
    const out = await c.find("hash a string");
    ok(out.length === 1 && out[0].slug === "hash", "find() answers after one shed 503");
    ok(calls.length === 2 && waits.join(",") === "2000", `find() waited the body's retryAfterSeconds once (${waits})`);
  }
  {
    const { c, waits } = mk([shed(1, { header: true }), okJson({ query: "x", results: [] })]);
    await c.route("ocr");
    ok(waits.join(",") === "1000", `route() honors a Retry-After header (${waits})`);
  }
  {
    const { c, waits } = mk([shed(600), okJson({ endpoints: [] })]);
    await c._loadCatalog();
    ok(waits.join(",") === "5000", `a long server delay is capped at 5 s (${waits})`);
  }
  {
    const { c, calls, waits } = mk([shed(2)]);
    let err = null;
    try { await c.find("hash"); } catch (e) { err = e; }
    ok(err && /^find failed: HTTP 503 from \/api\/find after 3 attempts$/.test(err.message), `3 shed 503s throw naming the surface and status (${err && err.message})`);
    ok(err.status === 503 && err.surface === "/api/find" && err.attempts === 3, "the error carries status, surface and attempts");
    ok(calls.length === 3 && waits.length === 2, "exactly 3 attempts, 2 waits");
  }
  {
    const { c, calls } = mk([new Response(JSON.stringify({ error: "busy" }), { status: 503 })]);
    let err = null;
    try { await c.topSellers(); } catch (e) { err = e; }
    ok(calls.length === 1 && /topSellers failed: HTTP 503 from \/api\/leaderboard$/.test(err.message), "a 503 that names no delay is not retried");
  }
  {
    const { c, calls } = mk([new Response(JSON.stringify({ error: "x", retryAfterSeconds: 1 }), { status: 500 })]);
    let err = null;
    try { await c.findWorkflows("audit"); } catch (e) { err = e; }
    ok(calls.length === 1 && err && err.status === 500, "only a 503 is retried, not another status");
  }
  {
    // A paid call answering a shed-looking 503 is reported, never repeated.
    const payCalls = [];
    const c = new Agent402({
      baseUrl: "https://shed.example", cache: false,
      fetchImpl: async () => okJson({ endpoints: [{ slug: "paid", method: "POST", path: "/api/paid", computePayable: false, price: "$0.01" }] }),
      fetch: async (url) => { payCalls.push(String(url)); return shed(1); },
    });
    c._sleep = async () => {};
    let err = null;
    try { await c.call("paid", { a: 1 }); } catch (e) { err = e; }
    ok(err && payCalls.length === 1, `a paid call that answers 503 is sent once (${payCalls.length})`);
  }
}

// Offline: every request the SDK issues carries its own User-Agent product
// token (agent402-client/<version>) - the plain-fetch path AND the x402
// payFetch path that settles real payments - so sellers can attribute paid
// traffic to this SDK (payment_settled.clientUa server-side).
{
  const uas = [];
  const grab = async (_url, init) => { uas.push(init?.headers?.["User-Agent"] ?? null); return { ok: true, json: async () => ({ endpoints: [] }) }; };
  const packageVersion = JSON.parse(readFileSync(join(ROOT, "client/package.json"), "utf8")).version;
  const expectedUa = `agent402-client/${packageVersion}`;
  const c = new Agent402({ baseUrl: "https://seller.example", cache: false, fetch: grab, fetchImpl: grab });
  await c._loadCatalog(); // plain fetch path
  c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
  await c.call("cheap"); // payFetch path
  ok(uas.length >= 2 && uas.every((u) => u === expectedUa),
    `every request carries the current ${expectedUa} product token (got ${JSON.stringify(uas)})`);
}

// Offline: a slow route (async.recommended on its /api/pricing row) is sent
// with Prefer: respond-async and collected from its job link: 202, then
// polling that honors Retry-After, then the route's 200 with its receipt
// header. A fast route is sent without the header; a failed job is a failed
// call whose spend is released; a job still running past the caller's
// timeout throws AsyncJobPendingError with the link and keeps the spend; a
// job link on another origin is never followed.
{
  const { createServer } = await import("node:http");
  const { AsyncJobPendingError } = await import("./index.js");
  const seen = { prefer: [], polls: 0, sleeps: [] };
  let jobPlan = ["running", "running", "succeeded"], jobFail = false, foreignLocation = false, oldServer = false;
  const srv = createServer((req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/pricing") return send(200, { endpoints: [
      { slug: "slow", method: "POST", path: "/v1/slow", computePayable: false, price: "$0.50", async: { recommended: true, expectedSeconds: 40, maxSeconds: 240, prefer: "respond-async", statusUrl: "/api/jobs/{id}" } },
      { slug: "fast", method: "POST", path: "/api/fast", computePayable: false, price: "$0.01" },
    ] });
    if (req.url === "/api/fast") { seen.prefer.push(["fast", req.headers.prefer || null]); return send(200, { fast: true }); }
    if (req.url === "/v1/slow") {
      seen.prefer.push(["slow", req.headers.prefer || null]);
      // The spend-cap preflight (no Prefer, no payment) draws the 402, as live.
      if (!req.headers.prefer) return send(402, { x402Version: 2, accepts: [] });
      seen.polls = 0;
      const id = "ab".repeat(24);
      return send(202, { jobId: id, status: "working", state: "queued", statusUrl: `/api/jobs/${id}`, pollIntervalSeconds: 3 }, { location: foreignLocation ? "https://elsewhere.example/api/jobs/x" : `/api/jobs/${id}`, "retry-after": "3" });
    }
    if (req.url.startsWith("/api/jobs/")) {
      const st = jobPlan[Math.min(seen.polls++, jobPlan.length - 1)];
      if (st === "running") return send(200, { status: "working", state: "running", stage: "generating", progress: 0.5, etaSeconds: 20, pollIntervalSeconds: 2 }, { "retry-after": "2" });
      if (jobFail) return send(200, { status: "failed", state: "failed", message: "The call ended with HTTP 502 and nothing was charged.", error: { httpStatus: 502, body: { error: "upstream down" } } });
      if (oldServer) return send(200, { status: "completed", result: { httpStatus: 200, body: { clip: "done" } } });
      return send(200, { status: "completed", state: "succeeded", progress: 1, result: { httpStatus: 200, headers: { "payment-response": "cmVjZWlwdA==" }, body: { clip: "done" } } });
    }
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const progress = [];
    const c = new Agent402({ baseUrl: base, cache: false, fetch: fetch, fetchImpl: fetch, tlsDistrust: false, onProgress: (d) => progress.push(d.state), dailyLimitUsd: 10 });
    c._sleep = async (ms) => { seen.sleeps.push(ms); };
    const out = await c.call("slow", { prompt: "x" });
    ok(out.clip === "done", "a slow route's job answer is returned as the call's result");
    ok(seen.prefer.filter((p) => p[0] === "slow").map((p) => p[1]).join(",") === ",respond-async", `the unpaid preflight is plain and the paid call carries Prefer: respond-async (${JSON.stringify(seen.prefer)})`);
    ok(JSON.stringify(seen.sleeps) === JSON.stringify([3000, 2000, 2000]), `polling honors Retry-After (${seen.sleeps.join(",")})`);
    ok(JSON.stringify(progress) === JSON.stringify(["queued", "running", "running", "succeeded"]), `onProgress sees each job document (${progress.join(",")})`);
    ok(c.spendingSummary().dailyUsd === 0.5, "a delivered job counts its price as spent");
    await c.call("fast", {});
    ok(seen.prefer.find((p) => p[0] === "fast")?.[1] === null, "a fast route is sent without Prefer");
    const off = new Agent402({ baseUrl: base, cache: false, fetch: fetch, fetchImpl: fetch, tlsDistrust: false, respondAsync: false });
    seen.prefer.length = 0;
    try { await off.call("slow", {}); } catch { /* a 202 is not a result when async is off */ }
    ok(seen.prefer[0]?.[1] === null, "respondAsync: false never asks for a job");
    jobFail = true; jobPlan = ["succeeded"];
    let e = null; try { await c.call("slow", { prompt: "y" }); } catch (x) { e = x; }
    ok(e && e.status === 502 && /upstream down/.test(e.message) && c.spendingSummary().dailyUsd === 0.51, `a failed job is a failed call and its spend is released (${e?.status} ${e?.message?.slice(0, 60)})`);
    jobFail = false; jobPlan = ["running"];
    e = null; try { await c.call("slow", { prompt: "z" }, { asyncTimeoutMs: 4500 }); } catch (x) { e = x; }
    ok(e instanceof AsyncJobPendingError && e.jobUrl === `${base}/api/jobs/${"ab".repeat(24)}` && e.mayBeCharged === true, `a job past the timeout throws AsyncJobPendingError with its link (${e?.name})`);
    ok(c.spendingSummary().dailyUsd === 1.01, "a job still running keeps its spend reserved (it may yet settle)");
    jobPlan = ["succeeded"];
    const collected = await c.collectJob(e.jobUrl);
    ok(collected.clip === "done", "collectJob(jobUrl) collects the answer later");
    oldServer = true;
    const fromOld = await c.collectJob(e.jobUrl);
    ok(fromOld.clip === "done", "a server that sends only the original status (completed) is still collected");
    oldServer = false;
    foreignLocation = true;
    e = null; try { await c.call("slow", { prompt: "w" }); } catch (x) { e = x; }
    ok(e instanceof AsyncJobPendingError && /another origin/.test(e.message), "a job link on another origin is never followed");
  } finally { srv.close(); }
}

// Offline: the Circle Gateway batched option. A real loopback seller offers a
// plain Base accept and a batched one (extra.name GatewayWalletBatched) on the
// same 402, verifies a batched payment's signature under the Gateway domain
// (viem), and can answer a refusal or settlement-pending. Without the option
// the plain accept is paid (through a real @x402/fetch); with it the batched
// one is signed by the gateway signer, under the Gateway domain and not the
// asset's, and sent on the plain fetch; the caps hold before anything is
// signed; a 402 with no batched accept this signer may pay falls back.
{
  const { createServer } = await import("node:http");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { verifyTypedData } = await import("viem");
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { GATEWAY_KIND_NAME, GATEWAY_MAX_TIMEOUT_SECONDS, GatewayPendingError, SpendingLimitError, gatewayAcceptOf, signGatewayPayment } = await import("./index.js");
  const account = privateKeyToAccount("0x" + "44".repeat(32));
  let signs = 0;
  const signer = { address: account.address, signTypedData: (...a) => { signs++; return account.signTypedData(...a); } };
  const GW_WALLET = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const PAY_TO = "0x000000000000000000000000000000000000dEaD";
  const TYPES = { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const unb64 = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const plainAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const batchedAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 604900, extra: { name: GATEWAY_KIND_NAME, version: "1", verifyingContract: GW_WALLET } };
  const arcBatched = { ...batchedAccept, network: "eip155:5042", asset: ARC_USDC };
  const domainOf = (network) => ({ name: GATEWAY_KIND_NAME, version: "1", chainId: Number(network.split(":")[1]), verifyingContract: GW_WALLET });
  const bigMsg = (a) => ({ ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) });
  const st = { mode: "ok", offer: "both", paid: [], pendingLeft: 0 };
  let port = 0;
  const srv = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/pricing") return send(200, { endpoints: [{ slug: "thing", method: "GET", path: "/api/thing", computePayable: false, price: "$0.005" }] });
    if (!req.url.startsWith("/api/thing")) return send(404, {});
    const accepts = st.offer === "both" ? [plainAccept, batchedAccept] : st.offer === "plain" ? [plainAccept] : st.offer === "long" ? [plainAccept, { ...batchedAccept, maxTimeoutSeconds: 365 * 24 * 3600 }] : st.offer === "dear" ? [plainAccept, { ...batchedAccept, amount: "20000" }] : [plainAccept, arcBatched];
    const offer = { x402Version: 2, resource: { url: `http://127.0.0.1:${port}/api/thing`, description: "thing", mimeType: "application/json" }, accepts };
    const header = req.headers["payment-signature"];
    if (!header) return send(402, {}, { "payment-required": b64(offer) });
    let p = null; try { p = unb64(header); } catch { p = null; }
    st.paid.push(p);
    if (p?.accepted?.extra?.name !== GATEWAY_KIND_NAME) return send(200, { paid: "plain", accepted: p?.accepted?.extra?.name || null });
    const a = p.payload.authorization;
    let valid = false;
    try { valid = await verifyTypedData({ address: a.from, domain: domainOf(p.accepted.network), types: TYPES, primaryType: "TransferWithAuthorization", message: bigMsg(a), signature: p.payload.signature }); } catch { valid = false; }
    if (!valid) return send(402, { reason: "invalid-signature", hint: "the signature does not verify under the Gateway domain" }, { "payment-required": b64(offer) });
    if (st.mode === "short") return send(402, { reason: "insufficient-funds", retry: "fund-gateway-deposit", hint: "the signer's Circle Gateway balance holds less than this call costs" }, { "payment-required": b64(offer), "retry-after": "60" });
    if (st.mode === "pending" && st.pendingLeft-- > 0) return send(402, { reason: "settlement-pending", retry: "same-payment", retryAfterSeconds: 1, hint: "not confirmed yet" }, { "retry-after": "1" });
    return send(200, { paid: "gateway", payer: a.from, nonce: a.nonce });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const plainFetch = () => {
    const xc = new x402Client();
    xc.setSpendControls?.(false);
    registerExactEvmScheme(xc, { signer: account });
    return wrapFetchWithPayment(fetch, xc);
  };
  const mk = (opts = {}) => {
    const c = new Agent402({ baseUrl: base, cache: false, tlsDistrust: false, fetchImpl: fetch, ...opts });
    c._sleep = async (ms) => { sleeps.push(ms); };
    return c;
  };
  const sleeps = [];
  const lastPaid = () => st.paid[st.paid.length - 1];
  try {
    // The pure helpers.
    ok(gatewayAcceptOf([plainAccept, batchedAccept]) === batchedAccept, "gatewayAcceptOf picks the batched accept beside the plain one");
    ok(gatewayAcceptOf([plainAccept]) === null && gatewayAcceptOf([batchedAccept], ["arc"]) === null && gatewayAcceptOf([plainAccept, arcBatched], ["arc"]) === arcBatched, "gatewayAcceptOf answers null with no batched accept, or none on the wanted chains, and the chain asked for otherwise");
    ok(gatewayAcceptOf([{ ...batchedAccept, asset: "0x000000000000000000000000000000000000bEEF" }]) === null, "a batched accept in an asset the known-asset table cannot price is never a candidate");
    ok(GATEWAY_MAX_TIMEOUT_SECONDS === 7 * 24 * 3600 + 3600 && gatewayAcceptOf([{ ...batchedAccept, maxTimeoutSeconds: GATEWAY_MAX_TIMEOUT_SECONDS }]) !== null && gatewayAcceptOf([{ ...batchedAccept, maxTimeoutSeconds: GATEWAY_MAX_TIMEOUT_SECONDS + 1 }]) === null && gatewayAcceptOf([{ ...batchedAccept, maxTimeoutSeconds: 365 * 24 * 3600 }]) === null, "a batched accept whose validity window is past seven days and an hour is never a candidate (a year is refused; the ceiling itself is admitted)");
    let longSign = null; try { await signGatewayPayment({ ...batchedAccept, maxTimeoutSeconds: 365 * 24 * 3600 }, { signer: account }); } catch (e) { longSign = e; }
    ok(longSign instanceof TypeError, "signGatewayPayment refuses an oversized validity window before signing");
    {
      const t0 = Math.floor(Date.now() / 1000);
      const { payload, header } = await signGatewayPayment(batchedAccept, { signer: account, resource: { url: `${base}/api/thing` } });
      const a = payload.payload.authorization;
      ok(payload.x402Version === 2 && payload.accepted === batchedAccept && payload.resource?.url === `${base}/api/thing`, "signGatewayPayment builds an x402 v2 payload echoing the accept and the resource");
      ok(a.from === account.address && a.to === PAY_TO && a.value === "5000" && a.validAfter === "0" && /^0x[0-9a-f]{64}$/.test(a.nonce), "the authorization is from the signer to the payTo for the amount, valid from the start, with a fresh 32-byte nonce");
      ok(Math.abs(Number(a.validBefore) - (t0 + 604900)) <= 5, `validBefore is now plus the accept's maxTimeoutSeconds (${Number(a.validBefore) - t0})`);
      const underGateway = await verifyTypedData({ address: account.address, domain: domainOf("eip155:8453"), types: TYPES, primaryType: "TransferWithAuthorization", message: bigMsg(a), signature: payload.payload.signature });
      const underUsdc = await verifyTypedData({ address: account.address, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC }, types: TYPES, primaryType: "TransferWithAuthorization", message: bigMsg(a), signature: payload.payload.signature });
      ok(underGateway && !underUsdc, "the signature verifies under the GatewayWalletBatched domain (verifyingContract from the accept) and not under the asset's USDC domain");
      ok(JSON.stringify(unb64(header)) === JSON.stringify(payload), "the header is the base64 of that payload");
    }
    let bad = null; try { new Agent402({ baseUrl: base, fetchImpl: fetch, gateway: { signer: { address: "nope" } } }); } catch (e) { bad = e; }
    ok(bad instanceof TypeError, "a gateway option without an EIP-712 signer is refused at construction");

    // Off by default: the payment fetch pays the plain accept.
    {
      const c = mk({ fetch: plainFetch() });
      const out = await c.call("thing", { q: 1 });
      ok(out.paid === "plain" && lastPaid()?.accepted?.extra?.name === "USD Coin" && signs === 0, `without the option the plain accept is paid and the gateway signer signs nothing (${out.paid}, ${lastPaid()?.accepted?.extra?.name})`);
    }
    // With the option: the batched accept, signed under the Gateway domain.
    {
      st.paid.length = 0;
      const c = mk({ gateway: { signer } });
      const t0 = Math.floor(Date.now() / 1000);
      const out = await c.call("thing", { q: 1 });
      const p = lastPaid();
      ok(out.paid === "gateway" && out.payer === account.address && signs === 1 && st.paid.length === 1, `with the option the batched accept is signed once and the seller verified it under the Gateway domain (${out.paid})`);
      ok(JSON.stringify(p.accepted) === JSON.stringify(batchedAccept) && p.resource?.url === `${base}/api/thing`, "the payload echoes the batched accept and the 402's resource");
      ok(p.payload.authorization.to === PAY_TO && p.payload.authorization.value === "5000" && Math.abs(Number(p.payload.authorization.validBefore) - (t0 + 604900)) <= 5, "the authorization pays the accept's payTo exactly its amount inside its validity window");
      ok(c.spendingSummary().dailyUsd === 0.005 && c.spendingSummary().calls === 1, `the paid amount is recorded as spend (${c.spendingSummary().dailyUsd})`);
      const again = mk({ gateway: { signer }, fetch: plainFetch() });
      const out2 = await again.call("thing", { q: 2 });
      ok(out2.paid === "gateway", "with both a payment fetch and the option, the batched accept is paid where it is offered");
    }
    // The caps hold before the signature: nothing is signed, nothing is sent.
    {
      const before = { signs, sent: st.paid.length };
      const c = mk({ gateway: { signer }, maxPerCallUsd: 0.001 });
      let e = null; try { await c.call("thing", { q: 3 }); } catch (err) { e = err; }
      ok(e instanceof SpendingLimitError && e.limit === "maxPerCallUsd" && e.priceUsd === 0.005, `an over-cap batched price is refused with SpendingLimitError (${e?.name}: ${e?.message?.slice(0, 80)})`);
      ok(signs === before.signs && st.paid.length === before.sent && c.spendingSummary().dailyUsd === 0, "the refusal signed nothing, sent no payment and reserved nothing");
      const d = mk({ gateway: { signer }, dailyLimitUsd: 0.007 });
      await d.call("thing", { q: 4 });
      e = null; try { await d.call("thing", { q: 5 }); } catch (err) { e = err; }
      ok(e instanceof SpendingLimitError && e.limit === "dailyLimitUsd" && d.spendingSummary().dailyUsd === 0.005, "the rolling daily cap counts settled batched payments and refuses the one that would cross it");
      // The 402 asks more than the catalog lists and the cap sits between: the
      // cap is checked against the accept's amount, never the catalog's figure.
      st.offer = "dear";
      const dear = mk({ gateway: { signer }, maxPerCallUsd: 0.01 });
      const before2 = { signs, sent: st.paid.length };
      e = null; try { await dear.call("thing", { q: 18 }); } catch (err) { e = err; }
      ok(e instanceof SpendingLimitError && e.limit === "maxPerCallUsd" && e.priceUsd === 0.02 && e.listPriceUsd === 0.005 && /quoted \$0\.02; the catalog lists \$0\.005/.test(e.message), `a batched accept quoting more than the catalog price is held to the cap at the quoted amount (${e?.message?.slice(0, 110)})`);
      ok(signs === before2.signs && st.paid.length === before2.sent, "and nothing was signed or sent");
      st.offer = "both";
    }
    // No batched accept this signer may pay: the plain paths, as without the option.
    {
      st.offer = "plain";
      const before = signs;
      const c = mk({ gateway: { signer }, fetch: plainFetch() });
      const out = await c.call("thing", { q: 6 });
      ok(out.paid === "plain" && signs === before, "a 402 with no batched accept falls back to the payment fetch and the gateway signer signs nothing");
      const alone = mk({ gateway: { signer } });
      let e = null; try { await alone.call("thing", { q: 7 }); } catch (err) { e = err; }
      ok(e && e.status === 402 && e.paid === false && /no Circle Gateway batched accept/.test(e.message), `with no other way to pay, the refusal says the seller offers no batched accept (${e?.message?.slice(0, 90)})`);
      st.offer = "both";
      const arcOnly = mk({ gateway: { signer, networks: ["arc"] }, fetch: plainFetch() });
      const out2 = await arcOnly.call("thing", { q: 8 });
      ok(out2.paid === "plain" && signs === before, "a batched accept on a chain outside gateway.networks is not signed; the plain accept is paid");
      st.offer = "arc";
      const out3 = await arcOnly.call("thing", { q: 9 });
      ok(out3.paid === "gateway" && lastPaid().accepted.network === "eip155:5042" && signs === before + 1, "a batched accept on the wanted chain is signed with that chain's id in the domain");
      // A seller asking for a year-long validity window: refused unsigned, the plain accept paid.
      st.offer = "long";
      const longSeller = mk({ gateway: { signer }, fetch: plainFetch() });
      const out4 = await longSeller.call("thing", { q: 13 });
      ok(out4.paid === "plain" && signs === before + 1, "a batched accept with an oversized validity window is never signed; the plain accept is paid");
      const longAlone = mk({ gateway: { signer } });
      let e2 = null; try { await longAlone.call("thing", { q: 14 }); } catch (err) { e2 = err; }
      ok(e2 && e2.status === 402 && signs === before + 1 && /no Circle Gateway batched accept/.test(e2.message), "with no other way to pay, an oversized window is refused without a signature");
      st.offer = "both";
    }
    // A signer that throws: nothing was sent, so the reservation is released.
    {
      const broken = { address: account.address, signTypedData: async () => { throw new Error("hardware wallet locked"); } };
      const sent = st.paid.length;
      const c = mk({ gateway: { signer: broken }, dailyLimitUsd: 1 });
      let e = null; try { await c.call("thing", { q: 15 }); } catch (err) { e = err; }
      ok(e && /hardware wallet locked/.test(e.message) && st.paid.length === sent, "a signer that throws fails the call before any payment is sent");
      ok(c.spendingSummary().dailyUsd === 0 && c._spend.log.length === 0, "and its reservation is released (nothing left the process)");
    }
    // The seller refuses the batched payment: the message carries its words and what to do.
    {
      st.mode = "short";
      const c = mk({ gateway: { signer } });
      let e = null; try { await c.call("thing", { q: 10 }); } catch (err) { e = err; }
      ok(e && e.status === 402 && e.paid === false && /Circle Gateway balance holds less/.test(e.message) && /deposit through Circle's GatewayWallet contract/.test(e.message) && e.message.includes(account.address), `a refusal for a short Gateway balance relays the seller's hint and says to deposit first (${e?.message?.slice(0, 120)})`);
      ok(/stays valid until its validBefore/.test(e.message) && /counts against this client's spending caps/.test(e.message), "and says the sent authorization stays valid and counts against the caps");
      ok(c.spendingSummary().dailyUsd === 0.005 && c.spendingSummary().calls === 1, `a refused batched authorization was sent, so it stays counted against the caps (${c.spendingSummary().dailyUsd})`);
      const capped = mk({ gateway: { signer }, dailyLimitUsd: 0.009 });
      let e3 = null; try { await capped.call("thing", { q: 16 }); } catch (err) { e3 = err; }
      let e4 = null; try { await capped.call("thing", { q: 17 }); } catch (err) { e4 = err; }
      ok(e3?.status === 402 && e4 instanceof SpendingLimitError && e4.limit === "dailyLimitUsd", "a second call after a refusal is held to the daily cap net of the refused authorization");
      st.mode = "ok";
    }
    // settlement-pending: the same header is resent after Retry-After, never a new signature.
    {
      st.mode = "pending"; st.pendingLeft = 1; st.paid.length = 0; sleeps.length = 0;
      const before = signs;
      const c = mk({ gateway: { signer } });
      const out = await c.call("thing", { q: 11 });
      ok(out.paid === "gateway" && st.paid.length === 2 && st.paid[0].payload.authorization.nonce === st.paid[1].payload.authorization.nonce && signs === before + 1, "a pending answer is followed by a resend of the same signed payment (one signature, one nonce)");
      ok(JSON.stringify(sleeps) === "[1000]" && c.spendingSummary().dailyUsd === 0.005, `the resend waits the seller's Retry-After and the call counts once (${sleeps.join(",")})`);
      st.pendingLeft = 99; st.paid.length = 0;
      let e = null; try { await c.call("thing", { q: 12 }); } catch (err) { e = err; }
      ok(e instanceof GatewayPendingError && e.paymentHeader && unb64(e.paymentHeader).payload.authorization.nonce === st.paid[0].payload.authorization.nonce && st.paid.length === 4 && st.paid.every((p) => p.payload.authorization.nonce === st.paid[0].payload.authorization.nonce), `still pending after the resends: GatewayPendingError carries the header that was sent (${st.paid.length} sends, ${e?.name})`);
      ok(e.status === 402 && e.paid === null && c.spendingSummary().dailyUsd === 0.01, "the unconfirmed payment counts against the caps (Gateway may settle it)");
      st.mode = "ok";
    }
  } finally { srv.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const a = new Agent402({ baseUrl: `http://localhost:${PORT}` });

  // 1. find() resolves a task to the right tool.
  const matches = await a.find("hash text with sha256");
  ok(matches.some((m) => m.slug === "hash"), `find() returns the hash tool (got ${matches.map((m) => m.slug).slice(0, 3).join(",")})`);

  // 2. call() auto-solves the proof-of-work on a paywalled free tool.
  const out = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out.hex && out.hex.slice(0, 8) === "b94d27b9", `call() auto-pays via PoW and returns the result (got ${out.hex?.slice(0, 8)})`);

  // 3. second identical call is served from cache (same reference, no re-solve).
  const out2 = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out2 === out, "identical call is served from cache");

  // 4. cache can be bypassed.
  const out3 = await a.call("hash", { text: "hello world", algo: "sha256" }, { cache: false });
  ok(out3 !== out && out3.hex === out.hex, "cache:false re-fetches but returns the same value");

  // 5. solvePow() produces a valid nonce for a difficulty.
  const sol = Agent402.solvePow({ challenge: "abc", difficulty: 8, token: "t" });
  const nonce = sol.split(":").pop();
  const lz = (b) => { let n = 0; for (const x of b) { if (!x) { n += 8; continue; } n += Math.clz32(x) - 24; break; } return n; };
  ok(lz(createHash("sha256").update(`abc:${nonce}`).digest()) >= 8, "solvePow finds a nonce meeting the difficulty");

  // 6. unknown slug is a clear error.
  let threw = false; try { await a.call("definitely-not-a-tool", {}); } catch { threw = true; }
  ok(threw, "unknown slug throws");

  // 7. findWorkflows() surfaces multi-tool skill packs for task-shaped queries.
  const packs = await a.findWorkflows("security audit");
  ok(packs.some((p) => p.slug === "security-audit"), `findWorkflows("security audit") returns the security-audit pack (got ${packs.map((p) => p.slug).slice(0, 3).join(",")})`);

  // 8. getWorkflowPrompt() returns rendered messages with args substituted in.
  const rendered = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
  const promptText = rendered.messages?.[0]?.content?.text ?? "";
  ok(promptText.includes("stripe.com") && !promptText.includes("{{domain}}"), "getWorkflowPrompt substitutes args into the rendered prompt");

  // 9. topSellers() proxies /api/leaderboard with the right envelope. CI runs
  // before the first chain scan finishes, so results may be empty - but the
  // envelope shape and sort/include echo must be correct regardless.
  const sellers = await a.topSellers({ limit: 5, sort: "calls", include: "all" });
  ok(sellers.sort === "calls" && sellers.include === "all", `topSellers echoes sort+include (got sort=${sellers.sort}, include=${sellers.include})`);
  ok(Array.isArray(sellers.results) && sellers.results.length <= 5, `topSellers honors limit (got ${sellers.results?.length} rows)`);
  ok(typeof sellers.source === "string" && sellers.source.endsWith("/api/leaderboard"), "topSellers links to /api/leaderboard");

  // 10. route() proxies /api/route and preserves executeVia metadata.
  const routed = await a.route("hash text with sha256", { k: 3, include: "all" });
  ok(routed.include === "all" && Array.isArray(routed.results), "route() returns the server envelope");
  ok(typeof routed.count === "number" && routed.count <= 3, "route() honors k against the live server");
  const selfHit = routed.results.find((r) => r.slug === "hash" || r.seller === "self");
  ok(selfHit, "route() ranks a local catalog match");
  if (selfHit?.executeVia) ok(typeof selfHit.executeVia.tool === "string", "route() preserves executeVia.tool");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
