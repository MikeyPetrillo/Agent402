// Refresh Bazaar metadata for Agent402 listings.
//
// Background: Coinbase's CDP Bazaar harvester captures per-resource metadata
// (description, serviceName, tags) when a payment is observed against that
// resource — it doesn't re-poll the 402 challenge on its own.
//
// Two modes:
//   MODE=stale   (default) — find listings whose serviceName drifted and
//                re-trigger the harvester so they pick up the current name.
//                Used by the daily refresh after renames.
//   MODE=missing — find routes in our catalog that aren't on Bazaar at all
//                and pay the minimum-cost call once each so the harvester
//                registers them. Used after large catalog additions.
//
// Stale mode steps:
//   1) Page Bazaar for our resources whose serviceName !== EXPECT_NAME
//   2) Look up each tool's example from /api/find
//   3) Pay once to make the harvester re-observe metadata
//
// Missing mode steps:
//   1) Fetch /api/pricing (our catalog) and the full Bazaar resource set
//   2) Diff: catalog ∖ Bazaar = routes that have never been observed
//   3) Pull examples from /openapi.json (full coverage, unlike /api/find)
//   4) Pay each from cheapest first, bounded by MAX_SPEND_USD
//   5) Re-verify the missing count
//
// Cost: stale mode is well under $1. Missing mode prints an estimate up
//   front and refuses to run if it exceeds MAX_SPEND_USD. The script is
//   idempotent — already-registered routes drop from the missing set on
//   re-run, so a timed-out run can be safely resumed.
//
// Run: BURNER_KEY=0x... node scripts/refresh-bazaar.js
//   or KEY_FILE=/tmp/agent-key node scripts/refresh-bazaar.js
// Optional env:
//   MODE              "stale" (default), "missing", or "sweep" (pay EVERY route
//                     priced <= MAX_PRICE_USD once — for settlement-driven
//                     registration on PAY_NETWORK, e.g. PayAI's Solana index)
//   PAY_NETWORK       "base" (default, BURNER_KEY via CDP) or "solana"
//                     (SOLANA_BURNER_KEY via PayAI)
//   MAX_PRICE_USD     sweep-mode per-tool ceiling (default 0.05 — skips the
//                     LLM/image/audio proxies that bill real upstream credit)
//   SLUGS             comma-separated slug filter for missing-mode (register only these)
//   TARGET_URL        (default https://agent402.tools)
//   EXPECT_NAME       (default "Agent402.tools")
//   MAX_SPEND_USD     missing-mode cost ceiling (default 5)
//   DRY_RUN=1         list the work without paying
//
// Exit codes: 0 = no work remaining OF OURS (includes "every buy settled, the
// Bazaar harvester just hasn't ingested them yet" — that lag is theirs, not a
// failure) · 1 = real work remaining: a buy failed, or a route was never paid
// for (spend/price cap, batch stride) · 2 = misconfigured.

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
// viem + @x402/* are loaded lazily so DRY_RUN works without them installed.

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const EXPECT_NAME = process.env.EXPECT_NAME || "Agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const MODE = (process.env.MODE || "stale").toLowerCase();
const MAX_SPEND_USD = Number(process.env.MAX_SPEND_USD || "5");
// Which chain the paid requests settle on. "base" (default) pays via the EVM
// BURNER_KEY through CDP — what the Bazaar harvester observes. "solana" pays
// via SOLANA_BURNER_KEY through PayAI — what SETTLEMENT-DRIVEN Solana indexes
// (PayAI's merchant listing, x402scan's facilitator view) observe, and every
// payment also makes harvesters re-observe the live 402 with the full
// multi-chain accepts.
const PAY_NETWORK = (process.env.PAY_NETWORK || "base").toLowerCase();
// Sweep-mode price ceiling per tool: skip anything above it. The LLM / image /
// audio / code-run proxies bill real upstream credit per call — registering
// them isn't worth actual money burn; they stay findable via the live 402.
const MAX_PRICE_USD = Number(process.env.MAX_PRICE_USD || (MODE === "sweep" ? "0.05" : "Infinity"));
// UPSTREAM_FREE_ONLY=1 sweeps only routes that cost us nothing per call at a
// third party, so the pass can run daily instead of weekly. The price ceiling
// is only a PROXY for upstream cost (a $0.002 Blockscout call bills us $0.002
// upstream); this is the real question, asked of the server. Memory tools are
// admitted by name: they are wallet-keyed rather than compute-payable, and the
// only resource they consume is our own Railway volume.
const UPSTREAM_FREE_ONLY = /^(1|true|yes)$/i.test(process.env.UPSTREAM_FREE_ONLY || "");
// The inverse, for the priced pass: skip what the daily zero-upstream pass has
// already settled today, so the weekly one is not re-buying 177 routes that are
// already well inside the 30-day window. Each skipped route is one fewer
// facilitator settlement against CDP's 1,000/month free tier.
const SKIP_UPSTREAM_FREE = /^(1|true|yes)$/i.test(process.env.SKIP_UPSTREAM_FREE || "");
// Floor, so the expensive tail can be swept on its own cadence without the
// cheap routes riding along.
const MIN_PRICE_USD = Number(process.env.MIN_PRICE_USD || "0");
// Group selector, so a natural family (the skill packs are all "skill-") can be
// given its own cadence without pasting sixty-odd slugs into a dispatch input.
const SLUG_PREFIX = (process.env.SLUG_PREFIX || "").trim();
// Only pay for what is about to be culled. A listing's 30-day clock is reset by
// ANY settlement, ours or a customer's, so a route that is actually selling
// needs nothing from us - and measured 2026-08-31, 371 of our 452 listings had
// exactly one payer (the burner) while 62 had a real outside buyer. Paying for
// all of them every day buys advertisement we already have. STALE_DAYS sweeps
// only listings whose lastCalledAt is older than N days, plus anything not
// listed at all. Unset = the old behaviour, sweep everything selected.
const STALE_DAYS = Number(process.env.STALE_DAYS || "0");
const UPSTREAM_FREE_EXTRA = new Set((process.env.UPSTREAM_FREE_EXTRA || "memory-").split(",").map((x) => x.trim()).filter(Boolean));
const costsNothingUpstream = (t) =>
  t.computePayable || [...UPSTREAM_FREE_EXTRA].some((p) => t.slug === p || t.slug.startsWith(p));
const SLUGS_FILTER = process.env.SLUGS ? new Set(process.env.SLUGS.split(",").map(s => s.trim())) : null;
// Deterministic batching for large sweeps: split the (sorted) work list into
// BATCH_COUNT interleaved groups and run only BATCH_INDEX. Lets a big settlement
// sweep run in several bounded passes (each ~1/COUNT of the routes + cost) so no
// single pass runs long enough to time out. Default = one batch (everything).
const BATCH_COUNT = Math.max(1, parseInt(process.env.BATCH_COUNT || "1", 10) || 1);
const BATCH_INDEX = Math.min(BATCH_COUNT - 1, Math.max(0, parseInt(process.env.BATCH_INDEX || "0", 10) || 0));
const BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_SIZE = 1000;
const HOST = new URL(TARGET).host;

function priceToUsd(s) {
  return Number(String(s || "").replace(/[^\d.]/g, "")) || 0;
}

async function pageBazaar(filter) {
  const matches = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const r = await fetch(`${BAZAAR_URL}?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!r.ok) throw new Error(`Bazaar HTTP ${r.status}`);
    const j = await r.json();
    total = j.pagination?.total || 0;
    const items = j.items || [];
    if (!items.length) break;
    for (const it of items) if (filter(it)) matches.push(it);
    offset += items.length;
    if (offset >= total) break;
  }
  return { matches, total };
}

async function loadStaleRoutes() {
  // serviceName is PER TOOL since 2026-08-31 ("Extract article", not
  // "Agent402.tools"), because 168 identical rows in a 14,000-row index answer
  // no query an agent would type. So "stale" can no longer mean "differs from
  // one constant" - that would flag every listing we have. It means the name
  // the Bazaar holds differs from the name the catalog declares for that route
  // right now. EXPECT_NAME stays as the fallback for routes the catalog no
  // longer carries.
  const expected = new Map();
  try {
    const r = await fetch(`${TARGET}/api/pricing`);
    if (r.ok) for (const e of ((await r.json()).endpoints || [])) if (e?.path) expected.set(e.path, e.name || EXPECT_NAME);
  } catch { /* fall back to the constant below */ }
  const { matches, total } = await pageBazaar((it) => {
    const r = it.resource || "";
    if (!r.includes(HOST)) return false;
    let want = EXPECT_NAME;
    try { want = expected.get(new URL(r).pathname) ?? EXPECT_NAME; } catch { /* keep the fallback */ }
    return it.serviceName !== want;
  });
  console.log(`Scanned ${total} Bazaar resources; ${matches.length} stale on ${HOST}.`);
  // Normalise to { slug, route, serviceName }
  return matches.map((it) => {
    const u = new URL(it.resource);
    const slug = u.pathname.replace(/^\/api\//, "");
    return { slug, path: u.pathname, serviceName: it.serviceName || "(null)" };
  });
}

async function loadExample(slug) {
  // /api/find returns examples per slug; query by slug to get an exact match.
  const r = await fetch(`${TARGET}/api/find?q=${encodeURIComponent(slug)}`);
  if (!r.ok) return null;
  const j = await r.json();
  const hit = (j.results || []).find((x) => x.slug === slug);
  if (!hit) return null;
  return {
    method: hit.route.split(" ")[0],
    path: hit.route.split(" ")[1],
    example: hit.example || {},
    price: hit.price,
  };
}

// Missing-mode helpers ----------------------------------------------------

async function loadCatalog() {
  const r = await fetch(`${TARGET}/api/pricing`);
  if (!r.ok) throw new Error(`/api/pricing HTTP ${r.status}`);
  const j = await r.json();
  const tools = j.tools || j.endpoints || [];
  return tools.map((t) => ({
    slug: t.slug,
    method: (t.method || "GET").toUpperCase(),
    path: t.path,
    price: t.price,
    priceUsd: priceToUsd(t.price),
    // The server's own PoW-eligibility flag. A tool is compute-payable only
    // when it makes NO external call - scripts/test-free-tier-egress.js drives
    // every one of them under an egress-recording preload and requires zero
    // attributed egress, refusing to report a clean run unless a planted
    // control proves the probe can still see a leak. So this is a MEASURED
    // "costs nothing upstream", not a hand-kept list that drifts.
    computePayable: t.computePayable === true,
  }));
}

async function loadRegisteredPaths() {
  const reg = new Set();
  const { matches } = await pageBazaar((it) => (it.resource || "").includes(HOST));
  for (const it of matches) {
    try { reg.add(new URL(it.resource).pathname); } catch {}
  }
  return reg;
}

// path -> ms since CDP last observed a settlement for it. A path absent here is
// not listed at all, which is always worth a settlement.
async function loadFreshness() {
  const fresh = new Map();
  const { matches } = await pageBazaar((it) => (it.resource || "").includes(HOST));
  for (const it of matches) {
    const at = it.quality?.lastCalledAt;
    if (!at) continue;
    const t = Date.parse(at);
    if (Number.isFinite(t)) {
      try { fresh.set(new URL(it.resource).pathname, Date.now() - t); } catch {}
    }
  }
  return fresh;
}

async function loadOpenapiExamples() {
  // Returns Map(`${METHOD} ${path}` → exampleInput object).
  const r = await fetch(`${TARGET}/openapi.json`);
  if (!r.ok) throw new Error(`/openapi.json HTTP ${r.status}`);
  const spec = await r.json();
  const out = new Map();
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    for (const [m, op] of Object.entries(methods)) {
      const key = `${m.toUpperCase()} ${p}`;
      const body = op.requestBody?.content?.["application/json"]?.example;
      if (body && typeof body === "object") {
        out.set(key, body);
        continue;
      }
      const params = (op.parameters || []).filter((x) => x.example !== undefined);
      if (params.length) {
        const obj = {};
        for (const x of params) obj[x.name] = x.example;
        out.set(key, obj);
        continue;
      }
      out.set(key, {}); // no example — try an empty payload
    }
  }
  return out;
}

async function runMissingMode({ sweep = false } = {}) {
  const [catalog, registered, examples, freshness] = await Promise.all([
    loadCatalog(),
    sweep ? Promise.resolve(new Set()) : loadRegisteredPaths(),
    loadOpenapiExamples(),
    STALE_DAYS > 0 ? loadFreshness() : Promise.resolve(new Map()),
  ]);
  // A path we have never listed has no freshness reading, and that is exactly
  // the case that needs a settlement - so an unknown path is treated as stale,
  // never as fresh. Same rule as the rest of this repo: a missing measurement
  // is not a passing one.
  const isStale = (t) => {
    if (!(STALE_DAYS > 0)) return true;
    const age = freshness.get(t.path);
    return age === undefined || age >= STALE_DAYS * 86400000;
  };
  // sweep = pay EVERY affordable route once (settlement-driven registration on
  // the PAY_NETWORK chain + re-observe of the multi-chain accepts), cheapest
  // first so a timeout loses the least coverage. missing = only routes the
  // Bazaar has never seen, expensive first so skill packs register before a
  // timeout.
  const missing = catalog
    .filter((t) => sweep || !registered.has(t.path))
    .filter((t) => !SLUGS_FILTER || SLUGS_FILTER.has(t.slug))
    .filter((t) => t.priceUsd <= MAX_PRICE_USD)
    .filter((t) => !UPSTREAM_FREE_ONLY || costsNothingUpstream(t))
    .filter((t) => !SKIP_UPSTREAM_FREE || !costsNothingUpstream(t))
    .filter((t) => t.priceUsd > MIN_PRICE_USD)
    .filter((t) => !SLUG_PREFIX || t.slug.startsWith(SLUG_PREFIX))
    .filter((t) => isStale(t))
    .sort((a, b) => (sweep ? a.priceUsd - b.priceUsd : b.priceUsd - a.priceUsd))
    // Batch stride (applied after sort so each batch is a price-balanced slice).
    .filter((_, i) => i % BATCH_COUNT === BATCH_INDEX);
  const batchNote = BATCH_COUNT > 1 ? ` · batch ${BATCH_INDEX + 1}/${BATCH_COUNT}` : "";
  console.log(
    sweep
      ? `Catalog: ${catalog.length} · sweeping ${missing.length} routes priced ≤ $${MAX_PRICE_USD} via ${PAY_NETWORK}${batchNote}`
      : `Catalog: ${catalog.length} · already on Bazaar: ${registered.size} · missing: ${missing.length}${batchNote}`
  );
  if (!missing.length) {
    console.log("Nothing to register.");
    return 0;
  }

  const estCost = missing.reduce((s, t) => s + t.priceUsd, 0);
  console.log(`Estimated total cost to ${sweep ? "sweep" : "register"} all routes: $${estCost.toFixed(3)}`);
  if (estCost > MAX_SPEND_USD) {
    console.error(`Estimate exceeds MAX_SPEND_USD=$${MAX_SPEND_USD}. Refusing to run. Raise MAX_SPEND_USD or filter the set.`);
    return 2;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — listing the work without paying:");
    for (const t of missing.slice(0, 20)) console.log(`  ${t.method} ${t.path} (${t.price})`);
    if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);
    return 0;
  }

  const payFetch = await buildPayFetch();
  console.log(`Spending up to $${estCost.toFixed(3)} …`);

  // `bought` records the paths whose settlement we actually observed, so the
  // post-check below can tell "the harvester hasn't ingested it yet" apart from
  // "this route never got paid for".
  const results = { ok: 0, fail: 0, errors: [], bought: new Set() };
  for (let i = 0; i < missing.length; i++) {
    const t = missing[i];
    const key = `${t.method} ${t.path}`;
    const example = examples.get(key) || {};
    const isGet = t.method === "GET";
    const url = isGet
      ? `${TARGET}${t.path}${Object.keys(example).length ? "?" + new URLSearchParams(example).toString() : ""}`
      : `${TARGET}${t.path}`;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await payFetch(url, {
          method: t.method,
          headers: isGet ? {} : { "Content-Type": "application/json" },
          body: isGet ? undefined : JSON.stringify(example),
        });
        lastStatus = res.status;
        if (res.status === 200) {
          results.ok++;
          results.bought.add(t.path);
          if (i % 50 === 0 || i === missing.length - 1) console.log(`  [${i + 1}/${missing.length}] OK ${key} (${t.price})`);
          break;
        }
        // 402 = facilitator hiccup (settlement timeout); retry after a pause.
        // 502/503/504 = upstream flap; also worth retrying.
        if ((res.status === 402 || res.status >= 502) && attempt < 2) {
          console.warn(`  RETRY ${key} → HTTP ${res.status} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const body = await res.text().catch(() => "");
        console.warn(`  FAIL ${key} → HTTP ${res.status} ${body.slice(0, 120)}`);
        results.fail++;
        results.errors.push(`${t.path}: HTTP ${res.status}`);
        break;
      } catch (e) {
        if (attempt < 2) {
          console.warn(`  RETRY ${key} → ${(e.message || "").slice(0, 80)} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
        console.warn(`  FAIL ${key} → ${msg}`);
        results.fail++;
        results.errors.push(`${t.path}: ${msg}`);
        break;
      }
    }
  }
  console.log(`\n${sweep ? "Sweep" : "Registration"} pass complete: ${results.ok} ok, ${results.fail} failed.`);

  if (sweep) {
    // Settlement-driven indexes (PayAI, x402scan) have no public recount
    // endpoint — success = the settlements happened. Fail only on a wipeout.
    return results.ok > 0 || results.fail === 0 ? 0 : 1;
  }

  // Bazaar harvester is not instant. Give it ~60s then re-verify.
  console.log("Waiting 60s for the Bazaar harvester to catch up …");
  await new Promise((r) => setTimeout(r, 60000));
  const afterReg = await loadRegisteredPaths();
  const stillMissing = catalog.filter((t) => !afterReg.has(t.path));
  console.log(`After: ${afterReg.size} registered, ${stillMissing.length} still missing (harvester may continue to catch up).`);
  if (stillMissing.length === 0) return 0;

  const verdict = missingModeVerdict({
    failCount: results.fail,
    okCount: results.ok,
    stillMissingPaths: stillMissing.map((t) => t.path),
    boughtPaths: results.bought,
  });
  console[verdict.exitCode === 0 ? "log" : "error"](verdict.message);
  return verdict.exitCode;
}

/** Decide whether a `missing` pass actually left work undone.
 *
 *  Coinbase's harvester is asynchronous: it lists a route only after it
 *  observes the settlement, which routinely takes far longer than the 60s we
 *  wait. A 74-route pass on 2026-07-24 reported all 74 "still missing" here and
 *  every one of them listed within ~2.5h, unattended. Exiting non-zero in that
 *  case put a red X on a run where every single buy succeeded, which is exactly
 *  the kind of lying check that teaches people to ignore red.
 *
 *  So the verdict keys off work that is still OURS: a buy that failed, or a
 *  route we never paid for (spend cap, price cap, batch stride). If every route
 *  still unlisted is one we just watched settle, the pass did its job and the
 *  remainder is ingestion lag on their side.
 *
 *  Pure, so scripts/test-bazaar-verdict.js can pin it without paying anyone. */
export function missingModeVerdict({ failCount, okCount, stillMissingPaths, boughtPaths }) {
  const bought = boughtPaths instanceof Set ? boughtPaths : new Set(boughtPaths || []);
  const missing = stillMissingPaths || [];
  if (missing.length === 0) return { exitCode: 0, message: "All routes are listed on the Bazaar." };
  const unpaid = missing.filter((p) => !bought.has(p));
  if (failCount === 0 && unpaid.length === 0) {
    return {
      exitCode: 0,
      message:
        `All ${okCount} route(s) settled successfully; the ${missing.length} not yet listed are waiting on Coinbase's ` +
        `harvester, which is asynchronous and outside our control. Treating as success — re-count in a few hours to confirm ingestion.`,
    };
  }
  // A route left unpaid by our OWN caps is the caps working, not a failure.
  // This exited 1 whenever anything was left over, and something is always left
  // over - the spend cap, the price cap and the batch stride all exist to leave
  // routes for a later pass. Measured 2026-08-31: 4 of the last 7 red "Deploy to
  // Railway" runs were this job reporting "5 ok, 0 failed" and then exiting 1,
  // which trains everyone to ignore the deploy failure mail - and that mail is
  // how a REAL failure gets noticed.
  //
  // A failed BUY still fails the job; leftovers only report.
  if (failCount === 0) {
    return {
      exitCode: 0,
      message:
        `${okCount} route(s) settled successfully. ${unpaid.length} route(s) were left for a later pass by our own ` +
        `spend cap, price cap or batch stride - the caps doing their job, not a failure. The keep-alive sweeps ` +
        `whatever is still unlisted on its own schedule.`,
    };
  }
  return {
    exitCode: 1,
    message: `${failCount} buy(s) FAILED (plus ${unpaid.length} route(s) left unpaid by the caps, which is expected).`,
  };
}

// One pay-capable fetch for whichever chain PAY_NETWORK selects.
async function buildPayFetch() {
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const client = new x402Client();
  if (PAY_NETWORK === "solana") {
    const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
    if (!raw) {
      console.error("refresh-bazaar: PAY_NETWORK=solana requires SOLANA_BURNER_KEY (base58 64-byte secret or JSON byte array)");
      process.exit(2);
    }
    const kit = await import("@solana/kit");
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
    const signer = await kit.createKeyPairSignerFromBytes(bytes);
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
    registerExactSvmScheme(client, { signer });
    console.log(`Paying via Solana from ${signer.address} …`);
  } else {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const account = privateKeyToAccount(loadKey());
    registerExactEvmScheme(client, { signer: account });
    console.log(`Paying via Base from ${account.address} …`);
  }
  return wrapFetchWithPayment(fetch, client);
}

function loadKey() {
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) {
    console.error("refresh-bazaar: no BURNER_KEY / KEY_FILE — set one to run paid refresh");
    process.exit(2);
  }
  return pk;
}

async function main() {
  if (MODE === "missing") {
    process.exit(await runMissingMode());
  }
  if (MODE === "sweep") {
    process.exit(await runMissingMode({ sweep: true }));
  }
  if (MODE !== "stale") {
    console.error(`Unknown MODE="${MODE}". Use "stale", "missing", or "sweep".`);
    process.exit(2);
  }
  const stale = await loadStaleRoutes();
  if (!stale.length) {
    console.log(`No stale Agent402 Bazaar listings — all serviceNames already "${EXPECT_NAME}". Nothing to do.`);
    process.exit(0);
  }
  console.log(`Will refresh ${stale.length} routes:`);
  stale.forEach((s) => console.log(`  ${s.path} (currently "${s.serviceName}")`));

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — skipping paid requests.");
    process.exit(0);
  }

  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");

  const account = privateKeyToAccount(loadKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payFetch = wrapFetchWithPayment(fetch, client);

  console.log(`Paying from ${account.address} …`);
  const results = { ok: 0, fail: 0, skipped: 0, errors: [] };
  for (const route of stale) {
    const meta = await loadExample(route.slug);
    if (!meta) {
      console.warn(`  SKIP ${route.path} — no example in /api/find for slug "${route.slug}"`);
      results.skipped++;
      continue;
    }
    const method = meta.method;
    const isGet = method === "GET";
    const url = isGet
      ? `${TARGET}${meta.path}?${new URLSearchParams(meta.example).toString()}`
      : `${TARGET}${meta.path}`;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await payFetch(url, {
          method,
          headers: isGet ? {} : { "Content-Type": "application/json" },
          body: isGet ? undefined : JSON.stringify(meta.example),
        });
        lastStatus = res.status;
        if (res.status === 200) {
          console.log(`  OK   ${method} ${meta.path} (${meta.price})`);
          results.ok++;
          break;
        }
        if ((res.status === 402 || res.status >= 502) && attempt < 2) {
          console.warn(`  RETRY ${method} ${meta.path} → HTTP ${res.status} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const body = await res.text().catch(() => "");
        console.warn(`  FAIL ${method} ${meta.path} → HTTP ${res.status} ${body.slice(0, 120)}`);
        results.fail++;
        results.errors.push(`${meta.path}: HTTP ${res.status}`);
        break;
      } catch (e) {
        if (attempt < 2) {
          console.warn(`  RETRY ${method} ${meta.path} → ${(e.message || "").slice(0, 80)} (attempt ${attempt + 1}/3, waiting 5s)`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const msg = (e && e.message ? e.message : String(e)).slice(0, 160);
        console.warn(`  FAIL ${method} ${meta.path} → ${msg}`);
        results.fail++;
        results.errors.push(`${meta.path}: ${msg}`);
        break;
      }
    }
  }
  console.log(`\nPaid refresh complete: ${results.ok} ok, ${results.fail} failed, ${results.skipped} skipped`);

  // Bazaar harvester is not instant; give it a moment, then re-verify.
  console.log("Waiting 30s for the Bazaar harvester to catch up …");
  await new Promise((r) => setTimeout(r, 30000));
  const after = await loadStaleRoutes();
  if (!after.length) {
    console.log(`All Agent402 listings now show serviceName="${EXPECT_NAME}". Done.`);
    process.exit(0);
  }
  console.log(`Still stale: ${after.length} routes. They may catch up over the next few minutes; re-run to verify.`);
  after.forEach((s) => console.log(`  ${s.path} (still "${s.serviceName}")`));
  process.exit(1);
}

// Same main-guard convention as deploy-quiet-gate.js / sync-count.js, so
// scripts/test-bazaar-verdict.js can import missingModeVerdict without the
// script running (and paying for) anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("refresh-bazaar: unhandled error", e);
    process.exit(1);
  });
}
