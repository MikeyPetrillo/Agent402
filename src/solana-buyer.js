// External buying on Solana - the SVM counterpart of the AVM/Tempo spending
// paths. route-execute pays a PROVEN external Solana seller from a DEDICATED
// SVM spending hot wallet (SOLANA_UPSTREAM_BUYER_KEY - never the treasury,
// never the CI burner), chain-matched: a buyer who paid us on Solana funds a
// purchase on Solana. Everything here is env-gated: with no key configured,
// Solana external routing is simply not offered (the Algorand pattern).
//
// Signing rides the same stack the daily paid canary has proven against our
// own routes since July: @x402/svm exact scheme + @solana/kit keypair signer.
//
// PROOF GATE (the Tempo lesson, applied to Solana): discovery ranks a
// candidate, but the address that gets paid is only known from the live 402,
// so proven-ness is enforced AT PAY TIME against the accept we are about to
// sign - recent inbound USDC transfers on Solana to that payTo's own token
// account, read from the chain, failing CLOSED on any RPC error. A seller
// nobody pays is not routable, whatever a registry says.

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// Devnet's genesis hash is a DIFFERENT CAIP-2 suffix - an accept labeled
// solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1... must never match mainnet.
export const SOLANA_NETWORK_LABELS = new Set([
  SOLANA_CAIP2.toLowerCase(),
  "solana",
  "solana-mainnet",
  "solana-mainnet-beta",
]);

const RPC_URL = () => (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();

const bad = (msg, statusCode) => Object.assign(new Error(msg), { statusCode });

/** True when the DEDICATED Solana spending wallet is configured - the gate
 *  route-execute uses to advertise/refuse Solana external routing. */
export function svmBuyerConfigured() {
  return !!(process.env.SOLANA_UPSTREAM_BUYER_KEY || "").trim();
}

let svmBuyerPromise = null;
/** Lazy singleton x402 client signing Solana payments with the dedicated SVM
 *  spending wallet. Key format matches the canary's: a base58 secret key or a
 *  JSON byte array. */
export async function getUpstreamBuyerSvm() {
  const raw = (process.env.SOLANA_UPSTREAM_BUYER_KEY || "").trim();
  if (!raw) throw bad("Solana upstream buyer wallet not configured (SOLANA_UPSTREAM_BUYER_KEY) - this path pays a Solana x402 seller and cannot run without a funded SVM spending wallet", 503);
  svmBuyerPromise ??= (async () => {
    const [{ x402Client, x402HTTPClient }, { ExactSvmScheme }, kit] = await Promise.all([
      import("@x402/core/client"), import("@x402/svm/exact/client"), import("@solana/kit"),
    ]);
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
    const signer = await kit.createKeyPairSignerFromBytes(bytes);
    const client = new x402Client();
    // Registered by hand rather than via registerExactSvmScheme so the scheme
    // reads OUR RPC (SOLANA_RPC_URL) for mint metadata instead of the
    // library's hardcoded default - and so an offline test can point it at a
    // stub RPC. The accept's extra.recentBlockhash (which real facilitator
    // 402s carry) means signing then needs no blockhash fetch at all.
    client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC_URL() }));
    return { client, http: new x402HTTPClient(client), address: signer.address, signer };
  })();
  return svmBuyerPromise;
}

/** One JSON-RPC call against the Solana mainnet RPC. Injectable for tests. */
async function rpcCall(method, params, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const res = await fetchImpl(RPC_URL(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Solana RPC error: ${String(body.error.message || body.error.code).slice(0, 120)}`);
  return body.result;
}

/**
 * Recent VERIFIED-INBOUND-USDC evidence for a seller payTo: the number of
 * distinct funders who CREDITED the seller's own USDC token account inside the
 * window. It is not enough to count signatures on the account
 * (getSignaturesForAddress returns outbound and self-transfers too) - a seller
 * can manufacture ~20 self-transfers for a few cents of fees and look
 * "proven" (2026-09-01 security review). So each recent transaction is
 * inspected: the ATA's post-USDC balance must EXCEED its pre-balance (a
 * credit, not a debit or a no-op), and the payer must be someone OTHER than
 * the seller itself (self-transfers do not count). The evidence is the count
 * of DISTINCT such payers - the same "distinct wallets actually paid" signal
 * the Base rail's reliability gate uses, not raw activity.
 *
 * Bounded: getTransaction is called per signature but stops the moment the
 * floor is met (`stopAt`) or a hard fetch cap is hit, so a genuine seller
 * verifies in ~20-25 reads and a cold address gives up quickly. Throws on RPC
 * failure - the CALLER treats that as refusal (fail closed).
 */
// Window: 7 DAYS by default (SOR_SVM_WINDOW_HOURS overrides). Solana's x402
// volume is concentrated - one seller (sol.blockrun) dominates settlements and
// almost every other seller has only a handful of inbound credits in any 15h
// slice, so a 15h window admitted exactly ONE routable seller and the rail had
// no fallback when that one seller's upstream was down (2026-09-01). The TRUST
// BAR is unchanged - still 20 real, self-transfer-defended inbound credits - it
// is only measured over a period that matches Solana's slower settlement cadence
// so established-but-thinner sellers can qualify. `limit` (one sig fetch) is
// raised to reach back across the wider window; the expensive tx reads stay
// bounded by maxTxReads and short-circuited by stopAt at the floor.
const SVM_WINDOW_MS = () => (Number(process.env.SOR_SVM_WINDOW_HOURS) || 168) * 3600 * 1000;
export async function solanaInboundCount(payTo, { windowMs = SVM_WINDOW_MS(), limit = 500, fetchImpl = fetch, stopAt = Infinity, maxTxReads = 120, detail = false } = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(payTo || ""))) throw new Error("payTo is not a plausible Solana address");
  const accounts = await rpcCall("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
  const ata = accounts?.value?.[0]?.pubkey;
  if (!ata) return detail ? { credits: 0, payers: 0, truncated: false, read: 0, recent: 0 } : 0; // no USDC account = nobody has ever paid this address USDC
  const sigs = await rpcCall("getSignaturesForAddress", [ata, { limit }], { fetchImpl });
  const cutoff = (Date.now() - windowMs) / 1000;
  const recent = (sigs || []).filter((sig) => !sig.err && Number(sig.blockTime || 0) >= cutoff).map((sig) => sig.signature);
  // Read transactions CONCURRENTLY in chunks - 20 sequential round-trips on a
  // slow public RPC blew the pay-path budget (503 fail-closed, 2026-09-01).
  // Between chunks, stop once the floor is met or the hard read cap is hit.
  const toRead = recent.slice(0, maxTxReads);
  const truncated = recent.length > toRead.length;
  const funders = new Set();
  const CHUNK = Number(process.env.SOR_SVM_TX_CONCURRENCY || "12");
  const readOne = (signature) =>
    rpcCall("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { fetchImpl })
      .catch(() => null);                            // one unreadable tx is not fatal
  let credits = 0;
  for (let off = 0; off < toRead.length && credits < stopAt; off += CHUNK) {
    const batch = await Promise.all(toRead.slice(off, off + CHUNK).map(readOne));
    for (const tx of batch) {
    if (credits >= stopAt) break;
    const verdict = creditFromTx(tx?.meta, payTo);
    if (!verdict.credited) continue;
    credits++;
    if (verdict.funder) funders.add(verdict.funder);
    }
  }
  // detail: the leaderboard's batched scan wants the funder count and whether
  // the read cap was hit; the gates keep the bare number.
  if (detail) return { credits, payers: funders.size, truncated, read: toRead.length, recent: recent.length };
  return credits;
}

/** The credit rule, PURE and shared with the Solana leaderboard's incremental
 *  scan: a transaction credits the seller when its USDC balance ROSE and some
 *  account other than the seller's was debited (self-funding excluded). */
export function creditFromTx(meta, payTo) {
  if (!meta || meta.err) return { credited: false, funder: null };
  const pre = (meta.preTokenBalances || []).find((b) => b?.mint === USDC_MINT && b?.owner === payTo);
  const post = (meta.postTokenBalances || []).find((b) => b?.mint === USDC_MINT && b?.owner === payTo);
  const preAmt = Number(pre?.uiTokenAmount?.amount || 0);
  const postAmt = Number(post?.uiTokenAmount?.amount || 0);
  if (!(postAmt > preAmt)) return { credited: false, funder: null };  // the seller's balance did NOT rise: outbound or no-op
    // SELF-TRANSFER DEFENCE. Some USDC account OTHER than the seller must be
    // the one debited, or this is the seller funding itself to fake volume
    // (the spoof the review flagged). On Solana x402 that debited account is
    // typically a shared FACILITATOR, not the buyer - so we count the CREDIT,
    // not distinct funders (distinct-funder collapses to 1 for a real,
    // facilitator-intermediated seller: measured 2026-09-01, sol.blockrun has
    // 49 buyers on x402scan but one on-chain sender). Residual: a seller with
    // a SECOND wallet can still fund payTo for ~$0.001/tx in fees; that costs
    // real money per fake and is bounded downstream by cap + the per-payer
    // spend ceiling. Closing it fully needs parsing the x402 buyer identity
    // from the payment instruction, deferred.
  let funder = null;
  const fundedByOther = (meta.preTokenBalances || []).some((b) => {
    if (b?.mint !== USDC_MINT || b?.owner === payTo) return false;
    const p2 = (meta.postTokenBalances || []).find((x) => x?.accountIndex === b.accountIndex);
    const debited = Number(b?.uiTokenAmount?.amount || 0) > Number(p2?.uiTokenAmount?.amount || 0);
    if (debited && !funder) funder = b.owner || null;
    return debited;
  });
  return { credited: fundedByOther, funder: fundedByOther ? funder : null };
}
export const solanaRpc = (method, params, opts) => rpcCall(method, params, opts);

// PRIMED proof cache (2026-09-02): the Solana leaderboard's hourly batched scan
// hands each payTo's credit count here, so a routed buy to a scanned seller
// does not re-read the chain at pay time (the same seam as tempo-buyer's
// primeTempoInboundCount). Consulted ONLY when the primed count already
// clears the caller's floor: a primed count below the floor falls through to a
// live read, so a seller proven since the last scan is never refused on stale
// data, and an unreadable chain still fails closed on the live path.
const SVM_PROOF_TTL_MS = Number(process.env.SOR_SVM_PROOF_TTL_MS) || 60 * 60_000;
const svmProofCache = new Map(); // payTo -> { at, count }
export function primeSvmInboundCount(payTo, count, now = Date.now()) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(payTo || "")) || !Number.isFinite(count)) return;
  svmProofCache.set(String(payTo), { at: now, count: Math.max(0, count | 0) });
}
export function primedSvmInboundCount(payTo, now = Date.now()) {
  const hit = svmProofCache.get(String(payTo));
  if (!hit || now - hit.at > SVM_PROOF_TTL_MS) return null;
  return hit.count;
}
export function __resetSvmProofCacheForTest() { svmProofCache.clear(); }
export async function cachedSolanaInboundCount(payTo, opts = {}) {
  const primed = primedSvmInboundCount(payTo);
  const floor = Number.isFinite(opts?.stopAt) ? opts.stopAt : Infinity;
  if (primed != null && primed >= floor) return primed;
  return solanaInboundCount(payTo, opts);
}

/**
 * The pay-time proven-seller gate. Floor defaults to the router's global
 * SOR_MIN_SETTLED_TX doctrine (env SOR_SVM_MIN_SETTLED_TX overrides for this
 * rail alone). Fails CLOSED: an unreadable chain refuses the spend with a 503
 * the buyer is never charged for, exactly like the Tempo gate.
 */
export async function assertProvenSolanaSeller(payTo, { minCount = Number(process.env.SOR_SVM_MIN_SETTLED_TX || process.env.SOR_MIN_SETTLED_TX || "20"), inboundFn = cachedSolanaInboundCount, allowUnprovenUpToAtomic = 0n, quotedAtomic = null } = {}) {
  let inbound;
  try { inbound = await inboundFn(payTo, { stopAt: minCount }); }
  catch (e) { throw bad(`Cannot verify seller settlement history on Solana (${String(e?.message || e).slice(0, 80)}) - refusing to spend`, 503); }
  if (inbound < minCount) {
    // UNPROVEN ALLOWANCE (2026-09-02). The chain was readable and the seller
    // simply has too little history. The floor exists so a spend cannot be
    // lost to a seller that never delivers; on Solana the loss per attempt is
    // the quote itself, so a small enough quote is a bounded risk rather than
    // an unbounded one. The caller (route-execute, via the resolver) opts in
    // per candidate, and only after every proven candidate is exhausted.
    let quote = null;
    try { quote = quotedAtomic != null ? BigInt(String(quotedAtomic)) : null; } catch { quote = null; }
    if (allowUnprovenUpToAtomic > 0n && quote != null && quote > 0n && quote <= allowUnprovenUpToAtomic) {
      console.log(`[solana-buyer] paying UNPROVEN seller ${String(payTo).slice(0, 8)}… (${inbound} recent credits, floor ${minCount}) - quote ${quote} atomic is within the unproven allowance ${allowUnprovenUpToAtomic}`);
      return inbound;
    }
    throw bad(`Seller payTo ${String(payTo).slice(0, 8)}… has ${inbound} recent inbound USDC payments on Solana (floor ${minCount}) - not routable yet`, 409);
  }
  return inbound;
}

/**
 * How much a single spend to an UNPROVEN Solana seller may be, in USDC atomic
 * units. Default $0.01. `SOR_SVM_UNPROVEN_MAX_USD=0` (or `off`) disables the
 * tier and restores the hard floor. Measured before this existed: two
 * long-tail Solana sellers with ZERO on-chain history each settled a stock
 * @x402/svm payment and delivered (2026-09-02, $0.001 and $0.002), while the
 * one proven seller under the cap for the same task refused every payment.
 */
export function svmUnprovenAllowanceAtomic() {
  const raw = String(process.env.SOR_SVM_UNPROVEN_MAX_USD ?? "0.01").trim().toLowerCase();
  if (raw === "off") return 0n;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.round(usd * 1e6));
}

/**
 * Build the x402 payment payload for a Solana accept WITHOUT going through
 * @x402/svm's ExactSvmScheme. That scheme's @solana/kit RPC transport sets a
 * manual `content-length` header, and after ANY fetch through a custom undici
 * dispatcher (our ssrfDispatcher on the seller legs) undici validates it
 * strictly and throws "invalid content-length header" while building the
 * request - so the scheme's mint read fails and no Solana buy could complete
 * (root-caused 2026-09-01, see the block below). This replicates the scheme's
 * transaction byte-for-byte (transferChecked + memo + compute budget, feePayer
 * from the accept, blockhash from extra.recentBlockhash), but does ZERO RPC:
 * USDC on mainnet is always 6 decimals under the standard token program, and
 * the accept carries the blockhash, so there is no kit-transport fetch to
 * corrupt. Output is identical to the scheme's ({x402Version, payload:{
 * transaction: base64}}), so the facilitator accepts it unchanged.
 */
export async function createSvmPaymentPayload(signer, paymentRequirements) {
  const kit = await import("@solana/kit");
  const { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  const { getSetComputeUnitLimitInstruction, setTransactionMessageComputeUnitPrice } = await import("@solana-program/compute-budget");
  const accepts = Array.isArray(paymentRequirements?.accepts) ? paymentRequirements.accepts : [paymentRequirements];
  const req = accepts.find((a) => String(a?.network || "").toLowerCase().startsWith("solana:")) || accepts[0];
  if (!req) throw bad("no solana accept to sign", 502);
  if (String(req.asset) !== USDC_MINT) throw bad("SVM payload builder only signs USDC on Solana mainnet", 502);
  const feePayer = req.extra?.feePayer;
  if (!feePayer) throw bad("feePayer is required in the accept's extra for SVM", 502);
  // Blockhash: prefer the one the facilitator's 402 already carries (sol.blockrun
  // does - then signing needs ZERO RPC, the whole point of this builder). When a
  // seller's accept omits it (x402node.dev and most non-Pyth sellers), fetch it
  // via the PLAIN-fetch `rpcCall` helper - NOT @solana/kit's RPC transport, which
  // manually sets a content-length header that undici validates strictly after
  // any custom-dispatcher (ssrf) fetch and rejects ("invalid content-length
  // header"). Plain fetch sets no such header, so this is safe even in the
  // route-execute path where the ssrf seller fetch precedes it.
  let recentBlockhash = req.extra?.recentBlockhash;
  let fetchedLastValidBH = null;
  if (!recentBlockhash) {
    const bh = await rpcCall("getLatestBlockhash", [{ commitment: "confirmed" }]);
    recentBlockhash = bh?.value?.blockhash;
    fetchedLastValidBH = bh?.value?.lastValidBlockHeight != null ? String(bh.value.lastValidBlockHeight) : null;
    if (!recentBlockhash) throw bad("could not obtain a recent blockhash (no extra.recentBlockhash and RPC getLatestBlockhash returned none)", 502);
  }
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [sourceATA] = await findAssociatedTokenPda({ mint: kit.address(USDC_MINT), owner: signer.address, tokenProgram });
  const [destinationATA] = await findAssociatedTokenPda({ mint: kit.address(USDC_MINT), owner: kit.address(req.payTo), tokenProgram });
  const transferIx = getTransferCheckedInstruction(
    { source: sourceATA, mint: kit.address(USDC_MINT), destination: destinationATA, authority: signer, amount: BigInt(req.amount), decimals: 6 },
    { programAddress: tokenProgram },
  );
  // Memo: the seller's if given (bounded), else a random 16-byte hex nonce -
  // byte-identical to the scheme's default.
  let memoData;
  const sellerMemo = req.extra?.memo;
  if (sellerMemo) {
    memoData = new TextEncoder().encode(String(sellerMemo));
    if (memoData.byteLength > 566) throw bad("extra.memo exceeds the memo size limit", 502);
  } else {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    memoData = new TextEncoder().encode(Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  const memoIx = { programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: memoData };
  const tx = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageComputeUnitPrice(1, m),                       // DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS
    (m) => kit.setTransactionMessageFeePayer(kit.address(feePayer), m),
    (m) => kit.prependTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 20000 }), m), // DEFAULT_COMPUTE_UNIT_LIMIT
    (m) => kit.appendTransactionMessageInstructions([transferIx, memoIx], m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight: BigInt(req.extra?.lastValidBlockHeight || fetchedLastValidBH || "0") }, m),
  );
  const signed = await kit.partiallySignTransactionMessageWithSigners(tx);
  // `accepted` echoes back the exact requirement this transaction satisfies -
  // scheme/network/amount/payTo/asset/extra. The facilitator matches the signed
  // tx against it; WITHOUT it verify throws `unexpected_verify_error` (the scheme
  // client always includes it). amount stringified to match the wire.
  const accepted = {
    scheme: req.scheme || "exact",
    network: req.network,
    amount: String(req.amount),
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    asset: req.asset,
    ...(req.extra ? { extra: req.extra } : {}),
  };
  // The v2 wrap is the STOCK client's, field for field: @x402/core wraps every
  // scheme payload with the 402's own `resource` and `extensions` beside
  // `accepted` (client/index.mjs createPaymentPayload). A seller running the
  // stock middleware tolerated their absence (sol.blockrun settled two buys
  // without them, 2026-09-02); a seller with its own verifier did not -
  // api.xfuel.app answered `payment_payload_invalid` to a transaction that was
  // byte-for-byte the shape of the ones it settles for stock clients. Same
  // lesson as the Tempo relay wire: hand-assemble nothing the library would
  // have filled in.
  const wrap = {};
  if (paymentRequirements?.resource) wrap.resource = paymentRequirements.resource;
  if (paymentRequirements?.extensions && typeof paymentRequirements.extensions === "object") wrap.extensions = paymentRequirements.extensions;
  return { x402Version: paymentRequirements?.x402Version || 2, payload: { transaction: kit.getBase64EncodedWireTransaction(signed) }, ...wrap, accepted };
}

/**
 * CHAIN TRUTH for a refused payment: did OUR spending wallet's USDC move
 * since `sinceUnix`? A seller that answers 402 to the paid retry is saying
 * "not paid", but a seller controls its own status line, so the buyer used
 * to treat any seen response as "maybe charged" and never tried another
 * seller (the post-commit rule in x402-buyer). On Solana the question has an
 * observable answer that the seller cannot influence: the wallet's own USDC
 * token account. Polls for `graceMs` (a Solana transfer lands in ~1-2 s;
 * the grace covers a slow facilitator broadcast), reading every signature
 * newer than `sinceUnix` (minus 5 s of clock slack) and its balance deltas.
 *   { debited: true, signature }  - a transaction lowered our USDC: charged
 *   { debited: false, observed }  - nothing lowered it within the grace
 * THROWS on any RPC failure: an unreadable chain is "maybe charged", never
 * "not charged" - the caller keeps the hold and does not retry elsewhere.
 * A concurrent buy from the same wallet inside the window reads as debited,
 * which errs toward the safe side. Injectable RPC for tests.
 */
export async function confirmSvmNotDebited({ wallet, sinceUnix, graceMs = 8000, pollMs = 2000, fetchImpl = fetch, now = Date.now } = {}) {
  if (!wallet) throw new Error("confirmSvmNotDebited: wallet required");
  const accounts = await rpcCall("getTokenAccountsByOwner", [wallet, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
  const ata = accounts?.value?.[0]?.pubkey;
  if (!ata) return { debited: false, observed: 0 }; // no USDC account: nothing could have moved
  const cutoff = Number(sinceUnix) - 5;
  const deadline = now() + graceMs;
  let observed = 0;
  for (;;) {
    const sigs = await rpcCall("getSignaturesForAddress", [ata, { limit: 20 }], { fetchImpl });
    const recent = (sigs || []).filter((s) => !s.err && Number(s.blockTime || 0) >= cutoff);
    observed = recent.length;
    for (const s of recent) {
      const tx = await rpcCall("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { fetchImpl });
      const meta = tx?.meta;
      if (!meta || meta.err) continue;
      const bal = (list) => Number((list || []).find((b) => b?.mint === USDC_MINT && b?.owner === wallet)?.uiTokenAmount?.amount || 0);
      if (bal(meta.postTokenBalances) < bal(meta.preTokenBalances)) return { debited: true, signature: s.signature };
    }
    if (now() >= deadline) return { debited: false, observed };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Bucketed SVM spending-wallet status for /api/gateway-status - the
 *  upstreamBuyerAvm pattern. Numbers never leave the server. */
export async function svmBuyerStatus({ fetchImpl = fetch } = {}) {
  if (!svmBuyerConfigured()) return { status: "unconfigured" };
  try {
    const { address } = await getUpstreamBuyerSvm();
    const accounts = await rpcCall("getTokenAccountsByOwner", [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
    const usd = Number(accounts?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    const low = Number(process.env.SOLANA_UPSTREAM_BUYER_LOW_USD || "0.5");
    return { status: usd < low ? "low" : "ok", asset: "USDC", chain: SOLANA_CAIP2 };
  } catch {
    return { status: "unknown", asset: "USDC", chain: SOLANA_CAIP2 };
  }
}

/**
 * Resolve-time twin of the pay-time gate, for the router's candidate loop: a
 * candidate whose live 402 names an UNPROVEN payTo is SKIPPED (the next
 * candidate gets tried) instead of aborting the whole call at pay time - the
 * first live proof run failed exactly that way, with an unproven seller
 * ranking above workable ones and the 409 taking the whole request down.
 * Parses the probe's own v2 402 header (v1 body as fallback); anything
 * unreadable or unproven is { ok:false, reason } - the caller logs and moves
 * on. The pay-time gate in payX402 stays: this reads the PROBE's 402, the
 * seller writes both answers, and what we verify last must be what we sign.
 */
export async function passesSolanaResolveGate({ header, body, inboundFn = cachedSolanaInboundCount, minCount = Number(process.env.SOR_SVM_MIN_SETTLED_TX || process.env.SOR_MIN_SETTLED_TX || "20") } = {}) {
  let payTo = null;
  try {
    const doc = header
      ? JSON.parse(Buffer.from(String(header), "base64").toString("utf8"))
      : JSON.parse(String(body || "{}"));
    const accept = (doc.accepts || []).find((a) => SOLANA_NETWORK_LABELS.has(String(a.network || "").toLowerCase()));
    payTo = accept?.payTo || null;
  } catch { /* unreadable challenge = not a candidate */ }
  if (!payTo) return { ok: false, payTo: null, reason: "no readable solana accept on the live 402" };
  let inbound;
  try { inbound = await inboundFn(payTo, { stopAt: minCount }); }
  catch (e) { return { ok: false, payTo, reason: `chain unreadable (${String(e?.message || e).slice(0, 60)})` }; }
  if (inbound < minCount) return { ok: false, payTo, inbound, reason: `${inbound} recent inbound USDC payments (floor ${minCount})` };
  return { ok: true, payTo, inbound };
}

// ============================================================================
// KNOWN BLOCKER on the router-COMPOSED Solana buy (2026-09-01) - NOT a money
// or logic bug; documented here with a full repro for a fresh, focused fix.
//
// Symptom: payX402(..., chain:"solana") throws `fetch failed` /
//   `InvalidArgumentError: invalid content-length header`, raised SYNCHRONOUSLY
//   inside undici's `new Request()` while the @solana/kit RPC transport
//   (@solana/rpc-transport-http makeHttpRequest) builds its mint-metadata read
//   during createPaymentPayload. It throws BEFORE any authorization is signed,
//   so nothing is ever spent (the pay-time hold is released; buyer uncharged).
//
// Root cause (bisected): a `fetch()` made through ANY custom undici dispatcher
//   - our ssrfDispatcher AND a vanilla `new undici.Agent()` both do it -
//   corrupts the NEXT @solana/kit transport fetch's request construction.
//   Plain global `fetch()` never triggers it. Verified sequences:
//     plain-alchemy -> plain-bare -> sign            => OK (664-byte tx)
//     warm(kit) -> ssrf-fetch -> sign                 => OK
//     ssrf-fetch -> sign                              => THROWS
//     ssrf-fetch -> warm(kit) -> sign                 => THROWS (warm after does not clear)
//     warm(kit) -> ssrf-fetch -> 20 plain-alchemy -> sign => THROWS (evicted)
//   So warming before the poison works only if nothing runs between; payX402's
//   bare(ssrf) + ~20-read proven-gate + sign cannot satisfy that ordering.
//
// The DIRECT buy path is unaffected and settled on-chain earlier tonight
//   (tx 2jXgRZRQ568...ymFE6, $0.001 to sol.blockrun's proven payTo): it uses
//   the manual getUpstreamBuyerSvm + createPaymentPayload flow with plain
//   fetches and no dispatcher chain. So the RAIL works; only the composed
//   route-execute path hits this.
//
// Candidate fixes (each needs its own verification, none belongs in the
//   midnight rail work): (a) give @solana/kit a custom RPC transport bound to
//   a dedicated dispatcher so it never rides the corrupted global fetch;
//   (b) do all SVM signing RPC on plain fetch and move the seller fetches off
//   undici custom dispatchers (re-checking the SSRF story); (c) bump
//   @solana/kit / undici to a pair where the interaction is gone.
// ============================================================================
