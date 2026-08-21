// agent402-client — a tiny buyer-side client for agent402.tools (or any Agent402
// instance). Resolve a task to a tool, then call it with payment handled for you:
//   - free pure-CPU tools settle with a built-in proof-of-work (no wallet, zero deps),
//   - wallet-only tools settle via an x402-wrapped fetch you provide (@x402/fetch),
// results are cached (tools are deterministic), and retries reuse an
// Idempotency-Key so a lost response never double-charges.
//
//   import { Agent402 } from "agent402-client";
//   const a = new Agent402();                       // free tier, proof-of-work
//   const [best] = await a.find("extract the article from a url");
//   const out = await a.call("extract", { url: "https://example.com/article" });
//
//   // paid tools: pass an x402-wrapped fetch (your wallet signs)
//   const a = new Agent402({ fetch: payFetch });
import { createHash } from "node:crypto";

// Keep in lockstep with package.json. Every request the SDK issues carries
// `User-Agent: agent402-client/<version>` — a standard header, no extra
// network calls — so a seller can attribute traffic (and settled payments)
// to this SDK. Product token only; nothing about the caller rides along.
const VERSION = "0.6.12";
const USER_AGENT = `agent402-client/${VERSION}`;
const OUTPUT_MAX_RESPONSE_BYTES_DEFAULT = 100_000;
const OUTPUT_MAX_RESPONSE_BYTES_CEILING = 10_000_000;

const leadingZeroBits = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };

export class Agent402 {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl="https://agent402.tools"]
   * @param {typeof fetch} [opts.fetch]      an x402-wrapped fetch for wallet-only tools (optional)
   * @param {boolean} [opts.cache=true]      cache results in memory (deterministic tools)
   * @param {typeof fetch} [opts.fetchImpl]  plain fetch (defaults to global fetch)
   * @param {number} [opts.maxPerCallUsd]    hard ceiling on a single paid call (USD); over → SpendingLimitError before paying
   * @param {number} [opts.dailyLimitUsd]    hard ceiling on rolling-24h paid spend (USD)
   * @param {number} [opts.maxPerHostUsd]    hard ceiling on rolling-24h paid spend to one seller host (USD)
   * @param {object} [opts.outputSchema]     buyer-owned JSON Schema 2020-12; compiled before payFetch via optional peer agent-payment-policy@0.15.0. Only null/undefined omits the contract; any other inadmissible value throws.
   * @param {string[]} [opts.requiredFields] dotted paths the paid JSON must contain (bound into the same contract)
   * @param {number} [opts.maxResponseBytes] paid-body raw-byte ceiling (default 100000); enforced on actual response bytes before JSON parse
   */
  constructor({ baseUrl = "https://agent402.tools", fetch: payFetch, cache = true, fetchImpl = globalThis.fetch,
    maxPerCallUsd = null, dailyLimitUsd = null, maxPerHostUsd = null,
    outputSchema = null, requiredFields = null, maxResponseBytes = null } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("No fetch available — pass { fetchImpl } on Node < 18");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.payFetch = payFetch || null;
    // Wrap the plain fetch so every request identifies the SDK (see USER_AGENT
    // above). Caller-supplied init.headers still win on a key collision.
    this.f = (url, init = {}) => fetchImpl(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers || {}) } });
    this._catalog = null;
    this._cache = cache ? new Map() : null;
    // Spending policy (defends the x402 "wallet drain via uncapped spending"
    // failure mode): optional hard ceilings enforced BEFORE any payment is
    // signed. A malicious or misconfigured 402 that quotes an inflated price is
    // refused instead of paid. null = no limit (default — behavior unchanged).
    // Amounts commit to the rolling window only on a settled paid call, so a
    // failed/blocked call never counts against the budget.
    this._spend = {
      maxPerCall: numOrNull(maxPerCallUsd),
      daily: numOrNull(dailyLimitUsd),
      perHost: numOrNull(maxPerHostUsd),
      log: [], // [{ ts, host, usd }] — settled paid calls in the last 24h
    };
    // Optional buyer-owned acceptance contract. Compiled with public
    // agent-payment-policy@0.15.0 APIs before payFetch so a paid HTTP 200
    // with the wrong shape cannot be cached as a successful purchase.
    // Absent (null/undefined) → existing behavior. The package is an optional
    // peer, so the default client stays zero-dependency (same pattern as
    // mppx / @x402/fetch). Inadmissible control values throw here rather than
    // being coerced into a weaker/null default.
    this._outputSchema = assertOutputSchemaControl(outputSchema, "constructor");
    this._outputRequiredFields = assertRequiredFieldsControl(requiredFields, "constructor") ?? [];
    this._outputMaxResponseBytes = assertMaxResponseBytesControl(maxResponseBytes, "constructor") ?? OUTPUT_MAX_RESPONSE_BYTES_DEFAULT;
  }

  async _loadCatalog() {
    if (this._catalog) return this._catalog;
    const r = await this.f(`${this.baseUrl}/api/pricing`);
    if (!r.ok) throw new Error(`could not load catalog: HTTP ${r.status}`);
    const j = await r.json();
    const m = new Map();
    for (const e of j.endpoints || []) m.set(e.slug, { method: e.method, path: e.path, computePayable: e.computePayable, price: e.price });
    this._catalog = m;
    return m;
  }

  /** Resolve a plain-language task to the best-matching tools (route, price, schema, example). */
  async find(task, { k = 5 } = {}) {
    const r = await this.f(`${this.baseUrl}/api/find?q=${encodeURIComponent(task)}&k=${k}`);
    if (!r.ok) throw new Error(`find failed: HTTP ${r.status}`);
    return (await r.json()).results || [];
  }

  /**
   * Resolve a task to matching multi-tool workflow templates (skill packs).
   * Each pack composes 5–7 catalog tools into a Claude-ready task template
   * for jobs that no single tool covers (e.g. audit a domain). Returns
   * `[{slug, title, tagline, toolSlugs, score, url, promptName}]` (possibly
   * empty when the lexical signal is weak). Use `getWorkflowPrompt(slug, args)`
   * to fetch the rendered prompt messages, or hand the slug to an MCP client.
   */
  async findWorkflows(task, { k = 2 } = {}) {
    const r = await this.f(`${this.baseUrl}/api/find?q=${encodeURIComponent(task)}&k=${k}`);
    if (!r.ok) throw new Error(`findWorkflows failed: HTTP ${r.status}`);
    return (await r.json()).packs || [];
  }

  /**
   * Fetch the rendered prompt messages for a skill pack with arguments
   * substituted in. Same output as MCP `prompts/get` — usable directly with
   * any LLM. `args` are passed by promptArg name (see /api/skill-packs.json).
   */
  async getWorkflowPrompt(slug, args = {}) {
    const qs = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString();
    const r = await this.f(`${this.baseUrl}/api/skill-packs/${encodeURIComponent(slug)}/prompt${qs ? `?${qs}` : ""}`);
    if (!r.ok) throw new Error(`getWorkflowPrompt("${slug}") failed: HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Live x402 leaderboard — the sellers earning the most USDC (or serving the
   * most calls) on Base in the last ~24h, derived from on-chain USDC
   * transfers. Free; no payment, no wallet, no proof-of-work. Useful when
   * building agents that want to discover the live x402 economy beyond a
   * single service's catalog. Hourly snapshot — safe to call freely.
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
    const url = `${this.baseUrl}/api/leaderboard?top=${top}&sort=${sortParam}&include=${includeParam}`;
    const r = await this.f(url);
    if (!r.ok) throw new Error(`topSellers failed: HTTP ${r.status}`);
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
   * @param {string} walletAddress  the caller's wallet address (e.g. "0x…")
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]  plain fetch (defaults to global fetch)
   * @returns {Promise<{builderCode:string, walletAddress:string}>}
   */
  static async registerBuilderCode(walletAddress, { fetchImpl = globalThis.fetch } = {}) {
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
   * Compile a buyer-owned output contract before any payment credential or
   * signature is created. Uses only public agent-payment-policy@0.15.0 APIs:
   * inspectOutputSchema, prepareOutputValidator, validateOutput.
   */
  async _prepareOutputContract(schema, requiredFields, maxResponseBytes) {
    if (schema == null) return null;
    let policy;
    try {
      policy = await import("agent-payment-policy");
    } catch {
      throw new Error("outputSchema requires the optional peer agent-payment-policy@0.15.0 (Node >=22)");
    }
    const fields = normalizeOutputContractRequiredFields(requiredFields || []);
    const inspected = policy.inspectOutputSchema({ schema, requiredFields: fields });
    // Identity fields are the cache namespace. Raw schema is retained only
    // for the validator and is never used as a cache key or log value.
    const contract = {
      mediaType: "application/json",
      requiredFields: fields,
      maxResponseBytes: maxResponseBytes ?? OUTPUT_MAX_RESPONSE_BYTES_DEFAULT,
      schemaDigest: inspected.schemaDigest,
    };
    return {
      contract,
      validator: policy.prepareOutputValidator({ schema, contract }),
      validateOutput: policy.validateOutput,
    };
  }

  _assertOutput(slug, body, prepared) {
    try {
      prepared.validateOutput(body, prepared.contract, { schemaValidator: prepared.validator });
    } catch (err) {
      throw new Error(`call "${slug}" completed but output failed the buyer contract: ${err.message}`);
    }
  }

  async _deliverResponse(slug, response, cacheKey, cache, prepared) {
    const body = prepared
      ? await parseContractJson(slug, response, prepared.contract.maxResponseBytes)
      : await response.json();
    if (prepared) this._assertOutput(slug, body, prepared);
    return this._store(cacheKey, body, cache);
  }

  /**
   * Call a tool by slug; pays automatically (PoW for free tools, x402 for
   * wallet-only) and returns the parsed JSON result.
   */
  async call(slug, params = {}, { idempotencyKey, cache = true, outputSchema, requiredFields, maxResponseBytes } = {}) {
    // Reject inadmissible per-call controls before catalog I/O, cache lookup, or payFetch.
    // Only null/undefined falls back to the constructor contract; false and
    // other coerced-falsey values must not disable a valid constructor schema.
    const schema = assertOutputSchemaControl(outputSchema, "call") ?? this._outputSchema;
    const fields = assertRequiredFieldsControl(requiredFields, "call") ?? this._outputRequiredFields;
    const maxBytes = assertMaxResponseBytesControl(maxResponseBytes, "call") ?? this._outputMaxResponseBytes;

    // Prepare the buyer output contract before any cache lookup so a cached
    // uncontracted or different-contract body cannot hide an invalid control
    // or satisfy a stricter identity.
    const prepared = await this._prepareOutputContract(schema, fields, maxBytes);

    const cat = await this._loadCatalog();
    const tool = cat.get(slug);
    if (!tool) throw new Error(`unknown tool "${slug}" — use client.find(task) to discover one`);

    const cacheKey = resultCacheKey(slug, params, prepared);
    if (this._cache && cache && this._cache.has(cacheKey)) {
      const cached = this._cache.get(cacheKey);
      // Contracted hits must revalidate the stored object. The public API
      // returns this same reference, so a caller can mutate a previously
      // valid nested field into a schema-invalid value. Evict that exact
      // entry and throw without paying or fetching. No-contract hits stay
      // as stored.
      if (prepared) {
        try {
          this._assertOutput(slug, cached, prepared);
        } catch (err) {
          this._cache.delete(cacheKey);
          throw err;
        }
      }
      return cached;
    }

    const idem = idempotencyKey || `a402-${createHash("sha256").update(`${cacheKey}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
    const send = (extraHeaders = {}, useFetch = this.f) => {
      // UA set here too (not only in the this.f wrapper) so the x402 payFetch
      // path — the one that settles real payments — always carries it.
      const headers = { "User-Agent": USER_AGENT, "Idempotency-Key": idem, ...extraHeaders };
      let url = `${this.baseUrl}${tool.path}`;
      const init = { method: tool.method, headers };
      if (tool.method === "GET") {
        const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString();
        if (qs) url += `?${qs}`;
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(params);
      }
      return useFetch(url, init);
    };

    // Wallet-only tool → settle in USDC via the provided x402 fetch.
    if (!tool.computePayable) {
      if (this.payFetch) {
        // Spending policy: refuse to pay BEFORE signing if the price breaks a
        // configured ceiling (per-call / rolling-24h / per-host).
        const host = hostOf(this.baseUrl);
        let usd = parseUsd(tool.price);
        // The catalog price is seller-ADVERTISED — a hostile server could under-
        // state it and then quote more in the 402. When a cap is set, preflight
        // the 402 to learn the price the wallet will actually be asked to sign and
        // check the cap against the larger of the two. Fail-open: if the 402 can't
        // be read (FREE_MODE / non-402 / unparseable), fall back to the advertised
        // price — never block a legitimate payment on a parse miss.
        if (this._spendCapsConfigured()) {
          try {
            const pre = await send();
            if (pre.status === 402) {
              const quoted = parse402Usd(await pre.json().catch(() => null));
              if (quoted != null) usd = Math.max(usd, quoted);
            }
          } catch { /* fail-open to the advertised price */ }
        }
        // Reserve the amount synchronously (before the await) so concurrent calls
        // can't each observe the pre-commit total and collectively blow a rolling
        // cap; release the reservation if the call doesn't settle.
        const reservation = this._spendReserve(host, usd, slug);
        let settled = false;
        try {
          const r = await send({}, this.payFetch);
          if (!r.ok) throw new Error(`call "${slug}" failed: HTTP ${r.status}`);
          // HTTP success means the wallet fetch already settled. Mark spend
          // before reading, parsing, or validating the body so a malformed,
          // empty, oversized, or schema-invalid payload cannot roll back funds
          // that have already moved.
          this._spendSettle(reservation);
          settled = true;
          return await this._deliverResponse(slug, r, cacheKey, cache, prepared);
        } catch (e) {
          if (!settled) this._spendRelease(reservation); // roll back — nothing settled
          throw e;
        }
      }
      const r = await send(); // no wallet — succeeds only on a FREE_MODE instance
      if (r.ok) return this._deliverResponse(slug, r, cacheKey, cache, prepared);
      throw new Error(`call "${slug}" failed: HTTP ${r.status} — wallet-only tool; construct with { fetch: payFetch } (an @x402/fetch-wrapped fetch)`);
    }

    // Free (compute-payable) tool: succeeds plainly on a FREE_MODE instance,
    // otherwise pay with a proof-of-work (fetched from /api/pow/challenge — the
    // Agent402 server signals it via the X-Pow-Challenge header, not the 402 body).
    let r = await send();
    if (!r.ok) {
      const chal = await this._powChallenge(slug);
      r = await send({ "X-Pow-Solution": Agent402.solvePow(chal) });
    }
    if (!r.ok) throw new Error(`call "${slug}" failed after proof-of-work: HTTP ${r.status}`);
    return this._deliverResponse(slug, r, cacheKey, cache, prepared);
  }

  async _powChallenge(slug) {
    const r = await this.f(`${this.baseUrl}/api/pow/challenge?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`proof-of-work challenge for "${slug}" failed: HTTP ${r.status}`);
    return r.json();
  }

  _store(key, val, cache) { if (this._cache && cache) this._cache.set(key, val); return val; }
  clearCache() { this._cache?.clear(); }

  /** Throw SpendingLimitError if paying `usd` to `host` now would break a cap.
   *  Prunes the rolling 24h window first; a null cap is unlimited. */
  _spendCheck(host, usd, slug) {
    const s = this._spend;
    if (s.maxPerCall == null && s.daily == null && s.perHost == null) return;
    if (s.maxPerCall != null && usd > s.maxPerCall) {
      throw new SpendingLimitError(
        `refusing to pay $${usd} for "${slug}" — exceeds maxPerCallUsd $${s.maxPerCall}`,
        { limit: "maxPerCallUsd", slug, priceUsd: usd, cap: s.maxPerCall });
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    s.log = s.log.filter((e) => e.ts >= cutoff);
    if (s.daily != null) {
      const spent = s.log.reduce((a, e) => a + e.usd, 0);
      if (spent + usd > s.daily) {
        throw new SpendingLimitError(
          `refusing to pay $${usd} for "${slug}" — would bring 24h spend to $${(spent + usd).toFixed(6)}, over dailyLimitUsd $${s.daily}`,
          { limit: "dailyLimitUsd", slug, priceUsd: usd, spent, cap: s.daily });
      }
    }
    if (s.perHost != null) {
      const spentHost = s.log.filter((e) => e.host === host).reduce((a, e) => a + e.usd, 0);
      if (spentHost + usd > s.perHost) {
        throw new SpendingLimitError(
          `refusing to pay $${usd} for "${slug}" — would bring 24h spend to ${host} to $${(spentHost + usd).toFixed(6)}, over maxPerHostUsd $${s.perHost}`,
          { limit: "maxPerHostUsd", slug, host, priceUsd: usd, spent: spentHost, cap: s.perHost });
      }
    }
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
  _spendReserve(host, usd, slug) {
    this._spendCheck(host, usd, slug);
    if (!(usd > 0)) return null;
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

  /** Rolling-24h spend summary (settled paid calls only) — for observability. */
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
export class SpendingLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpendingLimitError";
    Object.assign(this, details);
  }
}

// Parse the USD amount an x402 `402` challenge actually requires — the max across
// the offered rails. x402 is stablecoin-settled (USDC/USDG), so
// atomic / 10^decimals ≈ USD. Returns null if the body isn't a parseable 402
// challenge, so the caller fails open to the advertised catalog price.
function parse402Usd(body) {
  const accepts = body && body.accepts;
  if (!Array.isArray(accepts) || !accepts.length) return null;
  let maxUsd = 0;
  for (const a of accepts) {
    const atomic = Number(a && a.maxAmountRequired);
    if (!Number.isFinite(atomic) || atomic < 0) return null;
    const decimals = Number((a && a.extra && a.extra.decimals) ?? (a && a.decimals) ?? 6);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 30) return null;
    const usd = atomic / 10 ** decimals;
    if (usd > maxUsd) maxUsd = usd;
  }
  return maxUsd;
}

function numOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertOutputSchemaControl(value, where) {
  if (value == null) return null;
  if (!isJsonObject(value)) {
    throw new Error(`${where} outputSchema must be a JSON object; only null or undefined omits the contract`);
  }
  return value;
}
function assertRequiredFieldsControl(value, where) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string" || !field.trim())) {
    throw new Error(`${where} requiredFields must be an array of non-empty dotted paths`);
  }
  return value;
}
function assertMaxResponseBytesControl(value, where) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > OUTPUT_MAX_RESPONSE_BYTES_CEILING) {
    throw new Error(`${where} maxResponseBytes must be a positive integer`);
  }
  return value;
}
function normalizeOutputContractRequiredFields(fields) {
  if (!Array.isArray(fields)) return [];
  return [...new Set(fields.map((field) => String(field).trim()).filter(Boolean))].sort();
}
// Deterministic identity for contracted cache entries. Key order is sorted.
// Raw schema content is never included; only the inspected digest is.
function outputContractIdentityCanonical(contract) {
  return JSON.stringify({
    maxResponseBytes: Number(contract.maxResponseBytes),
    mediaType: String(contract.mediaType || "").split(";", 1)[0].trim().toLowerCase(),
    requiredFields: normalizeOutputContractRequiredFields(contract.requiredFields),
    schemaDigest: String(contract.schemaDigest || "").toLowerCase(),
  });
}
function outputContractIdentityDigest(contract) {
  return createHash("sha256").update(outputContractIdentityCanonical(contract), "utf8").digest("hex");
}
function resultCacheKey(slug, params, prepared) {
  const requestKey = `${slug}:${JSON.stringify(params)}`;
  if (!prepared) return requestKey;
  return `${requestKey}#output-contract/v1/${outputContractIdentityDigest(prepared.contract)}`;
}
function responseContentType(response) {
  const headers = response && response.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get("content-type");
    return value == null ? null : String(value);
  }
  const raw = headers["content-type"] ?? headers["Content-Type"];
  if (raw == null) return null;
  return String(Array.isArray(raw) ? raw[0] : raw);
}
// RFC 9110 media-type: type/subtype is case-insensitive; parameters follow `;`.
// The output contract's intended JSON media type is exactly application/json
// (same rule agent-payment-policy@0.15.0 uses on declared mediaType).
function isApplicationJsonContentType(contentType) {
  if (contentType == null) return false;
  const media = String(contentType).split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}
function assertContractJsonMediaType(slug, response) {
  const contentType = responseContentType(response);
  if (contentType == null || !String(contentType).trim()) {
    throw new Error(`call "${slug}" completed but output Content-Type was missing`);
  }
  if (!isApplicationJsonContentType(contentType)) {
    throw new Error(`call "${slug}" completed but output Content-Type was not application/json`);
  }
}
async function readResponseBytes(response, maxBytes, slug) {
  const tooLarge = () => new Error(`call "${slug}" completed but output exceeded maxResponseBytes`);
  const unreadable = () => new Error(`call "${slug}" completed but the response body could not be read as bytes`);
  const stream = response && response.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* already over the bound */ }
        throw tooLarge();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }
  if (typeof response?.arrayBuffer === "function") {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  throw unreadable();
}
async function parseContractJson(slug, response, maxBytes) {
  // Media type is part of the output contract. Check it before touching the
  // body so a paid 200 with the wrong or missing Content-Type cannot be
  // parsed or cached even when the bytes happen to be JSON.
  assertContractJsonMediaType(slug, response);
  const raw = await readResponseBytes(response, maxBytes, slug);
  if (raw.byteLength === 0) {
    throw new Error(`call "${slug}" completed but output body was empty`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`call "${slug}" completed but output was not valid UTF-8 JSON`);
  }
  if (!text.trim()) {
    throw new Error(`call "${slug}" completed but output body was empty`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`call "${slug}" completed but output was not valid JSON`);
  }
}
function parseUsd(price) {
  if (typeof price === "number") return Number.isFinite(price) ? price : 0;
  const n = Number(String(price ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function hostOf(url) { try { return new URL(url).host; } catch { return String(url); } }

/**
 * Restrict + order which chains an @x402 client will pay on (duck-typed — any
 * client version with createPaymentPayload works, zero new dependencies).
 * Multi-chain sellers list Base first, so an unmodified client effectively
 * always settles there; this makes rails like USDG on Robinhood Chain
 * (eip155:4663) reachable:
 *
 *   import { withNetworkPreference } from "agent402-client";
 *   withNetworkPreference(x402client, ["robinhood"]);       // or ["eip155:4663"]
 *   const payFetch = wrapFetchWithPayment(fetch, x402client);
 *
 * Short names map to CAIP-2; unknown entries pass through verbatim so future
 * chains work without a package update. Throws (before paying) when the
 * preference matches none of a seller's payment options.
 */
export const NETWORK_CAIP2 = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
  robinhood: "eip155:4663",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

export function withNetworkPreference(client, networks) {
  const prefs = (networks || []).map((n) => NETWORK_CAIP2[String(n).trim().toLowerCase()] || String(n).trim());
  if (!prefs.length) return client;
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (paymentRequired) => {
    const list = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
    const picked = prefs.flatMap((caip2) => list.filter((a) => String(a?.network || "").toLowerCase() === caip2.toLowerCase()));
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
