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

const leadingZeroBits = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };

export class Agent402 {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl="https://agent402.tools"]
   * @param {typeof fetch} [opts.fetch]      an x402-wrapped fetch for wallet-only tools (optional)
   * @param {boolean} [opts.cache=true]      cache results in memory (deterministic tools)
   * @param {typeof fetch} [opts.fetchImpl]  plain fetch (defaults to global fetch)
   */
  constructor({ baseUrl = "https://agent402.tools", fetch: payFetch, cache = true, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("No fetch available — pass { fetchImpl } on Node < 18");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.payFetch = payFetch || null;
    this.f = fetchImpl;
    this._catalog = null;
    this._cache = cache ? new Map() : null;
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
   * Call a tool by slug; pays automatically (PoW for free tools, x402 for
   * wallet-only) and returns the parsed JSON result.
   */
  async call(slug, params = {}, { idempotencyKey, cache = true } = {}) {
    const cat = await this._loadCatalog();
    const tool = cat.get(slug);
    if (!tool) throw new Error(`unknown tool "${slug}" — use client.find(task) to discover one`);

    const cacheKey = `${slug}:${JSON.stringify(params)}`;
    if (this._cache && cache && this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const idem = idempotencyKey || `a402-${createHash("sha256").update(`${cacheKey}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
    const send = (extraHeaders = {}, useFetch = this.f) => {
      const headers = { "Idempotency-Key": idem, ...extraHeaders };
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
        const r = await send({}, this.payFetch);
        if (!r.ok) throw new Error(`call "${slug}" failed: HTTP ${r.status}`);
        return this._store(cacheKey, await r.json(), cache);
      }
      const r = await send(); // no wallet — succeeds only on a FREE_MODE instance
      if (r.ok) return this._store(cacheKey, await r.json(), cache);
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
    return this._store(cacheKey, await r.json(), cache);
  }

  async _powChallenge(slug) {
    const r = await this.f(`${this.baseUrl}/api/pow/challenge?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`proof-of-work challenge for "${slug}" failed: HTTP ${r.status}`);
    return r.json();
  }

  _store(key, val, cache) { if (this._cache && cache) this._cache.set(key, val); return val; }
  clearCache() { this._cache?.clear(); }
}

export default Agent402;
