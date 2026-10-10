// Scan progress kept as one document (the seller-funding state, the Tempo
// transfer feed state) is saved through a version check with the state
// database: a state built while the row was unread (a stand-in) is never
// saved, even after the background re-read has landed mid-scan, and a state
// the row moved past (another container saved) never replaces it.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";
const { url } = requireTestPg({ label: "test-scan-state-version-pg" });
const relay = await startPgRelay(url);
const DIR = mkdtempSync(join(tmpdir(), "scan-state-pg-"));
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1000";
process.env.STATE_STORE_RETRY_MS = "200";
process.env.STATE_STORE_RETRY_MAX_MS = "400";
process.env.LEADERBOARD_FUNDING_FILE = join(DIR, "none", "leaderboard-funding.json");
process.env.TEMPO_TRANSFERS_CACHE_FILE = join(DIR, "none", "tempo-transfers.json");
const sdb = await import("../src/state-db.js");
const lb = await import("../src/leaderboard.js");
const tt = await import("../src/tempo-transfers.js");
const { createFundingState, serializeFundingState } = await import("../src/seller-funding.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FUND = "leaderboard-funding.json", FEED = "tempo-transfers.json";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const version = async (n) => (await sdb.documents.get(n))?.version;

try {
  // ---- funding state: a stand-in is never saved -----------------------------
  const stored = JSON.parse(serializeFundingState(createFundingState(USDC)));
  stored.marker = "stored progress";
  await sdb.documents.put(FUND, stored);
  const v0 = await version(FUND);
  relay.cut();
  const standIn = await lb.__loadSellerFundingStateForTest();
  relay.heal();
  await wait(1500); // the background re-read lands mid-scan
  const saved = await lb.__persistSellerFundingStateForTest(standIn);
  ok(saved === false && (await version(FUND)) === v0 && (await sdb.documents.get(FUND)).body.marker === "stored progress", "a funding state built while the row was unread is not saved over it, after the re-read landed");

  // ---- funding state: a row that moved on is not overwritten ----------------
  lb.__resetSellerFundingStateForTest();
  const st = await lb.__loadSellerFundingStateForTest();
  ok((await lb.__persistSellerFundingStateForTest(st)) === true, "the state read from the row saves");
  const other = (await sdb.documents.get(FUND)).body; other.marker = "other container";
  await sdb.documents.put(FUND, other);
  const v1 = await version(FUND);
  ok((await lb.__persistSellerFundingStateForTest(st)) === false && (await version(FUND)) === v1 && (await sdb.documents.get(FUND)).body.marker === "other container", "a save over a row another container advanced is refused");
  const again = await lb.__loadSellerFundingStateForTest();
  ok(again !== st, "the next scan reloads the state from the row");

  // ---- feed state: a stand-in is never saved --------------------------------
  const feedStored = { ...tt.emptyFeedState(), syncs: 41, cursorTs: 123 };
  await sdb.documents.put(FEED, feedStored);
  const f0 = await version(FEED);
  relay.cut();
  ok((await tt.loadFeedStateAsync()) === null && tt.feedStateUnread(), "the feed load during an outage reads nothing and the state is unread");
  const feedStandIn = tt.emptyFeedState();
  relay.heal();
  await wait(1500);
  ok((await tt.persistFeedStateAsync(feedStandIn)) === false && (await version(FEED)) === f0, "a feed state built while the row was unread is not saved over it");

  // ---- feed state: the row moved on: the stored state is taken in -----------
  const feed = await tt.loadFeedStateAsync();
  ok(feed?.syncs === 41, "the feed state is read from the row");
  feed.syncs = 42;
  ok((await tt.persistFeedStateAsync(feed)) === true && (await sdb.documents.get(FEED)).body.syncs === 42, "the feed state read from the row saves");
  await sdb.documents.put(FEED, { ...tt.emptyFeedState(), syncs: 99, cursorTs: 999 });
  const f2 = await version(FEED);
  feed.syncs = 43;
  ok((await tt.persistFeedStateAsync(feed)) === false && (await version(FEED)) === f2, "a feed save over a row another container advanced is refused");
  ok(feed.syncs === 99 && feed.cursorTs === 999, `the stored feed state is taken into the caller's object (${feed.syncs}, ${feed.cursorTs})`);
  feed.syncs = 100;
  ok((await tt.persistFeedStateAsync(feed)) === true && (await sdb.documents.get(FEED)).body.syncs === 100, "the next save goes on from the stored state");
} finally {
  relay.heal();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-scan-state-version-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
