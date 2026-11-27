// Resale clearance (src/resale-terms.js): a tool is sold through a third
// party's marketplace (the /ref copies, src/referral-gate.js, and the AWS
// Marketplace front door, src/aws-marketplace-gate.js) only when its
// definition declares its upstream terms cleared for that, beside its
// handler (markResaleCleared), or it reaches no upstream at all. Anything
// else is refused at boot with the reason, so a new tool, or one whose
// source's terms are not cleared (raw model access, search results, a
// source that bars sharing its data), cannot be listed by a setting alone.
//
//   - every tool in the cleared list below carries the mark, and each mark
//     names its source;
//   - representative uncleared tools carry none and are refused by both
//     gates' boot checks with the reason; a pure-CPU tool passes unmarked;
//   - a raw pass-through of a source that bars resale keeps its own reason;
//   - the test seam that clears a slug for a suite is off in production.
//
//   node scripts/test-resale-clearance.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const R = await import("../src/resale-terms.js");
const { referralIneligibility } = await import("../src/referral-gate.js");
const { awsIneligibility } = await import("../src/aws-marketplace-gate.js");

// The kits that hold the cleared tools, and a few that hold uncleared ones.
const kits = await Promise.all([
  "weather-kit.js", "weather-plan-kit.js", "weather-probability-kit.js", "bundle-kit.js", "data-kit.js", "gov-kit.js",
  "holidays-kit.js", "crypto-screens-kit.js", "crypto-kit.js", "macro-kit.js", "edgar-kit.js", "network-kit.js", "kit.js",
  "sql-guard-kit.js", "sanctions-kit.js", "kit2.js", "email-guard-kit.js",
  "cdp-kit.js", "x-data-kit.js", "derivatives-kit.js", "enrich-kit.js", "chain-kit.js", "search.js", "crypto-markets-kit.js", "alchemy-data-kit.js",
].map((f) => import(`../src/tools/${f}`)));
const defs = new Map();
for (const mod of kits) for (const v of Object.values(mod)) if (Array.isArray(v)) for (const d of v) if (d && typeof d === "object" && typeof d.slug === "string" && typeof d.handler === "function" && !defs.has(d.slug)) defs.set(d.slug, d);

// The tools whose upstream terms were read and cleared for resale through a
// third party (government data, licensed or sponsored commercial use, our
// own computation over a source that allows it).
const CLEARED = [
  "weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "place-lookup",
  "weather-window", "weather-thresholds", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-risk-brief",
  "weather-forecast", "weather-alerts",
  "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar",
  "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health", "token-diligence", "stablecoin-peg",
  // Look-back statistics computed from the market source's series (cleared; on no third party's list).
  "crypto-history", "coin-history", "coin-ohlc", "coin-market-chart-range",
  "fx-rate", "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "treasury-debt", "treasury-avg-rates",
  "edgar-13f-dataset-head", "edgar-13f-datasets", "edgar-13f-holdings", "edgar-company-concept", "edgar-company-facts", "edgar-company-lookup", "edgar-filings", "edgar-recent-ipos", "edgar-search", "edgar-xbrl-frame", "edgar-insider-trades", "filings-brief",
  "drug-adverse-events", "drug-label", "drug-ndc", "drug-recalls", "device-510k", "device-adverse-events", "device-recalls", "food-recalls",
  "vin-decode", "vehicle-recalls", "earthquakes", "fema-disasters", "fec-candidates", "federal-awards", "geo-lookup",
  "dns", "ip-info", "tls-cert", "sql-guard", "sanctions-name", "sanctions-wallet",
  "perp-basis", "perp-dex-limits", "perp-dex-markets", "perp-dexs", "perp-funding", "perp-funding-screener", "perp-klines", "perp-markets", "perp-open-interest", "perp-orderbook",
];
const missing = CLEARED.filter((s) => !defs.has(s));
ok(missing.length === 0, `every cleared slug is a tool in the kits read here (${missing.join(",") || CLEARED.length})`);
const unmarked = CLEARED.filter((s) => defs.get(s)?.resaleCleared !== true);
ok(unmarked.length === 0, `every cleared tool carries the clearance mark (${unmarked.join(",") || "all marked"})`);
const unsourced = CLEARED.filter((s) => !(typeof defs.get(s)?.resaleClearedBy === "string" && defs.get(s).resaleClearedBy.trim().length >= 3));
ok(unsourced.length === 0, `each mark names the source it was cleared for (${unsourced.join(",") || "all named"})`);
ok(CLEARED.every((s) => R.resaleClearanceRefusal(defs.get(s)) === null), "a marked tool has no clearance refusal");

// Not cleared: model and search pass-throughs, a source that bars sharing its
// data, the registry record copy, a repository read, a raw relay.
const UNCLEARED = ["onchain-sql", "onchain-sql-schema", "x-search-recent", "web-search", "whois", "github-repo", "evm-rpc"];
const present = UNCLEARED.filter((s) => defs.has(s));
ok(present.length >= 6, `the uncleared controls are in the kits read here (${present.join(",")})`);
ok(present.every((s) => defs.get(s).resaleCleared !== true), `none of them carries the mark (${present.filter((s) => defs.get(s).resaleCleared === true).join(",") || "none"})`);
const NOT_CLEARED = R.RESALE_NOT_CLEARED_REASON;
ok(typeof NOT_CLEARED === "string" && /not cleared/.test(NOT_CLEARED) && !/https?:|terms of [A-Z]/.test(NOT_CLEARED), `the refusal reason is one neutral sentence (${NOT_CLEARED})`);
ok(present.every((s) => R.resaleClearanceRefusal(defs.get(s)) === NOT_CLEARED), "each uncleared tool is refused with that reason");

// The two gates' boot checks.
{
  const refGot = present.map((s) => [s, referralIneligibility(defs.get(s), { clamped: true, priceForNetwork: (p) => p })]);
  ok(refGot.every(([, why]) => why === NOT_CLEARED), `/ref: each uncleared tool is refused at boot with the reason (${refGot.map(([s, w]) => `${s}: ${w}`).filter(([, w]) => w !== NOT_CLEARED).join("; ") || present.length})`);
  const awsGot = present.map((s) => [s, awsIneligibility(defs.get(s), {})]);
  ok(awsGot.every(([, why]) => why === NOT_CLEARED), `/aws: each uncleared tool is refused at boot with the reason (${awsGot.map(([s, w]) => `${s}: ${w}`).filter(([, w]) => w !== NOT_CLEARED).join("; ") || present.length})`);
  const edgar = defs.get("edgar-company-facts");
  ok(referralIneligibility(edgar, { clamped: true, priceForNetwork: (p) => p }) === null && awsIneligibility(edgar, {}) === null, "CONTROL: a cleared tool passes both boot checks");
  // A pure-CPU tool reaches no upstream: nothing to clear.
  const redact = defs.get("redact");
  ok(redact && redact.resaleCleared !== true && awsIneligibility(redact, { compute: true }) === null && awsIneligibility(redact, {}) === NOT_CLEARED, "a tool that reaches no upstream passes unmarked (the server's compute reading), and the same definition read as reaching one is refused");
  ok(referralIneligibility(redact, { compute: true, priceForNetwork: (p) => p }) === null, "...on /ref too");
  // A resale-barred raw pass-through keeps its own reason, ahead of clearance.
  const barred = defs.get("crypto-price");
  ok(barred && referralIneligibility(barred, { clamped: true, priceForNetwork: (p) => p }) === R.MARKET_DATA_RESALE_REASON && awsIneligibility(barred, {}) === R.MARKET_DATA_RESALE_REASON, "a raw pass-through of a source that bars resale keeps its own reason on both gates");
  // Marking a barred tool cleared is refused when the kit loads.
  let threw = false;
  try { R.markResaleCleared([{ slug: "z", resale: R.RESALE_BARRED, resaleReason: "x" }], ["z"], "a source"); } catch { threw = true; }
  ok(threw, "a tool marked barred cannot also be marked cleared");
  threw = false;
  try { R.markResaleCleared([{ slug: "z" }], ["z"], ""); } catch { threw = true; }
  ok(threw, "a clearance mark must name its source");
}

// Everything sold through a third party today is cleared, so no listed slug is
// refused at boot: the /ref list (73 slugs) and the AWS listing (74, read
// from src/aws-listing.js where the build has it).
{
  const PERPS = ["perp-basis", "perp-dex-limits", "perp-dex-markets", "perp-dexs", "perp-funding", "perp-funding-screener", "perp-klines", "perp-markets", "perp-open-interest", "perp-orderbook"];
  const REF_LISTED = [
    "weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "place-lookup", "weather-window", "weather-thresholds", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-risk-brief",
    "weather-forecast", "weather-alerts", "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar",
    "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health", "token-diligence", "stablecoin-peg",
    "fx-rate", "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "treasury-debt", "treasury-avg-rates",
    "edgar-13f-dataset-head", "edgar-13f-datasets", "edgar-13f-holdings", "edgar-company-concept", "edgar-company-facts", "edgar-company-lookup", "edgar-filings", "edgar-recent-ipos", "edgar-search", "edgar-xbrl-frame", "edgar-insider-trades",
    "drug-adverse-events", "drug-label", "drug-ndc", "drug-recalls", "device-510k", "device-adverse-events", "device-recalls", "food-recalls",
    "vin-decode", "vehicle-recalls", "earthquakes", "fema-disasters", "fec-candidates", "federal-awards", "geo-lookup", "dns", "ip-info", "tls-cert", ...PERPS,
  ];
  let awsListed = null;
  try { awsListed = (await import("../src/aws-listing.js")).AWS_LISTING_SLUGS; } catch { awsListed = null; }
  const AWS_LISTED = Array.isArray(awsListed) ? [...awsListed] : [
    "redact", "sql-guard", "email-guard", "sanctions-name", "sanctions-wallet",
    "edgar-13f-dataset-head", "edgar-13f-datasets", "edgar-13f-holdings", "edgar-company-concept", "edgar-company-facts", "edgar-company-lookup", "edgar-filings", "edgar-recent-ipos", "edgar-search", "edgar-xbrl-frame",
    "treasury-avg-rates", "treasury-debt", "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread", "fx-rate",
    "device-510k", "device-adverse-events", "device-recalls", "drug-adverse-events", "drug-label", "drug-ndc", "drug-recalls", "food-recalls",
    "earthquakes", "federal-awards", "fema-disasters", "geo-lookup", "vehicle-recalls", "vin-decode",
    "weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality", "place-lookup", "weather-window", "weather-thresholds", "weather-probability", "weather-market-brackets", "weather-market-board", "weather-forecast", "weather-alerts",
    "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "dns", "tls-cert", "ip-info",
    "stablecoin-peg", "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health", ...PERPS,
  ];
  ok(new Set(REF_LISTED).size === REF_LISTED.length && AWS_LISTED.length > 0, `the lists read are the ones sold today (/ref ${new Set(REF_LISTED).size}, AWS ${AWS_LISTED.length})`);
  // The server's compute reading, for the pure-CPU tools on the AWS list.
  const { isComputePayable } = await import("../src/pow.js");
  const computeOf = (d) => { try { return typeof isComputePayable === "function" ? isComputePayable(d) === true : false; } catch { return false; } };
  const refusedOf = (list) => list.filter((s) => !defs.has(s) || R.resaleClearanceRefusal(defs.get(s), { compute: computeOf(defs.get(s)) }) !== null);
  ok(refusedOf(REF_LISTED).length === 0, `every slug on the /ref list is cleared (${refusedOf(REF_LISTED).join(",") || "73 of 73"})`);
  ok(refusedOf(AWS_LISTED).length === 0, `every slug on the AWS listing is cleared or reaches no upstream (${refusedOf(AWS_LISTED).join(",") || `${AWS_LISTED.length} of ${AWS_LISTED.length}`})`);
  ok(["whois", "github-repo", "onchain-sql-schema"].every((s) => !REF_LISTED.includes(s) && !AWS_LISTED.includes(s) && defs.get(s)?.resaleCleared !== true), "whois, github-repo and onchain-sql-schema are on neither list and stay uncleared");
}

// CLASS GUARD, source figures in a computed answer (owner rule for the market
// source: a tool built on it is listed and sold only when its answer is our
// own computation). Every tool that reads the market source (attribution
// "coingecko") and is marked computed or cleared over market data has its
// PUBLIC published example read, at any depth, for a field on the shared
// raw-field denylist (R.RAW_MARKET_FIELDS); none may carry one, and none needs
// a resale trim (markRefAnswer) to be clean. The kits' suites drive the
// handlers themselves through the same list. A tool that computes its answer
// from a historical series (R.COMPUTED_SERIES_SLUGS) is read for the series
// field names too (R.RAW_SOURCE_FIELDS: bars, points, a window's first, last,
// high and low), whatever its source.
{
  const CLASS = "[source figure in a computed answer]";
  const keysAt = (v, path = "", acc = []) => { if (Array.isArray(v)) v.forEach((x) => keysAt(x, `${path}[]`, acc)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const at = path ? `${path}.${k}` : k; acc.push([k, at]); keysAt(x, at, acc); } return acc; };
  const deny = new Set(R.RAW_MARKET_FIELDS);
  const computedCg = [...defs.values()].filter((d) => d.attribution === "coingecko" && (d.resale === R.RESALE_COMPUTED || d.resaleClearedBy === R.MARKET_DATA_CLEARANCE));
  const NINE = ["funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health", "token-diligence", "stablecoin-peg"];
  ok(NINE.every((s) => computedCg.some((d) => d.slug === s)), `${CLASS} the guard reads every computed market-source tool (${computedCg.length}: ${NINE.filter((s) => !computedCg.some((d) => d.slug === s)).join(",") || "all nine"})`);
  for (const d of computedCg) {
    const pub = d.discovery?.output?.example;
    ok(pub && typeof pub === "object" && Object.keys(pub).length > 3, `${CLASS} ${d.slug}: has a published example to read`);
    const hits = keysAt(pub).filter(([k]) => deny.has(k)).map(([, p]) => p);
    ok(hits.length === 0, `${CLASS} ${d.slug}: the public example carries no source figure (${hits.join(", ") || "none"}${hits.length ? "; answer a share, ratio, deviation, percentile, rank, band or score instead" : ""})`);
    ok(typeof d.refAnswer !== "function", `${CLASS} ${d.slug}: no resale trim is needed (the public answer is the resold one)`);
  }
  // The look-back tools: marked computed, and no series field in the example.
  const denySeries = new Set(R.RAW_SOURCE_FIELDS);
  ok(R.COMPUTED_SERIES_SLUGS.every((s) => Object.hasOwn(R.WITHDRAWN_SOURCE_FIELDS, s)) && R.RAW_MARKET_FIELDS.every((k) => denySeries.has(k)) && ["bars", "points", "first", "last", "high", "low"].every((k) => denySeries.has(k) && !deny.has(k)), `${CLASS} the series denylist holds the market one and the series field names`);
  for (const slug of R.COMPUTED_SERIES_SLUGS) {
    const d = defs.get(slug);
    const pub = d?.discovery?.output?.example;
    ok(d?.resale === R.RESALE_COMPUTED && pub && Object.keys(pub).length > 3, `${CLASS} ${slug}: marked computed, with a published example to read`);
    const hits = keysAt(pub).filter(([k]) => denySeries.has(k)).map(([, p]) => p);
    ok(hits.length === 0, `${CLASS} ${slug}: the public example carries no source figure or series field (${hits.join(", ") || "none"})`);
    ok(typeof d?.refAnswer !== "function" && Object.hasOwn(R.WITHDRAWN_SOURCE_FIELDS, slug), `${CLASS} ${slug}: needs no resale trim and names the fields it withdrew`);
  }
  ok(defs.get("token-price-history")?.resaleCleared !== true && R.resaleClearanceRefusal(defs.get("token-price-history")) === NOT_CLEARED, `${CLASS} token-price-history is computed and carries no clearance for resale through a third party`);
  // Every withdrawn top-level field is a denylisted one and is gone from the example.
  for (const [slug, fields] of Object.entries(R.WITHDRAWN_SOURCE_FIELDS)) {
    ok(fields.every((k) => denySeries.has(k)) && fields.every((k) => !(k in (defs.get(slug)?.discovery?.output?.example || {}))), `${CLASS} ${slug}: each withdrawn field (${fields.join(", ")}) is on the denylist and out of the example`);
  }
  // CONTROLS: the guard reads something. A source figure planted deep in a
  // copy of one example is found at its path; the barred raw pass-through
  // carries listed fields and is outside the computed set.
  const planted = structuredClone(defs.get("exchange-spread").discovery.output.example);
  planted.venues[0].liquidityUsd = 1;
  ok(keysAt(planted).some(([k, p]) => deny.has(k) && p === "venues[].liquidityUsd"), "CONTROL: a planted source figure is found at its path");
  ok(!computedCg.some((d) => d.slug === "crypto-price") && keysAt(defs.get("crypto-price")?.discovery?.output?.example).some(([k]) => deny.has(k)), "CONTROL: the barred raw pass-through carries listed fields and is outside the computed set");
}

// CLASS GUARD, raw upstream figures sold on a resale surface: every tool
// cleared as computed over market data (R.MARKET_DATA_CLEARANCE) has its
// published example driven through the one resale serializer both gates
// serve (refAnswerOf: /ref and /aws), and the resold answer may carry no field
// on the shared list (R.RAW_MARKET_FIELDS) at any depth, nor any field the
// tool's own trim names (markRefAnswer rawFields). Each named field must be in
// the public example (else the check reads nothing) and gone after the trim.
{
  const CLASS = "[raw upstream on a resale surface]";
  const FIX = "drop it in the tool's markRefAnswer transform and name it in its rawFields (src/resale-terms.js)";
  const keysAnywhere = (v, acc = new Set()) => { if (Array.isArray(v)) for (const x of v) keysAnywhere(x, acc); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysAnywhere(x, acc); } return acc; };
  const market = [...defs.values()].filter((d) => d.resaleCleared === true && d.resaleClearedBy === R.MARKET_DATA_CLEARANCE);
  const expected = CLEARED.filter((s) => /market data/.test(String(defs.get(s)?.resaleClearedBy || "")));
  ok(market.length >= 9 && expected.every((s) => market.some((d) => d.slug === s)), `${CLASS} every tool cleared over market data reads the shared clearance constant (${market.length}: ${expected.filter((s) => !market.some((d) => d.slug === s)).join(",") || "all"})`);
  ok(R.RAW_MARKET_FIELDS.length >= 10 && R.RAW_MARKET_FIELDS.includes("price") && R.RAW_MARKET_FIELDS.includes("marketCap"), "the shared raw-field list names the source's own figures");
  for (const d of market) {
    const pub = d.discovery?.output?.example;
    ok(pub && typeof pub === "object", `${CLASS} ${d.slug}: has a published example to drive through the resale serializer`);
    if (!pub || typeof pub !== "object") continue;
    const before = JSON.stringify(pub);
    let resold;
    try { resold = R.refAnswerOf(d, structuredClone(pub)); } catch (e) { resold = undefined; ok(false, `${CLASS} ${d.slug}: the resale trim threw (${e?.message})`); continue; }
    const leaked = R.RAW_MARKET_FIELDS.filter((k) => keysAnywhere(resold).has(k));
    ok(leaked.length === 0, `${CLASS} ${d.slug}: the resold example carries no shared raw field (${leaked.join(",") || "none"}${leaked.length ? `; ${FIX}` : ""})`);
    if (typeof d.refAnswer === "function") {
      const paths = Array.isArray(d.refRawFields) ? d.refRawFields : [];
      ok(paths.length > 0, `${CLASS} ${d.slug}: its trim names the raw fields it drops (${FIX})`);
      const absentInPublic = paths.filter((p) => R.valuesAtPath(pub, p).length === 0);
      ok(absentInPublic.length === 0, `${CLASS} ${d.slug}: CONTROL, each named raw field is in the public example, so the check reads something (${absentInPublic.join(",") || paths.length})`);
      const kept = paths.filter((p) => R.valuesAtPath(resold, p).length > 0);
      ok(kept.length === 0, `${CLASS} ${d.slug}: each named raw field is gone from the resold answer (${kept.join(",") || "all dropped"}${kept.length ? `; ${FIX}` : ""})`);
    }
    ok(JSON.stringify(pub) === before, `${d.slug}: the trim leaves the public answer untouched`);
  }
  // Both resale gates serve through the one serializer.
  const { readFileSync } = await import("node:fs");
  for (const f of ["referral-gate.js", "aws-marketplace-gate.js"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    ok(/refAnswerOf\(def, result\)/.test(src), `${CLASS} src/${f} serves a sale's answer through refAnswerOf`);
  }
  // A trim must name what it drops.
  let threw = false;
  try { R.markRefAnswer([{ slug: "z" }], ["z"], (a) => a); } catch { threw = true; }
  ok(threw, "a resale trim that names no raw fields is refused when the kit loads");
}

// CLASS GUARD, facts compiled from outside sources: reaching no upstream
// clears a tool for resale only when none of its facts come from an outside
// source. Every proof-of-work tool's own example is run here, and one whose
// answer names an outside source (a URL under a source, credit, license or
// citation key, off this host) must declare its sources (markContentSources),
// which takes it out of the compute clearance unless it is marked cleared.
{
  const CLASS = "[outside facts cleared as compute]";
  const { readdirSync } = await import("node:fs");
  const { isComputePayable } = await import("../src/pow.js");
  const all = new Map(defs);
  for (const f of readdirSync(new URL("../src/tools/", import.meta.url)).filter((x) => x.endsWith(".js") && !/-worker\.js$/.test(x))) {
    let mod;
    try { mod = await import(`../src/tools/${f}`); } catch { continue; }
    for (const v of Object.values(mod)) if (Array.isArray(v)) for (const d of v) if (d && typeof d === "object" && typeof d.slug === "string" && typeof d.handler === "function" && !all.has(d.slug)) all.set(d.slug, d);
  }
  const KEY = /source|credit|licen|citation/i;
  const urlsIn = (v, acc = [], key = "") => {
    if (typeof v === "string") { if (KEY.test(key) && /^https?:\/\//.test(v)) acc.push(v); }
    else if (Array.isArray(v)) for (const x of v) urlsIn(x, acc, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) urlsIn(x, acc, KEY.test(k) ? k : key);
    return acc;
  };
  const compute = [...all.values()].filter((d) => { try { return isComputePayable(d) === true; } catch { return false; } });
  ok(compute.length >= 100, `the proof-of-work tools are read (${compute.length})`);
  const undeclared = [];
  let named = 0;
  for (const d of compute) {
    let out;
    try { out = await Promise.race([Promise.resolve(d.handler(structuredClone(d.discovery?.input ?? {}), { headers: {} })), new Promise((r) => setTimeout(() => r(null), 3000))]); } catch { continue; }
    const urls = urlsIn(out).filter((u) => !/agent402\.tools/.test(u));
    if (!urls.length) continue;
    named++;
    if (!R.hasContentSources(d)) undeclared.push(`${d.slug} (${urls[0]})`);
  }
  ok(named >= 1, `CONTROL: at least one proof-of-work tool names an outside source in its answer (${named})`);
  ok(undeclared.length === 0, `${CLASS} every proof-of-work tool whose answer names an outside source declares it (${undeclared.join("; ") || "all declared"}; fix: markContentSources beside its handler, src/resale-terms.js)`);
  const mc = all.get("market-calendar");
  ok(R.hasContentSources(mc) && mc.contentSources.every((x) => x.url.startsWith("https://") && x.license && typeof x.redistribution === "boolean"), "market-calendar declares each source, its license and whether it allows redistribution");
  ok(R.resaleClearanceRefusal(mc, { compute: true }) === NOT_CLEARED && referralIneligibility(mc, { compute: true, priceForNetwork: (p) => p }) !== null && awsIneligibility(mc, { compute: true }) === NOT_CLEARED, `${CLASS} market-calendar is not cleared by reaching no upstream (both gates refuse it)`);
  const redact = all.get("redact");
  ok(R.resaleClearanceRefusal(redact, { compute: true }) === null, "CONTROL: a compute tool with no outside facts still passes");
  const sc = all.get("settlement-calendar");
  ok(R.hasContentSources(sc) && sc.resaleCleared === true && !sc.contentSources.some((x) => /nacha|frbservices|bankofengland|europeanpaymentscouncil|jpx\.co\.jp/.test(x.url)), "settlement-calendar's rule sources are public ones, declared");
  const nyfed = ["fed-funds", "us-macro-series"].map((x) => all.get(x));
  ok(nyfed.every((d) => d && R.resaleBarredReason(d) === R.NYFED_PASS_ON_RESALE_REASON && awsIneligibility(d, {}) === R.NYFED_PASS_ON_RESALE_REASON), "the tools serving New York Fed rates are barred from resale, with the pass-on reason");
  let threw = false;
  try { R.markContentSources([{ slug: "z" }], ["z"], [{ name: "x", url: "https://x.example", license: "y" }]); } catch { threw = true; }
  ok(threw, "a content source must say whether its license allows redistribution");
}

// The suite seam: clears named slugs for a test boot, never in production.
{
  const d = { slug: "zz-seam", handler: () => ({}) };
  ok(R.resaleClearanceRefusal(d, { env: { RESALE_CLEARED_FOR_TEST: "zz-seam" } }) === null, "outside production the seam clears a named slug");
  ok(R.resaleClearanceRefusal(d, { env: { RESALE_CLEARED_FOR_TEST: "zz-seam", NODE_ENV: "production" } }) === NOT_CLEARED && R.resaleClearanceRefusal(d, { env: { RESALE_CLEARED_FOR_TEST: "zz-seam", RAILWAY_ENVIRONMENT_NAME: "production" } }) === NOT_CLEARED, "a production boot ignores it");
  ok(R.resaleClearanceRefusal(d, { env: { RESALE_CLEARED_FOR_TEST: "other" } }) === NOT_CLEARED, "a slug it does not name stays refused");
}

console.log(`\ntest-resale-clearance: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
