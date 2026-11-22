// One PAID-mode server on port 0 with every wire that settles after the
// handler, against local stubs that behave like a chain: each payer has a
// balance, a settle takes the price out of it or refuses for funds, and each
// rail's balance read answers that balance (or fails, when a test says the
// read is down). Nothing leaves this machine (the server runs under
// scripts/lib/paid-wires-preload.js) and every store is the run's own.
//
// Wires: x402 exact on Base, Solana, Algorand and Stellar; the MPP evm wire
// (through the shim, onto the same Base facilitator); a Tempo pull credential.
//
//   const rig = await bootPaidWires({ label: "burst" });
//   const w = await rig.wallet("svm");            // a fresh payer on a wire
//   rig.fund(w, 3n * price);                      // its balance, in base units
//   const res = await rig.pay(w, ROUTE);          // one paid call
//   await rig.stop();
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bootServer } from "./boot-server.js";
import { svmTransferAccounts } from "../../src/svm-payer.js";
import { ALGORAND_MAINNET_CAIP2 } from "../../src/avm-network.js";

const kit = await import("@solana/kit");
const sdk = await import("@stellar/stellar-sdk");
const algosdk = (await import("algosdk")).default;
const { Challenge, Credential } = await import("mppx");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const viemTempo = await import("viem/tempo");
const TempoAccount = viemTempo.Account;
const { keccak256, encodeFunctionResult, decodeFunctionData } = await import("viem");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BASE = "eip155:8453";
export const WIRES = ["evm", "mpp-evm", "tempo", "svm", "avm", "stellar"];
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CB = "ComputeBudget111111111111111111111111111111";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TEMPO_CUR = "0x2000000000000000000000000000000000000000";
// Payments have a life of their own, and the stubs hold them to it: a Tempo
// pull transaction is signed 25 s ahead (the stock client's figure), a Solana
// blockhash lives about a minute.
export const TEMPO_TX_LIFE_MS = 25_000;
export const SVM_BLOCKHASH_LIFE_MS = 60_000;
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => r(b)); });
const decode = (h) => JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));

export async function bootPaidWires({ label = "paid-wires", env = {}, operatorToken = "paid-wires-operator-token-0123456789abcdef" } = {}) {
  const secret = "paid-wires-secret-" + randomBytes(6).toString("hex");
  const feePayer = await kit.generateKeyPairSigner();
  const solPayTo = await kit.generateKeyPairSigner();
  const stellarPayTo = sdk.Keypair.random().publicKey();
  const algoPayTo = algosdk.generateAccount();
  // ---- the chain ----
  // account id (`<rail>:<address>`) -> { balance: bigint, readable, shown }.
  // `shown` (when set) is what a balance read answers instead of the balance.
  const accounts = new Map();
  const acct = (id) => { if (!accounts.has(id)) accounts.set(id, { balance: 10n ** 15n, readable: true, shown: null }); return accounts.get(id); };
  // payment blob -> { id, amount }: which account a settle call draws on.
  const payments = new Map();
  // Access keys the chain holds, "account:key" (lowercase); a getKey read of
  // any other pair answers the empty record. st.keyReadDelayMs delays it
  // (st.keyReadDelayFor(pair), when set, per pair).
  const chainKeys = new Set();
  const st = { keyReadDelayMs: 0, keyReadDelayFor: null, keyReads: 0, verifyDelayMs: 0, settleDelayMs: 250, readDelayMs: 0, readDelayFor: null, llmDelayMs: 0, llmStatus: 0, images: 0, captures: 0, expired: 0, stripeCapture: "decline", verifies: 0, settleAttempts: 0, settled: 0, refused: 0, completions: 0, reads: 0, byAccount: new Map() };
  const tally = (id, k) => { const t = st.byAccount.get(id) || { attempts: 0, settled: 0, refused: 0 }; t[k]++; st.byAccount.set(id, t); };
  // The most settle calls one account had under way at once (each is a
  // handler that has just answered), outside the tallies.
  const settling = new Map(), peak = new Map();
  const takeFrom = async (id, amount) => {
    st.settleAttempts++; tally(id, "attempts");
    settling.set(id, (settling.get(id) || 0) + 1);
    peak.set(id, Math.max(peak.get(id) || 0, settling.get(id)));
    await sleep(st.settleDelayMs);
    settling.set(id, settling.get(id) - 1);
    const a = acct(id);
    if (a.balance >= amount) { a.balance -= amount; st.settled++; tally(id, "settled"); return true; }
    st.refused++; tally(id, "refused");
    return false;
  };
  // A balance read: answers what the account shows now, after st.readDelayMs.
  const svmSources = new Map(); // a Solana signer -> the source token accounts made for it
  const readOf = async (id) => { st.reads++; const a = acct(id); const v = a.readable ? (a.shown ?? a.balance) : null; const d = typeof st.readDelayFor === "function" ? st.readDelayFor(id) : st.readDelayMs; if (d > 0) await sleep(d); return v; };
  const paymentOf = (fam, j) => {
    const inner = j?.paymentPayload?.payload || {};
    if (inner.authorization) return { id: `evm:${String(inner.authorization.from).toLowerCase()}`, amount: BigInt(inner.authorization.value) };
    const blob = inner.transaction || (Array.isArray(inner.paymentGroup) ? inner.paymentGroup[0] : null);
    return payments.get(blob) || null;
  };
  const stub = createServer(async (req, res) => {
    const body = await readBody(req);
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const [path] = req.url.split("?");
    let j = {}; try { j = JSON.parse(body || "{}"); } catch { /* not JSON */ }
    // balance reads
    if (path === "/rpc" || path === "/tempo-rpc") {
      const data = String(j?.params?.[0]?.data || "");
      if (j.method === "eth_call" && data.startsWith("0x70a08231")) {
        const v = await readOf(`${path === "/rpc" ? "evm" : "tempo"}:0x${data.slice(-40).toLowerCase()}`);
        return v == null ? reply(500, {}) : reply(200, { jsonrpc: "2.0", id: j.id ?? 1, result: "0x" + v.toString(16) });
      }
      if (path === "/tempo-rpc" && j.method === "eth_call" && String(j?.params?.[0]?.to || "").toLowerCase() === viemTempo.Addresses.accountKeychain.toLowerCase()) {
        st.keyReads++;
        const { args } = decodeFunctionData({ abi: viemTempo.Abis.accountKeychain, data });
        const k = `${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`;
        const d = typeof st.keyReadDelayFor === "function" ? st.keyReadDelayFor(k) : st.keyReadDelayMs;
        if (d) await sleep(d);
        const rec = chainKeys.has(k) ? { signatureType: 0, keyId: args[1], expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), enforceLimits: false, isRevoked: false } : { signatureType: 0, keyId: "0x0000000000000000000000000000000000000000", expiry: 0n, enforceLimits: false, isRevoked: false };
        return reply(200, { jsonrpc: "2.0", id: j.id ?? 1, result: encodeFunctionResult({ abi: viemTempo.Abis.accountKeychain, functionName: "getKey", result: rec }) });
      }
      return reply(200, { jsonrpc: "2.0", id: j.id ?? 1, result: path === "/rpc" ? "0x0" : null });
    }
    if (path === "/sol") {
      // The wallet's token accounts of the mint: each source account made for
      // that signer, with what it holds (any unreadable: the read fails).
      if (j.method === "getTokenAccountsByOwner") {
        const value = [];
        for (const source of svmSources.get(String(j.params?.[0])) || []) {
          const v = await readOf(`svm:${source}`);
          if (v == null) return reply(500, {});
          value.push({ pubkey: source, account: { data: { parsed: { info: { mint: j.params?.[1]?.mint, owner: j.params?.[0], tokenAmount: { amount: v.toString(), decimals: 6 } } } } } });
        }
        return reply(200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
      }
      if (j.method === "getTokenAccountBalance") {
        const v = await readOf(`svm:${j.params?.[0]}`);
        return v == null ? reply(500, {}) : reply(200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { amount: v.toString(), decimals: 6 } } });
      }
      return reply(200, { jsonrpc: "2.0", id: 1, result: null });
    }
    let m = /^\/algod\/v2\/accounts\/([A-Z2-7]{58})\/assets\/(\d+)$/.exec(path);
    if (m) { const v = await readOf(`avm:${m[1]}`); return v == null ? reply(500, {}) : reply(200, { "asset-holding": { amount: Number(v), "asset-id": Number(m[2]), "is-frozen": false }, round: 1 }); }
    m = /^\/horizon\/accounts\/(G[A-Z2-7]{55})$/.exec(path);
    if (m) {
      const v = await readOf(`stellar:${m[1]}`);
      if (v == null) return reply(500, {});
      const s = v.toString().padStart(8, "0");
      return reply(200, { id: m[1], balances: [{ balance: "5.0000000", asset_type: "native" }, { balance: `${s.slice(0, -7)}.${s.slice(-7)}`, asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER }] });
    }
    if (path.startsWith("/horizon")) return reply(404, {});
    // the Tempo relay
    if (path.startsWith("/relay")) {
      if (/validate$/.test(path)) { st.verifies++; return reply(200, { success: true }); }
      const sig = j?.payload?.signature;
      const p = payments.get(sig);
      if (!p) return reply(200, { success: false, error: { code: "invalid_payment", message: "unknown payment" } });
      // A pull transaction cannot be broadcast past its own validBefore.
      if (p.lifeMs && Date.now() - p.signedAt > p.lifeMs) { st.expired++; tally(p.id, "attempts"); tally(p.id, "refused"); return reply(200, { success: false, error: { code: "expired", message: "transaction expired: validBefore passed" } }); }
      if (await takeFrom(p.id, p.amount)) return reply(200, { success: true, receipt: { method: "tempo", status: "success", reference: keccak256(sig), timestamp: new Date().toISOString() } });
      return reply(200, { success: false, error: { code: "insufficient_funds", message: "insufficient funds" } });
    }
    // the card processor: a capture (PaymentIntent create) is declined, or succeeds when a test says so
    if (path.startsWith("/stripe")) {
      if (req.method === "POST" && path === "/stripe/v1/payment_intents") {
        st.captures++;
        if (st.stripeCapture === "ok") return reply(200, { id: `pi_test_${st.captures}`, object: "payment_intent", status: "succeeded", amount: 0, currency: "usd" });
        return reply(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } });
      }
      return reply(404, { error: { type: "invalid_request_error", message: "no such route on the stub" } });
    }
    // the model upstream
    if (path.startsWith("/llm")) {
      // A streamed Messages or Responses call: st.llmStreamFrames(j, wire).
      if (req.method === "POST" && /\/api\/v1\/(messages|responses)$/.test(path) && j.stream === true && typeof st.llmStreamFrames === "function") {
        st.completions++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const f of st.llmStreamFrames(j, path.endsWith("/messages") ? "messages" : "responses")) res.write(f);
        return res.end();
      }
      if (req.method === "POST" && /chat\/completions/.test(path)) {
        st.completions++;
        await sleep(st.llmDelayMs);
        if (st.llmStatus >= 400) return reply(st.llmStatus, { error: { message: "stub upstream error", code: st.llmStatus } });
        // A streamed call: st.llmStreamFrames(j) gives the SSE frames (strings).
        if (j.stream === true && typeof st.llmStreamFrames === "function") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const f of st.llmStreamFrames(j, "chat")) res.write(f);
          return res.end();
        }
        const content = typeof st.llmContent === "function" ? st.llmContent(j) : "stub answer";
        return reply(200, { id: "gen-" + st.completions, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: j.model || "x", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.000001 } });
      }
      if (req.method === "GET" && path.endsWith("/endpoints") && path.includes("/images/models/")) return reply(200, { data: { endpoints: [] } });
      // st.imageB64 (when set): the image the stub answers, e.g. a large one.
      if (req.method === "POST" && /\/api\/v1\/images$/.test(path)) { st.images++; await sleep(st.llmDelayMs); return reply(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: st.imageB64 || "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }); }
      if (req.method === "POST" && /audio\/speech/.test(path)) { res.writeHead(200, { "Content-Type": "audio/mpeg" }); return res.end(Buffer.alloc(2048, 7)); }
      return reply(200, { data: [] });
    }
    // the x402 facilitators
    m = /^\/(evm|stellar|avm)\/(supported|verify|settle)$/.exec(path);
    if (!m) return reply(404, {});
    const [, fam, kind] = m;
    if (kind === "supported") {
      if (fam === "evm") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }], extensions: [], signers: {} });
      if (fam === "stellar") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:pubnet", extra: { areFeesSponsored: true } }], extensions: [], signers: {} });
      return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: ALGORAND_MAINNET_CAIP2 }], extensions: [], signers: {} });
    }
    const p = paymentOf(fam, j);
    const payer = p ? p.id.slice(p.id.indexOf(":") + 1) : "";
    const network = j?.paymentRequirements?.network || j?.paymentPayload?.accepted?.network || BASE;
    if (kind === "verify") { st.verifies++; if (st.verifyDelayMs) await sleep(st.verifyDelayMs); return reply(200, { isValid: true, payer }); }
    if (!p) return reply(200, { success: false, errorReason: "invalid_payload", transaction: "", network, payer });
    // A payment past its own life (a Solana blockhash) cannot be settled.
    if (p.lifeMs && Date.now() - p.signedAt > p.lifeMs) { st.expired++; tally(p.id, "attempts"); tally(p.id, "refused"); return reply(200, { success: false, errorReason: "transaction_expired_blockhash_not_found", transaction: "", network, payer }); }
    if (await takeFrom(p.id, p.amount)) return reply(200, { success: true, transaction: fam === "evm" && network === BASE ? "0x" + randomBytes(32).toString("hex") : randomBytes(32).toString("hex"), network, payer });
    return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network, payer });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const F = `http://127.0.0.1:${stub.address().port}`;
  const srv = await bootServer({
    stores: label,
    args: ["--import", "./scripts/lib/paid-wires-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,solana,stellar,algorand",
      SOLANA_WALLET_ADDRESS: solPayTo.address, SOLANA_RPCS: `${F}/sol`, SOLANA_RPC_URL: "", ALCHEMY_API_KEY: "",
      STELLAR_WALLET_ADDRESS: stellarPayTo, STELLAR_FACILITATOR_URL: `${F}/stellar`, STELLAR_FACILITATOR_KEY: "stub-key", STELLAR_HORIZON_URL: `${F}/horizon`, STELLAR_HORIZON_URLS: `${F}/horizon`,
      STELLAR_FALLBACK_FACILITATOR_URL: "", STELLAR_FALLBACK_FACILITATOR_KEY: "",
      ALGORAND_WALLET_ADDRESS: algoPayTo.addr.toString(), ALGORAND_FACILITATOR_URL: `${F}/avm`, ALGORAND_UPSTREAM_BUYER_ADDRESS: "", AVM_SUBCENT_GATE: "off",
      ALGORAND_ALGOD_URLS: `${F}/algod`, ALGORAND_RELAY_URL: "", ALGORAND_RELAY_TOKEN: "",
      FACILITATOR_URL: "", CDP_FACILITATOR_URL: "", PAYAI_FACILITATOR_URL: `${F}/evm`, AGENT402_BASE_RPC: `${F}/rpc`, FACILITATOR_GAS_CHECK: "off",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", CDP_SQL_API_KEY_ID: "", CDP_SQL_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "",
      MPP_SECRET_KEY: secret, TEMPO_API_KEY: "paid-wires-test-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: TEMPO_CUR,
      TEMPO_API_BASE_URL: `${F}/relay`, TEMPO_RPC_URL: `${F}/tempo-rpc`, TEMPO_LATE_CONFIRM_DELAYS_MS: "300,600", SLOW_SYNC_WINDOW_SECONDS: "off",
      STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "", FIRST_CALL_ALLOWANCE: "", GATEWAY_NANOPAYMENTS: "",
      REDIS_URL: "", TARGET_URL: "", AGENT402_OPERATOR_TOKEN: operatorToken,
      OPENROUTER_API_KEY: "sk-or-paid-wires-never-used", OPENROUTER_STUB_URL: `${F}/llm`, STRIPE_STUB_URL: `${F}/stripe`, OPENAI_API_KEY: "", BRAVE_API_KEY: "", EXA_API_KEY: "", X_BEARER_TOKEN: "",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../../docs/example-upstream-costs.json", import.meta.url)),
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      RECEIPT_SIGNING_KEY: "", RECEIPT_SIGNING_KEY_ID: "", RECEIPT_RETIRED_KEYS: "",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
      ...env,
    },
  });
  const url = srv.url;
  // A server that tried to contact a host that is not loopback fails the
  // suite here (the preload refused the connection and said so in the log).
  const stop = async () => {
    await srv.stop(); stub.closeAllConnections?.(); await new Promise((r) => stub.close(() => r()));
    const said = srv.log().split("\n").filter((l) => l.includes("[paid-wires-preload] BLOCKED outbound"));
    if (said.length) throw new Error(`the server under test tried to contact a third party ${said.length} time(s): ${said.slice(0, 3).join(" | ")}`);
  };

  // ---- offers, per route ----
  const offers = new Map();
  const offerOf = async (route) => {
    const k = `${route.method} ${route.path} ${JSON.stringify(route.body ?? null)}`;
    if (offers.has(k)) return offers.get(k);
    const r = await fetch(`${url}${route.path}`, { method: route.method, headers: { "content-type": "application/json" }, ...(route.method === "POST" ? { body: JSON.stringify(route.body ?? {}) } : {}) });
    await r.arrayBuffer();
    const h = r.headers.get("payment-required");
    const www = r.headers.get("www-authenticate");
    const challenges = www ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })) : [];
    const o = { status: r.status, offer: h ? decode(h) : null, challenges };
    offers.set(k, o);
    return o;
  };
  const acceptOn = (o, pred) => (o.offer?.accepts || []).find((a) => a.scheme === "exact" && pred(a.network));

  // ---- wallets ----
  // tempoSeq: a Tempo credential is claimed by its challenge, so each one minted
  // here gets an expiry of its own (two with one expiry are one challenge).
  let solSeq = 1, avmSeq = 0, xlmNonce = 9_000_000, tempoNonce = 0, tempoSeq = 0;
  // `signer`: another token account of the same Solana wallet (authority).
  // `accessKeyOf`: a Tempo wallet whose transactions are signed by a new
  // access key of that wallet's account (a keychain signature): the same
  // account, the same balance, another key, which the chain holds for that
  // account. `forgedKeyOf`: transactions that NAME that wallet's account but
  // are signed by a key the chain does not hold for it; a relay that does not
  // check the key would still draw on the named account, so the stub does.
  // `unregistered`: a genuine-looking access key the chain has no record of.
  async function wallet(wire, { signer = null, accessKeyOf = null, forgedKeyOf = null, unregistered = false } = {}) {
    if (wire === "tempo" && forgedKeyOf) { const a = TempoAccount.fromSecp256k1(generatePrivateKey(), { access: forgedKeyOf.address }); return { wire, id: forgedKeyOf.id, address: forgedKeyOf.address, account: a, keychain: true }; }
    if (wire === "evm" || wire === "mpp-evm") { const a = privateKeyToAccount(generatePrivateKey()); return { wire, id: `evm:${a.address.toLowerCase()}`, address: a.address }; }
    if (wire === "tempo" && accessKeyOf) { const a = TempoAccount.fromSecp256k1(generatePrivateKey(), { access: accessKeyOf.root }); if (!unregistered) chainKeys.add(`${accessKeyOf.address.toLowerCase()}:${a.accessKeyAddress.toLowerCase()}`); return { wire, id: accessKeyOf.id, address: accessKeyOf.address, account: a, keychain: true }; }
    if (wire === "tempo") { const k = generatePrivateKey(); const a = privateKeyToAccount(k); return { wire, id: `tempo:${a.address.toLowerCase()}`, address: a.address, account: a, root: TempoAccount.fromSecp256k1(k) }; }
    if (wire === "svm") { const s = signer || await kit.generateKeyPairSigner(); const source = (await kit.generateKeyPairSigner()).address; if (!svmSources.has(s.address)) svmSources.set(s.address, new Set()); svmSources.get(s.address).add(source); return { wire, id: `svm:${source}`, address: s.address, signer: s, source }; }
    if (wire === "avm") { const a = algosdk.generateAccount(); return { wire, id: `avm:${a.addr.toString()}`, address: a.addr.toString(), account: a }; }
    if (wire === "stellar") { const g = sdk.Keypair.random().publicKey(); return { wire, id: `stellar:${g}`, address: g }; }
    throw new Error(`unknown wire ${wire}`);
  }
  /** The price `w`'s wire is asked on `route`, in that wire's base units. */
  async function priceOf(w, route) {
    const o = await offerOf(route);
    if (w.wire === "evm") return BigInt(acceptOn(o, (n) => n === BASE).amount);
    if (w.wire === "mpp-evm") return BigInt(o.challenges.find((c) => c.method === "evm").request.amount);
    if (w.wire === "tempo") return BigInt(o.challenges.find((c) => c.method === "tempo" && c.intent === "charge").request.amount);
    if (w.wire === "svm") return BigInt(acceptOn(o, (n) => n === SOL).amount);
    if (w.wire === "avm") return BigInt(acceptOn(o, (n) => n.startsWith("algorand:")).amount);
    return BigInt(acceptOn(o, (n) => n.startsWith("stellar:")).amount);
  }
  /** The request headers of one new, distinct payment from `w` for `route`. */
  async function credentialFor(w, route, { ttlMs = null, validForSeconds = null } = {}) {
    const o = await offerOf(route);
    const x402 = (accept, payload) => ({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: o.offer.resource, accepted: accept, payload })).toString("base64") });
    if (w.wire === "evm") {
      const a = acceptOn(o, (n) => n === BASE);
      return x402(a, { signature: "0x" + "11".repeat(65), authorization: { from: w.address, to: a.payTo, value: a.amount, validAfter: "0", validBefore: validForSeconds == null ? "9999999999" : String(Math.floor(Date.now() / 1000) + validForSeconds), nonce: "0x" + randomBytes(32).toString("hex") } });
    }
    if (w.wire === "mpp-evm") {
      const seenEvm = o.challenges.find((c) => c.method === "evm");
      // ttlMs: the same challenge re-minted with a short life (the authorization keeps its own).
      const ch = ttlMs == null ? seenEvm : Challenge.from({ ...seenEvm, id: undefined, expires: new Date(Date.now() + ttlMs), secretKey: secret });
      return { Authorization: Credential.serialize({ challenge: ch, payload: { from: w.address, to: ch.request.recipient, value: ch.request.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 280), nonce: "0x" + randomBytes(32).toString("hex"), signature: "0x" + "11".repeat(65), type: "authorization" } }) };
    }
    if (w.wire === "tempo") {
      const seen = o.challenges.find((c) => c.method === "tempo" && c.intent === "charge");
      const ch = Challenge.from({ realm: seen.realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + (ttlMs ?? 60_000) + (tempoSeq++ % 20_000)), request: { amount: seen.request.amount, currency: TEMPO_CUR, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, secretKey: secret });
      // As the stock client signs it: valid for TEMPO_TX_LIFE_MS from now, and the stub relay holds it to that.
      const fields = { chainId: 4217, type: "tempo", calls: [{ to: TEMPO_CUR, data: "0x" }], nonce: tempoNonce++, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, validBefore: Math.floor((Date.now() + TEMPO_TX_LIFE_MS) / 1000) };
      const tx = w.keychain ? await w.account.signTransaction(fields) : await w.account.signTransaction(fields, { serializer: viemTempo.Transaction.serialize });
      payments.set(tx, { id: w.id, amount: BigInt(seen.request.amount), signedAt: Date.now(), lifeMs: TEMPO_TX_LIFE_MS });
      return { Authorization: Credential.serialize({ challenge: ch, payload: { signature: tx, type: "transaction" } }) };
    }
    if (w.wire === "svm") {
      const a = acceptOn(o, (n) => n === SOL);
      const ixs = [
        { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, ...u32(20000)]) },
        { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(solSeq++)]) },
        { programAddress: kit.address(TOKEN), accounts: [
          { address: kit.address(w.source), role: kit.AccountRole.WRITABLE },
          { address: kit.address(MINT), role: kit.AccountRole.READONLY },
          { address: solPayTo.address, role: kit.AccountRole.WRITABLE },
          { address: w.signer.address, role: kit.AccountRole.READONLY_SIGNER, signer: w.signer },
        ], data: new Uint8Array([12, ...u64(a.amount), 6]) },
      ];
      const msg = kit.pipe(
        kit.createTransactionMessage({ version: 0 }),
        (x) => kit.setTransactionMessageFeePayer(feePayer.address, x),
        (x) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, x),
        (x) => kit.appendTransactionMessageInstructions(ixs, x),
      );
      const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
      if (svmTransferAccounts(tx)?.source !== w.source) throw new Error("rig: the Solana transfer does not name the wallet's source account");
      payments.set(tx, { id: w.id, amount: BigInt(a.amount), signedAt: Date.now(), lifeMs: SVM_BLOCKHASH_LIFE_MS });
      return x402(a, { transaction: tx });
    }
    if (w.wire === "avm") {
      const a = acceptOn(o, (n) => n.startsWith("algorand:"));
      const sp = { fee: 1000, flatFee: true, minFee: 1000, firstValid: 1000, lastValid: 2000, genesisID: "mainnet-v1.0", genesisHash: new Uint8Array(Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64")) };
      const stx = Buffer.from(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: w.account.addr, receiver: algoPayTo.addr, amount: Number(a.amount), assetIndex: Number(a.asset), suggestedParams: sp, note: new Uint8Array(Buffer.from(`n${avmSeq++}`)) }).signTxn(w.account.sk)).toString("base64");
      payments.set(stx, { id: w.id, amount: BigInt(a.amount) });
      return x402(a, { paymentGroup: [stx], paymentIndex: 0 });
    }
    const a = acceptOn(o, (n) => n.startsWith("stellar:"));
    const args = [new sdk.Address(w.address).toScVal(), new sdk.Address(stellarPayTo).toScVal(), sdk.nativeToScVal(BigInt(a.amount), { type: "i128" })];
    const callX = new sdk.xdr.InvokeContractArgs({ contractAddress: new sdk.Address(a.asset).toScAddress(), functionName: "transfer", args });
    const entry = new sdk.xdr.SorobanAuthorizationEntry({ credentials: sdk.xdr.SorobanCredentials.sorobanCredentialsAddress(new sdk.xdr.SorobanAddressCredentials({ address: new sdk.Address(w.address).toScAddress(), nonce: sdk.xdr.Int64.fromString(String(xlmNonce++)), signatureExpirationLedger: 1000, signature: sdk.xdr.ScVal.scvBytes(Buffer.alloc(64, 7)) })), rootInvocation: new sdk.xdr.SorobanAuthorizedInvocation({ function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(callX), subInvocations: [] }) });
    const b = new sdk.TransactionBuilder(new sdk.Account(sdk.Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: sdk.Networks.PUBLIC });
    b.addOperation(sdk.Operation.invokeContractFunction({ contract: a.asset, function: "transfer", args, auth: [entry] }));
    const xdr = b.setTimeout(300).build().toXDR();
    payments.set(xdr, { id: w.id, amount: BigInt(a.amount) });
    return x402(a, { transaction: xdr });
  }
  /** One request with given payment headers. */
  async function send(route, headers = {}, { signal } = {}) {
    const r = await fetch(`${url}${route.path}`, { method: route.method, signal, headers: { "content-type": "application/json", ...headers }, ...(route.method === "POST" ? { body: JSON.stringify(route.body ?? {}) } : {}) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  const pay = async (w, route, opts) => send(route, await credentialFor(w, route, opts), opts);
  /** N distinct payments from one wallet, sent in the same turn. */
  async function burst(w, route, n) {
    const creds = [];
    for (let i = 0; i < n; i++) creds.push(await credentialFor(w, route));
    return Promise.all(creds.map((c) => send(route, c).catch((e) => ({ status: `error:${e?.cause?.code || e?.name}` }))));
  }
  const fund = (w, amount, { readable = true, shown = null } = {}) => { accounts.set(w.id, { balance: BigInt(amount), readable, shown: shown == null ? null : BigInt(shown) }); };
  const outcomesOf = (w) => st.byAccount.get(w.id) || { attempts: 0, settled: 0, refused: 0 };
  const peakOf = (w) => peak.get(w.id) || 0;
  const operator = async (path) => { const r = await fetch(`${url}${path}`, { headers: { "X-Operator-Token": operatorToken } }); return r.json().catch(() => null); };
  const gatewayStatus = async () => (await fetch(`${url}/api/gateway-status`)).json();
  return { Challenge, Credential, child: srv.child, url, F, stop, log: srv.log, st, wallet, fund, priceOf, credentialFor, send, pay, burst, outcomesOf, peakOf, offerOf, operator, gatewayStatus, accounts, secret };
}
export const tallyOf = (rs) => rs.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
