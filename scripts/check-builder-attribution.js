// Why does dashboard.base.org show zero transactions for this app? Answer the
// three questions that decide Builder Code (ERC-8021) attribution end-to-end,
// against LIVE prod + LIVE Base:
//
//   1. CONFIG — does prod's 402 declare the builder-code extension?
//      (BASE_BUILDER_CODE on Railway → declareBuilderCodeExtension per route →
//      the PAYMENT-REQUIRED header carries extensions["builder-code"].info.a.)
//   2. ECHO — buyers on @x402/core >= 2.16 auto-merge every server-declared
//      extension into the payment payload (createPaymentPayload always calls
//      mergeExtensions — no client-side registration needed). Static fact of
//      the SDK; nothing to probe live. Old/non-@x402 buyers may not echo, but
//      our own daily canary is pinned to 2.16, so at least one settlement per
//      day carries the echo IF config is right.
//   3. CHAIN — do recent settlement txs into the revenue wallet actually carry
//      the ERC-8021 calldata suffix (marker 8021…8021 + CBOR {a,w,s})? This is
//      the only thing the Base dashboard indexes. If config is declared but no
//      tx carries the suffix, the facilitator (CDP) is not appending it. If
//      txs DO carry it, compare the decoded `a` code with the app code on
//      dashboard.base.org — a mismatch means attribution lands on a different
//      (or unregistered) app.
//
// Dependency-free on purpose: the CI probe job that runs this does a bare
// checkout with no npm ci. The ERC-8021 Schema-2 suffix parser below mirrors
// @x402/extensions/builder-code parseBuilderCodeSuffixFromCalldata exactly
// (suffix layout: [CBOR map {a,w,s}][2-byte CBOR length][0x02][16-byte marker],
// required to sit at the very end of calldata).
//
// Read-only and best-effort: RPC flake degrades to a partial report, exit 0.
// Only an unreachable prod (can't even fetch a 402) exits 1 — that's an outage
// signal, not an attribution signal.
//
//   TARGET_URL=https://agent402.tools node scripts/check-builder-attribution.js
import { fileURLToPath } from "node:url";

const BASE = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const WALLET = (process.env.REVENUE_WALLET || "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0").toLowerCase();
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // native USDC on Base
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SPAN = parseInt(process.env.SPAN_BLOCKS || "40000", 10); // ~22h at 2s blocks — covers a full canary cycle
const MAX_TXS = parseInt(process.env.MAX_TXS || "25", 10);
const ERC_8021_MARKER = "80218021802180218021802180218021";
const SCHEMA_2_ID = 2;
const RPCS = (process.env.BASE_RPCS ||
  "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.drpc.org"
).split(",").map((s) => s.trim()).filter(Boolean);
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");

// --- pure helpers (unit-tested in scripts/test-builder-attribution.js) -------

/** Mirror of @x402/extensions parseBuilderCodeSuffixFromCalldata: decode the
 *  ERC-8021 Schema-2 builder-code suffix from the END of tx calldata. Returns
 *  { a?, w?, s? } or undefined when absent/malformed. */
export function parseBuilderSuffix(calldata) {
  const hex = (calldata.startsWith("0x") ? calldata.slice(2) : calldata).toLowerCase();
  const markerPos = hex.lastIndexOf(ERC_8021_MARKER);
  if (markerPos < 6) return undefined;
  if (parseInt(hex.slice(markerPos - 2, markerPos), 16) !== SCHEMA_2_ID) return undefined;
  const cborLength = parseInt(hex.slice(markerPos - 6, markerPos - 2), 16);
  const suffixStart = markerPos - 6 - cborLength * 2;
  // The suffix must terminate the calldata — that's where indexers look.
  if (suffixStart < 0 || suffixStart + (cborLength + 19) * 2 !== hex.length) return undefined;
  const bytes = Uint8Array.from({ length: cborLength }, (_, i) =>
    parseInt(hex.slice(suffixStart + i * 2, suffixStart + i * 2 + 2), 16));
  let o = 0;
  const readLen = (info) => (info <= 23 ? info : info === 24 ? bytes[o++] : undefined);
  if (bytes[o] >> 5 !== 5) return undefined; // CBOR map
  const mapSize = readLen(bytes[o++] & 31);
  if (mapSize === undefined) return undefined;
  const readString = () => {
    if (bytes[o] >> 5 !== 3) return undefined; // CBOR text string
    const len = readLen(bytes[o++] & 31);
    if (len === undefined || o + len > bytes.length) return undefined;
    const s = new TextDecoder().decode(bytes.subarray(o, o + len));
    o += len;
    return s;
  };
  const result = {};
  for (let entry = 0; entry < mapSize; entry++) {
    const key = readString();
    if (key === undefined) return undefined;
    if (bytes[o] >> 5 === 4) { // CBOR array (the `s` service-code list)
      const n = readLen(bytes[o++] & 31);
      if (n === undefined) return undefined;
      const arr = [];
      for (let i = 0; i < n; i++) {
        const v = readString();
        if (v === undefined) return undefined;
        arr.push(v);
      }
      result[key] = arr;
    } else {
      const v = readString();
      if (v === undefined) return undefined;
      result[key] = v;
    }
  }
  return result;
}

/** Pull the builder-code declaration out of a decoded PAYMENT-REQUIRED JSON
 *  (checks top-level extensions first, then per-accepts). */
export function declaredBuilderCode(paymentRequired) {
  const top = paymentRequired?.extensions?.["builder-code"]?.info;
  if (top) return { where: "top-level", info: top };
  const per = (paymentRequired?.accepts || [])
    .map((a) => a?.extensions?.["builder-code"]?.info).find(Boolean);
  return per ? { where: "accepts[]", info: per } : false;
}

// --- RPC ----------------------------------------------------------------------

async function rpc(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(20000),
        });
        const j = JSON.parse(await r.text());
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) { lastErr = e; }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`All RPCs failed for ${method}: ${lastErr?.message}`);
}

/** TX=<hash> mode: decode ONE Base transaction — who sent it, what it called,
 *  whether it's an x402 settlement (transferWithAuthorization) and for whom,
 *  and what builder codes ride the calldata suffix. Forensics for "this hash
 *  settled — through WHAT path?" questions. */
async function decodeOneTx(hash) {
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  if (!tx) { console.log(JSON.stringify({ hash, found: false })); return; }
  const receipt = await rpc("eth_getTransactionReceipt", [hash]);
  const block = await rpc("eth_getBlockByNumber", [tx.blockNumber, false]);
  const input = (tx.input || "").toLowerCase();
  const transfers = (receipt?.logs || [])
    .filter((l) => l.address?.toLowerCase() === USDC && l.topics?.[0] === TRANSFER)
    .map((l) => ({
      from: "0x" + l.topics[1].slice(26),
      to: "0x" + l.topics[2].slice(26),
      usd: parseInt(l.data, 16) / 1e6,
    }));
  console.log(JSON.stringify({
    hash,
    when: new Date(parseInt(block.timestamp, 16) * 1000).toISOString(),
    status: receipt?.status === "0x1" ? "success" : "failed",
    txFrom: tx.from,
    txTo: tx.to,
    selector: input.slice(0, 10),
    isUsdcContractCall: tx.to?.toLowerCase() === USDC,
    builderCodes: parseBuilderSuffix(input) ?? null,
    usdcTransfers: transfers,
    paysRevenueWallet: transfers.some((t) => t.to.toLowerCase() === WALLET),
  }, null, 2));
}

async function main() {
  if (process.env.TX) { await decodeOneTx(process.env.TX.toLowerCase()); return; }
  // ---- 1. CONFIG: health flag + live 402 declaration -------------------------
  let healthFlag = null;
  try {
    const h = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(15000) })).json();
    healthFlag = h?.flags?.builderCode ?? null;
  } catch (e) {
    console.error(`(health fetch failed: ${e.message})`);
  }

  let declared;
  try {
    const r = await fetch(`${BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
    const header = r.headers.get("payment-required") || r.headers.get("x-payment-required");
    if (!header) throw new Error("402 without PAYMENT-REQUIRED header");
    declared = declaredBuilderCode(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  } catch (e) {
    console.error(`FATAL: could not decode a live 402 from ${BASE}: ${e.message}`);
    process.exit(1);
  }

  console.error(`/health flags.builderCode: ${healthFlag === null ? "(unavailable)" : healthFlag}`);
  console.error(
    declared
      ? `402 declares builder-code (${declared.where}): ${JSON.stringify(declared.info)}`
      : "402 does NOT declare the builder-code extension"
  );

  // ---- 3. CHAIN: do recent settlements carry the ERC-8021 suffix? ------------
  const txReport = [];
  let scanError = null;
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    // Free-tier public RPCs cap eth_getLogs at 10k-block ranges (same cap the
    // Polygon revenue scan hit) — walk the window in chunks instead of one call.
    const CHUNK = 8000;
    const logs = [];
    for (let to = latest; to > latest - SPAN; to -= CHUNK) {
      const from = Math.max(to - CHUNK + 1, latest - SPAN);
      logs.push(...await rpc("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        address: USDC,
        topics: [TRANSFER, null, pad(WALLET)],
      }]));
    }
    // Keep the FIRST occurrence of each tx (logs are collected newest-chunk
    // first, oldest within a chunk first) and remember its block for the
    // timestamp — "when did attribution START landing" is the question that
    // separates indexer lag from a schema/registration mismatch.
    const byHash = new Map();
    for (const l of logs) if (!byHash.has(l.transactionHash)) byHash.set(l.transactionHash, l.blockNumber);
    // Sample evenly across the whole window (not newest-first): the oldest
    // days must be represented or "when did attribution start" is unanswerable.
    const all = [...byHash.keys()];
    const step = Math.max(1, Math.ceil(all.length / MAX_TXS));
    const hashes = all.filter((_, i) => i % step === 0).slice(0, MAX_TXS);
    const tsCache = {};
    const blockTs = async (blk) => {
      if (!tsCache[blk]) tsCache[blk] = parseInt((await rpc("eth_getBlockByNumber", [blk, false])).timestamp, 16);
      return tsCache[blk];
    };
    console.error(`\n${logs.length} USDC transfer(s) into ${WALLET} over last ${SPAN} blocks; inspecting ${hashes.length} tx(s):`);
    for (const hash of hashes) {
      const tx = await rpc("eth_getTransactionByHash", [hash]);
      const input = (tx?.input || "").toLowerCase();
      const hasMarker = input.includes(ERC_8021_MARKER);
      const decoded = hasMarker ? parseBuilderSuffix(input) : undefined;
      const when = new Date((await blockTs(byHash.get(hash))) * 1000).toISOString();
      txReport.push({ tx: hash, when, marker: hasMarker, codes: decoded ?? null });
      console.error(`  ${when} ${hash} ${decoded ? `ATTRIBUTED ${JSON.stringify(decoded)}`
        : hasMarker ? "marker present but suffix malformed/not-at-end" : "no builder-code suffix"}`);
    }
    // Per-day rollup: the shape of this table IS the diagnosis. Attribution
    // starting only recently → dashboard zero before that was correct, wait
    // for the indexer. Attributed txs across many days with a still-zero
    // dashboard → Base-side indexing gap, report with tx hashes.
    const days = {};
    for (const t of txReport) {
      const d = t.when.slice(0, 10);
      days[d] ??= { inspected: 0, attributed: 0 };
      days[d].inspected++;
      if (t.codes) days[d].attributed++;
    }
    console.error("\nper-day (UTC): " + Object.entries(days).sort()
      .map(([d, c]) => `${d}: ${c.attributed}/${c.inspected} attributed`).join("  ·  "));
  } catch (e) {
    scanError = e.message;
    console.error(`chain scan failed (best-effort): ${e.message}`);
  }

  // ---- Verdict ----------------------------------------------------------------
  const attributed = txReport.filter((t) => t.codes).length;
  let verdict;
  if (!declared) {
    verdict = "NOT CONFIGURED: prod's 402 does not declare the builder-code extension — set BASE_BUILDER_CODE on Railway to the app code from dashboard.base.org and redeploy. No settlement can be attributed until then.";
  } else if (txReport.length && attributed === 0) {
    verdict = "DECLARED BUT NOT ON-CHAIN: prod declares the code, buyers on @x402>=2.16 echo it, but no inspected settlement carries a valid ERC-8021 suffix — the facilitator (CDP) is not appending it at settlement. Check CDP's x402 facilitator Builder Code support/rollout.";
  } else if (attributed > 0) {
    verdict = `ATTRIBUTION IS LANDING ON-CHAIN (${attributed}/${txReport.length} inspected settlements). If the dashboard still shows zero, compare the decoded 'a' code above with the app's Builder Code on dashboard.base.org — they must match exactly — and allow for dashboard indexing lag.`;
  } else {
    verdict = `DECLARED, but no settlements found to inspect in the last ${SPAN} blocks${scanError ? ` (scan error: ${scanError})` : ""} — re-run after the next paid call (daily canary buys at 13:17 UTC).`;
  }
  console.error(`\nVERDICT: ${verdict}`);

  console.log(JSON.stringify({
    baseUrl: BASE,
    healthFlag,
    declared: declared || false,
    inspected: txReport.length,
    attributed,
    txs: txReport,
    verdict,
  }, null, 2));
}

// Run only as a CLI; importing for tests must not hit the network.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
