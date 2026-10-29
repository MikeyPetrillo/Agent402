// agent402-client - a tiny buyer-side client for agent402.tools (or any Agent402
// instance). Resolve a task to a tool, then call it with payment handled for you:
//   - free pure-CPU tools settle with a built-in proof-of-work (no wallet, zero deps),
//   - wallet-only tools settle via an x402-wrapped fetch you provide (@x402/fetch),
// results are cached (tools are deterministic), and every send carries an
// Idempotency-Key that is stable per client instance and per operation while
// caching is on, so a retry of a lost response (inside call() or by the caller
// invoking call() again) replays the paid answer on the credits and PoW paths
// instead of paying twice. A wallet buyer's fresh call() signs a fresh
// authorization, which the server treats as a new payment by design - see
// README "Retries and double charges".
//
//   import { Agent402 } from "agent402-client";
//   const a = new Agent402();                       // free tier, proof-of-work
//   const [best] = await a.find("extract the article from a url");
//   const out = await a.call("extract", { url: "https://example.com/article" });
//
//   // paid tools: pass an x402-wrapped fetch (your wallet signs)
//   const a = new Agent402({ fetch: payFetch });
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { quoteOf, guardSigning, networkIdsOf, acceptUsd } from "./known-assets.js";
export { KNOWN_ASSETS, NETWORK_NAMES, knownAsset, acceptUsd, networkIdsOf } from "./known-assets.js";
import { distrustFetch } from "./tls-distrust.js";
export { distrustFetch, distrustDispatcher, distrustCheckServerIdentity, DISTRUSTED_SPKI_SHA256 } from "./tls-distrust.js";
import { awaitJob, shouldRequestAsync, AsyncJobPendingError, DEFAULT_ASYNC_TIMEOUT_MS } from "./async-job.js";
export { AsyncJobPendingError } from "./async-job.js";

// Keep in lockstep with package.json. Every request the SDK issues carries
// `User-Agent: agent402-client/<version>` - a standard header, no extra
// network calls - so a seller can attribute traffic (and settled payments)
// to this SDK. Product token only; nothing about the caller rides along.
const VERSION = "0.8.20";
const USER_AGENT = `agent402-client/${VERSION}`;
// 32MB: about a hundred times any realistic response from this catalog (the
// largest is a base64 image at a few MB), so it cannot break a legitimate
// caller, while still stopping the class it exists for. A ceiling that is off
// by default protects nobody, so this one is on; pass null to disable it.
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const leadingZeroBits = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };

// Discovery reads (catalog, find, route, skill packs, leaderboard, a
// proof-of-work challenge) settle nothing, so a 503 the server sheds under
// load is safe to repeat. It is retried only when it names its own delay
// (a Retry-After header or a retryAfterSeconds body field), at most
// DISCOVERY_ATTEMPTS tries in all, each wait capped at DISCOVERY_MAX_WAIT_MS.
// A paid or priced call never goes through here: a repeat of one could settle
// twice.
const DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_MAX_WAIT_MS = 5000;

/** The wait (ms) a shed 503 asks for, or null when `r` is not one. */
async function shedRetryWaitMs(r, maxWaitMs = DISCOVERY_MAX_WAIT_MS) {
  if (!r || r.status !== 503) return null;
  const header = r.headers && typeof r.headers.get === "function" ? r.headers.get("retry-after") : null;
  let seconds = header != null && String(header).trim() !== "" ? Number(header) : NaN;
  if (!Number.isFinite(seconds)) {
    try {
      const body = await (typeof r.clone === "function" ? r.clone() : r).json();
      seconds = Number(body && body.retryAfterSeconds);
    } catch { seconds = NaN; }
  }
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxWaitMs);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The Circle Gateway batched option: a second `exact` accept a seller may
// offer on an EVM chain, named by `extra.name`, that a buyer pays from a USDC
// balance deposited into Circle Gateway once (an on-chain transfer the buyer
// pays gas for) by signing the same EIP-3009 TransferWithAuthorization under
// the GatewayWalletBatched EIP-712 domain the accept carries (its name,
// version and verifyingContract, with the chain's own id) instead of the
// asset's. Gateway verifies and settles it off chain, so no gas rides on a
// call. A stock x402 client signs under the asset's domain, so this is paid
// here, by the signer the `gateway` option names, and only when that option
// is set. A payment Gateway has not confirmed inside the seller's wait is
// answered 402 with reason settlement-pending: the SAME header is resent
// after the seller's Retry-After (never a new signature, which could be a
// second charge), at most GATEWAY_PENDING_RESENDS times, each wait capped at
// GATEWAY_PENDING_MAX_WAIT_MS; past that GatewayPendingError carries the
// header to resend later.
export const GATEWAY_KIND_NAME = "GatewayWalletBatched";
const GATEWAY_TYPES = Object.freeze({
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
});
const GATEWAY_PENDING_RESENDS = 3;
const GATEWAY_PENDING_MAX_WAIT_MS = 30_000;
const GATEWAY_DOCS_URL = "https://github.com/MikeyPetrillo/Agent402/wiki/Circle-Gateway";
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

// A pre-wrapped payment fetch with no x402Client is the one mode where the caps
// are checked on an unpaid preflight only, not on the payment that is signed.
// Said once per process, on the first capped paid call in that mode.
let advisoryCapsWarned = false;
function warnAdvisoryCaps() {
  if (advisoryCapsWarned) return;
  advisoryCapsWarned = true;
  console.warn("[agent402-client] spending caps are set with a pre-wrapped payment fetch and no x402Client, so they are checked on a preflight of the 402 only, not on the payment that is signed. Pass { x402Client } (the client your fetch wraps) to enforce them at signing.");
}

export class Agent402 {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl="https://agent402.tools"]
   * @param {typeof fetch} [opts.fetch]      an x402-wrapped fetch for wallet-only tools (optional)
   * @param {boolean} [opts.cache=true]      cache results in memory (deterministic tools)
   * @param {typeof fetch} [opts.fetchImpl]  plain fetch (defaults to global fetch through distrustFetch)
   * @param {boolean} [opts.tlsDistrust=true] send the default fetch through distrustFetch (refuses a TLS
   *                                         chain through a distrusted intermediate CA); false sends it as is
   * @param {number} [opts.maxPerCallUsd]    hard ceiling on a single paid call (USD); over → SpendingLimitError before paying
   * @param {number} [opts.dailyLimitUsd]    hard ceiling on rolling-24h paid spend (USD)
   * @param {number} [opts.maxPerHostUsd]    hard ceiling on rolling-24h paid spend to one seller host (USD)
   * @param {object} [opts.x402Client]       the @x402/core x402Client your `fetch` wraps: the caps are then
   *                                         enforced on the payment that is signed (see guardX402Client)
   * @param {string[]} [opts.payNetworks]    the chains your pre-wrapped `fetch` pays on (e.g. ["base"], the
   *                                         names withNetworkPreference takes): without an x402Client the
   *                                         caps count the dearest accept on these chains, not on every chain
   * @param {string} [opts.creditsKey]       a prepaid card-credits key (a402_...) - pays wallet-only tools on
   *                                         Agent402's own services when no payFetch is given
   * @param {{signer: {address: string, signTypedData: function}, networks?: string[]}} [opts.gateway]
   *        Pay the Circle Gateway batched accept where a 402 offers one: `signer` is an
   *        EIP-712 signer (a viem account: `address` and `signTypedData`) that holds a USDC
   *        deposit in Circle Gateway; `networks` (chain names, as withNetworkPreference takes)
   *        limits which chains' batched accepts it signs (default: any EVM chain offered). Off
   *        by default. A 402 with no batched accept falls back to `fetch` or `creditsKey`.
   * @param {number|null} [opts.maxResponseBytes=33554432]
   *        Hard ceiling on a response body, enforced BEFORE it is parsed. null disables it.
   * @param {{id:string, validate:function}} [opts.outputValidator]
   *        Optional buyer-owned result validator. `id` namespaces cache entries;
   *        `validate` may return false or throw to reject delivery.
   * @param {"auto"|boolean} [opts.respondAsync="auto"]
   *        Slow paid routes (the catalog's `async.recommended`): "auto" sends the
   *        paid call with Prefer: respond-async and polls the job link until the
   *        answer is ready; true does it on every route that runs as a job; false
   *        never (wait on the connection).
   * @param {number} [opts.asyncTimeoutMs=900000] overall wait for a job; past it,
   *        AsyncJobPendingError carries the job link to collect later
   * @param {function} [opts.onProgress] called with each job document
   *        ({ status, stage, progress, etaSeconds, ... }) while a job runs
   */
  constructor({ baseUrl = "https://agent402.tools", fetch: payFetch, cache = true, fetchImpl = undefined, tlsDistrust = true,
    maxPerCallUsd = null, dailyLimitUsd = null, maxPerHostUsd = null, creditsKey = null, x402Client = null, payNetworks = null,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, outputValidator = null,
    respondAsync = "auto", asyncTimeoutMs = DEFAULT_ASYNC_TIMEOUT_MS, onProgress = null, gateway = null } = {}) {
    this.respondAsync = respondAsync;
    this.gateway = normalizeGateway(gateway);
    this.asyncTimeoutMs = numOrNull(asyncTimeoutMs) ?? DEFAULT_ASYNC_TIMEOUT_MS;
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.creditsKey = typeof creditsKey === "string" && /^a402_[A-Za-z0-9_-]{32,64}$/.test(creditsKey) ? creditsKey : null;
    if (fetchImpl === undefined) {
      fetchImpl = globalThis.fetch;
      if (typeof fetchImpl === "function" && tlsDistrust !== false) fetchImpl = distrustFetch(fetchImpl);
    }
    if (typeof fetchImpl !== "function") throw new Error("No fetch available - pass { fetchImpl } on Node < 18");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.payFetch = payFetch || null;
    // Wrap the plain fetch so every request identifies the SDK (see USER_AGENT
    // above). Caller-supplied init.headers still win on a key collision.
    this.f = (url, init = {}) => fetchImpl(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers || {}) } });
    this._catalog = null;
    // The wait between shed-503 retries of a discovery read (tests replace it).
    this._sleep = sleepMs;
    this._cache = cache ? new Map() : null;
    // Salt for the default Idempotency-Key: one per client instance, so the key
    // for (slug, params) is stable across call() invocations on THIS client
    // (an agent framework retrying a lost response gets the replay) and still
    // distinct between sessions (two processes buying the same thing are two
    // purchases). Issue #1126: the old default mixed Date.now() + Math.random()
    // per invocation, which protected retries inside one call() and nothing
    // the header promised beyond it.
    this._idemSalt = randomBytes(12).toString("hex");
    // Spending policy (defends the x402 "wallet drain via uncapped spending"
    // failure mode): optional hard ceilings enforced BEFORE any payment is
    // signed. A malicious or misconfigured 402 that quotes an inflated price is
    // refused instead of paid. null = no limit (default - behavior unchanged).
    // Amounts commit to the rolling window only on a settled paid call, so a
    // failed/blocked call never counts against the budget.
    this._spend = {
      maxPerCall: numOrNull(maxPerCallUsd),
      daily: numOrNull(dailyLimitUsd),
      perHost: numOrNull(maxPerHostUsd),
      log: [], // [{ ts, host, usd }] - settled paid calls in the last 24h
    };
    // The paid call being signed right now, so the signing guard can tell this
    // call's own reservation from every other one (see guardX402Client).
    this._signCtx = new AsyncLocalStorage();
    this._guarded = false;
    if (x402Client) this.guardX402Client(x402Client);
    // The chains a pre-wrapped fetch pays on, as CAIP-2 ids (null = unknown).
    this._payNetworks = Array.isArray(payNetworks) && payNetworks.length
      ? new Set(payNetworks.flatMap((n) => networkIdsOf(n)).map((id) => id.toLowerCase()))
      : null;
    // A response-size ceiling, enforced before parsing. See _readJson.
    this.maxResponseBytes = maxResponseBytes === null ? null : (numOrNull(maxResponseBytes) ?? DEFAULT_MAX_RESPONSE_BYTES);
    // Buyer-owned delivery policy. The callback stays entirely local and may
    // use Ajv, Zod, agent-payment-policy, or ordinary application code.
    this.outputValidator = normalizeOutputValidator(outputValidator, "constructor");
  }

  /**
   * Enforce this client's spending caps on the payment that is signed.
   *
   * Register it on the x402Client your `fetch` wraps (or pass it as the
   * `x402Client` option): every accept that cannot be priced from a known
   * asset, or that asks more than the per-call cap or what is left of the
   * rolling caps, is dropped before the client selects one, and the selected
   * one is checked again just before its payload is built. The preflight read
   * of the 402 still runs for a readable refusal, but the challenge that is
   * signed is the one this guard sees, so the caps hold on the paid request's
   * own 402 whatever the preflight said. Returns the client.
   */
  guardX402Client(client) {
    guardSigning(client, {
      allowance: () => this._signAllowance().cap,
      onSign: (usd) => {
        const ctx = this._signCtx.getStore();
        if (!ctx) return;
        ctx.signedUsd = usd;
        if (ctx.reservation) ctx.reservation.usd = usd;
      },
      onRefuse: (detail) => {
        const ctx = this._signCtx.getStore();
        if (ctx) ctx.refusal = { ...detail, limit: this._signAllowance().limit };
      },
    });
    this._guarded = true;
    return client;
  }

  /** The most the payment being signed may ask for: the per-call cap and what
   *  is left of the rolling-24h caps, net of every other call's reservation
   *  (this call's own one is what is being replaced). */
  _signAllowance() {
    const s = this._spend;
    const own = this._signCtx.getStore()?.reservation || null;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const others = s.log.filter((e) => e.ts >= cutoff && e !== own);
    const host = hostOf(this.baseUrl);
    let cap = Infinity, limit = null;
    const tighten = (value, name) => { if (value < cap) { cap = value; limit = name; } };
    if (s.maxPerCall != null) tighten(s.maxPerCall, "maxPerCallUsd");
    if (s.daily != null) tighten(s.daily - others.reduce((a, e) => a + e.usd, 0), "dailyLimitUsd");
    if (s.perHost != null) tighten(s.perHost - others.filter((e) => e.host === host).reduce((a, e) => a + e.usd, 0), "maxPerHostUsd");
    return { cap: Math.max(0, cap), limit };
  }

  /**
   * Read a JSON body with a hard byte ceiling.
   *
   * WHY THIS LIVES IN THE SDK. Almost everything a buyer might want to check
   * about a response, they can check themselves in their own code once they
   * hold it. Not this one: by the time `r.json()` has resolved, a hostile or
   * broken seller's multi-gigabyte body is already in the agent's memory. The
   * SDK owns the fetch, so it is the only place the check can happen in time.
   *
   * That matters here more than in an ordinary HTTP client, because this SDK
   * calls STRANGERS and pays them. The seller chooses the response.
   *
   * Two gates: the declared content-length is refused before a byte is read,
   * and the actual stream is counted as it arrives, because content-length is
   * the seller's claim about their own body and a missing or lying header must
   * not be the thing standing between an agent and an OOM.
   */
  async _readJson(r, { maxBytes, slug, paid = false } = {}) {
    const cap = maxBytes === undefined ? this.maxResponseBytes : (maxBytes === null ? null : numOrNull(maxBytes));
    if (cap == null) return r.json();

    const declared = Number(r.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      throw new ResponseTooLargeError(declared, cap, { slug, paid, source: "content-length" });
    }
    // A response object we cannot measure at all - no stream and no text() -
    // is a caller-supplied stub or an exotic runtime, never a hostile seller
    // over a real fetch (a real Response has both). Degrade to an unbounded
    // read rather than turning "I could not measure this" into a failure of a
    // call the caller may have already paid for.
    if ((!r.body || typeof r.body.getReader !== "function") && typeof r.text !== "function") return r.json();
    // No readable stream but text() is available: bound the PARSE, even though
    // the bytes have already arrived.
    if (!r.body || typeof r.body.getReader !== "function") {
      const text = await r.text();
      const size = Buffer.byteLength(text, "utf8");
      if (size > cap) throw new ResponseTooLargeError(size, cap, { slug, paid, source: "body" });
      return JSON.parse(text);
    }
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > cap) {
        // Stop pulling immediately. Reading the rest to "see how big it is" is
        // the failure this exists to prevent.
        try { await reader.cancel(); } catch { /* already gone */ }
        throw new ResponseTooLargeError(received, cap, { slug, paid, source: "stream" });
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  /**
   * GET a discovery surface, retrying a shed 503 (see DISCOVERY_ATTEMPTS).
   * Returns the response once it is 2xx; otherwise throws an Error naming the
   * operation, the surface and the last status, with `.status`, `.surface`
   * and `.attempts` set.
   */
  async _discoveryGet(label, path) {
    let r;
    let attempts = 0;
    for (;;) {
      attempts++;
      r = await this.f(`${this.baseUrl}${path}`);
      if (r.ok) return r;
      if (attempts >= DISCOVERY_ATTEMPTS) break;
      const wait = await shedRetryWaitMs(r);
      if (wait == null) break;
      await this._sleep(wait);
    }
    const surface = path.split("?")[0];
    const err = new Error(`${label} failed: HTTP ${r.status} from ${surface}${attempts > 1 ? ` after ${attempts} attempts` : ""}`);
    err.status = r.status;
    err.surface = surface;
    err.attempts = attempts;
    throw err;
  }

  async _loadCatalog() {
    if (this._catalog) return this._catalog;
    const r = await this._discoveryGet("could not load catalog", "/api/pricing");
    const j = await r.json();
    const m = new Map();
    for (const e of j.endpoints || []) m.set(e.slug, { method: e.method, path: e.path, computePayable: e.computePayable, price: e.price, async: e.async && typeof e.async === "object" ? e.async : null });
    this._catalog = m;
    return m;
  }

  /** Resolve a plain-language task to the best-matching tools (route, price, schema, example). */
  async find(task, { k = 5 } = {}) {
    const r = await this._discoveryGet("find", `/api/find?q=${encodeURIComponent(task)}&k=${k}`);
    return (await r.json()).results || [];
  }

  /**
   * Cross-seller Smart Order Router - rank tools across eligible/routable seller
   * rows in the host's current index (local catalog plus crawled x402/MPP sellers
   * the router considers healthy enough to route). Free; no payment, no wallet, no
   * proof-of-work. Coverage is whatever the host's index holds at call time, not
   * every seller on the internet.
   *
   * Returns the server JSON as-is (reporting only - no validation or authorization).
   * Each result may carry server-reported `executeVia` naming a `route-execute*`
   * tier whose underlying cap covers that row's price. `call(executeVia.tool, ...)`
   * re-resolves an eligible match under that tier at execution time; it does not
   * bind the discovery row's url, route, seller, or identity.
   *
   * @param {string} task
   * @param {object} [opts]
   * @param {number} [opts.k=5]                         max results (1-25, server-bounded)
   * @param {"all"|"external"|"local"} [opts.include="all"]
   * @param {string} [opts.network]                       chain filter (e.g. "robinhood", "eip155:4663")
   * @returns {Promise<{query:string, include:string, count:number, sellers:number, results:Array<object>}>}
   */
  async route(task, { k = 5, include = "all", network } = {}) {
    const top = Math.min(Math.max(parseInt(k, 10) || 5, 1), 25);
    const includeParam = include === "external" || include === "local" ? include : "all";
    const qs = new URLSearchParams({ q: String(task ?? ""), k: String(top), include: includeParam });
    if (network) qs.set("network", String(network));
    const r = await this._discoveryGet("route", `/api/route?${qs}`);
    return r.json();
  }

  /**
   * Resolve a task to matching multi-tool workflow templates (skill packs).
   * Each pack composes 5-7 catalog tools into a Claude-ready task template
   * for jobs that no single tool covers (e.g. audit a domain). Returns
   * `[{slug, title, tagline, toolSlugs, score, url, promptName}]` (possibly
   * empty when the lexical signal is weak). Use `getWorkflowPrompt(slug, args)`
   * to fetch the rendered prompt messages, or hand the slug to an MCP client.
   */
  async findWorkflows(task, { k = 2 } = {}) {
    const r = await this._discoveryGet("findWorkflows", `/api/find?q=${encodeURIComponent(task)}&k=${k}`);
    return (await r.json()).packs || [];
  }

  /**
   * Fetch the rendered prompt messages for a skill pack with arguments
   * substituted in. Same output as MCP `prompts/get` - usable directly with
   * any LLM. `args` are passed by promptArg name (see /api/skill-packs.json).
   */
  async getWorkflowPrompt(slug, args = {}) {
    const qs = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString();
    const r = await this._discoveryGet(`getWorkflowPrompt("${slug}")`, `/api/skill-packs/${encodeURIComponent(slug)}/prompt${qs ? `?${qs}` : ""}`);
    return r.json();
  }

  /**
   * Live x402 leaderboard - the sellers earning the most USDC (or serving the
   * most calls) on Base in the last ~24h, derived from on-chain USDC
   * transfers. Free; no payment, no wallet, no proof-of-work. Useful when
   * building agents that want to discover the live x402 economy beyond a
   * single service's catalog. Hourly snapshot - safe to call freely.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=10]                  max rows (1-50)
   * @param {"usd"|"calls"} [opts.sort="usd"]          rank by USDC settled or call count
   * @param {"external"|"all"} [opts.include="external"] hide this service's own wallet (default) or include it
   * @returns {Promise<{window:string, asOf:string, sort:string, include:string, totalSellers:number, results:Array<object>, source:string}>}
   */
  async topSellers({ limit = 10, sort = "usd", include = "external" } = {}) {
    const top = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const sortParam = sort === "calls" ? "calls" : "usd";
    const includeParam = include === "all" ? "all" : "external";
    const r = await this._discoveryGet("topSellers", `/api/leaderboard?top=${top}&sort=${sortParam}&include=${includeParam}`);
    const snap = await r.json();
    return {
      window: snap.windowLabel || snap.windowServed || "24h",
      asOf: snap.asOf,
      sort: snap.sortServed || sortParam,
      include: snap.include || includeParam,
      totalSellers: snap.totalSellers ?? (snap.leaderboard || []).length,
      results: snap.leaderboard || [],
      ...(snap.warming || snap.scanSkipped ? { warming: true } : {}),
      source: `${this.baseUrl}/api/leaderboard`,
    };
  }

  /**
   * Register a wallet address for Base builder code attribution. Idempotent:
   * the same wallet always returns the same code. No authentication required.
   *
   * @param {string} walletAddress  the caller's wallet address (e.g. "0x...")
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]  plain fetch (defaults to global fetch through distrustFetch)
   * @returns {Promise<{builderCode:string, walletAddress:string}>}
   */
  static async registerBuilderCode(walletAddress, { fetchImpl = distrustFetch() } = {}) {
    if (!walletAddress || typeof walletAddress !== "string") throw new Error("walletAddress is required");
    const r = await fetchImpl("https://api.base.dev/v1/agents/builder-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
    if (!r.ok) throw new Error(`builder code registration failed: HTTP ${r.status}`);
    return r.json();
  }

  /** Solve a proof-of-work challenge object (from a 402 body) into an X-Pow-Solution value. */
  static solvePow(pow) {
    let n = 0;
    while (leadingZeroBits(createHash("sha256").update(`${pow.challenge}:${n}`).digest()) < pow.difficulty) n++;
    return `${pow.token}:${n}`;
  }

  /**
   * Call a tool by slug; pays automatically (PoW for free tools, x402 for
   * wallet-only) and returns the parsed JSON result.
   */
  async call(slug, params = {}, { idempotencyKey, cache = true, maxResponseBytes, outputValidator, respondAsync, asyncTimeoutMs, onProgress } = {}) {
    // Resolve and validate the buyer-owned contract before catalog fetch,
    // credential access, payment preflight, or any other network action.
    const validator = outputValidator == null
      ? this.outputValidator
      : normalizeOutputValidator(outputValidator, "call");
    const cat = await this._loadCatalog();
    const tool = cat.get(slug);
    if (!tool) throw new Error(`unknown tool "${slug}" - use client.find(task) to discover one`);

    const cacheKey = resultCacheKey(slug, params, validator);
    if (this._cache && cache && this._cache.has(cacheKey)) {
      const stored = this._cache.get(cacheKey);
      // Callers receive the stored object by reference and may mutate it.
      // Revalidate contracted hits so a now-invalid object cannot pass merely
      // because it was valid before the caller changed it.
      try {
        await this._assertOutput(slug, stored, validator, { paid: false, cacheHit: true });
      } catch (error) {
        this._cache.delete(cacheKey);
        throw error;
      }
      return stored;
    }

    // Default key = stable per (client instance, slug, params, validator) while
    // caching is on: the SDK already treats that tuple as one operation (a
    // second identical call is served from cache without payment), so the
    // idempotency key agrees with the cache key instead of contradicting it.
    // With { cache: false } the caller has said identical calls are distinct
    // purchases, so the key is fresh per invocation, as before. An explicit
    // idempotencyKey always wins.
    const idem = idempotencyKey || (cache
      ? `a402-${createHash("sha256").update(`${this._idemSalt}:${cacheKey}`).digest("hex").slice(0, 24)}`
      : `a402-${createHash("sha256").update(`${cacheKey}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`);
    const send = async (extraHeaders = {}, useFetch = this.f, { paid = false } = {}) => {
      // UA set here too (not only in the this.f wrapper) so the x402 payFetch
      // path - the one that settles real payments - always carries it.
      const headers = { "User-Agent": USER_AGENT, "Idempotency-Key": idem, ...extraHeaders };
      let url = `${this.baseUrl}${tool.path}`;
      // A request that can carry a payment never follows a redirect: followed,
      // it would answer a 402 from another origin with a signature to that
      // origin's payee, or forward a signature already made to another host,
      // and deliver that host's answer as this route's. The redirect is
      // refused with where it pointed, so an alias baseUrl is easy to fix.
      const init = paid ? { method: tool.method, headers, redirect: "manual" } : { method: tool.method, headers };
      if (tool.method === "GET") {
        const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString();
        if (qs) url += `?${qs}`;
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(params);
      }
      const r = await useFetch(url, init);
      if (paid && (r?.type === "opaqueredirect" || (r?.status >= 300 && r?.status < 400))) throw new PaymentRedirectError(slug, url, r);
      return r;
    };
    const paidSend = (extraHeaders = {}, useFetch = this.f) => send(extraHeaders, useFetch, { paid: true });
    // A slow route runs as a job: the paid call carries Prefer: respond-async,
    // answers 202 with a job link, and the answer is collected from it (free)
    // when ready. Payment still settles only on the delivered answer.
    const asyncHeaders = shouldRequestAsync(tool.async, respondAsync ?? this.respondAsync) ? { Prefer: "respond-async" } : {};
    const collect = (r) => awaitJob(r, {
      baseUrl: this.baseUrl, fetchImpl: this.f, slug, sleep: this._sleep,
      timeoutMs: numOrNull(asyncTimeoutMs) ?? this.asyncTimeoutMs,
      onProgress: typeof onProgress === "function" ? onProgress : this.onProgress,
    });

    // Wallet-only tool → settle in USDC via the provided x402 fetch.
    if (!tool.computePayable) {
      // The Circle Gateway batched accept, when this client signs for it and
      // the 402 offers one; otherwise the paths below, as without the option.
      if (this.gateway) {
        const paid = await this._gatewayCall(slug, tool, { paidSend, asyncHeaders, collect, cacheKey, cache, validator, maxResponseBytes });
        if (paid !== NO_GATEWAY_ACCEPT) return paid;
        if (!this.payFetch && !this.creditsKey) {
          throw Object.assign(new Error(`call "${slug}" failed: HTTP 402 - the seller offers no Circle Gateway batched accept${this.gateway.networks ? ` on ${this.gateway.networks.join(", ")}` : ""} for this route, so the gateway signer cannot pay it; construct with { fetch: payFetch } to pay a plain accept`), { status: 402, slug, paid: false });
        }
      }
      if (this.payFetch) {
        // Spending policy: refuse to pay BEFORE signing if the price breaks a
        // configured ceiling (per-call / rolling-24h / per-host).
        const host = hostOf(this.baseUrl);
        const listUsd = parseUsd(tool.price);
        // The catalog price is the ROUTE's list price, and it is not the amount
        // the wallet will be asked to sign: a seller may quote per request from
        // the body (a token-metered route, or a chat route priced by the model
        // named in it), and a hostile one could understate the catalog outright.
        // When a cap is set, preflight the 402 and check the cap against the
        // amount THIS request is quoted. Fail-open: a 402 we cannot read
        // (FREE_MODE / non-402 / unparseable) falls back to the advertised
        // price - never block a legitimate payment on a parse miss.
        const guarded = this._guarded;
        if (!guarded && this._spendCapsConfigured()) warnAdvisoryCaps();
        const usd = await this._quotedUsd(paidSend, listUsd, { slug, mode: guarded ? "guarded" : "wallet" });
        // Reserve the amount synchronously (before the await) so concurrent calls
        // can't each observe the pre-commit total and collectively blow a rolling
        // cap; release the reservation if the call doesn't settle. With the
        // signing guard on, the reservation is replaced by the amount actually
        // signed, and a call that signed nothing spends nothing.
        const reservation = this._spendReserve(host, usd, slug, listUsd, { always: guarded });
        const ctx = { reservation, signedUsd: null, refusal: null };
        const signedNothing = () => guarded && ctx.signedUsd == null;
        let settled = false;
        try {
          const r = await collect(await this._signCtx.run(ctx, () => paidSend(asyncHeaders, this.payFetch)));
          if (!r.ok) throw this._fail(slug, r, await this._failureDetail(slug, r));
          if (signedNothing()) this._spendRelease(reservation);
          else this._spendSettle(reservation); // confirm the reservation as settled spend
          settled = true;
          return this._deliverResponse(slug, r, cacheKey, cache, validator, { maxResponseBytes, paid: true });
        } catch (e) {
          // An invalid or oversized paid HTTP-success body is failed delivery,
          // not a rollback of money that already moved. A job still running
          // past the wait may yet settle, so its reservation stands.
          // A redirect after a signature was sent leaves that payment's outcome
          // unknown, so it counts against the caps, like a job still running.
          if ((e instanceof AsyncJobPendingError || e instanceof PaymentRedirectError) && !signedNothing()) this._spendSettle(reservation);
          else if (!settled) this._spendRelease(reservation);
          if (ctx.refusal) {
            const d = ctx.refusal;
            throw new SpendingLimitError(d.reason === "unknown-asset"
              ? `refusing to pay for "${slug}" - no payment option it asked to sign is in a known asset, so none can be priced`
              : `refusing to pay $${d.priceUsd} for "${slug}" - the payment it asked to sign is over ${d.limit || "the cap"} ($${d.allowanceUsd} left to sign)`,
            { limit: d.limit || "signing", slug, priceUsd: d.priceUsd, cap: d.allowanceUsd, atSigning: true, cause: e });
          }
          throw e;
        }
      }
      if (this.creditsKey) {
        // A prepaid credits key: the server authorizes against the key's balance
        // before the handler and debits only on a 200 (X-Credits-Balance tells
        // what is left). The same spend caps apply as on the wallet path, and
        // against the same number: a credits gate holds and debits the amount
        // the 402 quotes for THIS body, not the route's list price. The
        // preflight carries no Authorization, so it is an unpaid 402, never a
        // debit.
        const host = hostOf(this.baseUrl);
        const listUsd = parseUsd(tool.price);
        const usd = await this._quotedUsd(paidSend, listUsd, { slug, mode: "credits" });
        const reservation = this._spendReserve(host, usd, slug, listUsd);
        let settled = false;
        try {
          const r = await collect(await paidSend({ Authorization: `Bearer ${this.creditsKey}`, ...asyncHeaders }));
          if (r.status === 402) {
            const body = await r.json().catch(() => ({}));
            throw this._fail(slug, r, `call "${slug}" refused by credits: ${body.error || "payment required"}${body.balanceUsd != null ? ` (balance $${body.balanceUsd})` : ""} ${body.topup ? ` - top up at ${body.topup}` : body.topupNote ? ` - ${body.topupNote}` : ""}`);
          }
          if (!r.ok) throw this._fail(slug, r, await this._failureDetail(slug, r));
          this._spendSettle(reservation);
          settled = true;
          return this._deliverResponse(slug, r, cacheKey, cache, validator, { maxResponseBytes, paid: true });
        } catch (e) {
          if (e instanceof AsyncJobPendingError) this._spendSettle(reservation);
          else if (!settled) this._spendRelease(reservation);
          throw e;
        }
      }
      const r = await send(); // no wallet - succeeds only on a FREE_MODE instance
      if (r.ok) return this._deliverResponse(slug, r, cacheKey, cache, validator, { maxResponseBytes, paid: false });
      throw this._fail(slug, r, `call "${slug}" failed: HTTP ${r.status} - wallet-only tool; construct with { fetch: payFetch } (an @x402/fetch-wrapped fetch) or { creditsKey } (a prepaid credits key; routes that buy from an outside seller need a wallet)`);
    }

    // Free (compute-payable) tool: succeeds plainly on a FREE_MODE instance,
    // otherwise pay with a proof-of-work (fetched from /api/pow/challenge - the
    // Agent402 server signals it via the X-Pow-Challenge header, not the 402 body).
    let r = await send();
    if (!r.ok) {
      const chal = await this._powChallenge(slug);
      r = await send({ "X-Pow-Solution": Agent402.solvePow(chal) });
    }
    if (!r.ok) throw this._fail(slug, r, await this._failureDetail(slug, r, " after proof-of-work"));
    return this._deliverResponse(slug, r, cacheKey, cache, validator, { maxResponseBytes, paid: false });
  }

  /**
   * Collect a job link (AsyncJobPendingError.jobUrl, or a 202's Location) until
   * it has the answer, and return the parsed answer. The link is free to poll
   * and must be on this client's baseUrl origin.
   */
  async collectJob(jobUrl, { timeoutMs, onProgress, maxResponseBytes } = {}) {
    const start = new Response(JSON.stringify({ statusUrl: String(jobUrl), pollIntervalSeconds: 1 }), { status: 202, headers: { "content-type": "application/json" } });
    const r = await awaitJob(start, {
      baseUrl: this.baseUrl, fetchImpl: this.f, slug: "job", sleep: this._sleep,
      timeoutMs: numOrNull(timeoutMs) ?? this.asyncTimeoutMs,
      onProgress: typeof onProgress === "function" ? onProgress : this.onProgress,
    });
    if (!r.ok) throw this._fail("job", r, await this._failureDetail("job", r));
    return this._readJson(r, { maxBytes: maxResponseBytes, slug: "job", paid: true });
  }

  /**
   * Pay a wallet-only route on the Circle Gateway batched accept its 402
   * offers. Reads the unpaid 402 (one round trip), picks the batched accept
   * (gatewayAcceptOf), holds its amount to the caps BEFORE anything is
   * signed, signs the authorization under the Gateway domain and sends it as
   * the payment header on the plain fetch (never the payment-wrapped one,
   * which would sign the plain accept). Returns NO_GATEWAY_ACCEPT, with
   * nothing reserved or signed, when the answer is not a 402 or offers no
   * batched accept this signer may pay, so the caller falls back.
   */
  async _gatewayCall(slug, tool, { paidSend, asyncHeaders, collect, cacheKey, cache, validator, maxResponseBytes }) {
    const pre = await paidSend();
    if (pre?.status !== 402) return NO_GATEWAY_ACCEPT;
    const env = await challengeEnvelope(pre);
    const accept = gatewayAcceptOf(acceptsOf(env), this.gateway.networks);
    if (!accept) return NO_GATEWAY_ACCEPT;
    const host = hostOf(this.baseUrl);
    const listUsd = parseUsd(tool.price);
    // The amount the accept asks for, priced from the known-asset table
    // (gatewayAcceptOf keeps only an accept that table can price); the
    // catalog's figure never lowers what the caps are checked against.
    const usd = Math.max(listUsd, acceptUsd(accept));
    const reservation = this._spendReserve(host, usd, slug, listUsd);
    let settled = false;
    try {
      const { header } = await signGatewayPayment(accept, { signer: this.gateway.signer, resource: env?.resource });
      const paidHeaders = { "PAYMENT-SIGNATURE": header, ...asyncHeaders };
      let r = await collect(await paidSend(paidHeaders));
      let body = null;
      for (let resend = 0; ; resend++) {
        if (r.status !== 402) break;
        body = await readJsonQuietly(r);
        const pending = body && typeof body === "object" && (body.reason === "settlement-pending" || body.retry === "same-payment");
        if (!pending) break;
        if (resend >= GATEWAY_PENDING_RESENDS) {
          // Gateway may yet settle it: the amount counts, and the header
          // is handed back so the same payment can be resent later.
          this._spendSettle(reservation);
          settled = true;
          throw new GatewayPendingError(slug, header, body);
        }
        const retryAfterSec = Number(r.headers?.get?.("retry-after")) || Number(body.retryAfterSeconds) || 10;
        await this._sleep(Math.min(Math.max(0, retryAfterSec) * 1000, GATEWAY_PENDING_MAX_WAIT_MS));
        r = await collect(await paidSend(paidHeaders));
      }
      if (r.status === 402) throw this._fail(slug, r, gatewayRefusalMessage(slug, body, accept, this.gateway.signer.address));
      if (!r.ok) throw this._fail(slug, r, await this._failureDetail(slug, r));
      this._spendSettle(reservation);
      settled = true;
      return this._deliverResponse(slug, r, cacheKey, cache, validator, { maxResponseBytes, paid: true });
    } catch (e) {
      if (e instanceof AsyncJobPendingError || e instanceof PaymentRedirectError) this._spendSettle(reservation);
      else if (!settled) this._spendRelease(reservation);
      throw e;
    }
  }

  async _assertOutput(slug, body, validator, { paid = false, cacheHit = false } = {}) {
    if (!validator) return body;
    try {
      // BOUNDED. The validator is caller-owned code we await inside call(), so
      // one that never settles hangs the buyer's call forever - and on a paid
      // route the money has already moved by the time it runs, which makes an
      // indefinite hang the worst possible place to have one. A timeout is a
      // REJECTION, not a pass: an unfinished contract has not been satisfied.
      const result = await withValidatorTimeout(validator.validate(body), validator.timeoutMs ?? OUTPUT_VALIDATOR_TIMEOUT_MS, validator.id);
      if (result === false) throw new Error("validator returned false");
      return body;
    } catch (cause) {
      throw new OutputValidationError(`output for "${slug}" failed buyer validator "${validator.id}"${paid ? "; this call WAS paid" : ""}`,
        { slug, contractId: validator.id, paid, cacheHit, cause });
    }
  }

  async _deliverResponse(slug, response, cacheKey, cache, validator, { maxResponseBytes, paid } = {}) {
    const body = await this._readJson(response, { maxBytes: maxResponseBytes, slug, paid });
    await this._assertOutput(slug, body, validator, { paid });
    return this._store(cacheKey, body, cache);
  }

  async _powChallenge(slug) {
    const r = await this._discoveryGet(`proof-of-work challenge for "${slug}"`, `/api/pow/challenge?slug=${encodeURIComponent(slug)}`);
    return r.json();
  }

  _store(key, val, cache) { if (this._cache && cache) this._cache.set(key, val); return val; }
  clearCache() { this._cache?.clear(); }

  /** The price THIS request will be asked to pay, read from its own 402.
   *
   *  A cap enforced against the catalog price is not a cap: the seller decides
   *  the amount in the challenge, and a route may quote per request from the
   *  body. Only preflights when a ceiling is configured (it costs a round trip,
   *  and with no cap the number changes nothing). The preflight send carries no
   *  payment header and no credits key, so it can only ever draw a 402.
   *
   *  Each accept is priced from the table of known assets (./known-assets.js),
   *  never from a decimals value the seller sends. `mode` says who signs:
   *  "guarded" (the signing guard holds every signature to the caps, so the
   *  cheapest known accept is what can be paid, and unknown ones are dropped
   *  there), "wallet" (no guard: the wallet may sign any accept, so the dearest
   *  one that can be priced counts, among the chains in `payNetworks` when
   *  they are given; an accept in an asset this client cannot price is
   *  skipped beside one it can, and refused here only when none can be
   *  priced, since the cap is enforced on the accept the wallet chooses when
   *  the guard is on), or "credits" (nothing is signed:
   *  the credits gate debits the route's own quote, and no accept is below it,
   *  since a chain premium or price floor only raises an accept, so the
   *  cheapest known accept counts).
   *  @returns {Promise<number>} the quoted amount, or `listUsd` when there is no readable 402 */
  async _quotedUsd(send, listUsd, { slug = "", mode = "wallet" } = {}) {
    if (!this._spendCapsConfigured()) return listUsd;
    let q = null;
    try {
      const pre = await send();
      if (pre?.status !== 402) return listUsd;
      let accepts = await challengeAccepts(pre);
      if (mode === "wallet" && this._payNetworks && Array.isArray(accepts)) {
        const onChains = accepts.filter((a) => this._payNetworks.has(String(a?.network || "").toLowerCase()));
        // No option on the declared chains (or a name that maps to none): the
        // wallet may still sign any of them, so the dearest of all counts.
        if (onChains.length) accepts = onChains;
      }
      q = quoteOf(accepts);
    } catch (e) {
      // A redirect is refused here, before anything is reserved or signed.
      if (e instanceof PaymentRedirectError) throw e;
      return listUsd; /* no readable 402: the advertised price */
    }
    if (!q) return listUsd;
    // An option in an asset this client cannot price is skipped beside one it
    // can (a seller adding a chain this table does not know yet must not
    // refuse every capped buyer); only an offer with nothing priceable is
    // refused, since no cap can be checked against it.
    if (q.max == null) {
      if (mode === "credits") return listUsd;
      throw new SpendingLimitError(
        `refusing to pay for "${slug}" - no payment option it offers is in an asset this client can price, and a capped wallet signs only what it can price${mode === "wallet" ? " (pass your x402Client to guard signing and pay the options it can price)" : ""}`,
        { limit: "knownAsset", slug, priceUsd: null, unknownOptions: q.unknown });
    }
    const quoted = mode === "wallet" ? q.max : q.min;
    // Larger of the two: an understated catalog must not lower the ceiling
    // the cap is checked against.
    return Math.max(listUsd, quoted);
  }

  /** Throw SpendingLimitError if paying `usd` to `host` now would break a cap.
   *  Prunes the rolling 24h window first; a null cap is unlimited.
   *  `listUsd` (when it differs) is the catalog price, named in the refusal so
   *  a caller can see the quote is not the number they budgeted from. */
  _spendCheck(host, usd, slug, listUsd = null) {
    const s = this._spend;
    if (s.maxPerCall == null && s.daily == null && s.perHost == null) return;
    const quotedNote = listUsd != null && listUsd !== usd
      ? ` (this request is quoted $${usd}; the catalog lists $${listUsd})` : "";
    if (s.maxPerCall != null && usd > s.maxPerCall) {
      throw new SpendingLimitError(
        `refusing to pay $${usd} for "${slug}" - exceeds maxPerCallUsd $${s.maxPerCall}${quotedNote}`,
        { limit: "maxPerCallUsd", slug, priceUsd: usd, cap: s.maxPerCall, ...(listUsd != null ? { listPriceUsd: listUsd } : {}) });
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    s.log = s.log.filter((e) => e.ts >= cutoff);
    if (s.daily != null) {
      const spent = s.log.reduce((a, e) => a + e.usd, 0);
      if (spent + usd > s.daily) {
        throw new SpendingLimitError(
          `refusing to pay $${usd} for "${slug}" - would bring 24h spend to $${(spent + usd).toFixed(6)}, over dailyLimitUsd $${s.daily}`,
          { limit: "dailyLimitUsd", slug, priceUsd: usd, spent, cap: s.daily });
      }
    }
    if (s.perHost != null) {
      const spentHost = s.log.filter((e) => e.host === host).reduce((a, e) => a + e.usd, 0);
      if (spentHost + usd > s.perHost) {
        throw new SpendingLimitError(
          `refusing to pay $${usd} for "${slug}" - would bring 24h spend to ${host} to $${(spentHost + usd).toFixed(6)}, over maxPerHostUsd $${s.perHost}`,
          { limit: "maxPerHostUsd", slug, host, priceUsd: usd, spent: spentHost, cap: s.perHost });
      }
    }
  }

  /** The message for a failed call CARRIES THE SELLER'S OWN DETAIL. Agent402's
   *  4xx bodies are self-explaining ({error, tool, expected}); a message that
   *  said only "HTTP 400" threw that away, and an agent reading it could not
   *  correct its input (elizaOS registry review, 2026-09-14). WHOLE: 0.8.4
   *  cut the detail at 2,000 characters and 0.8.5 said so when it cut, and
   *  the same review measured a 2,517-character seller error reaching the
   *  model without its end (2026-09-16). The body is already bounded before
   *  it is parsed (maxResponseBytes, 32 MB default), so a second cut here
   *  protected nothing and lost the part of the message an agent needs to
   *  act on. A body that is not JSON contributes nothing but its status. */
  /** A refusal a caller can branch on: `status` (the HTTP status), `slug` and
   *  `paid: false` ride on the Error, so a 402 is not something to regex out of
   *  the message. Nothing was spent on any path that reaches this. */
  _fail(slug, r, message) {
    return Object.assign(new Error(message), { status: r?.status, slug, paid: false });
  }

  async _failureDetail(slug, r, when = "") {
    let detail = "";
    try {
      const body = await r.json();
      // A refused payment that says what went wrong carries that sentence in
      // `detail` (an RFC 9457 problem) or `hint` (an x402 refusal), with no
      // `error`; a seller's plain error keeps its place first.
      const msg = body?.error ?? body?.message ?? body?.detail ?? body?.hint;
      if (msg != null) detail = ` - ${typeof msg === "string" ? msg : JSON.stringify(msg)}`;
      if (body?.expected != null) detail += ` (expected: ${JSON.stringify(body.expected)})`;
    } catch { /* not JSON: the status is the whole story */ }
    return `call "${slug}" failed${when}: HTTP ${r.status}${detail}`;
  }

  /** True if any spending ceiling is configured (worth preflighting the 402). */
  _spendCapsConfigured() {
    const s = this._spend;
    return s.maxPerCall != null || s.daily != null || s.perHost != null;
  }

  /** Check caps AND reserve the amount atomically (no await in between), so
   *  concurrent calls account for each other's in-flight reservations instead of
   *  all passing against the same pre-commit total. Returns a reservation handle
   *  (or null for a $0 call). Throws SpendingLimitError before reserving if over. */
  _spendReserve(host, usd, slug, listUsd = null, { always = false } = {}) {
    this._spendCheck(host, usd, slug, listUsd);
    if (!(usd > 0) && !always) return null;
    const entry = { ts: Date.now(), host, usd, pending: true };
    this._spend.log.push(entry);
    return entry;
  }
  /** Confirm a reservation as settled spend. */
  _spendSettle(entry) { if (entry) entry.pending = false; }
  /** Roll back a reservation whose call did not settle (failed / errored). */
  _spendRelease(entry) {
    if (!entry) return;
    const i = this._spend.log.indexOf(entry);
    if (i >= 0) this._spend.log.splice(i, 1);
  }

  /** Rolling-24h spend summary (settled paid calls only) - for observability. */
  spendingSummary() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const log = this._spend.log.filter((e) => e.ts >= cutoff && !e.pending);
    const byHost = {};
    for (const e of log) byHost[e.host] = Number(((byHost[e.host] || 0) + e.usd).toFixed(6));
    return {
      dailyUsd: Number(log.reduce((a, e) => a + e.usd, 0).toFixed(6)),
      calls: log.length,
      byHost,
      limits: { maxPerCallUsd: this._spend.maxPerCall, dailyLimitUsd: this._spend.daily, maxPerHostUsd: this._spend.perHost },
    };
  }
}

/** Thrown when a paid call would exceed a configured spending ceiling. The call
 *  is refused BEFORE any payment is signed, so no funds move. */
/** A response body over the ceiling, refused BEFORE it was parsed.
 *
 *  `paid` matters: on a wallet-only tool the money has already moved by the
 *  time the body arrives, so a caller must be able to tell "I was charged and
 *  the seller sent something unusable" from "nothing happened". Losing that
 *  distinction would turn a refused response into a silently forgotten spend. */
/** A request that could carry a payment was answered with a redirect, which
 *  is never followed. `location` is where it pointed (null when the runtime
 *  hides it, as a browser does for a manual redirect). */
export class PaymentRedirectError extends Error {
  constructor(slug, url, r) {
    const location = r?.headers?.get?.("location") || null;
    const to = location ? new URL(location, url).href : null;
    super(`refusing to follow a redirect on a paid call to "${slug}": ${url} answered HTTP ${r?.status || "redirect"}${to ? ` pointing to ${to}` : ""}. Paid requests never follow redirects${to ? `; if that is the address you meant, set baseUrl to ${new URL(to).origin}` : ""}.`);
    this.name = "PaymentRedirectError";
    this.slug = slug;
    this.status = r?.status ?? null;
    this.location = to;
    this.paid = false;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(size, cap, { slug, paid, source } = {}) {
    super(`response for "${slug}" is ${size} bytes, over the ${cap}-byte ceiling (${source}) - refused before parsing${paid ? "; this call WAS paid" : ""}`);
    this.name = "ResponseTooLargeError";
    Object.assign(this, { size, cap, slug, paid: Boolean(paid), source });
  }
}

/** A buyer-owned validator rejected the delivered body. `paid` records whether
 * this invocation had already settled before validation ran. */
export class OutputValidationError extends Error {
  constructor(message, { slug, contractId, paid, cacheHit, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OutputValidationError";
    Object.assign(this, { slug, contractId, paid: Boolean(paid), cacheHit: Boolean(cacheHit) });
  }
}

export class SpendingLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpendingLimitError";
    Object.assign(this, details);
  }
}

/** A Circle Gateway batched payment the seller had not confirmed after the
 *  resends. `paymentHeader` is the signed payment: resend the same request
 *  with it as PAYMENT-SIGNATURE to be served once Gateway confirms it, with
 *  no new charge. Never sign a new authorization for the same request. The
 *  amount counts against the caps (Gateway may settle it). */
export class GatewayPendingError extends Error {
  constructor(slug, paymentHeader, body = null) {
    super(`"${slug}" is paid on the Circle Gateway batched option and Gateway had not confirmed the payment after ${GATEWAY_PENDING_RESENDS} resends; resend the same request with the same PAYMENT-SIGNATURE header (paymentHeader) after a short wait, never a new signature${body?.hint ? ` - ${body.hint}` : ""}`);
    this.name = "GatewayPendingError";
    this.slug = slug;
    this.paymentHeader = paymentHeader;
    this.status = 402;
    this.paid = null;
    this.retryAfterSeconds = Number(body?.retryAfterSeconds) || null;
  }
}

/** Sentinel: the 402 offered no batched accept this client signs for. */
const NO_GATEWAY_ACCEPT = Symbol("no-gateway-accept");

async function readJsonQuietly(r) {
  try { return await (typeof r?.clone === "function" ? r.clone() : r).json(); } catch { return null; }
}

function normalizeGateway(value) {
  if (value == null || value === false) return null;
  if (typeof value !== "object") throw new TypeError("gateway must be { signer, networks? }");
  const signer = value.signer;
  if (!signer || typeof signer.signTypedData !== "function" || !EVM_ADDR.test(String(signer.address || ""))) {
    throw new TypeError("gateway.signer must be an EIP-712 signer with an EVM address and signTypedData (a viem account)");
  }
  const networks = Array.isArray(value.networks) && value.networks.length ? value.networks.map(String) : null;
  return Object.freeze({ signer, networks });
}

/** The first Circle Gateway batched accept a buyer may pay: scheme exact,
 *  `extra.name` the Gateway kind, on an EVM chain (among `networks` when
 *  given), with a payTo, a verifyingContract, a domain version, a validity
 *  window and an amount in a known asset (so the caps can price it; a batched
 *  accept in an asset the table does not know is never signed). null when
 *  there is none. */
export function gatewayAcceptOf(accepts, networks = null) {
  const list = Array.isArray(accepts) ? accepts : [];
  const wanted = networks ? new Set(networks.flatMap((n) => networkIdsOf(n)).map((id) => id.toLowerCase())) : null;
  return list.find((a) => a && typeof a === "object" && a.scheme === "exact"
    && a.extra && typeof a.extra === "object" && a.extra.name === GATEWAY_KIND_NAME
    && /^eip155:[0-9]{1,12}$/.test(String(a.network || "")) && (!wanted || wanted.has(String(a.network).toLowerCase()))
    && EVM_ADDR.test(String(a.payTo || "")) && EVM_ADDR.test(String(a.extra.verifyingContract || ""))
    && typeof a.extra.version === "string" && /^[0-9]{1,4}$/.test(a.extra.version)
    && /^[0-9]{1,78}$/.test(String(a.amount ?? "")) && Number(a.maxTimeoutSeconds) > 0
    && acceptUsd(a) != null) || null;
}

/**
 * Sign a Circle Gateway batched payment for one accept: an EIP-3009
 * TransferWithAuthorization from the signer to the accept's payTo for exactly
 * its amount, valid from now (validAfter 0) for the accept's
 * maxTimeoutSeconds, under the Gateway EIP-712 domain the accept carries
 * (name, version, verifyingContract) with the accept's chain id. Returns the
 * x402 v2 payment payload and its base64 header value.
 */
export async function signGatewayPayment(accept, { signer, resource = undefined, now = Date.now, nonce = undefined } = {}) {
  if (!signer || typeof signer.signTypedData !== "function" || !EVM_ADDR.test(String(signer.address || ""))) throw new TypeError("signGatewayPayment needs a signer with an EVM address and signTypedData");
  if (!gatewayAcceptOf([accept])) throw new TypeError("signGatewayPayment needs a Circle Gateway batched accept (scheme exact, extra.name GatewayWalletBatched, an EVM network, payTo, verifyingContract, version, amount, maxTimeoutSeconds)");
  const nowSec = Math.floor(now() / 1000);
  const authorization = {
    from: signer.address, to: accept.payTo, value: String(accept.amount),
    validAfter: "0", validBefore: String(nowSec + Math.floor(Number(accept.maxTimeoutSeconds))),
    nonce: nonce || `0x${randomBytes(32).toString("hex")}`,
  };
  const signature = await signer.signTypedData({
    domain: { name: accept.extra.name, version: accept.extra.version, chainId: Number(String(accept.network).split(":")[1]), verifyingContract: accept.extra.verifyingContract },
    types: GATEWAY_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  const payload = { x402Version: 2, ...(resource && typeof resource === "object" ? { resource } : {}), accepted: accept, payload: { signature, authorization } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64") };
}

/** The message for a 402 that refused a batched payment: the seller's own
 *  explanation first, and when it says the Gateway balance came up short,
 *  what to do about it (deposit, never a resend of the same authorization). */
function gatewayRefusalMessage(slug, body, accept, address) {
  const said = body && typeof body === "object" ? (body.hint ?? body.detail ?? body.error ?? body.message) : null;
  const words = `${body?.reason || ""} ${typeof said === "string" ? said : ""}`;
  const short = /insufficient|balance|underflow|not enough/i.test(words);
  const chain = String(accept.network);
  return `call "${slug}" refused on the Circle Gateway batched option (${chain}): HTTP 402${said != null ? ` - ${typeof said === "string" ? said : JSON.stringify(said)}` : ""}${short
    ? ` The signer ${address} needs a USDC balance in Circle Gateway on that chain: deposit through Circle's GatewayWallet contract first (this client never deposits), then call again; see ${GATEWAY_DOCS_URL}.`
    : ""}`;
}

/** The dearest amount a 402 asks for, in USD, or null when it cannot be read.
 *
 *  Each accept is priced from the known-asset table (./known-assets.js): the
 *  base-unit amount over that asset's real decimals, never a decimals value
 *  the seller sends. One accept that is not a known asset makes the whole
 *  quote unreadable (null).
 *
 *  x402 v2 carries the challenge base64 in the `PAYMENT-REQUIRED` HEADER and
 *  leaves the body `{}`, so a body-only reader learns nothing from a stock v2
 *  seller and silently falls back to the catalog price. Header first, then the
 *  body (v1 sellers, and sellers that serve both). */
export async function quoted402Usd(res) {
  const q = quoteOf(await challengeAccepts(res));
  // Every accept must be priceable: the wallet picks which one to sign.
  return q && q.unknown === 0 ? q.max : null;
}

/** The accepts array of a 402, from the PAYMENT-REQUIRED header first, then the body. */
async function challengeAccepts(res) {
  return acceptsOf(await challengeEnvelope(res));
}

/** The decoded PaymentRequired object of a 402 (the header first, then the
 *  body), or null when neither carries accepts. */
async function challengeEnvelope(res) {
  const fromHeader = decodeChallengeHeader(res?.headers?.get?.("payment-required"));
  if (fromHeader) return fromHeader;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return acceptsOf(body) ? body : null;
}

function decodeChallengeHeader(header) {
  if (typeof header !== "string" || !header.trim()) return null;
  try { const obj = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")); return acceptsOf(obj) ? obj : null; } catch { return null; }
}

/** The accepts array, at the top level or under the envelope keys sellers wrap it in. */
function acceptsOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.accepts) && obj.accepts.length) return obj.accepts;
  for (const k of ["payment", "x402", "paymentRequired", "payment_required"]) {
    const nested = obj[k];
    if (nested && typeof nested === "object" && Array.isArray(nested.accepts) && nested.accepts.length) return nested.accepts;
  }
  return null;
}

function numOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }
function parseUsd(price) {
  if (typeof price === "number") return Number.isFinite(price) ? price : 0;
  const n = Number(String(price ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function hostOf(url) { try { return new URL(url).host; } catch { return String(url); } }

const OUTPUT_VALIDATOR_ID_MAX_CHARS = 256;
// How long a buyer-owned validator may take before delivery is refused.
const OUTPUT_VALIDATOR_TIMEOUT_MS = 5_000;

function normalizeOutputValidator(value, where) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where} outputValidator must be null or { id, validate }`);
  }
  const id = value.id;
  if (typeof id !== "string" || id.trim() !== id || id.length < 1 || id.length > OUTPUT_VALIDATOR_ID_MAX_CHARS) {
    throw new TypeError(`${where} outputValidator.id must be a nonempty trimmed string of at most ${OUTPUT_VALIDATOR_ID_MAX_CHARS} characters`);
  }
  if (typeof value.validate !== "function") {
    throw new TypeError(`${where} outputValidator.validate must be a function`);
  }
  // Opt-in per-validator override; anything unusable falls back to the default
  // rather than silently disabling the bound.
  const t = Number(value.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : OUTPUT_VALIDATOR_TIMEOUT_MS;
  return Object.freeze({ id, validate: value.validate, timeoutMs });
}

/** Reject if the caller's validator has not settled in `ms`. The timer is
 *  cleared on both paths so a fast validator leaves nothing pending (an
 *  un-cleared timer would hold the event loop open on a short-lived script). */
function withValidatorTimeout(promise, ms, id) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      // NOT unref'd: an unref'd timer lets a short-lived script exit before the
      // rejection fires, so the buyer gets a silent process exit instead of an
      // OutputValidationError - which is the failure this bound exists to
      // prevent. clearTimeout in finally() is what stops it lingering.
      timer = setTimeout(() => reject(new Error(`validator ${JSON.stringify(id)} did not settle within ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function resultCacheKey(slug, params, validator) {
  const requestKey = `${slug}:${JSON.stringify(params)}`;
  if (!validator) return requestKey;
  // The caller supplies a stable semantic identity because function source is
  // neither stable nor meaningful. Hashing keeps arbitrary labels out of map
  // keys and avoids an unbounded readable cache-key surface.
  const digest = createHash("sha256").update(validator.id, "utf8").digest("hex");
  return `${requestKey}#output-validator/v1/${digest}`;
}

/**
 * Restrict + order which chains an @x402 client will pay on (duck-typed - any
 * client version with createPaymentPayload works, zero new dependencies).
 * Multi-chain sellers list Base first, so an unmodified client effectively
 * always settles there; this makes rails like USDG on Robinhood Chain
 * (eip155:4663) reachable:
 *
 *   import { withNetworkPreference } from "agent402-client";
 *   withNetworkPreference(x402client, ["robinhood"]);       // or ["eip155:4663"]
 *   const payFetch = wrapFetchWithPayment(fetch, x402client);
 *
 * A name resolves through the known-asset table to every id that chain is
 * spelled with on the wire (./known-assets.js NETWORK_NAMES), and an id to
 * the ids of its chain, so either spelling of a chain matches the other;
 * unknown entries pass through verbatim so future chains work without a
 * package update. Throws (before paying) when the preference matches none of
 * a seller's payment options.
 */
export const NETWORK_CAIP2 = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
  robinhood: "eip155:4663",
  arc: "eip155:5042",
  monad: "eip155:143",
  celo: "eip155:42220",
  avalanche: "eip155:43114",
  sei: "eip155:1329",
  optimism: "eip155:10",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  stellar: "stellar:pubnet",
  algorand: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
};

export function withNetworkPreference(client, networks) {
  // Every id each preference names, in preference order, once each.
  const prefs = [...new Set((networks || []).flatMap((n) => networkIdsOf(n)))];
  if (!prefs.length) return client;
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (paymentRequired) => {
    const list = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
    const picked = prefs.flatMap((id) => list.filter((a) => String(a?.network || "").toLowerCase() === id.toLowerCase()));
    if (!picked.length) {
      const offered = [...new Set(list.map((a) => a?.network).filter(Boolean))];
      throw new Error(`network preference [${prefs.join(", ")}] matched none of the seller's payment options [${offered.join(", ")}]`);
    }
    return orig({ ...paymentRequired, accepts: picked });
  };
  return client;
}

/**
 * Payee allowlist: refuse to pay ANY 402 whose accepts would send funds to an
 * address outside `payees` - the buyer-side mirror of a spend control (CDP's
 * CdpX402Client bounds amounts and networks; this bounds WHO gets paid). Same
 * wrapping style as withNetworkPreference: the payment-aware fetch sees a
 * filtered `accepts`, so a quote that names an unknown payTo is never paid -
 * it throws before any signature exists. Addresses compare case-insensitively
 * for 0x (EVM) and exactly otherwise (base58/Stellar are case-sensitive).
 * Works on any x402Client (createPaymentPayload) - register it before
 * wrapFetchWithPayment.
 */
export function withPayeeAllowlist(client, payees) {
  const norm = (a) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : String(a || "").trim());
  const allowed = new Set((payees || []).map(norm).filter(Boolean));
  if (!allowed.size) throw new Error("withPayeeAllowlist: at least one payee address is required");
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (paymentRequired) => {
    const list = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
    const picked = list.filter((a) => allowed.has(norm(a?.payTo)));
    if (!picked.length) {
      const offered = [...new Set(list.map((a) => a?.payTo).filter(Boolean))];
      throw new Error(`payee allowlist refused this quote: the seller asks to be paid at [${offered.join(", ")}], none of which is allowlisted`);
    }
    return orig({ ...paymentRequired, accepts: picked });
  };
  return client;
}

export default Agent402;
