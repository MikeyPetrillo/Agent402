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
  "cdp-kit.js", "x-data-kit.js", "derivatives-kit.js", "enrich-kit.js", "chain-kit.js", "search.js", "crypto-markets-kit.js",
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
    "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar", "dns", "tls-cert", "ip-info",
    "stablecoin-peg", "funding-screener", "stablecoin-depeg-watch", "exchange-spread", "defi-screener", "chain-board", "dex-volume-board", "dex-pool-health", ...PERPS,
  ];
  ok(new Set(REF_LISTED).size === 73 && AWS_LISTED.length >= 74, `the lists read are the ones sold today (/ref ${new Set(REF_LISTED).size}, AWS ${AWS_LISTED.length})`);
  // The server's compute reading, for the pure-CPU tools on the AWS list.
  const { isComputePayable } = await import("../src/pow.js");
  const computeOf = (d) => { try { return typeof isComputePayable === "function" ? isComputePayable(d) === true : false; } catch { return false; } };
  const refusedOf = (list) => list.filter((s) => !defs.has(s) || R.resaleClearanceRefusal(defs.get(s), { compute: computeOf(defs.get(s)) }) !== null);
  ok(refusedOf(REF_LISTED).length === 0, `every slug on the /ref list is cleared (${refusedOf(REF_LISTED).join(",") || "73 of 73"})`);
  ok(refusedOf(AWS_LISTED).length === 0, `every slug on the AWS listing is cleared or reaches no upstream (${refusedOf(AWS_LISTED).join(",") || `${AWS_LISTED.length} of ${AWS_LISTED.length}`})`);
  ok(["whois", "github-repo", "onchain-sql-schema"].every((s) => !REF_LISTED.includes(s) && !AWS_LISTED.includes(s) && defs.get(s)?.resaleCleared !== true), "whois, github-repo and onchain-sql-schema are on neither list and stay uncleared");
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
