// Exa kit - neural web search, grounded answers, and page-content retrieval
// over Exa's API.
//
// WHY THIS EXISTS AND WHAT IT IS NOT: we already sell Brave-backed `search`,
// `search-news`, `search-images` and `search-videos` at $0.02, and a cheaper
// clone of our own best-selling tool would cannibalise real revenue to serve
// nobody better. Exa is a DIFFERENT retrieval model - embedding/neural search
// over a curated index, plus an answer endpoint that returns citations - so
// these are listed beside the Brave tools, never as a replacement.
//
// Env-gated: EXA_API_KEY. `EXA_TOOLS` is exported unconditionally and
// `exaEnabled()` is the listing predicate, so an unkeyed deployment lists
// nothing and a handler called anyway throws a self-explaining 503. Every
// tool reaches the network and is WALLET-ONLY (metered upstream quota; never
// PoW-eligible).
//
// Pricing verified against exa.ai/pricing on 2026-09-13: search is billed per
// request (base covers up to 10 results, a surcharge per result beyond),
// answer per request, contents per page PER CONTENT TYPE. On a small free
// credit balance, set EXA_DAILY_MAX_USD lower than the default.
// Result counts are capped at 10 so a call cannot silently cross into the
// per-result surcharge band.
//
// Wire verified against exa.ai/docs/reference/{search,answer,get-contents} on
// 2026-09-13: POST https://api.exa.ai/<endpoint>, `x-api-key` header, bodies
// keyed `query` / `urls`. Do not adjust these from memory - this repository
// has shipped two live wire drifts (Tempo decimals, Tempo `decimals` on the
// wire) that stub tests could not see.
//
// TOPPING UP, because Exa gives us no balance to read and the alarm is over a
// number we keep ourselves:
//   1. Add credits at https://exa.ai (pay as you go, no plan needed).
//   2. Set EXA_CREDITS_USD on Railway to the NEW funded total. That is what
//      `exaAllowance` measures remaining against; leaving it stale is how the
//      alarm goes quiet while the account empties.
//   3. Optionally raise EXA_DAILY_MAX_USD and EXA_DAILY_HARD_MAX_USD. The
//      first is an alarm (calls are served past it); the second, by default
//      five times the first, is where calls are refused.
// The spend counter lives in memory and resets on deploy, so `remainingUsd` is
// an UPPER bound. Top up on "low"; never wait for it to reach zero.
//
// Covered by scripts/test-exa-kit.js (offline, stubbed fetch).

import { markUntrusted } from "./provenance.js";
import { upstreamCosts } from "../upstream-costs.js";
import { meterUpstreamSpend } from "../posthog.js";
import { createSharedDailySpend } from "../shared-limits.js";
import { dailyCeilings, ceilingWord, noteOverAlarm, createSharedCeilingView, REFUSAL_HOLD_MS } from "../daily-ceilings.js";

const EXA_API = "https://api.exa.ai";
import { upstreamFetch, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
// DEADLINES (src/upstream-deadline.js): one read per handler under its own
// 30 s cap and the route's payment-window budget (PAYMENT_WINDOW_BUDGET_MS);
// a read that outlives it is a 503 naming the upstream and the step, never a
// 504 (the booked estimate stays booked).
const TIMEOUT_MS = 30_000;
const USER_AGENT = "agent402-exa/1";
const SHARED_TAGS = ["web", "search"];

// Result/page caps. These are the COST lever, not a UX nicety: Exa's base
// price covers 10 results, and every result past that bills a surcharge, so
// an uncapped numResults turns a fixed-price tool into an open tab.
const MAX_RESULTS = 10;
const MAX_URLS = 10;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// EXA_API_KEY is the documented name; EXA_KEY is accepted because it is the
// obvious shorter spelling and an operator who picks it should get a working
// deployment, not a silently unlisted kit. Same forgiving-alias rule as the
// Farcaster kit's NEYNAR/WARPCAST pair.
const apiKey = () => (process.env.EXA_API_KEY || process.env.EXA_KEY || "").trim();

export function exaEnabled() {
  return apiKey().length > 0;
}

function requireKey() {
  const k = apiKey();
  if (!k) throw bad("Exa tools are not configured on this deployment (EXA_API_KEY unset)", 503);
  return k;
}

// ---- daily upstream spend cap ----------------------------------------------
// Exa is pay-as-you-go against a prepaid balance, and the whole point of
// shipping on the free tier is to measure demand without spending - so a
// buyer must not be able to burn the allowance in an afternoon. Every call is
// priced BEFORE it goes out at the published card and then re-booked AFTER
// the call at what Exa itself reports in `costDollars` - the estimate is only
// ever a gate, never the accounting. Two ceilings on the UTC day's booked
// spend (src/daily-ceilings.js, shared with the X data kit):
//   EXA_DAILY_MAX_USD (default 1): the alarm. Past it every call is still
//     served, since each one is paid for by its buyer; `exaSpend` on
//     /api/gateway-status reads `over`, which pages. 0 is the switch: it
//     refuses every call (the word reads `off`). Blank or malformed reads as
//     the default, never as off.
//   EXA_DAILY_HARD_MAX_USD (default 5 times the alarm ceiling; a blank,
//     malformed or non-positive value reads as the default, and a value under
//     the alarm ceiling reads as the alarm ceiling): the stop for a runaway.
//     A call that would take the day past it is refused 503 (uncharged, so a
//     >= 400 cancels settlement and nobody pays for the refusal) and the word
//     reads `capped`, which pages too.
// A restart resets this process's day; the shared day counter (below) does
// not, and both the refusal and the status word read it. A refusal holds the
// word at `capped` for an hour on every replica, since a refused call books
// nothing. The prepaid balance is the outer bound: with the balance spent the
// upstream refuses and the tools answer 503 whatever these ceilings say.
// Exa's card (search, instant and lite per request at <= 10 results, answer per
// request, content per page per type) is private: src/upstream-costs.js,
// `vendor.exa`. Without it the cap cannot be enforced, so calls refuse 503.
function exaRate(k) {
  const v = upstreamCosts().vendor?.exa?.[k];
  if (v == null) throw bad("Exa tools are temporarily unavailable. This call is not charged on x402.", 503);
  return v;
}
const exaCeilings = () => dailyCeilings("EXA_DAILY_MAX_USD", "EXA_DAILY_HARD_MAX_USD");

// ---- prepaid allowance + low-water -----------------------------------------
// EXA PUBLISHES NO BALANCE. Their public OpenAPI carries 42 endpoints and not
// one for credits, usage or billing (/v0/teams/me returns id, name,
// concurrency, limits - no balance), so unlike OpenRouter there is nothing to
// read and `gatewayCreditsStatus`'s shape cannot be copied. The only honest
// alarm is over the number WE own: cumulative spend against the allowance the
// operator says they put in.
//
// EXA_CREDITS_USD is what was funded. Spend is counted here from Exa's own
// costDollars, persisted nowhere - a restart resets it - so this ALWAYS
// UNDER-REPORTS after a deploy and the status says so rather than pretending
// the count is authoritative. It is a top-up prompt, not an accounting record.
// Unset allowance = "unconfigured", never a fabricated "ok".
const EXA_CREDITS_USD = () => { const n = Number(process.env.EXA_CREDITS_USD); return Number.isFinite(n) && n > 0 ? n : null; };
const EXA_LOW_FRACTION = () => { const n = Number(process.env.EXA_LOW_FRACTION); return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.25; };
const lifetime = { micro: 0, since: Date.now() };
const spend = { day: "", micro: 0, refused: 0, refusedAt: 0, calls: 0, overLogged: "" };
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const spentToday = (now = Date.now()) => {
  const d = utcDay(now);
  if (spend.day !== d) { spend.day = d; spend.micro = 0; spend.refused = 0; spend.refusedAt = 0; spend.calls = 0; spend.overLogged = ""; }
  return spend.micro / 1e6;
};

/** Worst-case cost of one call at Exa's published card, before it is sent. */
export function estimateExaUsd(path, body = {}) {
  if (path === "/search" || path === "/findSimilar") {
    const n = Math.max(1, Number(body.numResults) || MAX_RESULTS);
    // Content types requested alongside a search bill per returned page.
    const types = ["text", "highlights", "summary"].filter((k) => body?.contents?.[k]).length;
    const base = path === "/search" && body?.type === "instant" ? exaRate("instant")
      : path === "/search" && body?.type === "lite" ? exaRate("lite")
      : exaRate("search");
    return base + n * types * exaRate("content");
  }
  if (path === "/answer") return exaRate("answer");
  if (path === "/contents") {
    const n = Math.max(1, (Array.isArray(body.urls) ? body.urls.length : 0) || 1);
    const types = ["text", "highlights", "summary"].filter((k) => body[k]).length || 1;
    return n * types * exaRate("content");
  }
  return exaRate("search"); // an endpoint this table does not know is priced as a search
}

/**
 * What the call ACTUALLY cost, read from Exa's own `costDollars.total`.
 * Returns null when the field is absent or unusable, and the caller then
 * keeps the estimate - a missing cost is never booked as zero, which would
 * make the cap silently stop counting.
 */
export function actualExaUsd(data) {
  const t = data?.costDollars?.total;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
}

/**
 * Counts only - never a key, a query or a buyer. The day's figure is the
 * larger of this process's own and the shared day counter last read by
 * refreshExaSpendShared (a new process starts at zero; the shared counter,
 * which the refusal reads, does not).
 */
export function exaSpendStatus(now = Date.now()) {
  spentToday(now);
  const c = exaCeilings();
  const micro = Math.max(spend.micro, exaView.micro(now));
  const refusing = (spend.refusedAt > 0 && now - spend.refusedAt < REFUSAL_HOLD_MS) || exaView.refusing(now);
  return {
    day: spend.day,
    spentUsd: Number((micro / 1e6).toFixed(4)),
    capUsd: c.alarmUsd,
    hardCapUsd: c.hardUsd,
    refusedToday: spend.refused,
    // off: the switch refuses every call. capped: the hard ceiling refuses, or
    // refused a call inside the hold. over: past the alarm ceiling and still
    // serving. over and capped page.
    status: ceilingWord(micro, c, { refusing }),
  };
}
/** One bounded read of the shared day for the status word; never rejects. */
export function refreshExaSpendShared(now = Date.now()) { return exaView.refresh(now); }
/** Calls our Exa tools sent today. The index crawlers also read api.exa.ai
 *  (Exa is an indexed x402 and MPP seller), unpaid, so a host-level count of
 *  that domain is not this number. */
export function exaCallsToday(now = Date.now()) { spentToday(now); return spend.calls; }
export function _exaSpendReset() { spend.day = ""; spend.micro = 0; spend.refused = 0; spend.refusedAt = 0; spend.calls = 0; spend.overLogged = ""; exaShared.reset(); exaView.reset(); }
// Shared across replicas (src/shared-limits.js): the day's spend is also a
// shared counter per UTC day, reserved before the call and corrected after; a
// reserve that takes the shared total past the hard ceiling is given back and refused.
// The local counter stays the floor when the store does not answer.
const exaShared = createSharedDailySpend("exa-day", "exa");
const exaView = createSharedCeilingView(exaShared);
export function _exaSpendBook(usd) { spentToday(); spend.micro += Math.round(usd * 1e6); lifetime.micro += Math.round(usd * 1e6); }

/**
 * Allowance status for the heartbeat. Counts only - never the key.
 *   unconfigured : no EXA_CREDITS_USD set, so there is nothing to measure
 *   ok / low     : remaining allowance against EXA_LOW_FRACTION
 * `sinceRestart: true` is load-bearing: the counter is in memory, so a deploy
 * zeroes it and the figure is a FLOOR. A reader who forgets that would read a
 * fresh "ok" off a nearly empty account.
 */
export function exaAllowanceStatus(now = Date.now()) {
  const funded = EXA_CREDITS_USD();
  const spent = lifetime.micro / 1e6;
  if (!exaEnabled()) return { status: "unconfigured", reason: "no EXA key on this deployment" };
  if (funded === null) {
    return { status: "unconfigured", reason: "set EXA_CREDITS_USD to what you funded and this reports remaining allowance", spentSinceRestartUsd: Number(spent.toFixed(4)), sinceRestart: true };
  }
  const remaining = Math.max(0, funded - spent);
  return {
    status: remaining / funded < EXA_LOW_FRACTION() ? "low" : "ok",
    fundedUsd: funded,
    spentSinceRestartUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(remaining.toFixed(4)),
    lowBelowFraction: EXA_LOW_FRACTION(),
    sinceRestart: true,
    note: "spend is counted in memory from Exa's own costDollars and resets on deploy, so remaining is an UPPER bound - top up on 'low', do not wait for zero",
  };
}
export function _exaLifetimeReset() { lifetime.micro = 0; lifetime.since = Date.now(); }

const EXA_RELEASE_STATUSES = new Set([400, 401, 402, 403, 404, 429]);

// type "lite" (2026-10-19) serves cached pages only and answers 400 for any
// parameter it does not take, so a lite body carries only the ones its docs
// list. A key outside these sets is dropped before the call, never sent.
export const LITE_SEARCH_PARAMS = new Set([
  "query", "type", "numResults", "contents", "category", "includeDomains", "excludeDomains",
  "startPublishedDate", "endPublishedDate", "userLocation", "moderation", "objective",
  "userIdentifier", "compliance",
]);
export const LITE_CONTENTS_PARAMS = new Set(["text", "highlights", "snapshotAsOf"]);
/** The body a lite search may send: only listed keys, null treated as unset. */
export function liteSearchBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (v === null || v === undefined || !LITE_SEARCH_PARAMS.has(k)) continue;
    if (k === "contents") {
      const c = Object.fromEntries(Object.entries(v || {}).filter(([ck, cv]) => cv !== null && cv !== undefined && LITE_CONTENTS_PARAMS.has(ck)));
      if (Object.keys(c).length) out.contents = c;
      continue;
    }
    if (k === "compliance" && v !== "hipaa") continue;
    out[k] = v;
  }
  return out;
}

async function exaPost(path, rawBody) {
  const body = path === "/search" && rawBody?.type === "lite" ? liteSearchBody(rawBody) : rawBody;
  const key = requireKey();
  // The refusing ceiling: the hard one, or nothing at all while the switch is 0.
  const { alarmUsd: soft, refuseAtUsd: cap } = exaCeilings();
  const estimate = estimateExaUsd(path, body);
  // A refusal at the hard ceiling (not the 0 switch, whose word is off) is
  // noted here and on the shared store, so every replica's word reads capped.
  const capped = () => { spentToday(); spend.refused++; if (cap > 0) { spend.refusedAt = Date.now(); exaShared.noteRefused(REFUSAL_HOLD_MS); } return bad(`Exa tools have reached today's usage cap - retry after 00:00 UTC. This call is not charged on x402.`, 503); };
  // The shared reserve first (an atomic add on the store, awaited only when
  // there is one): over the cap there, nothing is booked here. Then this
  // process's check and booking, with no await between them.
  if (exaShared.enabled && !(await exaShared.reserve(estimate, cap))) throw capped();
  if (spentToday() + estimate > cap) { exaShared.book(-estimate); throw capped(); }
  // Past the alarm ceiling the call is served: its buyer pays for it. One
  // log line a day; the status word carries the alarm (no figure here).
  if (spentToday() + estimate > soft) noteOverAlarm(spend, "[exa]", "EXA_DAILY_MAX_USD", "EXA_DAILY_HARD_MAX_USD");
  // Book the estimate BEFORE the call. If the request dies mid-flight we may
  // still have been billed, and a guard that only books on success is a guard
  // a timeout walks straight through.
  _exaSpendBook(estimate);
  const book = (usd) => { _exaSpendBook(usd); exaShared.book(usd); };
  spend.calls++;

  const res = await upstreamFetch(`${EXA_API}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
  }, { label: "Exa", step: String(path).replace(/^\//, "") || "search", timeoutMs: TIMEOUT_MS, tag: "[exa]" });

  // Never relay an upstream error body to the buyer: it can carry our own key
  // material, account identifiers or another tenant's text.
  if (!res.ok) {
    // A clean refusal did no billable work: release the booked estimate so
    // refused calls cannot fill the day's cap. Timeouts and 5xx keep it.
    if (EXA_RELEASE_STATUSES.has(res.status)) book(-estimate);
    if (res.status === 401 || res.status === 403) throw bad("Exa tools are not configured on this deployment. This call is not charged on x402.", 503);
    if (res.status === 402) throw bad("Exa tools are temporarily unavailable. This call is not charged on x402.", 503);
    if (res.status === 429) throw bad("Exa is rate-limiting this deployment right now - retry shortly", 503);
    if (res.status === 404) throw bad("Exa has nothing for that request", 404);
    if (res.status >= 500) throw bad(`Exa upstream error (HTTP ${res.status}) - the upstream is having trouble; retry shortly. This call is not charged on x402.`, 503);
    throw bad(`Exa refused the request (HTTP ${res.status}) - check the query and any filters`, 400);
  }

  let data;
  try { data = await res.json(); }
  catch { throw bad("Exa upstream error: the upstream returned a body that is not JSON. This call is not charged on x402.", 503); }

  // Correct the day's booking to what Exa says it charged. Only ever replaces
  // the estimate with a real figure; an absent costDollars keeps the estimate.
  const actual = actualExaUsd(data);
  if (actual !== null) book(actual - estimate);
  // The served call's cost, in the server-side spend meter beside the model
  // tiers (/__operator/margin.json): what Exa says it charged, else the card.
  meterUpstreamSpend("exa", actual ?? estimate);
  return data;
}

// ---- input helpers ---------------------------------------------------------
function takeQuery(raw, field = "query", max = 1000) {
  const q = typeof raw === "string" ? raw.trim() : "";
  if (!q) throw bad(`"${field}" is required - the text to search for`);
  if (q.length > max) throw bad(`"${field}" is too long (${q.length} chars, max ${max})`);
  return q;
}

// ISO 8601 date or date-time, checked locally so a malformed filter is a 400
// before any upstream call.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
export function takeIsoDate(raw, field) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw bad(`"${field}" must be an ISO 8601 date such as 2025-01-31`);
  const v = raw.trim();
  if (!v) return null;
  const m = ISO_DATE_RE.exec(v);
  const t = m ? Date.parse(v) : NaN;
  const real = m && Number.isFinite(t)
    && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`;
  if (!real) throw bad(`"${field}" must be an ISO 8601 date such as 2025-01-31 (got ${JSON.stringify(v.slice(0, 40))})`);
  return v;
}

function takeNumResults(raw) {
  if (raw === undefined || raw === null || raw === "") return MAX_RESULTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw bad(`"numResults" must be a whole number of 1 or more`);
  if (n > MAX_RESULTS) {
    throw bad(`"numResults" is capped at ${MAX_RESULTS} on this tool`);
  }
  return n;
}

// Exa's search categories, from the search reference (exa.ai/docs/reference/search.md,
// read 2026-09-18). The 2026-07-23 changelog retired `pdf`, `github` and `tweet` and
// replaced `research paper` with `publication`. We used to pass the buyer's string
// through untouched, so a retired category reached Exa as a "hint" and silently
// changed what the search meant; now the retired names are refused with the
// accepted list, and the renamed one is mapped to its successor.
export const EXA_CATEGORIES = ["company", "publication", "news", "personal site", "financial report", "people"];
const EXA_CATEGORY_RENAMED = { "research paper": "publication" };
const EXA_CATEGORIES_RETIRED = ["pdf", "github", "tweet"];
export function takeCategory(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw bad(`"category" must be a string; accepted values: ${EXA_CATEGORIES.join(", ")}`);
  const c = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!c) return null;
  if (EXA_CATEGORIES.includes(c)) return c;
  if (EXA_CATEGORY_RENAMED[c]) return EXA_CATEGORY_RENAMED[c];
  if (EXA_CATEGORIES_RETIRED.includes(c)) {
    throw bad(`"category" ${JSON.stringify(raw)} was retired by Exa on 2026-07-23; accepted values: ${EXA_CATEGORIES.join(", ")} ("research paper" is accepted as an alias of "publication")`);
  }
  throw bad(`unknown "category" ${JSON.stringify(raw)}; accepted values: ${EXA_CATEGORIES.join(", ")} ("research paper" is accepted as an alias of "publication")`);
}

function takeUrl(raw, field = "url") {
  const u = typeof raw === "string" ? raw.trim() : "";
  let parsed;
  try { parsed = new URL(u); } catch { throw bad(`"${field}" must be an absolute http(s) URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw bad(`"${field}" must be an absolute http(s) URL`);
  return parsed.toString();
}

function shapeResult(r) {
  return {
    title: r?.title ?? null,
    url: r?.url ?? null,
    publishedDate: r?.publishedDate ?? null,
    author: r?.author ?? null,
    text: typeof r?.text === "string" ? r.text : null,
    highlights: Array.isArray(r?.highlights) ? r.highlights : undefined,
    summary: typeof r?.summary === "string" ? r.summary : undefined,
  };
}

// Search response notes (2026-10-19): `warnings` name a request field that
// had no effect, `notices` say how the results were produced. Each item is
// {code, path, message}; codes are an open set. Passed through as those three
// strings, bounded, and only when there are any.
export const EXA_NOTE_MAX_ITEMS = 10;
export const EXA_NOTE_MAX_CHARS = 500;
export function exaNotes(list) {
  if (!Array.isArray(list)) return [];
  const str = (v) => (typeof v === "string" ? v.slice(0, EXA_NOTE_MAX_CHARS) : null);
  return list.filter((n) => n && typeof n === "object" && typeof n.message === "string" && n.message)
    .slice(0, EXA_NOTE_MAX_ITEMS)
    .map((n) => ({ code: str(n.code), path: str(n.path), message: str(n.message) }));
}

// Search types the upstream marks legacy (search reference, x-exa-replacement;
// changelog 2026-10-19): each still works, and each is sent as the type named
// as its replacement. Every filter this tool takes is one `lite` accepts.
export const LEGACY_SEARCH_TYPES = Object.freeze({ fast: "lite", instant: "lite" });

// The example reads one of our own pages (scripts/test-example-hosts.js): a
// buyer copying it, and the daily catalog buy, get a page that exists.
const RESULT_EXAMPLE = {
  title: "Agent402.Tools: pay-per-call tools for AI agents",
  url: "https://agent402.tools/",
  publishedDate: "2026-08-02T00:00:00.000Z",
  author: null,
  text: null,
};

export const EXA_TOOLS = [
  {
    route: "POST /api/exa-search",
    name: "Neural web search",
    slug: "exa-search",
    category: "web",
    price: "$0.012",
    description:
      "Neural (embedding-based) web search over a curated web index, which finds pages by meaning rather than keyword overlap. Use it when a keyword engine returns the wrong thing: conceptual questions, 'pages like this one', or niche technical writing. Returns up to 10 results with title, URL, published date and author. Set type to lite for the fastest search, served from cached pages. Complements the keyword web search rather than replacing it.",
    tags: [...SHARED_TAGS, "neural", "semantic"],
    discovery: {
      bodyType: "json",
      input: { query: "how agent-to-agent micropayment protocols settle onchain", numResults: 5, type: "lite" },
      inputSchema: {
        properties: {
          query: { type: "string", description: "What to search for, in natural language (max 1000 chars)." },
          numResults: { type: "number", description: `Results to return, 1 to ${MAX_RESULTS} (default ${MAX_RESULTS}).` },
          type: { type: "string", description: "auto (default), neural, keyword or lite (cached pages only, lowest latency). The legacy fast and instant are accepted and run as lite, their named replacement; the answer's warnings say so." },
          category: { type: "string", description: `Optional category filter: ${EXA_CATEGORIES.join(", ")} ("research paper" is accepted as an alias of "publication"; pdf, github and tweet were retired upstream on 2026-07-23 and are refused with this list).` },
          includeDomains: { type: "array", description: "Only return results from these domains." },
          excludeDomains: { type: "array", description: "Never return results from these domains." },
          startPublishedDate: { type: "string", description: "ISO date; only pages published on or after it." },
          endPublishedDate: { type: "string", description: "ISO date; only pages published on or before it." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          query: "how agent-to-agent micropayment protocols settle onchain",
          searchType: "lite",
          count: 1,
          results: [RESULT_EXAMPLE],
        },
      },
    },
    handler: async (i) => {
      const query = takeQuery(i.query);
      const numResults = takeNumResults(i.numResults);
      const body = { query, numResults };
      const ours = [];
      if (i.type !== undefined && i.type !== null && i.type !== "") {
        const t = String(i.type);
        if (!["auto", "neural", "keyword", "lite", "fast", "instant"].includes(t)) throw bad('"type" must be auto, neural, keyword, lite, fast or instant');
        body.type = LEGACY_SEARCH_TYPES[t] || t;
        if (body.type !== t) ours.push({ code: "LEGACY_TYPE", path: "/type", message: `type "${t}" is legacy upstream and ran as "${body.type}", its named replacement; send "${body.type}" to keep this search` });
      }
      const category = takeCategory(i.category);
      if (category) body.category = category;
      for (const k of ["includeDomains", "excludeDomains"]) {
        if (i[k] !== undefined && i[k] !== null) {
          if (!Array.isArray(i[k])) throw bad(`"${k}" must be an array of domains`);
          if (i[k].length) body[k] = i[k].map(String).slice(0, 20);
        }
      }
      for (const k of ["startPublishedDate", "endPublishedDate"]) {
        const v = takeIsoDate(i[k], k);
        if (v) body[k] = v;
      }
      if (body.startPublishedDate && body.endPublishedDate && Date.parse(body.startPublishedDate) > Date.parse(body.endPublishedDate)) {
        throw bad('"startPublishedDate" is after "endPublishedDate"');
      }
      const data = await exaPost("/search", body);
      const results = Array.isArray(data?.results) ? data.results.map(shapeResult) : [];
      const warnings = [...ours, ...exaNotes(data?.warnings)];
      const notices = exaNotes(data?.notices);
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        query,
        // The upstream's resolved type is deprecated and may be empty; the type sent stands in then.
        searchType: (typeof data?.resolvedSearchType === "string" && data.resolvedSearchType) || body.type || null,
        count: results.length,
        results,
        ...(warnings.length ? { warnings } : {}),
        ...(notices.length ? { notices } : {}),
        ...(results.length ? {} : { note: "Exa returned no results for this query" }),
      };
    },
  },
  {
    route: "POST /api/exa-answer",
    name: "Grounded answer with citations",
    slug: "exa-answer",
    category: "web",
    modelBacked: true, // the answer text is generated: read by server.js's MODEL_BACKED_SLUGS
    price: "$0.010",
    description:
      "Ask a question and get a written answer with the sources it was drawn from. The engine searches its index, reads the pages and composes the answer, returning the citation list (title, URL, published date) alongside it so every claim can be checked. Model-backed: the answer text is generated, the citations are retrieved.",
    tags: [...SHARED_TAGS, "answer", "citations"],
    discovery: {
      bodyType: "json",
      input: { query: "What is the x402 payment protocol and who uses it?" },
      inputSchema: {
        properties: {
          query: { type: "string", description: "The question to answer (max 1000 chars)." },
          text: { type: "boolean", description: "Include the full page text of each citation (default false)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          query: "What is the x402 payment protocol and who uses it?",
          answer: "x402 is an HTTP-native payment protocol that settles stablecoin payments per request ...",
          citationCount: 1,
          citations: [RESULT_EXAMPLE],
        },
      },
    },
    handler: async (i) => {
      const query = takeQuery(i.query);
      const body = { query };
      if (i.text === true) body.text = true;
      const data = await exaPost("/answer", body);
      const citations = Array.isArray(data?.citations) ? data.citations.map(shapeResult) : [];
      const answer = typeof data?.answer === "string" ? data.answer : (data?.answer ?? null);
      if (answer === null || answer === "") throw bad("Exa returned no answer for that question", 502);
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        query,
        answer,
        citationCount: citations.length,
        citations,
      };
    },
  },
  {
    route: "POST /api/exa-contents",
    name: "Web page contents",
    slug: "exa-contents",
    category: "web",
    price: "$0.02",
    description:
      "Retrieve the readable text of up to 10 web pages by URL, with optional query-focused highlights. Pages are served from a crawl cache when the page is fresh enough and live-crawls otherwise, so this answers for pages a plain fetch would be blocked from. Returns per-URL status so a page that could not be read is named rather than silently missing.",
    tags: [...SHARED_TAGS, "contents", "extract"],
    discovery: {
      bodyType: "json",
      input: { urls: ["https://agent402.tools/"] },
      inputSchema: {
        properties: {
          urls: { type: "array", description: `Absolute http(s) URLs to read, 1 to ${MAX_URLS}.` },
          highlights: { type: "boolean", description: "Also return the passages most relevant to `query`." },
          query: { type: "string", description: "Focuses the highlights; ignored unless highlights is true." },
        },
        required: ["urls"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          count: 1,
          results: [{ ...RESULT_EXAMPLE, text: "x402 is an HTTP-native payment protocol ..." }],
          statuses: [{ id: "https://agent402.tools/", status: "success" }],
        },
      },
    },
    handler: async (i) => {
      if (!Array.isArray(i.urls) || i.urls.length === 0) throw bad('"urls" is required - an array of absolute http(s) URLs');
      if (i.urls.length > MAX_URLS) throw bad(`"urls" is capped at ${MAX_URLS} per call`);
      const urls = i.urls.map((u, n) => takeUrl(u, `urls[${n}]`));
      const body = { urls, text: true };
      if (i.highlights === true) {
        body.highlights = typeof i.query === "string" && i.query.trim() ? { query: i.query.trim() } : true;
      }
      const data = await exaPost("/contents", body);
      const results = Array.isArray(data?.results) ? data.results.map(shapeResult) : [];
      const errText = (e) => (e && typeof e === "object" ? String(e.tag || e.message || e.httpStatusCode || "error") : String(e)).slice(0, 200);
      const statuses = Array.isArray(data?.statuses)
        ? data.statuses.map((s) => ({ id: s?.id ?? null, status: s?.status ?? null, ...(s?.error ? { error: errText(s.error) } : {}) }))
        : [];
      // Nothing readable came back: a failed call, never a charged empty 200.
      if (!results.length) {
        const named = statuses.slice(0, MAX_URLS).map((s) => `${String(s.id ?? "?").slice(0, 120)}: ${s.status ?? "unknown"}${s.error ? ` (${s.error})` : ""}`);
        throw bad(`Exa could not read any of these URLs${named.length ? ` - ${named.join("; ")}` : ""}`, 502);
      }
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        count: results.length,
        results,
        statuses,
      };
    },
  },
];

// Exa returns third-party web text: page titles, extracted body text and
// generated answers drawn from them. That is untrusted content and can carry
// instructions aimed at whatever agent reads it, so every result is wrapped
// the same way the other web-reading kits wrap theirs.
for (const t of EXA_TOOLS) {
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(EXA_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
