// solana-rpc: read-only Solana mainnet JSON-RPC, the Solana sibling of
// evm-rpc (src/tools/chain-kit.js), with the same rules:
//
//   * a HARD method allowlist of reads, matched case-insensitively and sent
//     upstream in canonical casing; getProgramAccounts (unbounded scans),
//     every send/simulate/airdrop method and every subscription is refused;
//   * bounded params in (at most 4 entries, 4 KB serialized) and a bounded
//     result out (200 KB serialized, else 413 "narrow the query"), plus a byte
//     cap on the upstream body read itself;
//   * per-method shape checks before any egress (base58 addresses and
//     signatures, a slot number, bounded list lengths), and defaults that keep
//     the heavy reads small (getBlock without full transactions or rewards,
//     getSignaturesForAddress at 20 rows unless asked, at most 100);
//   * multi-endpoint failover over the shared Solana RPC list
//     (SOLANA_RPCS, src/solana-history-rpc.js): the keyed lane first, then the
//     public endpoints. Every call to the keyed provider passes the process
//     fetch hook, which counts it against that provider's hard daily ceiling
//     (src/upstream-hard-caps.js) and refuses past it with an uncharged 503.
//
// A well-formed JSON-RPC error is the node's verdict on the request (a bad
// param, a pruned slot) and passes through as a 502 without walking the list;
// a provider refusing us (rate limit, key, 403) or a transport failure moves
// to the next endpoint. Egress: wallet-only (src/pow.js WALLET_ONLY_SLUGS).

import { ssrfDispatcher } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";
import { partialFields } from "../partial-answer.js";
import { readBytesCapped, decodeUtf8 } from "../capped-body.js";
import { SOLANA_RPCS } from "../solana-history-rpc.js";
import { upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS, isUpstreamFailure, budgetSpentError, budgetSpent, currentBudget } from "../upstream-deadline.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const SOLANA_RPC_TIMEOUT_MS = 8_000;
const SOLANA_RPC_MAX_PARAMS = 4;
const SOLANA_RPC_MAX_PARAMS_BYTES = 4096;
const SOLANA_RPC_MAX_RESULT_BYTES = 200_000;
// The upstream body is read under its own cap: a node answering a huge
// account or block is cut off here rather than buffered whole.
const SOLANA_RPC_MAX_BODY_BYTES = 2_000_000;
const SIGNATURES_DEFAULT_LIMIT = 20;
const SIGNATURES_MAX_LIMIT = 100;
const SIGNATURE_STATUSES_MAX = 20;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function address(v, what) {
  if (typeof v !== "string" || !BASE58_ADDRESS.test(v)) throw bad(`${what} must be a base58 Solana address (32-44 characters)`);
  return v;
}
function signature(v, what) {
  if (typeof v !== "string" || !BASE58_SIGNATURE.test(v)) throw bad(`${what} must be a base58 transaction signature`);
  return v;
}
/** An optional config object: a plain object whose commitment, when set, is a known level. */
function config(v, what, allowed) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw bad(`${what} must be an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw bad(`${what} field "${k}" is not accepted here; allowed: ${allowed.join(", ")}`);
  if (v.commitment !== undefined && !COMMITMENTS.has(v.commitment)) throw bad(`commitment must be processed, confirmed or finalized`);
  if (v.minContextSlot !== undefined && !(Number.isSafeInteger(v.minContextSlot) && v.minContextSlot >= 0)) throw bad(`minContextSlot must be a slot number`);
  return { ...v };
}
const ENCODINGS = new Set(["base58", "base64", "base64+zstd", "jsonParsed"]);
function encoding(c, dflt) {
  if (c.encoding === undefined) { if (dflt) c.encoding = dflt; return c; }
  if (!ENCODINGS.has(c.encoding)) throw bad(`encoding must be one of ${[...ENCODINGS].join(", ")}`);
  return c;
}
function dataSlice(c) {
  if (c.dataSlice === undefined) return c;
  const d = c.dataSlice;
  if (!isPlainObject(d) || !Number.isSafeInteger(d.offset) || !Number.isSafeInteger(d.length) || d.offset < 0 || d.length < 0) throw bad(`dataSlice must be { offset, length } with whole numbers`);
  return c;
}
// An account's raw bytes are read only through a slice: an account can hold
// megabytes, which the node would send whole before the result cap refused
// them. jsonParsed answers are read without one.
const ACCOUNT_SLICE_MAX = 65_536;
function rawSliceRequired(c) {
  if (c.encoding === "jsonParsed") return c;
  if (c.dataSlice === undefined) throw bad(`getAccountInfo in ${c.encoding} needs a dataSlice { offset, length } of at most ${ACCOUNT_SLICE_MAX} bytes (or encoding "jsonParsed")`);
  if (c.dataSlice.length > ACCOUNT_SLICE_MAX) throw bad(`dataSlice.length is capped at ${ACCOUNT_SLICE_MAX} bytes`);
  return c;
}
// A block's signature list is served up to this many, marked partial past it.
const BLOCK_SIGNATURES_MAX = 1000;
const noParams = (what) => (p) => {
  if (p.length > 1) throw bad(`${what} takes at most one parameter (a config object)`);
  return p.length ? [config(p[0], "the config", ["commitment", "minContextSlot"])] : [];
};

// method -> params check (returns the params sent upstream). Every entry is a read.
const METHODS = {
  getSlot: noParams("getSlot"),
  getBlockHeight: noParams("getBlockHeight"),
  getEpochInfo: noParams("getEpochInfo"),
  getLatestBlockhash: noParams("getLatestBlockhash"),
  getTransactionCount: noParams("getTransactionCount"),
  getHealth: (p) => { if (p.length) throw bad(`getHealth takes no parameters`); return []; },
  getVersion: (p) => { if (p.length) throw bad(`getVersion takes no parameters`); return []; },
  getBalance: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getBalance takes [address, config?]`);
    return [address(p[0], "the address"), ...(p.length > 1 ? [config(p[1], "the config", ["commitment", "minContextSlot"])] : [])];
  },
  getAccountInfo: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getAccountInfo takes [address, config?]`);
    return [address(p[0], "the address"), rawSliceRequired(dataSlice(encoding(config(p[1], "the config", ["commitment", "minContextSlot", "encoding", "dataSlice"]), "base64")))];
  },
  getTokenAccountBalance: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getTokenAccountBalance takes [tokenAccount, config?]`);
    return [address(p[0], "the token account"), ...(p.length > 1 ? [config(p[1], "the config", ["commitment"])] : [])];
  },
  getTokenSupply: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getTokenSupply takes [mint, config?]`);
    return [address(p[0], "the mint"), ...(p.length > 1 ? [config(p[1], "the config", ["commitment"])] : [])];
  },
  getTokenAccountsByOwner: (p) => {
    if (p.length < 2 || p.length > 3) throw bad(`getTokenAccountsByOwner takes [owner, { mint }, config?]`);
    const f = p[1];
    if (!isPlainObject(f) || Object.keys(f).length !== 1 || !(f.mint !== undefined || f.programId !== undefined)) throw bad(`the filter must be exactly { mint }`);
    // An owner's accounts under a whole token program is an unbounded scan:
    // the filter names one mint.
    if (f.mint === undefined) throw bad(`the filter must be { mint }; a { programId } filter reads every account the owner holds under the program and is not served`);
    const filter = { mint: address(f.mint, "the mint") };
    return [address(p[0], "the owner"), filter, dataSlice(encoding(config(p[2], "the config", ["commitment", "minContextSlot", "encoding", "dataSlice"]), "jsonParsed"))];
  },
  getSignaturesForAddress: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getSignaturesForAddress takes [address, config?]`);
    const c = config(p[1], "the config", ["commitment", "minContextSlot", "limit", "before", "until"]);
    if (c.limit === undefined) c.limit = SIGNATURES_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(c.limit) || c.limit < 1 || c.limit > SIGNATURES_MAX_LIMIT) throw bad(`limit must be a whole number from 1 to ${SIGNATURES_MAX_LIMIT}`);
    if (c.before !== undefined) signature(c.before, "before");
    if (c.until !== undefined) signature(c.until, "until");
    return [address(p[0], "the address"), c];
  },
  getSignatureStatuses: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getSignatureStatuses takes [[signature, ...], config?]`);
    if (!Array.isArray(p[0]) || p[0].length < 1 || p[0].length > SIGNATURE_STATUSES_MAX) throw bad(`the signature list holds 1 to ${SIGNATURE_STATUSES_MAX} signatures`);
    const sigs = p[0].map((s, k) => signature(s, `signature ${k + 1}`));
    const c = config(p[1], "the config", ["searchTransactionHistory"]);
    if (c.searchTransactionHistory !== undefined && typeof c.searchTransactionHistory !== "boolean") throw bad(`searchTransactionHistory must be true or false`);
    return p.length > 1 ? [sigs, c] : [sigs];
  },
  getTransaction: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getTransaction takes [signature, config?]`);
    const c = config(p[1], "the config", ["commitment", "encoding", "maxSupportedTransactionVersion"]);
    if (c.encoding !== undefined && !new Set(["json", "jsonParsed", "base58", "base64"]).has(c.encoding)) throw bad(`encoding must be json, jsonParsed, base58 or base64`);
    if (c.commitment === "processed") throw bad(`getTransaction reads confirmed or finalized transactions only`);
    // Without it a node refuses every versioned transaction.
    if (c.maxSupportedTransactionVersion === undefined) c.maxSupportedTransactionVersion = 0;
    if (c.maxSupportedTransactionVersion !== 0) throw bad(`maxSupportedTransactionVersion must be 0`);
    return [signature(p[0], "the signature"), c];
  },
  getBlock: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`getBlock takes [slot, config?]`);
    if (!Number.isSafeInteger(p[0]) || p[0] < 0) throw bad(`the slot must be a whole number`);
    const c = config(p[1], "the config", ["commitment", "transactionDetails", "rewards", "maxSupportedTransactionVersion"]);
    // A full block is megabytes: transaction bodies are not served here
    // (read one with getTransaction), and rewards are off unless asked.
    if (c.transactionDetails === undefined) c.transactionDetails = "none";
    if (c.transactionDetails !== "none" && c.transactionDetails !== "signatures") throw bad(`transactionDetails must be "none" or "signatures"; read a transaction body with getTransaction`);
    if (c.rewards === undefined) c.rewards = false;
    if (typeof c.rewards !== "boolean") throw bad(`rewards must be true or false`);
    if (c.commitment === "processed") throw bad(`getBlock reads confirmed or finalized blocks only`);
    if (c.maxSupportedTransactionVersion === undefined) c.maxSupportedTransactionVersion = 0;
    if (c.maxSupportedTransactionVersion !== 0) throw bad(`maxSupportedTransactionVersion must be 0`);
    return [p[0], c];
  },
  isBlockhashValid: (p) => {
    if (p.length < 1 || p.length > 2) throw bad(`isBlockhashValid takes [blockhash, config?]`);
    return [address(p[0], "the blockhash"), ...(p.length > 1 ? [config(p[1], "the config", ["commitment", "minContextSlot"])] : [])];
  },
};
export const SOLANA_RPC_METHODS = Object.keys(METHODS);
const METHOD_BY_LOWER = new Map(SOLANA_RPC_METHODS.map((m) => [m.toLowerCase(), m]));

/** The endpoints in the order they are asked: the shared list, read per call. */
export function solanaRpcEndpoints(env = process.env) {
  const urls = env.SOLANA_RPCS ? String(env.SOLANA_RPCS).split(",").map((s) => s.trim()).filter(Boolean) : SOLANA_RPCS;
  return [...new Set(urls)].filter((u) => /^https:\/\//i.test(u));
}

// Provider refusals of US (not answers about the request): walk on.
const REFUSAL = /api key|tenant disabled|\b403\b|rate limit|too many requests|method not found|unsupported method|not available on (?:the|your) (?:free )?(?:tier|plan)/i;

export async function solanaJsonRpc(method, params, { fetchImpl } = {}) {
  const urls = solanaRpcEndpoints();
  if (!urls.length) throw bad("No Solana RPC endpoint is configured here", 503);
  let lastErr;
  let tried = 0;
  walk: for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of urls) {
      if (tried++ && budgetSpent()) break walk;
      let res, bytes;
      const ctx = { label: "Solana RPC", step: method, timeoutMs: SOLANA_RPC_TIMEOUT_MS, tag: "[solana-rpc]", ...(fetchImpl ? { fetchImpl } : {}) };
      try {
        res = await upstreamFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          dispatcher: ssrfDispatcher,
        }, ctx);
        bytes = await bodyUnderDeadline(readBytesCapped(res, SOLANA_RPC_MAX_BODY_BYTES), ctx);
      } catch (e) {
        // A daily ceiling refusal is the answer: uncharged, and it names the retry time.
        if (e?.hardCap) throw e;
        lastErr = e; continue;
      }
      if (bytes.truncated) {
        throw bad(`Result too large (over ${SOLANA_RPC_MAX_BODY_BYTES} bytes from the node, cap ${SOLANA_RPC_MAX_RESULT_BYTES}); narrow the query (a dataSlice, a mint filter, a smaller limit)`, 413);
      }
      let data;
      try { data = JSON.parse(decodeUtf8(bytes.bytes)); } catch { lastErr = new Error(`non-JSON from upstream (HTTP ${res.status})`); continue; }
      if (data && data.error) {
        const msg = redactSecrets(String(data.error.message || "unknown node error")).slice(0, 300);
        if (res.status === 429 || res.status === 401 || res.status === 403 || data.error.code === 429 || data.error.code === -32429 || data.error.code === -32601 || REFUSAL.test(msg)) {
          lastErr = new Error(`provider refused: ${msg}`); continue;
        }
        const err = bad(`Node error: ${msg}`, 502);
        if (typeof data.error.code === "number") err.rpcCode = data.error.code;
        throw err;
      }
      if (data && data.result !== undefined) return data.result;
      lastErr = new Error(`HTTP ${res.status} from upstream`);
    }
  }
  if (isUpstreamFailure(lastErr)) throw lastErr;
  if (!lastErr && budgetSpent()) throw budgetSpentError("Solana RPC", method, currentBudget()?.totalMs ?? SOLANA_RPC_TIMEOUT_MS);
  throw bad(`Solana RPC upstream unavailable${lastErr ? ` (${redactSecrets(String(lastErr.message)).slice(0, 120)})` : ""}`, 502);
}

/** The checked request: canonical method and the params sent upstream. Throws 400 before any egress. */
export function checkSolanaRpcRequest(input) {
  const rawMethod = typeof input?.method === "string" ? input.method.trim() : "";
  const method = METHOD_BY_LOWER.get(rawMethod.toLowerCase());
  if (!method) {
    throw bad(`${rawMethod ? `Method "${rawMethod.slice(0, 60)}" is not allowed: read-only allowlist only` : `"method" is required`}. Allowed: ${SOLANA_RPC_METHODS.join(", ")}`);
  }
  if (input.network !== undefined && input.network !== null && typeof input.network !== "string") throw bad(`"network" must be text: "mainnet"`);
  if (input.network !== undefined && input.network !== null && input.network !== "" && input.network.toLowerCase() !== "mainnet" && input.network.toLowerCase() !== "solana") {
    throw bad(`"network" must be "mainnet" (Solana mainnet is the only network served)`);
  }
  const params = input.params === undefined || input.params === null ? [] : input.params;
  if (!Array.isArray(params)) throw bad(`"params" must be an array (JSON-RPC positional parameters)`);
  if (params.length > SOLANA_RPC_MAX_PARAMS) throw bad(`"params" is capped at ${SOLANA_RPC_MAX_PARAMS} entries (got ${params.length})`);
  let serialized;
  try { serialized = JSON.stringify(params); } catch { serialized = undefined; }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > SOLANA_RPC_MAX_PARAMS_BYTES) {
    throw bad(`"params" must be JSON-serializable and at most ${SOLANA_RPC_MAX_PARAMS_BYTES} bytes serialized`);
  }
  return { method, params: METHODS[method](JSON.parse(serialized)) };
}

export const SOLANA_RPC_TOOLS = [
  {
    route: "POST /api/solana-rpc",
    name: "Solana RPC (read-only)",
    slug: "solana-rpc", aliases: ["sol-rpc", "solana-json-rpc"],
    category: "crypto",
    price: "$0.004",
    description:
      `Read-only JSON-RPC against Solana mainnet with multi-endpoint failover: one paid call, no node or API key of your own. Allowlisted reads only: ${SOLANA_RPC_METHODS.join(", ")}. getProgramAccounts and every send, simulate, airdrop and subscription method are refused. Heavy reads stay small: getBlock returns signatures (the first ${BLOCK_SIGNATURES_MAX.toLocaleString("en-US")}, marked partial past that) or no transaction list (never full bodies) and no rewards unless asked, getAccountInfo reads raw account bytes through a dataSlice of at most ${ACCOUNT_SLICE_MAX.toLocaleString("en-US")} bytes, or jsonParsed (an account the node cannot parse comes back as base64, held to the result cap below), getTokenAccountsByOwner takes a mint filter, getSignaturesForAddress returns 20 rows by default and 100 at most, getSignatureStatuses takes up to 20 signatures. Results over 200KB serialized return 413; narrow the query (a dataSlice, a mint filter, a smaller limit).`,
    tags: ["crypto", "solana", "rpc", "json-rpc", "svm", "spl", "account", "transaction", "balance", "slot"],
    discovery: {
      bodyType: "json",
      input: { method: "getSlot", params: [] },
      inputSchema: {
        properties: {
          method: { type: "string", description: "An allowlisted read-only Solana JSON-RPC method (e.g. getSlot, getBalance, getAccountInfo, getTransaction)." },
          params: { type: "array", description: `JSON-RPC positional parameter array (default []). Max ${SOLANA_RPC_MAX_PARAMS} entries, 4KB serialized. Addresses and signatures are base58.` },
          network: { type: "string", description: "mainnet (the default and the only network served)." },
        },
        required: ["method"],
      },
      output: {
        example: { network: "mainnet", method: "getSlot", result: 472743760 },
      },
    },
    handler: async (i) => {
      const { method, params } = checkSolanaRpcRequest(i || {});
      let result = await solanaJsonRpc(method, params);
      // A large block's signature list is cut, not refused: the node already
      // answered, so the buyer gets the first signatures, marked partial.
      let cut = {};
      if (method === "getBlock" && Array.isArray(result?.signatures) && result.signatures.length > BLOCK_SIGNATURES_MAX) {
        const total = result.signatures.length;
        result = { ...result, signatures: result.signatures.slice(0, BLOCK_SIGNATURES_MAX) };
        cut = { signaturesTotal: total, ...partialFields(total, BLOCK_SIGNATURES_MAX) };
      }
      const resultJson = JSON.stringify(result);
      const resultBytes = resultJson === undefined ? 0 : Buffer.byteLength(resultJson, "utf8");
      if (resultBytes > SOLANA_RPC_MAX_RESULT_BYTES) {
        throw bad(
          `Result too large (${resultBytes} bytes serialized, cap ${SOLANA_RPC_MAX_RESULT_BYTES}); narrow the query (a dataSlice, a mint filter, a smaller limit)`,
          413,
        );
      }
      return { network: "mainnet", method, result, ...cut };
    },
  },
];

underBudgetAll(SOLANA_RPC_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
