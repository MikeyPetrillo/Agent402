// Payer screening on every rail (src/payer-screen-rails.js, the x402 payer
// screen, the Tempo gate), one block per rail. Each block refuses a listed
// payer and, as its live control, serves the same payment from an unlisted
// one; with no list loaded it serves (never limit a buyer who is not listed),
// except Tempo direct mode, which is documented to fail closed.
//   - x402 on an EVM chain (EIP-3009 and Permit2), Circle Gateway batched,
//     the MPP evm credential as the shim hands it to the paywall: the signed
//     payer, through the real middleware;
//   - x402 on Solana, Stellar and Algorand: the signers the reader returns,
//     against the payout map;
//   - MPP Tempo through the relay: the payer the credential names, refused
//     before any relay call; an unlisted payer reaches the relay; no list
//     loaded reaches the relay too; the sender the relay settled on is
//     screened after it answers;
//   - MPP Tempo direct mode: refuses with no list (its documented rule);
//   - MPP card, credits and card checkout: no payer address exists, and the
//     conformance cells say so (identifier null);
//   - every conformance row names the identifier its screen reads.
//   node scripts/test-payer-screen-rails.js
import "./lib/file-mode.js"; // file backends: never the caller's database or Redis
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "payer-screen-rails-"));
const LISTED = "0x" + "5a".repeat(20);
const CLEAN = "0x" + "c1".repeat(20);
const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const PATH_USD = "0x20C000000000000000000000b9537d11c60E8b50";
const SECRET = "s".repeat(40);
process.env.SANCTIONS_SCREEN_FILE = join(dir, "screen.json");
process.env.SANCTIONS_PAYOUT_FILE = join(dir, "payout.json");
process.env.SANCTIONS_LIST_URL = "http://127.0.0.1:9/SDN.XML";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
delete process.env.TEMPO_RELAY;
delete process.env.TEMPO_DATA_API_KEY;
process.env.TEMPO_API_KEY = "test-tempo-key";

// Every outbound call is stubbed and counted: a relay call is the proof a
// credential got past the screen.
const calls = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  calls.push(url);
  if (/api\.tempo\.xyz\/v1\/mpp/.test(url)) return new Response(JSON.stringify({ success: false, error: { code: "invalid_request", message: "stub" } }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub rpc" } }), { status: 200, headers: { "content-type": "application/json" } });
};
const relayCalls = () => calls.filter((u) => /api\.tempo\.xyz\/v1\/mpp/.test(u)).length;

const S = await import("../src/sanctions-screen.js");
const K = await import("../src/tools/sanctions-kit.js");
const P = await import("../src/payer-screen-rails.js");
const { createX402PayerScreen, __resetX402PayerScreenForTests } = await import("../src/x402-payer-screen.js");
const T = await import("../src/mpp-tempo.js");
const { conformanceRails } = await import("../src/conformance.js");

const loadList = async (addresses) => {
  S.__resetSanctionsScreenForTests();
  if (addresses) {
    writeFileSync(process.env.SANCTIONS_SCREEN_FILE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: addresses.length }, addresses }));
    await S.loadStoredSanctionsScreen();
  } else {
    rmSync(process.env.SANCTIONS_SCREEN_FILE, { force: true });
  }
};

// One request through the real x402 payer screen.
const runScreen = (headers, { nonEvm = null } = {}) => new Promise((resolve) => {
  const mw = createX402PayerScreen({ log: () => {}, ...(nonEvm ? { nonEvmAddressesOf: async () => nonEvm } : {}) });
  const out = { next: false, code: null, body: null };
  const req = { method: "POST", path: "/api/hash", header: (k) => headers[String(k).toLowerCase()] ?? null, headers };
  const res = { setHeader() {}, status(c) { out.code = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
  mw(req, res, () => { out.next = true; resolve(out); });
});
const refused = (r) => !r.next && r.code === 403 && r.body?.charged === false;

// ---- x402 EVM, Gateway batched, MPP evm (signed payer) ----
{
  await loadList([LISTED]);
  __resetX402PayerScreenForTests();
  const eip3009 = (from, accepted = { scheme: "exact", network: "eip155:8453" }) => b64({ x402Version: 2, accepted, payload: { signature: "0x", authorization: { from, to: TREASURY, value: "1000", nonce: "0x01" } } });
  const permit2 = (from) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x", permit2Authorization: { from, nonce: "1" } } });
  const gateway = (from) => eip3009(from, { scheme: "exact", network: "eip155:8453", extra: { name: "GatewayWalletBatched", version: "1" } });
  for (const [rail, hdr] of [["x402 EVM (EIP-3009)", eip3009], ["x402 EVM (Permit2)", permit2], ["Circle Gateway batched", gateway], ["MPP evm (the header the shim hands the paywall)", eip3009]]) {
    ok(refused(await runScreen({ "payment-signature": hdr(LISTED) })), `${rail}: a listed payer is refused 403 before the handler, not charged`);
    ok((await runScreen({ "payment-signature": hdr(CLEAN) })).next, `${rail}: CONTROL an unlisted payer is served`);
  }
  const shim = readFileSync(new URL("../src/mpp-shim.js", import.meta.url), "utf8");
  ok(/req\.headers\[PAYMENT_SIGNATURE_HEADER\] = t\.paymentSignature;/.test(shim) && /payload: \{ authorization, signature \}/.test(shim), "the MPP evm shim hands the paywall an x402 header carrying the signed authorization, which the screen reads");
  await loadList(null);
  ok((await runScreen({ "payment-signature": eip3009(LISTED) })).next, "x402 EVM: no list loaded, served (fails open, never refuses a buyer for our missing list)");
}

// ---- x402 Solana, Stellar, Algorand (the transaction's signers) ----
{
  const SOL = "So1aNa1111111111111111111111111111111111111";
  const XLM = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const ALGO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
  for (const [rail, network, addr, asset] of [["x402 Solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SOL, "SOL"], ["x402 Stellar", "stellar:pubnet", XLM, "XLM"], ["x402 Algorand", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", ALGO, "ALGO"]]) {
    const hdr = { "payment-signature": b64({ x402Version: 2, accepted: { scheme: "exact", network }, payload: { transaction: "AQAB" } }) };
    K.__seedPayoutListForTests([{ address: addr, asset, entity: "TEST FIXTURE", sdnId: "1" }]);
    __resetX402PayerScreenForTests();
    ok(refused(await runScreen(hdr, { nonEvm: [addr] })), `${rail}: a listed signer is refused 403 before the handler, not charged`);
    K.__seedPayoutListForTests([{ address: "UNRELATED", asset, entity: "TEST FIXTURE", sdnId: "2" }]);
    ok((await runScreen(hdr, { nonEvm: [addr] })).next, `${rail}: CONTROL the same payment from an unlisted signer is served`);
    ok(P.x402ScreenKey(network) !== "x402-evm" && typeof P.PAYER_SCREEN_RAILS[P.x402ScreenKey(network)].identifier === "string", `${rail}: the screen table names what it reads (${P.x402ScreenKey(network)})`);
  }
  K.__resetPayoutListForTests();
}

// ---- MPP Tempo through the relay (the new screen) ----
const tempoHeader = (source) => {
  const ch = Challenge.from({ secretKey: SECRET, realm: "t.local", method: "tempo", intent: "charge", request: { amount: "1000", currency: PATH_USD, recipient: TREASURY, methodDetails: { chainId: 4217 } }, expires: new Date(Date.now() + 60_000).toISOString() });
  return Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: "0x76" + "00".repeat(60) }, source: `did:pkh:eip155:4217:${source}` });
};
{
  ok(T.tempoSettlementMode() === "relay", "control: the Tempo gate is in relay mode (the default)");
  await loadList([LISTED]);
  P.__resetRelayPayerScreenForTests();
  calls.length = 0;
  const v = await T.validateTempoCredential(tempoHeader(LISTED));
  ok(v.ok === false && v.cls === "screen-rejected" && relayCalls() === 0, `relay mode: a listed payer is refused before any relay call (${v.cls}, relay calls ${relayCalls()})`);
  ok(!String(v.error).includes(LISTED) && /relay mode/.test(v.error), "the log line masks the address");
  ok(T.tempoRefusalProblem("screen-rejected").details.charged === false, "the refusal says nothing was charged");
  calls.length = 0;
  const c = await T.validateTempoCredential(tempoHeader(CLEAN));
  ok(!/^screen-/.test(c.cls || "") && relayCalls() === 1, `relay mode: CONTROL an unlisted payer goes on to the relay (${c.cls}, relay calls ${relayCalls()})`);
  ok(P.relayPayerScreenView().refused === 1 && P.relayPayerScreenView().screened === 2, "counted: two screened, one refused");
  await loadList(null);
  calls.length = 0;
  const open = await T.validateTempoCredential(tempoHeader(LISTED));
  ok(!/^screen-/.test(open.cls || "") && relayCalls() === 1 && P.relayPayerScreenView().servedUnscreened === 1, "relay mode, no list loaded: goes on to the relay unscreened and is counted (fails open)");
  ok(T.tempoEnabled() === true, "relay mode stays offered with no list loaded");
  // The sender the relay settled on is screened after it answers.
  await loadList([LISTED]);
  ok(P.relayPayerScreen([undefined, LISTED, null], "after validate", { log: () => {} })?.cls === "screen-rejected" && P.relayPayerScreen([CLEAN, null], "after validate") === null && P.relayPayerScreen([], "after validate") === null, "the settled sender is screened; nothing readable passes");
  const mpp = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  ok(/relayPayerScreen\(\[validation\?\.details\?\.sender, validation\?\.receipt\?\.from, validation\?\.payer\], "after validate"\)/.test(mpp), "validateTempoCredential screens the relay's settled sender in relay mode");
}

// ---- MPP Tempo direct mode: fails closed (documented) ----
{
  process.env.TEMPO_RELAY = "off";
  await loadList(null);
  calls.length = 0;
  const v = await T.validateTempoCredential(tempoHeader(CLEAN));
  ok(v.cls === "screen-unavailable" && calls.length === 0, "direct mode, no list loaded: refused fail-closed and retryable (its documented rule; every other method stays offered)");
  delete process.env.TEMPO_RELAY;
}

// ---- the conformance cells: an identifier per rail, none where none exists ----
{
  const rows = conformanceRails();
  for (const r of rows) {
    const c = r.features.sanctionsScreening;
    if (r.id === "pow") { ok(c.supported === null, "pow: no payment, no screen"); continue; }
    if (!("identifier" in c)) ok(false, `${r.id}: the screening cell names its identifier`);
  }
  ok(true, "every paid rail's screening cell carries an identifier field");
  const id = (x) => rows.find((r) => r.id === x).features.sanctionsScreening;
  for (const x of ["mpp:stripe", "credits", "card:checkout"]) {
    ok(id(x).supported === false && id(x).identifier === null && /No payer address exists on this rail/.test(id(x).detail), `${x}: no payer address, identifier null, and the cell says so`);
  }
  for (const x of ["x402:exact:eip155:8453", "mpp:evm:eip155:8453", "mpp:tempo:pull", "mpp:tempo:push", "x402:exact:stellar:pubnet"]) {
    ok(typeof id(x).identifier === "string" && id(x).identifier.length > 10, `${x}: names the identifier its screen reads`);
  }
  ok(id("mpp:tempo:pull").identifier === P.PAYER_SCREEN_RAILS["mpp-tempo-relay"].identifier, "Tempo in relay mode names the relay screen's identifier");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
