#!/usr/bin/env node
// Offline guard for the daily ecosystem snapshot (src/dataset-snapshot.js).
//
// The four rules in that file's header are decisions, not implementation
// details, so each one is pinned here against a source object deliberately
// seeded with what must NOT come out: a Bazaar fold, a buyer roster, and a
// field nobody added to the allowlist.
//
// No network, no bucket: `put`/`exists` are injected and the "bucket" is a Map.
process.env.BACKUP_S3_ENDPOINT ||= "https://example.invalid";
process.env.BACKUP_S3_BUCKET ||= "test-bucket";
process.env.BACKUP_S3_KEY_ID ||= "test-key";
process.env.BACKUP_S3_SECRET ||= "test-secret";

import { strict as assert } from "node:assert";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  buildTables, serializeTable, manifestFor, columnFill,
  runDatasetSnapshot, EXCLUDED_THIRD_PARTY, UNFILLABLE_HERE, DATASET_PREFIX, DATASET_VERSION, PRICE_OUTLIER_USD } from "../src/dataset-snapshot.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

// A seller shaped like the real indexSnapshot projection, carrying three
// things that must never reach the output.
const SELLER = {
  origin: "https://seller.example",
  displayName: "Seller",
  homepage: "https://seller.example",
  network: "eip155:8453",
  networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  toolCount: 2,
  paidToolCount: 2,
  originResponded: true,
  discoveryPath: "/.well-known/x402",
  source: "manifest",
  health: 1,
  routable: true,
  mpp: null,
  stellarWallet: null,
  algorandWallet: null,
  payToByNetwork: { "eip155:8453": "0xseller" },
  paymentNetworksKnown: true,
  routerDispatchEligible: false,
  routerDispatchReason: "settlement_required",
  fetchedAt: "2026-09-11T04:00:00.000Z",
  error: null,
  // (1) a third-party measurement, (2) a field nobody allowlisted
  bazaar: { l30DaysTotalCalls: 4000, l30DaysUniquePayers: 12 },
  secretInternalScore: 0.97,
  tools: [{
    route: "/api/thing", method: "POST", price: "$0.005",
    quoteSource: "live-402", priceResolvedFrom: "origin",
    originDeclaredPrice: 0.005, quoteObservedAt: "2026-09-11T03:00:00.000Z",
    quoteCarriedForward: false, networks: ["eip155:8453"],
    networksInferred: false, networksVerifiedAt: "2026-09-11T03:00:00.000Z",
    methodInferred: false, methodCorrectedFrom: null, urlTemplate: null,
    internalProbeNote: "must not be published",
  }],
};

// A Base board row as finalizeLeaderboard emits it, plus the raw buyer roster
// that exists upstream and must not survive projection.
const BASE_ROW = {
  rank: 1, name: "Seller", origins: ["https://seller.example"],
  homepage: "https://seller.example", wallet: "0xabc", wallets: ["0xabc"],
  walletCount: 1, network: "base", callsSettled: 120, totalUsd: 1.2,
  uniqueBuyers: 7, endpoints: 3,
  buyers: ["0xbuyer1", "0xbuyer2"],
};
const SOLANA_ROW = { payTo: "So1...", origins: ["https://seller.example"], credits: 9, payers: 4, truncated: false, stale: false, self: false, funder: "BUYERWALLET111" };
const MPP_ROW = { recipient: "0xrecip", sellers: ["https://seller.example"], intents: ["charge"], transfers: 50, volumeUsdc: 0.5, payers: 3, proven: true, routable: true, self: false, lastError: "rpc said something" };

// --- rule 2: allowlist, never denylist --------------------------------------
{
  const t = buildTables({ sellers: [SELLER], baseRows: [BASE_ROW], solanaRows: [SOLANA_ROW], mppRows: [MPP_ROW] });
  const s = t.sellers.rows[0];
  ok(!("secretInternalScore" in s), "an un-allowlisted seller field must not be emitted");
  ok(!("bazaar" in s), "the Bazaar fold must not be emitted");
  ok(!("tools" in s), "the nested tools array is its own table, not a seller column");
  const r = t.routes.rows[0];
  ok(!("internalProbeNote" in r), "an un-allowlisted route field must not be emitted");
  eq(r.origin, "https://seller.example", "route rows carry their seller origin as the join key");
  eq(r.price_source, "live-402", "price provenance is carried");
  eq(r.price_usd, 0.005, "price_usd is DERIVED from the crawl row's display string - the raw object has no priceUsd, and the first real day shipped this column all-null because of it");
  eq(r.price_published, "$0.005", "what the origin literally published rides along beside the parsed number");
  eq(buildTables({ sellers: [{ origin: "o", tools: [{ route: "/x", price: "ask us" }] }] }).routes.rows[0].price_usd, null,
     "an unparseable price is NULL, never 0 - publishing 'free' for 'unreadable' would be a fabricated fact");
  eq(r.quote_observed_at, "2026-09-11T03:00:00.000Z", "observation time is carried");
  eq(s.router_dispatch_reason, "settlement_required", "the router's own verdict rides along - the column that separates transactable from merely listed");
  eq(s.pay_to_by_network["eip155:8453"], "0xseller", "the per-chain payout address is the join key to the settlement tables");

  // Every row of a table has an identical key set - a reader should never have
  // to guess the schema from row 1.
  const keysA = Object.keys(t.sellers.rows[0]).sort();
  const t2 = buildTables({ sellers: [SELLER, { origin: "https://other.example" }] });
  eq(Object.keys(t2.sellers.rows[1]).sort(), keysA, "a sparse source still yields the full column set");
  eq(t2.sellers.rows[1].display_name, null, "a missing value is null, never absent");
}

// --- rule 3: third-party measurements excluded, by name ---------------------
{
  ok("sellers.bazaar" in EXCLUDED_THIRD_PARTY, "the Bazaar exclusion is named, so it is greppable and reviewable");
  const m = manifestFor({ day: "2026-09-11", tables: buildTables({ sellers: [SELLER] }) });
  ok(/not redistributed/i.test(m.excludedThirdParty["sellers.bazaar"]), "the manifest says WHY it was excluded");
  ok(/first-party/i.test(m.provenance), "the manifest states provenance");
  // A column this source cannot fill is DROPPED and named, never published as
  // a permanent field of nulls - the failure the first real day shipped.
  const cols = buildTables({ sellers: [SELLER] }).routes.columns.map(([o]) => o);
  ok(!cols.includes("url_template") && !cols.includes("networks_inferred"), "columns the crawl row cannot fill are not emitted");
  ok(Object.keys(UNFILLABLE_HERE).length >= 2, "and they are named, so the omission is reviewable rather than forgotten");

  const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const persist = /function persistedEntries[\s\S]*?\n\}/.exec(idx)?.[0] || "";
  ok(/discoveryPath/.test(persist), "discoveryPath survives persistence: it is published by /api/index and every warm start dropped it, so prod served null for every seller");
  ok(/"payment"/.test(idx.match(/const MANIFEST_PERSIST_KEYS = \[[^\]]*\]/)?.[0] || ""), "manifest.payment survives persistence - primaryNetwork lives in it and /api/index publishes it as `network`");
}

// --- rule 4: counts, never rosters ------------------------------------------
{
  const t = buildTables({ baseRows: [BASE_ROW], solanaRows: [SOLANA_ROW], mppRows: [MPP_ROW] });
  const b = t.settlement_base.rows[0];
  eq(b.unique_buyers, 7, "the buyer COUNT is published");
  ok(!("buyers" in b), "the buyer roster is never published");
  ok(!JSON.stringify(t).includes("0xbuyer1"), "no buyer address appears anywhere in the tables");
  ok(!("funder" in t.settlement_solana.rows[0]), "the Solana credit funder is a buyer and is not published");
  ok(!JSON.stringify(t).includes("BUYERWALLET111"), "no Solana funder address survives projection");
  ok(!("lastError" in t.settlement_mpp.rows[0]), "an upstream error string is not dataset content");
  eq(b.pay_to, "0xabc", "the seller payTo IS published - it is the join key and public infrastructure");
  eq(t.settlement_mpp.rows[0].is_host, false, "MPP rows carry the self flag so our own volume runs can be excluded");
  eq(t.settlement_solana.rows[0].is_host, false, "Solana rows carry the self flag too");
  eq(t.settlement_mpp.rows[0].volume_usdc, 0.5, "MPP volume is read from the board's own field name");
}

// --- columnFill: a hole is visible, not silent ------------------------------
{
  // A source that stopped populating a field reads 0, not "fine".
  const missing = { ...SELLER, health: undefined, routable: undefined };
  const t = buildTables({ sellers: [missing] });
  const fill = columnFill(t.sellers.rows, t.sellers.columns);
  eq(fill.health, 0, "a field the source stopped populating reads 0 in columnFill");
  eq(fill.origin, 1, "a populated field counts");
  const m = manifestFor({ day: "2026-09-11", tables: t });
  eq(m.tables.sellers.columnFill.health, 0, "columnFill rides in the manifest where a buyer can see it");
}

// --- the run: immutability, ordering, partials -------------------------------
const bucket = new Map();
const put = async (key, body) => { bucket.set(key, body); return { key, bytes: body.length }; };
const exists = async (key) => bucket.has(key);

{
  const logs = [];
  const res = await runDatasetSnapshot({
    sellers: () => [SELLER], baseRows: () => [BASE_ROW],
    solanaRows: () => [SOLANA_ROW], mppRows: () => [MPP_ROW],
    day: "2026-09-11", put, exists, log: (m) => logs.push(m),
  });
  ok(res.ok, "a clean run succeeds");
  eq(res.rows.sellers, 1, "one seller written");
  eq(res.rows.routes, 1, "one route written");
  ok(bucket.has(`${DATASET_PREFIX}/dt=2026-09-11/manifest.json`), "the manifest is written");
  ok(bucket.has(`${DATASET_PREFIX}/dt=2026-09-11/sellers.ndjson.gz`), "the sellers table is written");

  // The bytes really are NDJSON: one complete JSON object per line.
  const lines = gunzipSync(bucket.get(`${DATASET_PREFIX}/dt=2026-09-11/routes.ndjson.gz`)).toString("utf8").trim().split("\n");
  eq(lines.length, 1, "one route line");
  eq(JSON.parse(lines[0]).route, "/api/thing", "the line parses as the row");

  const manifest = JSON.parse(bucket.get(`${DATASET_PREFIX}/dt=2026-09-11/manifest.json`).toString("utf8"));
  eq(manifest.day, "2026-09-11", "the manifest names its day");
  eq(manifest.tables.routes.rows, 1, "the manifest counts rows");
  ok(!manifest.partial, "a clean run is not marked partial");
  ok(/never published/i.test(manifest.privacy), "the manifest states the privacy line");
}

{
  // Rule 1: the same day again does not rewrite. Proven by mutating the stored
  // bytes and checking they survive - "skipped" in a return value would pass
  // even if the writer had clobbered the object first.
  const sentinel = Buffer.from("ORIGINAL");
  bucket.set(`${DATASET_PREFIX}/dt=2026-09-11/sellers.ndjson.gz`, sentinel);
  const res = await runDatasetSnapshot({
    sellers: () => [SELLER], baseRows: () => [], solanaRows: () => [], mppRows: () => [],
    day: "2026-09-11", put, exists, log: () => {},
  });
  eq(res.skipped, "already recorded", "a recorded day is skipped");
  eq(bucket.get(`${DATASET_PREFIX}/dt=2026-09-11/sellers.ndjson.gz`).toString(), "ORIGINAL", "a recorded day's bytes are untouched");

  const forced = await runDatasetSnapshot({
    sellers: () => [SELLER], baseRows: () => [], solanaRows: () => [], mppRows: () => [],
    day: "2026-09-11", force: true, put, exists, log: () => {},
  });
  ok(forced.ok && !forced.skipped, "force repairs a day");
  const m = JSON.parse(bucket.get(`${DATASET_PREFIX}/dt=2026-09-11/manifest.json`).toString("utf8"));
  ok(m.forcedOverwrite === true, "a forced overwrite is recorded in the manifest, never silent");
}

{
  // A dead source costs its table, not the day - and the manifest names it.
  const res = await runDatasetSnapshot({
    sellers: () => { throw new Error("index cache unreadable"); },
    baseRows: () => [BASE_ROW], solanaRows: () => [], mppRows: () => [],
    day: "2026-09-12", put, exists, log: () => {},
  });
  ok(res.ok, "one dead source does not fail the day");
  eq(res.rows.sellers, 0, "the dead table is empty");
  eq(res.rows.settlement_base, 1, "the live table still wrote");
  const m = JSON.parse(bucket.get(`${DATASET_PREFIX}/dt=2026-09-12/manifest.json`).toString("utf8"));
  ok(/index cache unreadable/.test(m.partial.sellers), "the manifest names what was missing and why");
}

{
  // The manifest is written LAST, so a run that dies mid-upload leaves no day
  // claiming to be complete (and so the immutability check cannot be fooled).
  const order = [];
  const trackingPut = async (key, body) => { order.push(key); if (key.endsWith("settlement_mpp.ndjson.gz")) throw new Error("upload died"); bucket.set(key, body); };
  const res = await runDatasetSnapshot({
    sellers: () => [SELLER], baseRows: () => [], solanaRows: () => [], mppRows: () => [],
    day: "2026-09-13", put: trackingPut, exists, log: () => {},
  });
  ok(!res.ok, "an upload failure fails the run");
  ok(!bucket.has(`${DATASET_PREFIX}/dt=2026-09-13/manifest.json`), "a half-written day has no manifest, so it is not treated as recorded");
  eq(order[order.length - 1], `${DATASET_PREFIX}/dt=2026-09-13/settlement_mpp.ndjson.gz`, "the failure was the table upload, not the manifest");
}

{
  // Serialization bound: an empty table is valid and tiny, not a crash.
  const body = serializeTable([]);
  eq(gunzipSync(body).toString("utf8"), "", "an empty table serializes to an empty document");
}

// --- pinned from source ------------------------------------------------------
// These two are invisible to the fixtures above: the first is a wiring shape in
// server.js, the second a transport rule whose violation only shows up under
// the npm undici the server installs as its global dispatcher (Node's built-in
// fetch tolerates it, so a standalone run passes while the server fails).
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const block = /const datasetSources = \(\) => \(\{[\s\S]*?\n\}\);/.exec(server)?.[0] || "";
  ok(/withDispatchFields\(s\)/.test(block), "the sellers source applies the dispatch decoration /api/index applies; without it the router_dispatch_* columns publish all-null");
  ok(block.includes("crawlToolsByOrigin()"), "the sellers source joins the raw crawl tools - without it the routes table is empty and the price provenance, the point of the dataset, is lost");
  ok(/filter\(\(s\) => !s\.local\)/.test(block), "our own host row is excluded: this dataset describes the ecosystem, and an index that publishes itself as a seller is the thing we refuse to do elsewhere");
  ok(block.includes("getLeaderboardSnapshot") && block.includes("getSolanaLeaderboardSnapshot") && block.includes("mppLeaderboardSnapshot"), "all three settlement boards are wired");

  const backup = readFileSync(new URL("../src/backup.js", import.meta.url), "utf8");
  const ex = /export async function objectExists[\s\S]*?\n\}/.exec(backup)?.[0] || "";
  ok(ex.includes("listAll("), "objectExists LISTS the key: a HEAD on a missing key answers 403 (not 404) on a credential without ListBucket, which is what our bucket does and what broke the first live run");
  ok(!/s3\("HEAD"/.test(ex), "objectExists must not HEAD - that path cannot tell a missing day from a permissions failure");

  const put = /export async function putObject[\s\S]*?\n\}/.exec(backup)?.[0] || "";
  // The Hive partition puts an "=" in every object key. SigV4 signs the
  // canonical URI and the request must send exactly that string, so the path
  // is encoded once, per segment, and shared - the first live snapshot failed
  // SignatureDoesNotMatch because the signature used a raw "=" and fetch sent
  // a normalized one. Backup keys are unreserved-only, so encoding is inert
  // for them and the proven path is untouched.
  ok(/map\(encodeURIComponent\)/.test(backup), "the S3 path is percent-encoded per segment for both the signature and the request");
  ok(DATASET_PREFIX.startsWith("datasets/"), "the dataset prefix is stable");

  ok(put.includes('s3("PUT", key, { body })'), "putObject sends NO explicit content-length: undici derives it from a Buffer and rejects a caller-supplied one (UND_ERR_INVALID_ARG). The streaming backup upload still passes it, correctly, because a stream cannot be measured.");
  ok(!/contentLength/.test(put), "no contentLength in the Buffer upload path");
}

// --- the outlier flag: distribution, not judgement ---------------------------
// Sellers advertise jokes ($1,500,000 for one call, read from a live 402 on the
// first recorded day) and nothing flagged them, so a buyer computing a median
// or a market size off price_usd got a poisoned answer. The flag exists so the
// rows can be excluded; it must never be confused with "we do not know".
{
  const rows = (t) => buildTables({ sellers: [{ ...SELLER, tools: t }] }).routes.rows;
  const one = (price) => rows([{ route: "/r", method: "GET", price }])[0];
  eq(one(0.005).price_outlier, false, "an ordinary $0.005 route is not an outlier");
  eq(one(149).price_outlier, false, "$149 is NOT an outlier: team credit packs, print-and-ship and card orders are real products in the hundreds, and flagging them would throw away real commerce");
  eq(one(999.99).price_outlier, false, "just under the line is inside it");
  eq(one(PRICE_OUTLIER_USD).price_outlier, true, "the threshold itself is an outlier (at or above, so the boundary is stated not guessed)");
  eq(one(1500000).price_outlier, true, "the $1.5M listing that started this is flagged");
  eq(one(null).price_outlier, null, "an UNPRICED route is null, never false - 'we do not know the price' and 'the price is in range' are different facts, and a buyer filtering on price_outlier = false must not silently collect unpriced rows");
  eq(one(0).price_outlier, false, "a genuinely free route is priced and in range");
  // The rule travels with the data: a reader must never have to find our source.
  const m = manifestFor({ day: "2026-09-11", tables: buildTables({ sellers: [SELLER] }) });
  eq(m.priceOutlierRule.thresholdUsd, PRICE_OUTLIER_USD, "the manifest states the threshold that produced the column");
  ok(/distribution, not about the seller/.test(m.priceOutlierRule.meaning), "...and says it is a statement about the distribution, not about the seller");
}

// --- the v1 schema is FROZEN ------------------------------------------------
// Buyers filter on whether "historical data is comparable to current data", so
// a column that changes meaning between days is worse than a column that never
// existed: every backtest spanning the change is silently wrong. Removing or
// renaming is a v2 change with a new prefix. Additions are allowed and must be
// DECLARED, so growth stays a decision rather than a drift.
{
  const frozen = JSON.parse(readFileSync(new URL("./dataset-schema-v1.json", import.meta.url), "utf8"));
  eq(frozen.version, DATASET_VERSION, "the freeze file describes the version actually being written");
  const live = buildTables({ sellers: [SELLER], baseRows: [BASE_ROW], solanaRows: [SOLANA_ROW], mppRows: [MPP_ROW] });
  const declaredAdds = new Set((frozen.additions || []).map((a) => `${a.table}.${a.column}`));

  for (const [table, cols] of Object.entries(frozen.tables)) {
    const emitted = live[table]?.columns.map(([o]) => o);
    ok(emitted, `table ${table} still exists in v1`);
    for (const c of cols) {
      ok(emitted.includes(c),
        `v1 froze ${table}.${c} and it is no longer emitted. Removing or renaming a column is a BREAKING change: bump DATASET_VERSION and write to a new prefix rather than changing what v1 means.`);
    }
    for (const c of emitted.filter((x) => !cols.includes(x))) {
      ok(declaredAdds.has(`${table}.${c}`),
        `${table}.${c} is new and undeclared. Additions are fine, but record it in scripts/dataset-schema-v1.json under additions[] with the date and reason - a schema nobody declared is a schema nobody can explain to a buyer.`);
    }
  }
}

console.log(`test-dataset-snapshot: ${n} assertions OK`);
