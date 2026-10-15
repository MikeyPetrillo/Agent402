// The payment-party screen behind Tempo direct mode (src/sanctions-screen.js,
// wired into src/mpp-tempo.js): the OFAC SDN.XML parse, the refresh that keeps
// the last good set, persistence across a restart, the verdicts, the one-hop
// funding check, and the direct-mode validate refusing before any network
// call. Offline: every fetch is stubbed and the list is a local fixture.
//   node scripts/test-sanctions-screen.js
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { TxEnvelopeTempo } from "ox/tempo";
import { Secp256k1, Address } from "ox";
import { encodeFunctionData, erc20Abi } from "viem";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "sanctions-screen-"));
const FIXTURE = readFileSync(new URL("./fixtures/ofac-sdn-sample.xml", import.meta.url), "utf8");
const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const LISTED_1 = "0xbad0000000000000000000000000000000000001";
const LISTED_2 = "0xbad0000000000000000000000000000000000002";
const LISTED_FUNDER = "0xbad0000000000000000000000000000000000003";
const CLEAN = "0x1234567890123456789012345678901234567890";
const PATH_USD = "0x20C000000000000000000000b9537d11c60E8b50";

process.env.SANCTIONS_SCREEN_FILE = join(dir, "screen.json");
process.env.SANCTIONS_PAYOUT_FILE = join(dir, "payout.json");
process.env.SANCTIONS_LIST_URL = "http://fixture.local/SDN.XML";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
delete process.env.TEMPO_DATA_API_KEY;
delete process.env.TEMPO_API_KEY;
process.env.TEMPO_RELAY = "off";

// One stub for every outbound call; each test reads what reached it.
const realFetch = globalThis.fetch;
const calls = [];
let listBody = FIXTURE, listStatus = 200;
let feed = () => ({ status: 200, body: { data: [], nextCursor: null } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  calls.push(url);
  if (url.startsWith("http://fixture.local/")) return new Response(listBody, { status: listStatus, headers: { "content-type": "application/xml" } });
  if (/\/v1\/transfers\?/.test(url)) { const r = feed(new URL(url)); if (r === "throw") throw new TypeError("fetch failed"); return json(r.status, r.body); }
  if (/api\.tempo\.xyz\/v1\/mpp/.test(url)) return json(200, { success: false, error: { code: "invalid_request", message: "stub" } });
  return json(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub rpc" } });
};
const isRpc = (u) => !u.startsWith("http://fixture.local/") && !/\/v1\/transfers\?/.test(u) && !/api\.tempo\.xyz\/v1\/mpp/.test(u);
const isFeed = (u) => /\/v1\/transfers\?/.test(u);

const S = await import("../src/sanctions-screen.js");
const T = await import("../src/mpp-tempo.js");

// --- parse ------------------------------------------------------------------
{
  const p = S.parseSdnXmlEvmAddresses(FIXTURE);
  ok(p.addresses.size === 3 && p.addresses.has(LISTED_1) && p.addresses.has(LISTED_2) && p.addresses.has(LISTED_FUNDER), `every EVM-format Digital Currency Address is kept, lowercased (${[...p.addresses].join(",")})`);
  ok(![...p.addresses].some((a) => a.endsWith("9")), "an EVM-looking value under a non-currency id type (Passport) is not kept");
  ok(JSON.stringify(p.perAsset) === JSON.stringify({ ETH: 2, USDC: 1, USDT: 1 }), `per-asset counts of EVM addresses (${JSON.stringify(p.perAsset)})`);
  ok(p.digitalCurrencyIds === 8 && p.publishDate === "10/14/2026", `non-EVM and malformed entries are read and skipped (${p.digitalCurrencyIds} currency ids, published ${p.publishDate})`);
  ok(S.parseSdnXmlEvmAddresses("<html>not a list</html>").addresses.size === 0, "a page that is not the export parses to nothing");
}

// --- missing until loaded; no tempo offer in direct mode meanwhile ---------
ok(S.sanctionsScreenStatus() === "missing", "status reads missing before any load");
ok(S.screenAddresses([CLEAN]).reason === "unavailable", "screenAddresses answers unavailable with no list");
ok(T.tempoConfigured() === true && T.tempoEnabled() === false, "direct mode stays configured but not enabled while the list is missing");
ok(T.mintTempoChallenge({ priceUsd: 0.01, realm: "t.local", secretKey: "k" }) === null, "no tempo/charge challenge is minted in direct mode while the list is missing");
ok(T.tempoDiscoveryInfo() === null, "discovery advertises no tempo method while the list is missing");

const SECRET = "test-secret";
function header({ source = CLEAN, signature = "0x76" + "00".repeat(60), type = "transaction", hash } = {}) {
  const ch = Challenge.from({ secretKey: SECRET, realm: "t.local", method: "tempo", intent: "charge", request: { amount: "1000", currency: PATH_USD, recipient: TREASURY, methodDetails: { chainId: 4217 } }, expires: new Date(Date.now() + 60_000).toISOString() });
  const payload = type === "hash" ? { type: "hash", hash } : { type: "transaction", signature };
  return Credential.serialize({ challenge: ch, payload, ...(source ? { source: `did:pkh:eip155:4217:${source}` } : {}) });
}
{
  calls.length = 0;
  const v = await T.validateTempoCredential(header());
  ok(v.ok === false && v.cls === "screen-unavailable", `with no list, direct-mode validate refuses fail-closed (${v.cls})`);
  ok(calls.length === 0, `and makes no network call (${calls.length})`);
  const c = T.TEMPO_REFUSAL_CLASSES["screen-unavailable"];
  ok(c.status === 503 && c.retryAfter > 0 && T.tempoRefusalProblem("screen-unavailable").details.charged === false, "screen-unavailable is a retryable 503 that says nothing was charged");
  const r = T.TEMPO_REFUSAL_CLASSES["screen-rejected"];
  ok(r.status === 402 && T.tempoRefusalProblem("screen-rejected").details.reason === "screen-rejected" && T.tempoRefusalProblem("screen-rejected").details.charged === false, "screen-rejected is a 402 refusal like any unacceptable credential, nothing charged");
}

// --- refresh ------------------------------------------------------------------
{
  const r = await S.refreshSanctionsScreen({ log: () => {} });
  ok(r.ok === true && r.evmAddresses === 3, `a refresh loads the fixture (${JSON.stringify(r)})`);
  ok(S.sanctionsScreenStatus() === "fresh", "status reads fresh after a load");
  ok(T.tempoEnabled() === true && typeof T.mintTempoChallenge({ priceUsd: 0.01, realm: "t.local", secretKey: "k" }) === "string", "with the list loaded, direct mode offers tempo/charge");
  ok(S.screenAddresses([CLEAN, LISTED_1.toUpperCase().replace("0X", "0x")]).reason === "listed" && S.screenAddresses([CLEAN]).ok === true, "screenAddresses: a listed address (any case) is listed, an unlisted one passes");
  ok(S.screenAddresses(["1FixtureBitcoinAddressNotEvm0000001", "not an address"]).ok === true, "non-EVM values are ignored, never matched");
  const view = S.sanctionsScreenOperatorView();
  ok(view.evmAddresses === 3 && view.perAsset.ETH === 2 && typeof view.lastLoadedAt === "string" && !JSON.stringify(view).includes("0xbad"), "the operator view carries counts and lastLoadedAt, never an address");

  const logs = [];
  const loadedAt = view.lastLoadedAt;
  listStatus = 500;
  const f = await S.refreshSanctionsScreen({ log: (m) => logs.push(m) });
  ok(f.ok === false && S.screenAddresses([LISTED_2]).reason === "listed" && S.sanctionsScreenOperatorView().lastLoadedAt === loadedAt, "a failed fetch keeps the previous set");
  ok(logs.length === 1 && /keeping the set/.test(logs[0]), `and logs one line (${logs.length})`);
  listStatus = 200;
  listBody = FIXTURE.replace(/0x[0-9a-fA-F]{40}/g, "1NotEvmAnyMore000000000000000000");
  const z = await S.refreshSanctionsScreen({ log: () => {} });
  ok(z.ok === false && /zero EVM/.test(z.reason) && S.sanctionsScreenOperatorView().evmAddresses === 3, "an export with no EVM address is refused, the set kept");
  listBody = FIXTURE.replace(LISTED_2, "1x").replace(LISTED_2, "1x").replace("0xBAD0000000000000000000000000000000000003", "1x");
  const d = await S.refreshSanctionsScreen({ log: () => {} });
  ok(d.ok === false && /drop past half/.test(d.reason) && S.sanctionsScreenOperatorView().evmAddresses === 3, `a drop past half is refused, the set kept (${d.reason})`);
  listBody = FIXTURE;
  ok(S.sanctionsScreenStatus(Date.now() + 3 * S.sanctionsListRefreshMs()) === "stale" && S.screenAddresses([LISTED_1], Date.now()).reason === "listed", "an old set reads stale and still screens");

  // Restart: a fresh module state reads the stored set at once.
  S.__resetSanctionsScreenForTests();
  ok(S.sanctionsScreenStatus() === "missing", "(reset) a new process starts empty");
  const adopted = await S.loadStoredSanctionsScreen();
  ok(adopted === true && S.sanctionsScreenStatus() === "fresh" && S.screenAddresses([LISTED_FUNDER]).reason === "listed" && S.sanctionsScreenOperatorView().source === "store" && S.sanctionsScreenOperatorView().lastLoadedAt === loadedAt, "after a restart the stored set is back, with its original load time");
  calls.length = 0;
  const tick = await S.sanctionsScreenTick({ log: () => {} });
  ok(tick?.skipped === "fresh" && calls.length === 0, "a tick with a fresh stored set fetches nothing");
}

// --- direct-mode validate ----------------------------------------------------
{
  calls.length = 0;
  const v = await T.validateTempoCredential(header({ source: LISTED_1 }));
  ok(v.ok === false && v.cls === "screen-rejected", `a listed payer (source) is refused (${v.cls})`);
  ok(calls.length === 0, `before any network call (${calls.join(",") || "none"})`);
  ok(!/0xbad0{35}1/i.test(v.error) && /0xbad0\.\.\.0001/.test(v.error), `the refusal names the address masked (${v.error})`);
  const line = T.logTempoRefusal({ method: "GET", path: "/x" }, { cls: v.cls, detail: v.error });
  ok(/class=screen-rejected/.test(line) && !/0xbad0{35}1/i.test(line), "the refusal log line carries the class and no full address");

  // A real signed pull transaction whose transfer pays a listed address.
  const pk = "0x" + "11".repeat(32);
  const signer = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: pk })).toLowerCase();
  const sign = (to) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1000n] });
    const env = TxEnvelopeTempo.from({ chainId: 4217, calls: [{ to: PATH_USD, data }], nonce: 0n, nonceKey: 0n, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    return TxEnvelopeTempo.serialize(env, { signature: { type: "secp256k1", signature: Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey: pk }) } });
  };
  const parties = T.tempoPaymentParties(header({ source: null, signature: sign(LISTED_2) }));
  ok(parties.includes(signer) && parties.includes(LISTED_2) && parties.includes(TREASURY.toLowerCase()) && parties.includes(PATH_USD.toLowerCase()), `parties: signer, transfer recipient, challenge recipient, call target (${parties.length})`);
  calls.length = 0;
  const v2 = await T.validateTempoCredential(header({ source: null, signature: sign(LISTED_2) }));
  ok(v2.cls === "screen-rejected" && calls.length === 0, "a signed transaction paying a listed address is refused before any network call");
  ok(T.tempoPayerAddresses(header({ source: CLEAN, signature: sign(TREASURY) })).sort().join() === [CLEAN, signer].sort().join(), "the payers are the source and the signer only");

  calls.length = 0;
  const v3 = await T.validateTempoCredential(header({ source: CLEAN }));
  ok(v3.ok === false && !/^screen-/.test(v3.cls) && !calls.some((u) => /api\.tempo\.xyz\/v1\/mpp/.test(u)), `an unlisted payer passes the screen to mppx's own verification (refused there: ${v3.cls})`);
  calls.length = 0;
  const b = await T.broadcastTempoCredential(header({ source: LISTED_2 }));
  ok(b.ok === false && b.cls === "screen-rejected" && calls.length === 0, "the broadcast screens again and sends nothing for a listed party");
}

// --- one-hop funding check ---------------------------------------------------
{
  const usd = (n) => ({ destinationToken: { address: PATH_USD.toLowerCase(), decimals: 6 }, destinationAmount: { baseUnits: String(Math.round(n * 1e6)) } });
  const tx = (r, sender, amount) => ({ recipient: r, sender, ...usd(amount) });
  const OTHER = "0x7777777777777777777777777777777777777777";
  // Each payer's inbound transfers: [sender, USD] pairs.
  const WALLETS = {
    "0x2222222222222222222222222222222222222222": [[LISTED_FUNDER, 0.20], [OTHER, 0.05]],   // $0.20 of $0.25 (80%): refused
    "0x2323232323232323232323232323232323232323": [[LISTED_FUNDER, 0.005], [OTHER, 0.045]], // $0.005 dust into $0.05: flagged
    "0x2424242424242424242424242424242424242424": [[LISTED_FUNDER, 1.00], [OTHER, 499]],    // $1.00 into $500: refused
    "0x2525252525252525252525252525252525252525": [[LISTED_FUNDER, 0.50], [OTHER, 4.50]],   // $0.50 of $5 (10%): flagged
    "0x2626262626262626262626262626262626262626": [[LISTED_FUNDER, 0.001]],                 // all dust, 100% but $0.001: flagged
    "0x2727272727272727272727272727272727272727": [[LISTED_FUNDER, 0.06], [LISTED_2, 0.06], [OTHER, 0.10]], // two listed, $0.12 of $0.22 (55%): refused
    "0x2828282828282828282828282828282828282828": [[LISTED_FUNDER, 0.04], [OTHER, 0.01]],   // 80% but $0.04, under the floor: flagged
    "0x3333333333333333333333333333333333333333": [[CLEAN, 3], [OTHER, 2]],                 // clean
  };
  const [P_80, P_DUST, P_1USD, P_10PCT, P_ALLDUST, P_MIXED, P_UNDERFLOOR, P_CLEAN] = Object.keys(WALLETS);
  const P_DOWN = "0x4444444444444444444444444444444444444444";
  const P_PAGED = "0x5555555555555555555555555555555555555555";
  const P_UNVALUED = "0x5656565656565656565656565656565656565656";
  process.env.TEMPO_DATA_API_KEY = "test-data-key";
  feed = (u) => {
    const r = u.searchParams.get("recipient");
    if (WALLETS[r]) return { status: 200, body: { data: WALLETS[r].map(([s, a]) => tx(r, s, a)), nextCursor: null } };
    if (r === P_DOWN) return { status: 503, body: { error: "down" } };
    if (r === P_PAGED) return { status: 200, body: { data: Array.from({ length: 50 }, () => tx(r, CLEAN, 1)), nextCursor: `c${Math.random()}` } };
    if (r === P_UNVALUED) return { status: 200, body: { data: [{ recipient: r, sender: LISTED_FUNDER, destinationToken: { address: "0x9999999999999999999999999999999999999999", symbol: "WETH", decimals: 18 }, destinationAmount: { baseUnits: "5000000000000000000" } }], nextCursor: null } };
    return { status: 200, body: { data: [tx(r, CLEAN, 1)], nextCursor: null } };
  };
  const logs = [];
  const origWarn = console.warn; console.warn = (m) => { logs.push(String(m)); };
  const run = async (payer) => { calls.length = 0; const v = await T.validateTempoCredential(header({ source: payer })); return { v, feedCalls: calls.filter(isFeed).length, rpcCalls: calls.filter(isRpc).length, total: calls.length }; };

  const a = await run(P_80);
  ok(a.v.cls === "screen-rejected" && /funded by a listed address/.test(a.v.error) && /\$0\.200000 in 1 transfer/.test(a.v.error), `$0.20 from a listed funder, 80% of a $0.25 wallet: refused (${a.v.error})`);
  ok(a.total === 1 && a.feedCalls === 1 && a.rpcCalls === 0, `refused before any RPC call: one feed read only (${a.total})`);
  ok(/0x2222\.\.\.2222/.test(a.v.error) && /0xbad0\.\.\.0003/.test(a.v.error) && !/0x2{40}/.test(a.v.error) && !/0xbad0{35}3/i.test(a.v.error), "both addresses are masked in the refusal");
  const u = new URL(calls[0]);
  ok(u.searchParams.get("limit") === "50" && u.searchParams.get("order") === "desc" && u.searchParams.get("timestamp.from"), "the feed read is newest first, 50 per page, inside a lookback window");

  const b = await run(P_DUST);
  ok(!/^screen-/.test(b.v.cls), `$0.005 dust into a $0.05 wallet: allowed (${b.v.cls})`);
  ok(logs.some((l) => /one-hop flagged, allowed: payer 0x2323\.\.\.2323 received \$0\.005000 in 1 transfer\(s\) from listed 0xbad0\.\.\.0003/.test(l)), "and flagged in the log with masked addresses, the amount and the count");
  const c = await run(P_1USD);
  ok(c.v.cls === "screen-rejected", "$1.00 from a listed funder into a $500 wallet: refused (the dollar line)");
  const d = await run(P_10PCT);
  ok(!/^screen-/.test(d.v.cls) && logs.some((l) => /flagged, allowed: payer 0x2525/.test(l)), "$0.50 from a listed funder, 10% of a $5 wallet: allowed and flagged");
  const e = await run(P_ALLDUST);
  ok(!/^screen-/.test(e.v.cls), "a wallet funded only by $0.001 of listed dust: allowed (under the share floor)");
  const f = await run(P_MIXED);
  ok(f.v.cls === "screen-rejected" && /\$0\.120000 in 2 transfer/.test(f.v.error), `mixed: two listed funders sum to $0.12 of $0.22: refused (${f.v.error})`);
  const g = await run(P_UNDERFLOOR);
  ok(!/^screen-/.test(g.v.cls), "80% listed but $0.04, under the $0.10 floor: allowed and flagged");
  const h = await run(P_UNVALUED);
  ok(!/^screen-/.test(h.v.cls) && logs.some((l) => /one-hop unvalued-token/.test(l)), "a listed transfer in a token that cannot be valued is left out of the sums and logged");
  ok(S.oneHopVerdict([{ sender: LISTED_FUNDER, usd: 0.1 }, { sender: OTHER, usd: 0.1 }], new Set([LISTED_FUNDER])).verdict === "listed", "the rule: exactly 50% and exactly the $0.10 floor refuses");
  ok(S.oneHopVerdict([{ sender: LISTED_FUNDER, usd: 0.999 }, { sender: OTHER, usd: 99 }], new Set([LISTED_FUNDER])).verdict === "flagged", "the rule: $0.999 at 1% is flagged");

  const view = S.sanctionsScreenOperatorView().oneHop;
  ok(view.flagged === 5 && view.refused === 3 && view.recentFlags.length === 5 && view.recentFlags[0].payer === "0x5656...5656" && typeof view.recentFlags[0].at === "string", `the operator view counts flags and refusals and keeps the last flags (${view.flagged} flagged, ${view.refused} refused)`);
  ok(!JSON.stringify(view).match(/0x[0-9a-f]{40}/i) && view.rule.minUsd === 1 && view.rule.minShare === 0.5 && view.rule.shareFloorUsd === 0.1, "the operator view never carries a full address and states the rule");

  const cl = await run(P_CLEAN);
  ok(!/^screen-/.test(cl.v.cls) && cl.feedCalls === 1, `a clean payer passes to verification after one feed read (${cl.v.cls})`);
  const cl2 = await run(P_CLEAN);
  ok(cl2.feedCalls === 0, "the cached clean verdict skips a second feed read");
  const fl2 = await run(P_DUST);
  ok(!/^screen-/.test(fl2.v.cls) && fl2.feedCalls === 0, "a cached flagged verdict allows with no second read");
  S.__clearOneHopLocalForTests();
  const cl3 = await run(P_CLEAN);
  ok(cl3.feedCalls === 0, "the verdict is read back from the shared store when the process copy is gone");
  const a2 = await run(P_80);
  ok(a2.v.cls === "screen-rejected" && a2.total === 0, "a cached refused verdict refuses with no read at all");
  const fl3 = await run(P_DUST);
  ok(!/^screen-/.test(fl3.v.cls) && fl3.feedCalls === 0, "a flagged verdict is read back from the shared store too");
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 86400_000;
  const ttl = await run(P_CLEAN);
  Date.now = realNow;
  ok(ttl.feedCalls === 1, "past the TTL the payer is read again");

  const pg = await run(P_PAGED);
  ok(pg.feedCalls === 2, `the read stops at the page cap (${pg.feedCalls} pages)`);

  const dn = await run(P_DOWN);
  ok(!/^screen-/.test(dn.v.cls) && dn.feedCalls === 1, `feed down: the payment falls back to the exact match and goes on to verification (${dn.v.cls})`);
  ok(S.oneHopStatus() === "degraded" && S.sanctionsScreenOperatorView().oneHop.status === "degraded" && /HTTP 503/.test(S.sanctionsScreenOperatorView().oneHop.lastError), "the operator view reports the failed feed read");
  const dn2 = await run(P_DOWN);
  ok(dn2.feedCalls === 1, "a failed read is not cached (the next payment reads again)");
  ok(logs.filter((l) => /one-hop unavailable/.test(l)).length === 1, `one log word per minute, not per payment (${logs.filter((l) => /one-hop unavailable/.test(l)).length})`);
  feed = () => "throw";
  const ex = await run(LISTED_1);
  ok(ex.v.cls === "screen-rejected" && ex.total === 0, "with the feed down the exact match still refuses a listed payer");
  console.warn = origWarn;

  delete process.env.TEMPO_DATA_API_KEY;
  const n = await run("0x6666666666666666666666666666666666666666");
  ok(!/^screen-/.test(n.v.cls) && n.feedCalls === 0 && S.oneHopStatus() === "off", "no data key: exact match only, status off, no feed read");
}

// --- relay mode never consults the screen ------------------------------------
{
  delete process.env.TEMPO_RELAY;
  process.env.TEMPO_API_KEY = "test-tempo-key";
  process.env.TEMPO_DATA_API_KEY = "test-data-key";
  S.__resetSanctionsScreenForTests(); // list missing: relay mode must not care
  calls.length = 0;
  const v = await T.validateTempoCredential(header({ source: LISTED_1 }));
  ok(!/^screen-/.test(v.cls) && calls.some((u) => /api\.tempo\.xyz\/v1\/mpp\/validate/.test(u)) && !calls.some(isFeed), `relay mode sends the credential to the relay, no screen, no feed read (${v.cls})`);
  ok(T.tempoEnabled() === true, "relay mode is enabled with no screen list loaded");
}

// --- the long entry, and one download feeding both readers -------------------
// The screen and the sanctions tools (src/tools/sanctions-kit.js) read the
// same parse through src/ofac-sdn.js: a refresh that comes due inside the
// reuse window takes the parse the other fetched, and two at once share one
// fetch. The long fixture entry carries 60 addresses, the shape SDN.CSV cut.
{
  const LONG = readFileSync(new URL("./fixtures/ofac-sdn-long-entry.xml", import.meta.url), "utf8");
  const BOTH = FIXTURE.replace("</sdnList>", LONG.slice(LONG.indexOf("<sdnEntry>"), LONG.indexOf("</sdnList>")) + "</sdnList>");
  const longEvm = [...LONG.matchAll(/<idNumber>(0x[0-9a-fA-F]{40})<\/idNumber>/g)].map((m) => m[1].toLowerCase());
  const p = S.parseSdnXmlEvmAddresses(LONG);
  ok(longEvm.length === 25 && longEvm.every((a) => p.addresses.has(a)) && p.addresses.size === 24, `every EVM address on the long entry is kept (${p.addresses.size} distinct of ${longEvm.length} listings)`);
  ok(JSON.stringify(p.perAsset) === JSON.stringify({ ARB: 4, BSC: 4, ETC: 4, ETH: 4, USDC: 4, USDT: 4 }), `per-asset counts across every EVM ticker (${JSON.stringify(p.perAsset)})`);

  const K = await import("../src/tools/sanctions-kit.js");
  const L = await import("../src/ofac-sdn.js");
  const listCalls = () => calls.filter((u) => u.startsWith("http://fixture.local/")).length;
  S.__resetSanctionsScreenForTests();
  L.__resetSdnListForTests();
  listBody = BOTH;
  calls.length = 0;
  await K.loadSanctions({ force: true });
  const r1 = await S.refreshSanctionsScreen({ maxAgeMs: S.sanctionsListRefreshMs() / 4, log: () => {} });
  ok(listCalls() === 1, `the kit's load and the screen's refresh after it make one download (${listCalls()})`);
  ok(r1.ok && r1.evmAddresses === 27 && K.sanctionsStatus().addresses === 67, `both read the same list (screen ${r1.evmAddresses} EVM, kit ${K.sanctionsStatus().addresses} addresses)`);
  ok(S.sanctionsScreenOperatorView().lastLoadedAt === K.sanctionsStatus().fetchedAt, "the screen's load time is the shared fetch's time, never the time it was reused");
  ok(longEvm.every((a) => S.screenAddresses([a]).reason === "listed"), "every EVM address on the long entry is refused by the screen");

  L.__resetSdnListForTests();
  calls.length = 0;
  const [, r2] = await Promise.all([K.loadSanctions({ force: true }), S.refreshSanctionsScreen({ maxAgeMs: S.sanctionsListRefreshMs() / 4, log: () => {} })]);
  ok(listCalls() === 1 && r2.ok, `a kit load and a screen refresh at the same time share one download (${listCalls()})`);

  calls.length = 0;
  const later = Date.now() + 7 * 3600_000;
  await S.sanctionsScreenTick({ now: () => later, log: () => {} });
  ok(listCalls() === 1, `a screen refresh due past the reuse window downloads again (${listCalls()})`);
  ok(K.sanctionsStatus().fetchedAt === new Date(later).toISOString() && S.sanctionsScreenOperatorView().lastLoadedAt === K.sanctionsStatus().fetchedAt, "the kit adopts the list the screen fetched, so its own timer has nothing to download");
  calls.length = 0;
  await K.loadSanctions({ now: () => later + 3600_000 });
  ok(listCalls() === 0, `and a kit load inside its refresh period then downloads nothing (${listCalls()})`);
  listBody = FIXTURE;
}

// --- a real paid-mode boot in direct mode ------------------------------------
// No tempo/charge challenge in the 402 while the list is missing; the public
// status is one word; with the list the challenge is offered; a restart reads
// the stored list at once even when the source is down.
{
  globalThis.fetch = realFetch;
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { getFreePort } = await import("./lib/free-port.js");
  let listUp = false;
  const src = createServer((req, res) => {
    if (req.url === "/supported") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })); }
    if (req.url === "/SDN.XML" && listUp) { res.writeHead(200, { "Content-Type": "application/xml" }); return res.end(FIXTURE); }
    res.writeHead(503); res.end();
  });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const SRC = `http://127.0.0.1:${src.address().port}`;
  const TOKEN = "screen-test-operator-token-0123456789";
  let proc = null;
  process.on("exit", () => { try { proc?.kill("SIGKILL"); } catch { /* gone */ } });
  const boot = async () => {
    const port = await getFreePort();
    proc = spawn(process.execPath, ["src/server.js"], {
      env: { ...process.env, PORT: String(port), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base", FACILITATOR_URL: SRC, MPP_SECRET_KEY: "boot-secret",
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", X402_INDEX_CRAWL: "off",
        TEMPO_RELAY: "off", TEMPO_API_KEY: "", TEMPO_DATA_API_KEY: "", TEMPO_RECIPIENT_ADDRESS: TREASURY, AGENT402_OPERATOR_TOKEN: TOKEN,
        SANCTIONS_LIST_URL: `${SRC}/SDN.XML`, SANCTIONS_SCREEN_FILE: join(dir, "boot-screen.json"), SANCTIONS_LIST_RETRY_MS: "1000" },
      stdio: process.env.DEBUG_SCREEN ? "inherit" : "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) { try { if ((await realFetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    return base;
  };
  const tempoOffered = async (base) => { const r = await realFetch(`${base}/api/uuid`); const h = r.headers.get("www-authenticate") || ""; if (process.env.DEBUG_SCREEN) console.log("WWW", r.status, h.slice(0, 300)); return /method="tempo"/.test(h); };
  const status = async (base, auth) => (await (await realFetch(`${base}/api/gateway-status`, auth ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {})).json()).sanctionsScreen;
  try {
    let base = await boot();
    const pub = await status(base);
    ok(pub?.status === "missing" && Object.keys(pub).join() === "status", `boot with the source down: the public status is one word (${JSON.stringify(pub)})`);
    const op = await status(base, true);
    ok(op?.evmAddresses === 0 && "lastLoadedAt" in op && op.oneHop?.status === "off", "the operator view adds the counts, the load time and the one-hop word");
    ok(!(await tempoOffered(base)), "no tempo/charge challenge in the 402 while the list is missing");
    listUp = true;
    let fresh = false;
    for (let i = 0; i < 40 && !fresh; i++) { await new Promise((r) => setTimeout(r, 250)); fresh = (await status(base))?.status === "fresh"; }
    ok(fresh, "the retry tick loads the list once the source answers");
    ok(await tempoOffered(base), "with the list loaded the 402 offers tempo/charge");
    proc.kill("SIGKILL");
    listUp = false;
    base = await boot();
    ok((await status(base))?.status === "fresh" && await tempoOffered(base), "a restart with the source down reads the stored list at once and offers tempo");
    proc.kill("SIGKILL");
  } finally {
    try { proc?.kill("SIGKILL"); } catch { /* gone */ }
    src.close();
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-sanctions-screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
