// Two containers, one MPP seller index on the state database:
//   - a seller registered on A reaches B by B's pull (listing and seed);
//   - a save never drops an origin only the other container stored, and an
//     older probe never replaces a newer one;
//   - two containers taking submissions at once keep each other's seeds;
//   - a crawl that did not run here (another container holds its lease) saves nothing.
//   STATE_DATABASE_URL=postgres://... node scripts/test-mpp-index-replicas-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-mpp-index-replicas-pg" });

const DIR = mkdtempSync(join(tmpdir(), "mpp-index-replicas-pg-"));
process.env.MPP_INDEX_CACHE_FILE = join(DIR, "mpp-index-cache.json");
process.env.MPP_SUBMITTED_SEEDS_FILE = join(DIR, "mpp-submitted-seeds.json");
process.env.X402_INDEX_CRAWL = "off";

const sdb = await import("../src/state-db.js");
const { createJsonDocument } = await import("../src/json-document.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const settle = () => new Promise((r) => setTimeout(r, 150));
const verifiedAt = (t) => async (origin) => ({ origin, name: origin, verified: true, verifiedAt: t, lastProbeAt: t, lastProbeOk: true, offers: [] });
const listed = (m) => new Set(m.mppIndexSnapshot().sellers.map((s) => s.origin));
const cacheDoc = createJsonDocument({ file: process.env.MPP_INDEX_CACHE_FILE, log: () => {} });
const seedsDoc = createJsonDocument({ file: process.env.MPP_SUBMITTED_SEEDS_FILE, log: () => {} });
const storedOrigins = async () => new Set(((await cacheDoc.read()).body?.entries || []).map((e) => e[0]));
const storedSeeds = async () => new Set(((await seedsDoc.read()).body || []).map((r) => (typeof r === "string" ? r : r.origin)));

try {
  const A = await import("../src/mpp-index.js?container=a");
  const B = await import("../src/mpp-index.js?container=b");
  await A.loadSubmittedSeeds(); await B.loadSubmittedSeeds();

  // ---- a registration on A reaches B -----------------------------------------
  const X = "https://seller-x.example", Y = "https://seller-y.example";
  const rx = await A.registerMppOrigin(X, { verify: verifiedAt(1_000) });
  ok(rx.listed === true && listed(A).has(X), "A lists X");
  await settle();
  ok((await storedOrigins()).has(X), "the registration's listing is stored at once (not only after a crawl)");
  ok((await storedSeeds()).has(X), "and its seed");
  ok(!listed(B).has(X), "B has not pulled yet");
  const n = await B.pullMppIndexChanges();
  ok(n >= 1 && listed(B).has(X), `B lists X after one pull (${n} change(s))`);

  // ---- submissions on both keep each other's seeds -----------------------------
  await Promise.all([B.registerMppOrigin(Y, { verify: verifiedAt(2_000) }), A.registerMppOrigin("https://seller-z.example", { verify: verifiedAt(2_100) })]);
  await settle();
  const seeds = await storedSeeds();
  ok(seeds.has(X) && seeds.has(Y) && seeds.has("https://seller-z.example"), `seeds from both containers are kept (${[...seeds].length})`);
  const origins = await storedOrigins();
  ok(origins.has(X) && origins.has(Y) && origins.has("https://seller-z.example"), `listings from both containers are kept (${[...origins].length})`);

  // ---- a save keeps the other container's origins; newer probe wins ----------------
  // B has X at probe 1000 only; A re-probes X at 5000 and saves. Then B saves.
  A.__testReset(); await A.pullMppIndexChanges();
  await A.registerMppOrigin("https://seller-w.example", { verify: verifiedAt(3_000) });
  await settle();
  ok(A.persistMppIndexCache(undefined, undefined) === true, "A saves after a crawl it ran");
  await settle();
  const before = await cacheDoc.read();
  const xBefore = before.body.entries.find((e) => e[0] === X)[1];
  // A newer row for X written behind B's back.
  await cacheDoc.update((b) => { const e = b.entries.find((r) => r[0] === X); e[1] = { ...e[1], lastProbeAt: 9_000, name: "x-newer" }; return b; });
  ok(B.persistMppIndexCache(undefined, undefined) === true, "B saves its (older) copy");
  await settle();
  const after = await cacheDoc.read();
  const xAfter = after.body.entries.find((e) => e[0] === X)?.[1];
  ok(xBefore && xAfter?.name === "x-newer" && xAfter?.lastProbeAt === 9_000, "B's older probe of X never replaces the newer row");
  ok(new Set(after.body.entries.map((e) => e[0])).has("https://seller-w.example"), "B's save keeps the origin only A stored");

  // ---- a skipped crawl saves nothing ------------------------------------------
  const v0 = (await cacheDoc.read()).version;
  ok(B.persistMppIndexCache(undefined, { skipped: "leased", reason: "held" }) === false, "a crawl skipped under another container's lease does not save");
  await settle();
  ok((await cacheDoc.read()).version === v0, "and the row is untouched");
  // The loop as wired: a crawl under a lease another holder has returns skipped.
  await sdb.leases.acquire?.("mpp-index-crawl", { owner: "other-container", ttlMs: 60_000 });
  const r = await B.runMppCrawl();
  ok(r && r.skipped === "leased", `B's crawl is skipped while another container holds the lease (${JSON.stringify(r)})`);
} catch (e) {
  fail++; console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  try { await sdb.__dropStateSchema(); } catch {}
  try { await sdb.closeStateDb?.(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
