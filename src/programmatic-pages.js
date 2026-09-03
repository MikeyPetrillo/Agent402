// Programmatic SEO landing pages for the SEC-filing report products.
//
//   /reports/insider/:ticker   free teaser: the latest Form 4 filings, parsed
//   /reports/fund/:manager     free teaser: the latest 13F, top holdings
//   /reports/dossier/:ticker   free teaser: EDGAR company identity + filings
//   /reports/insider|fund|dossier   crawlable hubs listing the seeded entities
//
// These pages are FREE and PUBLIC, so the cost discipline is the design:
//
//   1. SEC EDGAR is the only upstream, and a page makes at most a handful of
//      requests (dossier 1, fund 3, insider 1-2 + up to 4 filing XMLs).
//   2. Every result is cached in-process for 12 hours in a BOUNDED map with
//      oldest-first eviction, so a crawler walking 100 tickers pays EDGAR once
//      per entity per half-day, not once per hit.
//   3. A slug that does not parse never reaches EDGAR at all (shape is checked
//      first), and one that parses but does not resolve is NEGATIVE-cached for
//      10 minutes, so a scanner spraying four-letter strings cannot turn this
//      into an EDGAR amplifier. Callers also ride the existing per-IP
//      sessionReadLimiter (see server.js).
//   4. A global concurrency gate bounds how many EDGAR reads this module has in
//      flight at once - SEC asks for at most 10 requests/second, and a crawler
//      hitting 20 pages in parallel would otherwise blow straight through it.
//   5. An upstream failure NEVER 500s and never hangs: the teaser build has its
//      own deadline and a page whose data could not be read still renders (with
//      the data section saying so plainly). Only a slug that genuinely does not
//      resolve 404s.
//
// The 13F information table is fetched only when its DECLARED SIZE is under a
// cap: the largest index complexes publish tables in the tens of megabytes, and
// a free page must be able to decline that read.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { INSIDER_TIERS } from "./tools/insider-flow-kit.js";
import { FUND_TIERS } from "./tools/fund-report-kit.js";
import { DOSSIER_TIERS } from "./tools/dossier-kit.js";
import { probeInsiderFilings, parseForm4 } from "./tools/insider-flow-kit.js";
import { resolveCompany, resolveManager, edgarGetJson, fetchXmlText, findInformationTable, parse13fInformationTable, latest13fFiling } from "./tools/edgar-kit.js";
import { SEED_TICKERS, SEED_MANAGERS, seededManager, isSeededTicker } from "./programmatic-seeds.js";
import { alertFormHtml } from "./free-alerts.js";

// --- validation -------------------------------------------------------------
// Shape first, upstream second. Anything that fails here costs one regex.
export const TICKER_RE = /^[A-Z.\-]{1,6}$/;
export const MANAGER_SLUG_RE = /^[a-z0-9-]{2,60}$/;

export function normalizeTicker(raw) {
  const t = String(raw ?? "").trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}
export function normalizeManagerSlug(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!MANAGER_SLUG_RE.test(s)) return null;
  if (s.startsWith("-") || s.endsWith("-")) return null;
  return s;
}
/** "pershing-square-capital-management" -> "Pershing Square Capital Management".
 *  Used only to give EDGAR's name resolver something to search for on an
 *  off-list slug; the name EDGAR returns is what the page shows. */
export const slugToName = (slug) => String(slug || "").split("-").filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

// --- bounded cache ----------------------------------------------------------
const TTL_MS = Number(process.env.PROGRAMMATIC_TTL_MS) || 12 * 60 * 60 * 1000;
const NEG_TTL_MS = Number(process.env.PROGRAMMATIC_NEG_TTL_MS) || 10 * 60 * 1000;
const SOFT_NEG_TTL_MS = 60 * 1000;   // "EDGAR could not answer" - retry sooner
// A build that RESOLVED the entity but could not read part of its data (a
// throttled information table, a Form 4 XML that timed out) is cached only
// briefly: caching a half-empty page for twelve hours would freeze one bad
// minute onto a landing page for the rest of the day.
const PARTIAL_TTL_MS = Number(process.env.PROGRAMMATIC_PARTIAL_TTL_MS) || 5 * 60 * 1000;
const MAX_ENTRIES = Number(process.env.PROGRAMMATIC_CACHE_MAX) || 600;

/** TTL map with a hard entry cap and oldest-first eviction. Positive and
 *  negative results share the map (a negative entry carries `miss`), so a
 *  flood of unresolvable slugs can never grow memory without bound and can
 *  never evict more than MAX_ENTRIES worth of anything. */
export function createTeaserCache({ ttlMs = TTL_MS, negTtlMs = NEG_TTL_MS, max = MAX_ENTRIES, now = () => Date.now() } = {}) {
  const map = new Map();
  // Misses live in their OWN bounded map. Sharing one map let a spray of
  // unresolvable slugs evict every seeded page, which then rebuilt through a
  // gate the same caller was saturating and served degraded to crawlers.
  const misses = new Map();
  const evict = () => { while (map.size > max) { const k = map.keys().next().value; map.delete(k); } };
  const evictMisses = () => { while (misses.size > max) { const k = misses.keys().next().value; misses.delete(k); } };
  return {
    get(key) {
      const e = map.get(key);
      if (e) { if (e.exp > now()) return e; map.delete(key); }
      const m = misses.get(key);
      if (m) { if (m.exp > now()) return m; misses.delete(key); }
      return null;
    },
    setValue(key, value, ttl = ttlMs) { map.delete(key); map.set(key, { value, exp: now() + ttl }); evict(); return value; },
    setMiss(key, ttl = negTtlMs) { misses.delete(key); misses.set(key, { miss: true, exp: now() + ttl }); evictMisses(); return null; },
    get size() { return map.size; },
    get missSize() { return misses.size; },
    clear() { map.clear(); misses.clear(); },
  };
}

const cache = createTeaserCache();

// --- EDGAR politeness gate --------------------------------------------------
// SEC's published ceiling is 10 requests/second. A page is 1-4 requests, so a
// small concurrency cap keeps even a 20-wide crawler comfortably under it.
const MAX_CONCURRENT = Number(process.env.PROGRAMMATIC_EDGAR_CONCURRENCY) || 2;
// Beyond this many waiting builds we stop queueing and serve the page WITHOUT
// live data. Measured 2026-08-22: a 20-wide sitemap crawl of all 253 seeded
// URLs on a cold cache queued hundreds of builds and SEC started refusing our
// requests (HTTP 403), which is both impolite and useless. A real crawler
// paces itself and never reaches this depth, so it always gets full data; a
// burst that could not be served politely degrades instead of piling up.
const MAX_QUEUE = Number(process.env.PROGRAMMATIC_QUEUE_MAX) || 8;
const BUILD_TIMEOUT_MS = Number(process.env.PROGRAMMATIC_TIMEOUT_MS) || 12_000;
// How long a request may WAIT for a gate slot before it gives up and serves the
// page without live data.
//
// The build had a deadline from the start; the QUEUE did not, and that is a
// different thing entirely. With 2 concurrent and a queue of 8, the last waiter
// could sit through four full rounds before its own build even began - up to
// ~60s on a page that is supposed to answer in one - and nothing capped it. The
// comment above says a burst "degrades instead of piling up", which was true
// only for requests turned away PAST the queue; the eight inside it piled up
// silently.
//
// Found 2026-08-24 when a 1062-URL sitemap sweep aborted two fund pages at a
// 20s client timeout. The affected caller is not the test - it is any crawler
// walking our sitemap, Googlebot included, and a 60s hang costs the page in
// the index far more surely than a degraded render does. Seeded entities
// degrade rather than 404, so the honest answer is available immediately and
// carries noindex; waiting for a slot was never worth more than that.
const GATE_WAIT_MS = Number(process.env.PROGRAMMATIC_GATE_WAIT_MS) || 5_000;
const GATE_BUSY = Object.assign(new Error("programmatic gate saturated"), { gateBusy: true });
let active = 0;
const waiters = [];
export const gateDepth = () => ({ active, waiting: waiters.filter((w) => !w.abandoned).length });
export const __gateInternals = { withGate, GATE_BUSY };
async function withGate(fn, { waitMs = GATE_WAIT_MS, now = Date.now } = {}) {
  const startedAt = now();
  // Loop, do not test once: a request that arrives while a waiter is being
  // resumed would otherwise barge straight past MAX_CONCURRENT.
  while (active >= MAX_CONCURRENT) {
    if (waiters.filter((w) => !w.abandoned).length >= MAX_QUEUE) throw GATE_BUSY;
    const remaining = waitMs - (now() - startedAt);
    if (remaining <= 0) throw GATE_BUSY;
    // A waiter carries its own abandoned flag rather than being spliced out on
    // timeout, because splicing leaves a race nothing can test: the releaser
    // can shift and signal a waiter in the window between its timer firing and
    // its continuation running, handing a permit to someone who has already
    // left. Recovering from that needs a branch reachable only under a
    // microtask interleaving - a mutation that deletes it survives every test
    // you can write. So the releaser skips abandoned waiters instead, and the
    // situation the branch existed for cannot arise.
    const w = { resolve: null, abandoned: false };
    const slot = new Promise((r) => { w.resolve = r; });
    waiters.push(w);
    let timer;
    const expired = await Promise.race([
      slot.then(() => false),
      new Promise((r) => { timer = setTimeout(() => r(true), remaining); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (expired) {
      w.abandoned = true;
      // Leave it in place; nextWaiter() drops it. Splicing here is what
      // reintroduces the untestable race above.
      throw GATE_BUSY;
    }
  }
  active++;
  try { return await fn(); }
  finally { active--; nextWaiter(); }
}
// Hand the freed permit to the first waiter that is still waiting. Abandoned
// entries are discarded here, which is the only place that knows a permit is
// actually in hand to give away.
function nextWaiter() {
  while (waiters.length) {
    const w = waiters.shift();
    if (!w.abandoned) { w.resolve(); return true; }
  }
  return false;
}
const deadline = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(Object.assign(new Error("teaser timeout"), { statusCode: 504 })), ms); t.unref?.(); })]);

/** "This entity does not exist" vs "we could not read EDGAR" are DIFFERENT
 *  answers and only the first may be negative-cached. edgarGetJson collapses
 *  every non-5xx upstream status onto 422, so a 403 rate-limit looks exactly
 *  like an unknown CIK unless the upstream status is consulted - and caching a
 *  throttle as a miss 404s real tickers for as long as that entry lives (seen
 *  live during a 20-wide crawl, 2026-08-22). */
export function isUnresolvable(e) {
  if (e?.gateBusy) return false;
  const up = e?.upstreamStatus;
  if (up === 403 || up === 429 || (typeof up === "number" && up >= 500)) return false;
  return e?.statusCode === 404 || e?.statusCode === 422;
}

// --- teaser builders --------------------------------------------------------
const TEASER_FILINGS = 4;             // Form 4 XMLs read per insider page
const TEASER_HOLDINGS = 5;
// One Form 4 can report a dozen sale lines from a single VWAP fill. Without a
// per-filing cap that one person fills the whole teaser and the page reads as
// "one insider trades here" (measured on a real issuer, 2026-08-22).
const TEASER_TX_PER_FILING = 5;
const TEASER_ROWS = 20;
const MAX_TABLE_BYTES = Number(process.env.PROGRAMMATIC_MAX_13F_BYTES) || 4_000_000;
const INSIDER_WINDOW_DAYS = 90;

const CODE_LABEL = {
  P: "open-market buy", S: "open-market sale", A: "grant/award", M: "option exercise",
  F: "tax withholding", G: "gift", D: "disposition to issuer", C: "conversion",
  X: "derivative exercise", J: "other", W: "inheritance", I: "discretionary",
};

/** Latest Form 4 filings against an issuer, with the transactions parsed.
 *  ONE full-text search plus up to TEASER_FILINGS filing reads. */
export async function buildInsiderTeaser(ticker, deps = {}) {
  const probe = deps.probeInsiderFilings || probeInsiderFilings;
  const getXml = deps.fetchXmlText || fetchXmlText;
  const parse = deps.parseForm4 || parseForm4;
  const pf = await probe({ ticker, days: INSIDER_WINDOW_DAYS, limit: 12 });
  // Newest first, but prefer a DISTINCT reporting owner per slot: at a large
  // issuer the newest four filings are routinely the same officer's schedule,
  // and a teaser showing one person four times reads as "one insider trades
  // here". Same request count either way - only the choice of which filings.
  const picked = [];
  const seenOwner = new Set();
  for (const f of pf.filings) { if (picked.length >= TEASER_FILINGS) break; if (seenOwner.has(f.ownerCik)) continue; seenOwner.add(f.ownerCik); picked.push(f); }
  for (const f of pf.filings) { if (picked.length >= TEASER_FILINGS) break; if (!picked.includes(f)) picked.push(f); }
  const rows = [];
  for (const f of picked) {
    if (!f.url) continue;
    let p;
    try { p = parse(await getXml(f.url)); } catch { continue; }
    const who = p.owners[0] || {};
    const role = [who.isOfficer ? (who.title || "officer") : null, who.isDirector ? "director" : null, who.isTenPct ? "10% owner" : null].filter(Boolean).join(", ") || "reporting person";
    for (const x of p.transactions.slice(0, TEASER_TX_PER_FILING)) {
      rows.push({
        insider: who.name || String(f.displayNames?.[0] || "").replace(/\s*\(CIK[^)]*\)\s*$/i, ""),
        role, date: x.date, filedDate: f.filedDate, code: x.code, kind: CODE_LABEL[x.code] || x.code,
        shares: x.shares, price: x.price, ownedAfter: x.ownedAfter, url: f.url,
      });
    }
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    kind: "insider", ticker, name: pf.name || ticker, cik: pf.cik,
    startDate: pf.startDate, endDate: pf.endDate, windowDays: INSIDER_WINDOW_DAYS,
    filingsInWindow: pf.total, filingsRead: picked.length,
    // Filings existed but none could be read: cache this only briefly.
    partial: picked.length > 0 && rows.length === 0,
    latestFiledDate: picked[0]?.filedDate || null,
    rows: rows.slice(0, TEASER_ROWS),
  };
}

/** The manager's latest 13F-HR: period, filed date, position count, top
 *  holdings by reported value. Submissions index + filing index + the
 *  information table, and the table only when it is small enough to be free. */
export async function buildFundTeaser(slug, deps = {}) {
  const seed = (deps.seededManager || seededManager)(slug);
  const resolve = deps.resolveManager || resolveManager;
  const latest = deps.latest13fFiling || latest13fFiling;
  const findTable = deps.findInformationTable || findInformationTable;
  const getXml = deps.fetchXmlText || fetchXmlText;
  const parseTable = deps.parse13fInformationTable || parse13fInformationTable;
  // An off-list fund slug would resolve through EDGAR FULL-TEXT SEARCH - one live
  // query per unique slug, on a slug space of [a-z0-9-]{2,60}. That is an
  // amplifier pointed at the same SEC egress our PAID report products use, so a
  // spray here could 403 us out of $4-$25 handlers. Only seeded managers build;
  // everyone else 404s and can still be reached by name or CIK through the paid
  // tool, which is rate-limited and paid for.
  if (!seed) return null;
  const who = { cik: seed.cik, name: seed.name };
  const filing = await latest({ cik: who.cik });
  if (!filing) { const e = new Error("no 13F-HR filings"); e.statusCode = 422; throw e; }
  // Prefer the curated display name for a seeded manager: EDGAR's registered
  // entity name is upper-cased boilerplate ("BERKSHIRE HATHAWAY INC"), which
  // reads badly in a title and is not what a buyer types.
  const base = {
    kind: "fund", slug, name: seed?.name || filing.managerName || who.name || slugToName(slug), cik: who.cik,
    reportDate: filing.reportDate, filedDate: filing.filedDate, accession: filing.accessionNumber,
    filingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${who.cik}&type=13F-HR&dateb=&owner=include&count=10`,
    holdings: [], lineItems: null, totalHoldings: null, totalValueUsd: null, holdingsAvailable: false, holdingsNote: "",
  };
  let table = null;
  try { table = await findTable(parseInt(who.cik, 10), filing.accessionNumber); }
  catch { return { ...base, partial: true, holdingsNote: "The holdings table for this filing could not be read from EDGAR just now." }; }
  if (!table) return { ...base, holdingsNote: "This filing does not carry an information table in the expected layout." };
  if (table.size > MAX_TABLE_BYTES) {
    return { ...base, holdingsNote: `This manager's holdings table is ${(table.size / 1_000_000).toFixed(1)} MB, too large to summarize on a free page. The paid report reads all of it.` };
  }
  let rows;
  try { rows = parseTable(await getXml(table.url), filing.filedDate); }
  catch { return { ...base, partial: true, holdingsNote: "The holdings table for this filing could not be read from EDGAR just now." }; }
  // An information table lists one ROW per (security, manager, discretion),
  // so the same holding legitimately appears several times. Ranking raw rows
  // shows the same issuer twice in a top five, which reads as a bug. Fold by
  // CUSIP first and report both counts.
  const byCusip = new Map();
  for (const r of rows) {
    const key = String(r.cusip || `${r.issuer}|${r.titleOfClass}`);
    const cur = byCusip.get(key) || { issuer: r.issuer, titleOfClass: r.titleOfClass, cusip: r.cusip, valueUsd: 0, shares: 0 };
    cur.valueUsd += r.valueUsd ?? 0;
    cur.shares += r.shares ?? 0;
    byCusip.set(key, cur);
  }
  const positions = [...byCusip.values()].sort((a, b) => b.valueUsd - a.valueUsd);
  const totalValueUsd = positions.reduce((a, r) => a + r.valueUsd, 0);
  return {
    ...base, holdingsAvailable: true, lineItems: rows.length, totalHoldings: positions.length, totalValueUsd,
    holdings: positions.slice(0, TEASER_HOLDINGS).map((r) => ({
      issuer: r.issuer, titleOfClass: r.titleOfClass, cusip: r.cusip, valueUsd: r.valueUsd, shares: r.shares,
      weight: totalValueUsd > 0 ? r.valueUsd / totalValueUsd : null,
    })),
  };
}

/** Company identity straight off EDGAR's submissions index: ONE request. */
export async function buildDossierTeaser(ticker, deps = {}) {
  const resolve = deps.resolveCompany || resolveCompany;
  const getJson = deps.edgarGetJson || edgarGetJson;
  const who = await resolve({ ticker });
  const sub = await getJson(`https://data.sec.gov/submissions/CIK${who.cik}.json`);
  const recent = sub?.filings?.recent || {};
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const latestOf = (want) => {
    for (let i = 0; i < forms.length; i++) {
      if (String(forms[i]).toUpperCase() !== want) continue;
      return { form: want, filingDate: recent.filingDate?.[i] || null, reportDate: recent.reportDate?.[i] || null, accession: recent.accessionNumber?.[i] || null };
    }
    return null;
  };
  const counts = {};
  for (const f of forms) { const k = String(f).toUpperCase(); counts[k] = (counts[k] || 0) + 1; }
  return {
    kind: "dossier", ticker, cik: who.cik,
    name: sub?.name || who.name || ticker,
    sic: sub?.sic || null, industry: sub?.sicDescription || null,
    state: sub?.addresses?.business?.stateOrCountry || sub?.stateOfIncorporation || null,
    stateOfIncorporation: sub?.stateOfIncorporation || null,
    exchanges: Array.isArray(sub?.exchanges) ? sub.exchanges.filter(Boolean) : [],
    tickers: Array.isArray(sub?.tickers) ? sub.tickers.filter(Boolean) : [],
    fiscalYearEnd: sub?.fiscalYearEnd || null,
    entityType: sub?.entityType || null,
    latest10K: latestOf("10-K"), latest10Q: latestOf("10-Q"), latest8K: latestOf("8-K"),
    form4Count: counts["4"] || 0,
    filingsIndexed: forms.length,
  };
}

// --- cached, gated, deadline-bounded loader ---------------------------------
/**
 * @returns {Promise<{status:"ok"|"degraded"|"missing", data?:object, entity?:object}>}
 *   ok       - fresh or cached teaser data
 *   degraded - the entity is known (seeded) but EDGAR could not be read
 *   missing  - the slug does not resolve; caller renders the 404 page
 */
export async function loadTeaser(kind, slug, { seeded = false, builders = {}, teaserCache = cache } = {}) {
  const key = `${kind}:${slug}`;
  const hit = teaserCache.get(key);
  // `cached: true` means this answer cost nothing upstream, which is what lets
  // the route serve a crawler burst without spending rate-limit budget.
  if (hit) return hit.miss ? { status: "missing", cached: true } : { status: "ok", data: hit.value, cached: true };
  const build = builders[kind] || { insider: buildInsiderTeaser, fund: buildFundTeaser, dossier: buildDossierTeaser }[kind];
  if (!build) return { status: "missing" };
  try {
    const data = await withGate(() => deadline(build(slug), BUILD_TIMEOUT_MS));
    // A builder that returns nothing is declining the slug outright (the fund
    // builder does this for anything off the seed list, so an unbounded slug
    // space can never become EDGAR full-text-search traffic). That is a 404 and
    // a negative-cache entry, never a page carrying a made-up name in its title.
    if (!data) { teaserCache.setMiss(key); return { status: "missing" }; }
    return { status: "ok", data: teaserCache.setValue(key, data, data?.partial ? PARTIAL_TTL_MS : undefined) };
  } catch (e) {
    // A SEEDED entity is known to exist - we curated it - so no read failure
    // may ever turn its page into a 404. It degrades instead.
    if (seeded) return { status: "degraded" };
    if (isUnresolvable(e)) { teaserCache.setMiss(key); return { status: "missing" }; }
    // Could not READ an off-list slug: refuse it, but only briefly, so a real
    // long-tail page comes back on its own once EDGAR answers again.
    teaserCache.setMiss(key, SOFT_NEG_TTL_MS);
    return { status: "missing" };
  }
}

// --- pricing (never hardcoded) ----------------------------------------------
const cardUsd = (productKey) => (HUMAN_PRODUCTS[productKey].price / 100).toFixed(0);
export const FAMILIES = {
  insider: {
    kind: "insider", path: "insider", product: "insider-report", route: "POST /v1/insider-report",
    agentBody: (input) => JSON.stringify({ ticker: input }), agentPrice: () => INSIDER_TIERS["insider-report"].price,
    toolSlug: "insider-report",
  },
  fund: {
    kind: "fund", path: "fund", product: "fund-report", route: "POST /v1/fund",
    agentBody: (input) => JSON.stringify({ manager: input }), agentPrice: () => FUND_TIERS["fund-report"].price,
    toolSlug: "fund-report",
  },
  dossier: {
    kind: "dossier", path: "dossier", product: "dossier", route: "POST /v1/dossier",
    agentBody: (input) => JSON.stringify({ ticker: input }), agentPrice: () => DOSSIER_TIERS["dossier"].price,
    toolSlug: "dossier",
  },
};

// --- shared page furniture --------------------------------------------------
export const PROGRAMMATIC_CSS = `
  .pg-meta{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:12px;line-height:1.6}
  .pg-table-wrap{overflow-x:auto;border:1px solid var(--hairline);border-radius:14px;background:var(--card);margin-top:18px}
  .pg-table{border-collapse:collapse;width:100%;min-width:640px;font-size:14px}
  .pg-table th{text-align:left;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:500;padding:12px 14px;border-bottom:1px solid var(--hairline);white-space:nowrap}
  .pg-table td{padding:11px 14px;border-bottom:1px solid var(--hairline);color:var(--muted);vertical-align:top}
  .pg-table tr:last-child td{border-bottom:0}
  .pg-table td.num{font-family:var(--font-mono);text-align:right;white-space:nowrap;color:var(--ink)}
  .pg-table td.who{color:var(--ink)}
  .pg-buy{border:1px solid var(--hairline);border-radius:18px;background:var(--card);padding:26px;margin-top:26px;box-shadow:inset 0 1px 0 var(--card-inset),0 1px 2px rgba(0,0,0,.08)}
  .pg-buy h2{font-weight:500;font-size:22px;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink)}
  .pg-buy p{color:var(--muted);font-size:15px;line-height:1.55;margin:0 0 16px;font-weight:300}
  .pg-agent{font-family:var(--font-mono);font-size:12.5px;color:var(--muted);background:var(--chip-bg);border:1px solid var(--hairline);border-radius:12px;padding:12px 14px;margin-top:16px;line-height:1.7;overflow-x:auto}
  .pg-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  .pg-links a{font-size:14px;color:var(--ink);text-decoration:none;border:1px solid var(--dash);border-radius:999px;padding:8px 14px}
  .pg-links a:hover{border-color:var(--ink)}
  .pg-note{color:var(--faint);font-size:13px;line-height:1.6;margin-top:22px;font-weight:300}
  .pg-empty{border:1px dashed var(--dash);border-radius:14px;padding:22px;color:var(--muted);margin-top:18px;font-weight:300}
  .pg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:20px}
  .pg-grid a{display:block;border:1px solid var(--hairline);border-radius:12px;background:var(--card);padding:12px 14px;text-decoration:none;color:var(--ink);font-size:15px}
  .pg-grid a:hover{border-color:var(--ink)}
  .pg-grid a span{display:block;font-family:var(--font-mono);font-size:11px;color:var(--faint);margin-top:3px}
  .pg-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:20px}
  .pg-fact{border:1px solid var(--hairline);border-radius:14px;background:var(--card);padding:14px 16px}
  .pg-fact .l{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
  .pg-fact .v{font-size:17px;color:var(--ink);margin-top:5px;line-height:1.35}
`;

const DISCLAIMER = "Generated from public SEC EDGAR filings. Filing data is shown as filed. This is information, not investment advice.";

const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "");
const fmtUsd = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "");
const fmtPrice = (n) => (Number.isFinite(n) && n > 0 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const fmtPct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "");

function buySection({ family, input, headline, blurb, alertKind = null }) {
  const price = cardUsd(family.product);
  return `${alertKind ? alertFormHtml({ kind: alertKind, target: input, source: `/reports/${family.key || alertKind}` }) : ""}<div class="pg-buy">
  <h2>${esc(headline)}</h2>
  <p>${esc(blurb)}</p>
  <button class="btn btn-primary" data-buy-product="${esc(family.product)}" data-buy-input="${esc(input)}">Get the full report, $${esc(price)} →</button>
  <div class="err" id="err-buy"></div>
  <div class="pg-agent">agents: ${esc(family.route)} with ${esc(family.agentBody(input))} over x402 or MPP, ${esc(family.agentPrice())}</div>
  <p class="note" style="margin-top:12px;"><a href="/tools/${esc(family.toolSlug)}" style="color:var(--muted);">Sample output and API docs</a> · <a href="/reports" style="color:var(--muted);">all reports</a></p>
</div>`;
}

function crossLinks(links) {
  return `<div class="pg-links">${links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("")}</div>`;
}

function breadcrumbLd(baseUrl, trail) {
  return {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${baseUrl}${t.path}` })),
  };
}
function productLd(baseUrl, family, name, description, canonical) {
  const p = HUMAN_PRODUCTS[family.product];
  return {
    "@context": "https://schema.org", "@type": "Product",
    name: `${p.label}: ${name}`, description,
    image: `${baseUrl}/tools/${p.slug}/card.png`,
    brand: { "@type": "Brand", name: "Agent402" },
    offers: { "@type": "Offer", price: (p.price / 100).toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: canonical, seller: { "@type": "Organization", name: "Havok Holdings LLC" } },
  };
}
function datasetLd(baseUrl, { name, description, canonical, modified }) {
  return {
    "@context": "https://schema.org", "@type": "Dataset",
    name, description, url: canonical,
    isAccessibleForFree: true,
    license: "https://www.sec.gov/about/website-policy",
    creator: { "@type": "Organization", name: "Havok Holdings LLC", url: baseUrl },
    ...(modified ? { dateModified: modified } : {}),
    isBasedOn: "https://www.sec.gov/edgar",
    keywords: ["SEC EDGAR", "filings", "public company data"],
  };
}

function shell({ title, description, canonical, baseUrl, body, jsonLd }) {
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/reports",
    extraCss: REPORTS_CSS + PROGRAMMATIC_CSS,
    body: `<div class="wrap">${body}</div>${ledgerFooterCompact()}<script src="/js/report-buy.js"></script><script src="/js/alert-signup.js"></script>`,
    jsonLd,
  });
}

// --- insider page -----------------------------------------------------------
export function insiderPage({ ticker, data, baseUrl, degraded = false }) {
  const family = FAMILIES.insider;
  const name = data?.name || ticker;
  const canonical = `${baseUrl}/reports/insider/${ticker}`;
  const title = `${ticker} insider buying and selling: latest Form 4 filings`;
  const buys = (data?.rows || []).filter((r) => r.code === "P").length;
  const sells = (data?.rows || []).filter((r) => r.code === "S").length;
  const description = data
    ? `Who is buying and selling ${name} (${ticker}) stock: the latest SEC Form 4 filings with insider name, role, transaction code, shares and price. ${data.filingsInWindow} filings in the last ${data.windowDays} days.`
    : `Who is buying and selling ${ticker} stock: the latest SEC Form 4 insider filings, filer name, role, transaction code, shares and price, straight from EDGAR.`;
  const rows = data?.rows || [];
  const table = rows.length
    ? `<div class="pg-table-wrap"><table class="pg-table">
<thead><tr><th>Date</th><th>Insider</th><th>Role</th><th>Transaction</th><th>Code</th><th>Shares</th><th>Price</th><th>Owned after</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td class="num">${esc(r.date || "")}</td><td class="who">${esc(r.insider || "")}</td><td>${esc(r.role || "")}</td><td>${esc(r.kind || "")}</td><td class="num">${esc(r.code || "")}</td><td class="num">${esc(fmtInt(r.shares))}</td><td class="num">${esc(fmtPrice(r.price))}</td><td class="num">${esc(r.ownedAfter == null ? "" : fmtInt(r.ownedAfter))}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="pg-empty">${degraded || !data ? "SEC EDGAR could not be read for this company just now. The filings themselves are unaffected: try again shortly, or buy the full report, which reads them at request time." : data.partial ? `Form 4 filings exist for ${esc(name)} in this window, but their transaction detail could not be read just now. The paid report reads every filing at request time.` : `No Form 4 transactions were filed against ${esc(name)} in the last ${data.windowDays} days. The paid report can look back up to 365 days.`}</div>`;
  const body = `
<section class="hero">
  <div class="eyebrow">SEC Form 4 · insider transactions · free</div>
  <h1>${esc(name)} <em>insider buying and selling</em></h1>
  <p class="lede">${data ? `${esc(String(data.filingsInWindow))} Form 4 filings against ${esc(name)} (${esc(ticker)}) in the last ${esc(String(data.windowDays))} days. Below are the transactions from ${esc(String(data.filingsRead))} recent filings, one per insider where the window allows, as filed.` : `The latest SEC Form 4 filings against ${esc(ticker)}, as filed.`}</p>
  <div class="pg-meta">${data ? `Window ${esc(data.startDate)} to ${esc(data.endDate)} · CIK ${esc(data.cik)}${data.latestFiledDate ? ` · newest filing ${esc(data.latestFiledDate)}` : ""} · ` : ""}source: SEC EDGAR full-text search and the Form 4 XML itself</div>
</section>
<section>
  ${table}
  ${rows.length ? `<div class="pg-meta">Transaction codes: P is an open-market purchase, S an open-market sale, A a grant or award, M an option exercise, F shares surrendered for tax. ${buys} open-market buy${buys === 1 ? "" : "s"} and ${sells} open-market sale${sells === 1 ? "" : "s"} in the rows above.</div>` : ""}
  ${buySection({ family, alertKind: "insider", input: ticker, headline: `Every Form 4 against ${name}, parsed and explained`, blurb: `The free view above is the newest few filings. The paid report reads every Form 4 in your window (up to 365 days), separates open-market buys and sales from awards, exercises and tax withholding, totals the flow per insider, flags 10b5-1 plans where the filing notes them, and hands you a cited write-up plus a downloadable transactions table.` })}
  ${crossLinks([
    { href: `/reports/dossier/${ticker}`, label: `${ticker} company profile` },
    { href: "/reports/insider", label: "All insider pages" },
    { href: "/reports/fund", label: "13F fund holdings" },
    { href: "/reports", label: "All reports" },
    { href: "/monitors", label: `Watch ${ticker} for new filings` },
  ])}
  <p class="pg-note">${esc(DISCLAIMER)}</p>
</section>`;
  return shell({
    title, description, canonical, baseUrl, body,
    jsonLd: [
      datasetLd(baseUrl, { name: `${ticker} Form 4 insider transactions`, description, canonical, modified: data?.latestFiledDate || null }),
      breadcrumbLd(baseUrl, [{ name: "Reports", path: "/reports" }, { name: "Insider filings", path: "/reports/insider" }, { name: ticker, path: `/reports/insider/${ticker}` }]),
      productLd(baseUrl, family, `${name} (${ticker})`, `Cited insider flow report on ${name} from SEC Form 4 filings.`, canonical),
    ],
  });
}

// --- fund page --------------------------------------------------------------
export function fundPage({ slug, data, baseUrl, degraded = false }) {
  const family = FAMILIES.fund;
  const seed = seededManager(slug);
  const name = data?.name || seed?.name || slugToName(slug);
  const canonical = `${baseUrl}/reports/fund/${slug}`;
  const title = `${name} 13F holdings: latest portfolio from SEC filings`;
  const description = data
    ? `What ${name} holds: the latest SEC Form 13F-HR, period ending ${data.reportDate}, filed ${data.filedDate}${data.holdingsAvailable ? `, ${fmtInt(data.totalHoldings)} positions worth ${fmtUsd(data.totalValueUsd)}` : ""}. Top holdings shown free.`
    : `What ${name} holds: the latest SEC Form 13F-HR portfolio, position count and top holdings by reported value, straight from EDGAR.`;
  const facts = data ? `<div class="pg-facts">
  <div class="pg-fact"><div class="l">Period</div><div class="v">${esc(data.reportDate || "")}</div></div>
  <div class="pg-fact"><div class="l">Filed</div><div class="v">${esc(data.filedDate || "")}</div></div>
  <div class="pg-fact"><div class="l">Positions</div><div class="v">${esc(data.totalHoldings == null ? "not shown" : fmtInt(data.totalHoldings))}</div></div>
  <div class="pg-fact"><div class="l">Reported value</div><div class="v">${esc(data.totalValueUsd == null ? "not shown" : fmtUsd(data.totalValueUsd))}</div></div>
</div>` : "";
  const holdings = data?.holdings || [];
  const table = holdings.length
    ? `<div class="pg-table-wrap"><table class="pg-table">
<thead><tr><th>#</th><th>Issuer</th><th>Class</th><th>CUSIP</th><th>Value</th><th>Shares</th><th>Weight</th></tr></thead>
<tbody>${holdings.map((h, i) => `<tr><td class="num">${i + 1}</td><td class="who">${esc(h.issuer || "")}</td><td>${esc(h.titleOfClass || "")}</td><td class="num">${esc(h.cusip || "")}</td><td class="num">${esc(fmtUsd(h.valueUsd))}</td><td class="num">${esc(fmtInt(h.shares))}</td><td class="num">${esc(fmtPct(h.weight))}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="pg-empty">${degraded || !data ? "SEC EDGAR could not be read for this manager just now. Try again shortly, or buy the full report, which reads the filing at request time." : esc(data.holdingsNote || "No holdings table was available for this filing.")}</div>`;
  const body = `
<section class="hero">
  <div class="eyebrow">SEC Form 13F-HR · institutional holdings · free</div>
  <h1>${esc(name)} <em>13F holdings</em></h1>
  <p class="lede">${data ? `The latest 13F-HR filed by ${esc(name)} covers the period ending ${esc(data.reportDate || "")}${data.holdingsAvailable ? `, with ${esc(fmtInt(data.totalHoldings))} reported positions.` : "."} The largest positions by reported value are below, as filed.` : `The latest SEC 13F-HR portfolio filed by ${esc(name)}, as filed.`}</p>
  <div class="pg-meta">${data ? `CIK ${esc(data.cik)} · accession ${esc(data.accession || "")} · <a href="${esc(data.filingUrl)}" rel="nofollow">view the filings on SEC EDGAR</a> · ` : ""}source: SEC EDGAR, Form 13F-HR information table</div>
</section>
<section>
  ${facts}
  ${table}
  ${holdings.length ? `<div class="pg-meta">Positions are folded by CUSIP: this filing lists ${esc(fmtInt(data.lineItems))} line items across ${esc(fmtInt(data.totalHoldings))} securities. A 13F reports long US-listed equity positions held at the period end, filed up to 45 days later. It is a snapshot, not a live portfolio, and it excludes shorts, cash and most non-US holdings.</div>` : ""}
  ${buySection({ family, alertKind: "fund", input: name, headline: `What ${name} bought, added, trimmed and exited`, blurb: `The free view above is the top of one quarter's filing. The paid report diffs the two most recent 13F filings, so you see new positions, adds, trims and exits with the size of each move, a cited write-up, and the full holdings plus changes table to download.` })}
  ${crossLinks([
    { href: "/reports/fund", label: "All 13F fund pages" },
    { href: "/reports/insider", label: "Insider filings by ticker" },
    { href: "/reports", label: "All reports" },
    { href: "/monitors", label: `Watch ${name} for new 13F filings` },
  ])}
  <p class="pg-note">${esc(DISCLAIMER)}</p>
</section>`;
  return shell({
    title, description, canonical, baseUrl, body,
    jsonLd: [
      datasetLd(baseUrl, { name: `${name} Form 13F-HR holdings`, description, canonical, modified: data?.filedDate || null }),
      breadcrumbLd(baseUrl, [{ name: "Reports", path: "/reports" }, { name: "Fund 13F holdings", path: "/reports/fund" }, { name, path: `/reports/fund/${slug}` }]),
      productLd(baseUrl, family, name, `Cited 13F portfolio report on ${name}, including what changed last quarter.`, canonical),
    ],
  });
}

// --- dossier page -----------------------------------------------------------
export function dossierPage({ ticker, data, baseUrl, degraded = false }) {
  const family = FAMILIES.dossier;
  const name = data?.name || ticker;
  const canonical = `${baseUrl}/reports/dossier/${ticker}`;
  const title = `${ticker} due diligence: SEC filing profile for ${name}`;
  const description = data
    ? `Due-diligence starting point for ${name} (${ticker}): CIK ${data.cik}${data.industry ? `, ${data.industry}` : ""}${data.latest10K?.filingDate ? `, latest 10-K filed ${data.latest10K.filingDate}` : ""}. Company identity and filing dates from SEC EDGAR, free.`
    : `Due-diligence starting point for ${ticker}: company identity, industry classification and the latest 10-K and 10-Q dates from SEC EDGAR.`;
  const fact = (l, v) => (v ? `<div class="pg-fact"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>` : "");
  const facts = data ? `<div class="pg-facts">
  ${fact("CIK", data.cik)}
  ${fact("Industry (SIC)", data.industry ? `${data.industry}${data.sic ? ` (${data.sic})` : ""}` : "")}
  ${fact("Incorporated", data.stateOfIncorporation || "")}
  ${fact("Listed on", data.exchanges.join(", "))}
  ${fact("Tickers", data.tickers.join(", "))}
  ${fact("Fiscal year end", data.fiscalYearEnd ? `${data.fiscalYearEnd.slice(0, 2)}-${data.fiscalYearEnd.slice(2)}` : "")}
</div>` : "";
  const filingRow = (f, label) => (f ? `<tr><td class="who">${esc(label)}</td><td class="num">${esc(f.filingDate || "")}</td><td class="num">${esc(f.reportDate || "")}</td><td class="num">${esc(f.accession || "")}</td></tr>` : "");
  const rows = data ? [filingRow(data.latest10K, "Annual report (10-K)"), filingRow(data.latest10Q, "Quarterly report (10-Q)"), filingRow(data.latest8K, "Current report (8-K)")].filter(Boolean).join("") : "";
  const table = rows
    ? `<div class="pg-table-wrap"><table class="pg-table"><thead><tr><th>Filing</th><th>Filed</th><th>Period</th><th>Accession</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="pg-empty">${degraded || !data ? "SEC EDGAR could not be read for this company just now. Try again shortly, or buy the full dossier, which reads the filings at request time." : "No 10-K, 10-Q or 8-K appears in this company's recent EDGAR index."}</div>`;
  const body = `
<section class="hero">
  <div class="eyebrow">SEC EDGAR · company profile · free</div>
  <h1>${esc(name)} <em>due diligence</em></h1>
  <p class="lede">${data ? `Who ${esc(name)} (${esc(ticker)}) is on the public record: identity, industry classification and the most recent periodic filings, straight from SEC EDGAR.` : `Who ${esc(ticker)} is on the public record: identity, industry classification and the most recent periodic filings from SEC EDGAR.`}</p>
  <div class="pg-meta">${data ? `${esc(String(data.filingsIndexed))} filings in EDGAR's recent index${data.form4Count ? `, ${esc(String(data.form4Count))} of them Form 4 insider filings` : ""} · <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&amp;CIK=${esc(data.cik)}&amp;type=10-K&amp;dateb=&amp;owner=include&amp;count=10" rel="nofollow">view the filings on SEC EDGAR</a> · ` : ""}source: SEC EDGAR submissions index</div>
</section>
<section>
  ${facts}
  ${table}
  ${buySection({ family, alertKind: "filing", input: ticker, headline: `The full due-diligence dossier on ${name}`, blurb: `The free view above is identity and filing dates. The paid dossier reads the filings: business and segments, financial trend, insider and institutional activity, litigation and risk-factor themes, recent news, and the red flags, every claim cited and delivered with a data appendix.` })}
  ${crossLinks([
    { href: `/reports/insider/${ticker}`, label: `${ticker} insider filings` },
    { href: "/reports/dossier", label: "All company profiles" },
    { href: "/reports/fund", label: "13F fund holdings" },
    { href: "/reports", label: "All reports" },
  ])}
  <p class="pg-note">${esc(DISCLAIMER)}</p>
</section>`;
  return shell({
    title, description, canonical, baseUrl, body,
    jsonLd: [
      datasetLd(baseUrl, { name: `${name} SEC filing profile`, description, canonical, modified: data?.latest10Q?.filingDate || data?.latest10K?.filingDate || null }),
      breadcrumbLd(baseUrl, [{ name: "Reports", path: "/reports" }, { name: "Company profiles", path: "/reports/dossier" }, { name: ticker, path: `/reports/dossier/${ticker}` }]),
      productLd(baseUrl, family, `${name} (${ticker})`, `Cited due-diligence dossier on ${name} built from SEC filings and live sources.`, canonical),
    ],
  });
}

// --- hubs -------------------------------------------------------------------
const HUBS = {
  insider: {
    title: "Insider buying and selling by ticker: SEC Form 4 filings",
    description: "Free Form 4 insider transaction pages for 100 US public companies: who bought, who sold, how many shares and at what price, from SEC EDGAR.",
    h1: "Insider buying and selling", em: "by ticker",
    lede: "Every page below shows the latest SEC Form 4 filings against that company with the transactions parsed: insider name, role, transaction code, shares and price. Free, straight from EDGAR.",
    eyebrow: "SEC Form 4 · free filing pages",
  },
  fund: {
    title: "13F holdings by fund: what institutional managers own",
    description: "Free 13F holdings pages for 50 institutional managers: latest filing period, position count, reported value and top holdings, from SEC EDGAR.",
    h1: "13F holdings", em: "by fund",
    lede: "Every page below shows a manager's most recent SEC Form 13F-HR: the period it covers, how many positions it reports, and the largest holdings by reported value. Free, straight from EDGAR.",
    eyebrow: "SEC Form 13F-HR · free filing pages",
  },
  dossier: {
    title: "Company profiles by ticker: SEC EDGAR filing identity",
    description: "Free SEC EDGAR company profiles for 100 US public companies: CIK, industry classification, exchange listings and the latest 10-K, 10-Q and 8-K dates.",
    h1: "Company profiles", em: "by ticker",
    lede: "Every page below shows a company's public identity on SEC EDGAR: CIK, industry classification, where it lists, and when it last filed a 10-K, 10-Q and 8-K. Free.",
    eyebrow: "SEC EDGAR · free company profiles",
  },
};

export function hubPage({ kind, baseUrl }) {
  const h = HUBS[kind];
  const family = FAMILIES[kind];
  const canonical = `${baseUrl}/reports/${kind}`;
  const items = kind === "fund"
    ? SEED_MANAGERS.map((m) => ({ href: `/reports/fund/${m.slug}`, label: m.name, sub: "13F-HR" }))
    : SEED_TICKERS.map((t) => ({ href: `/reports/${kind}/${t}`, label: t, sub: kind === "insider" ? "Form 4" : "EDGAR profile" }));
  const others = Object.keys(HUBS).filter((k) => k !== kind).map((k) => ({ href: `/reports/${k}`, label: HUBS[k].h1 }));
  const body = `
<section class="hero">
  <div class="eyebrow">${esc(h.eyebrow)}</div>
  <h1>${esc(h.h1)} <em>${esc(h.em)}</em></h1>
  <p class="lede">${esc(h.lede)}</p>
</section>
<section>
  <div class="pg-grid">${items.map((i) => `<a href="${esc(i.href)}">${esc(i.label)}<span>${esc(i.sub)}</span></a>`).join("")}</div>
  <div class="pg-buy" style="margin-top:30px;">
    <h2>Want the whole thing, not the teaser?</h2>
    <p>The paid report reads every filing in your window, explains what it means, cites each claim, and gives you the data as a table. Card or USDC, no account.</p>
    <a class="btn btn-primary" href="/reports">Buy a report, $${esc(cardUsd(family.product))} →</a>
    <div class="pg-agent">agents: ${esc(family.route)} with ${esc(family.agentBody(kind === "fund" ? "Berkshire Hathaway" : "AAPL"))} over x402 or MPP, ${esc(family.agentPrice())}</div>
  </div>
  ${crossLinks([...others, { href: "/reports", label: "All reports" }, { href: "/monitors", label: "Standing monitors" }])}
  <p class="pg-note">${esc(DISCLAIMER)} Pages for companies and managers outside this list resolve too if the ticker or manager exists on EDGAR.</p>
</section>`;
  return shell({
    title: h.title, description: h.description, canonical, baseUrl, body,
    jsonLd: [
      breadcrumbLd(baseUrl, [{ name: "Reports", path: "/reports" }, { name: h.h1, path: `/reports/${kind}` }]),
      { "@context": "https://schema.org", "@type": "ItemList", name: h.title, numberOfItems: items.length, itemListElement: items.slice(0, 100).map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.label, url: `${baseUrl}${i.href}` })) },
    ],
  });
}

export { isSeededTicker, seededManager, SEED_TICKERS, SEED_MANAGERS };
