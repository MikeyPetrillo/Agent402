// A large seller's index entry in the state database as a header and parts
// (src/index-parts.js), across two containers:
//   - container A saves a 77,000-tool seller beside one-row sellers; the
//     header row is under the origin, the parts in their own collection;
//   - container B (its own process) warm-starts the same table: every seller
//     once, the large one whole and deep-equal to what A stored; its router
//     replica observer sees the same assembled entry;
//   - a change inside one part rewrites that part alone (the other part rows
//     keep their stamps), and B pulls the change;
//   - a save landing between a reader's header read and its part reads is
//     never mixed in: the reader takes the header again and gets the new
//     entry whole, or keeps the copy it holds when no consistent set arrives;
//   - the seller shrinking under the part size is one row again and its parts
//     are swept; growing past it is parts again; removal leaves nothing;
//   - the single-origin write stores a large entry in parts too;
//   - a container whose grace has not passed leaves an orphan for the next
//     sweep that may take it.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-parts-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";
import "./lib/uncapped-sellers.js"; // every seeded tool is kept: the large sellers here are the point (a child under the default cap sets it explicitly)
const ROLE = process.env.INDEX_PARTS_ROLE || "a";
const IS_B = ROLE !== "a"; // a child container: B (uncapped, as A), or C and D (the default per-seller cap)
let DIR = null;
if (!IS_B) {
  requireTestPg({ label: "test-index-parts-pg" });
  process.env.X402_INDEX_CRAWL = "off";
  DIR = mkdtempSync(join(tmpdir(), "index-parts-pg-"));
  process.env.INDEX_CACHE_FILE = join(DIR, "absent", "x402-index-cache.json");
  process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");
  // A's sweep takes any orphan at once; B keeps the default grace (below).
  process.env.INDEX_PARTS_ORPHAN_GRACE_MS = "0";
  process.env.INDEX_PARTS_RETRY_WAIT_MS = "300";
}

const sdb = await import("../src/state-db.js");
const { PARTS_COLLECTION, PART_TOOLS, splitEntry } = await import("../src/index-parts.js");
const COLLECTION = "x402-index";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BIG = "https://seller-big.example";
function tool(k, seller = "big") {
  return {
    route: `/api/${seller}/item/${k}`, method: k % 3 ? "GET" : "POST", name: `${seller} item ${k} 漢字 \u{1F600}`,
    description: `Returns item ${k} of ${seller} with pagination, filters, sorting and documented error codes for an agent. `.repeat(5),
    price: `$0.00${1 + (k % 9)}`, network: "eip155:8453", payTo: "0x" + "ab".repeat(20), asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tags: ["item", "x402"], mimeType: "application/json", maxTimeoutSeconds: 60, quotedAt: 1_700_000_000_000 + k, networks: ["eip155:8453", "eip155:137"],
  };
}
const sellerEntry = (name, n, fetchedAt) => ({ manifest: { name, description: "A seller", homepage: `https://${name}.example`, x402Version: 2, network: "base" }, tools: Array.from({ length: n }, (_, k) => tool(k, name)), fetchedAt, error: null, source: "crawl", history: [{ at: 1, ok: true }], paywall: null, discoveryPath: "/.well-known/x402" });
// A stable text of a value (keys sorted at every depth): jsonb reorders keys.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const digest = (v) => createHash("sha1").update(canon(v)).digest("hex");
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };
const sellers = (m) => m.indexSnapshot(snapArgs).sellers.filter((s) => s.origin.startsWith("https://seller-")).map((s) => `${s.origin} ${s.toolCount}`).sort();
const heldDigest = (m, origin) => { const v = m._cacheForTests().get(origin); if (!v) return null; const { warmStarted, ...rest } = v; return digest(JSON.parse(JSON.stringify(rest))); };
const partRows = async (origin = BIG) => (await sdb.stateQuery(`SELECT id, updated_at::text AS at FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id LIKE $2 ESCAPE '\\' ORDER BY id`, [PARTS_COLLECTION, origin.replace(/[\\%_]/g, "\\$&") + "#%"])).rows;

// ---- container B: a child process answering the parent's commands ----------
async function containerB() {
  const B = await import("../src/x402-index.js");
  const seen = new Map(); // what the router replica observer was shown
  B._setRouterReplicaObserver((kind, op, origin, v) => { if (kind === "cache" && op === "set") seen.set(origin, Array.isArray(v?.tools) ? v.tools.length : null); });
  const commands = {
    warm: async () => ({ n: await B.warmStartIndexFromStateDb(), sellers: sellers(B), big: heldDigest(B, BIG), tools: B._cacheForTests().get(BIG)?.tools?.length ?? null, replicaBig: seen.get(BIG) ?? null, stats: B.__testPartStats() }),
    pull: async () => ({ n: await B.pullIndexChanges(), big: heldDigest(B, BIG), tools: B._cacheForTests().get(BIG)?.tools?.length ?? null, desc: B._cacheForTests().get(BIG)?.tools?.[40_000]?.description?.slice(0, 7) ?? null, stats: B.__testPartStats() }),
    saveChanged: async () => {
      // B re-crawls the big seller with one more tool changed (its own grace: the default).
      const held = B._cacheForTests().get(BIG);
      const tools = held.tools.slice(); tools[100] = { ...tools[100], description: "B changed " + tools[100].description };
      B.__testSeedCache([[BIG, { ...held, tools, fetchedAt: held.fetchedAt + 1 }]]);
      return { saved: await B.persistIndexCacheAsync(), stats: B.__testPartStats() };
    },
    // The per-seller cap (src/seller-tool-cap.js), for a child under the default cap.
    held: async ({ origin }) => { const v = B._cacheForTests().get(origin); return v ? { tools: v.tools?.length ?? null, toolsTotal: v.toolsTotal ?? null, toolsCapped: v.toolsCapped ?? null, digest: heldDigest(B, origin) } : null; },
    save: async () => ({ saved: await B.persistIndexCacheAsync(), stats: B.__testPartStats() }),
    seedAndSave: async ({ origin, n, fetchedAt }) => { B.__testSeedCache([[origin, sellerEntry(origin.replace(/^https:\/\/|\.example$/g, ""), n, fetchedAt)]]); return { saved: await B.persistIndexCacheAsync(), stats: B.__testPartStats() }; },
    exit: () => { setImmediate(() => process.exit(0)); },
  };
  process.on("message", async ({ id, cmd, args }) => {
    try { process.send({ id, value: (await commands[cmd](args || {})) ?? null }); } catch (e) { process.send({ id, error: String(e?.stack || e) }); }
  });
  process.send({ id: 0, value: "ready" });
}

/** A child container, by role, with its own environment; resolves { ask, exit }. */
async function forkContainer(role, envOver = {}) {
  const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, INDEX_PARTS_ROLE: role, INDEX_PARTS_ORPHAN_GRACE_MS: "", ...envOver }, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const waiting = new Map();
  let seq = 0;
  child.on("message", ({ id, value, error }) => { const w = waiting.get(id); if (!w) return; waiting.delete(id); if (error) w.reject(new Error(error)); else w.resolve(value); });
  child.on("exit", (code) => { for (const w of waiting.values()) w.reject(new Error(`container ${role.toUpperCase()} exited (${code})`)); waiting.clear(); });
  const ask = (cmd, args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); child.send({ id, cmd, args }); });
  await new Promise((resolve, reject) => { waiting.set(0, { resolve, reject }); });
  return { ask, exit: async () => { try { await ask("exit"); } catch { /* gone */ } } };
}

async function main() {
  const containerB = await forkContainer("b");
  const askB = containerB.ask;
  const children = [containerB];
  try {
    const A = await import("../src/x402-index.js");
    const N = 77_000;
    const big = sellerEntry("big", N, 1_000_000);
    const edge = sellerEntry("edge", PART_TOOLS, 1_000_001); // exactly the part size: one row
    const smalls = Array.from({ length: 20 }, (_, i) => [`https://seller-${String(i).padStart(2, "0")}.example`, sellerEntry(`s${i}`, 3, 1_000_010 + i)]);
    A.__testSeedCache([[BIG, big], ["https://seller-edge.example", edge], ...smalls]);
    const projected = (origin) => JSON.parse(A._persistedLineForTest(origin))[1];
    const bigDigest = digest(projected(BIG));

    // ---- A saves: a header and parts for the large seller, one row each for the rest ----
    ok(await A.persistIndexCacheAsync(), "A's save writes every origin");
    const rows = (await sdb.stateQuery(`SELECT id, (body ? 'parts') AS parted, jsonb_array_length(COALESCE(body->'tools', '[]'::jsonb)) AS tools, pg_column_size(body) AS sz FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 ORDER BY id`, [COLLECTION])).rows;
    ok(rows.length === 22 && rows.every((r) => !r.id.includes("#")), `the seller collection holds one row per seller (${rows.length}), none a part`);
    const head = rows.find((r) => r.id === BIG);
    ok(head?.parted === true && Number(head.tools) === 0 && Number(head.sz) < 65_536, `the large seller's row is a header without tools (${head?.sz} bytes stored)`);
    ok(rows.find((r) => r.id === "https://seller-edge.example")?.parted === false && Number(rows.find((r) => r.id === "https://seller-edge.example").tools) === PART_TOOLS, `a seller of exactly ${PART_TOOLS} tools is one row`);
    const parts0 = await partRows();
    ok(parts0.length === Math.ceil(N / PART_TOOLS), `${parts0.length} part rows for ${N} tools`);
    const stored = await A._storedEntryForTest(BIG);
    ok(stored && digest(stored) === bigDigest && stored.tools.length === N, "the entry assembled from the table deep-equals the single row's content");
    ok(A.__testPartStats().written === parts0.length, "every part was written once");

    // ---- B warm-starts the table ------------------------------------------------
    const warm = await askB("warm");
    ok(warm.n === 22, `B warm-starts every seller once (${warm.n})`);
    ok(JSON.stringify(warm.sellers) === JSON.stringify(sellers(A)), "B lists the same sellers and tool counts as A, each once");
    ok(warm.tools === N && warm.big === bigDigest, "B's copy of the large seller is whole and deep-equals A's stored entry");
    ok(warm.replicaBig === N, `B's router replica observer was shown the assembled entry (${warm.replicaBig} tools)`);
    ok(warm.stats.assembled === 1 && warm.stats.retries === 0, "one assembly, no header re-read");

    // ---- one tool changes: one part rewritten, B pulls it ------------------------
    const changed = { ...big, fetchedAt: big.fetchedAt + 1, tools: big.tools.slice() };
    changed.tools[40_000] = { ...changed.tools[40_000], description: "changed " + changed.tools[40_000].description };
    A.__testSeedCache([[BIG, changed]]);
    const before = A.__testPartStats();
    ok(await A.persistIndexCacheAsync(), "A saves the change");
    const after = A.__testPartStats();
    ok(after.written - before.written === 1 && after.skipped - before.skipped === parts0.length - 1, `one part row written, ${parts0.length - 1} kept (${after.written - before.written} written, ${after.skipped - before.skipped} skipped)`);
    const parts1 = await partRows();
    ok(parts1.length === parts0.length && after.swept - before.swept === 1, `the replaced part was swept (${parts1.length} rows, ${after.swept - before.swept} swept)`);
    const kept = parts0.filter((r) => parts1.some((s) => s.id === r.id));
    ok(kept.length === parts0.length - 1 && kept.every((r) => parts1.find((s) => s.id === r.id).at > r.at), "the unchanged part rows are kept, their stamps moved to the save that names them again (so no sweep reads them as old)");
    ok(digest(await A._storedEntryForTest(BIG)) === digest(projected(BIG)), "the table assembles to the changed entry");
    const pull = await askB("pull");
    ok(pull.n >= 1 && pull.tools === N && pull.desc === "changed" && pull.big === digest(projected(BIG)), `B pulls the change whole (${pull.n} folded)`);

    // ---- an older copy never overwrites the header (the SQL newer-wins rule) ------
    {
      const older = { ...big, fetchedAt: big.fetchedAt - 1, tools: big.tools.map((t) => ({ ...t, price: "$0.009" })) };
      const b4 = A.__testPartStats();
      await A.__testPersistToStateDb([[BIG, older]]);
      const head2 = await sdb.records.get(COLLECTION, BIG);
      ok(head2?.fetchedAt === changed.fetchedAt && digest(await A._storedEntryForTest(BIG)) === digest(projected(BIG)), "an older copy's header write is refused, so the stored entry stays the newer one");
      ok(A.__testPartStats().written - b4.written === parts0.length, `the older copy's parts were written (${A.__testPartStats().written - b4.written})...`);
      ok((await partRows()).length === parts0.length, "...and, named by no header, swept by the same save");
    }

    // ---- a save lands between a reader's header read and its part reads -------
    // Staged by hand: the header is replaced with one naming parts not yet in
    // the table (as a save that wrote its header first would leave it for a
    // moment), the parts arrive while B's reader waits to take the header
    // again, and B ends with the new entry whole, never a mix.
    const base = projected(BIG); // the slim entry as A persists it now
    const stagedEntry = { ...base, fetchedAt: base.fetchedAt + 1, tools: base.tools.map((t, k) => (k === 5 ? { ...t, name: "staged" } : t)) };
    const split = await splitEntry(BIG, stagedEntry);
    const missing = split.parts.filter((p) => !parts1.some((r) => r.id === p.id));
    ok(missing.length === 1, `the staged save changes one part (${missing.length})`);
    await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.records SET body = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2`, [COLLECTION, BIG, JSON.stringify({ ...split.header, contentHash: "staged" })]);
    const racing = askB("pull");
    await new Promise((r) => setTimeout(r, 450)); // B has read the header and found a part missing; it waits to read the header again
    for (const p of missing) await sdb.stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`, [PARTS_COLLECTION, p.id, p.text]);
    const raced = await racing;
    const stagedDigest = digest(JSON.parse(JSON.stringify(stagedEntry)));
    ok(raced.stats.retries >= 1, `B's reader found the parts did not match and took the header again (${raced.stats.retries} re-read(s))`);
    ok(raced.tools === N && raced.big === stagedDigest, "B holds the staged save whole, not a mix of two saves");
    // The same, with parts that never arrive: B keeps the copy it holds.
    const never = await splitEntry(BIG, { ...base, fetchedAt: base.fetchedAt + 2, tools: base.tools.map((t, k) => (k === 7 ? { ...t, name: "never" } : t)) });
    await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.records SET body = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2`, [COLLECTION, BIG, JSON.stringify({ ...never.header, contentHash: "never" })]);
    const kept2 = await askB("pull");
    ok(kept2.tools === N && kept2.big === stagedDigest && kept2.stats.unreadable === 1, "with no consistent set of parts B keeps the copy it holds");
    // A rewrites the seller it holds (a crawl), which puts the table right.
    A.__testSeedCache([[BIG, { ...changed, fetchedAt: base.fetchedAt + 5 }]]);
    ok(await A.persistIndexCacheAsync() && digest(await A._storedEntryForTest(BIG)) === digest(projected(BIG)), "A's next save restores a consistent header and parts");
    await askB("pull");

    // ---- B's own save, under the default grace, leaves the orphan; A's sweep takes it ----
    const bSave = await askB("saveChanged");
    ok(bSave.saved === true && bSave.stats.written === 1 && bSave.stats.swept === 0, `B wrote one part and swept nothing inside its grace (${bSave.stats.swept})`);
    const partsB = await partRows();
    ok(partsB.length === parts0.length + 1, `the replaced part stays until the grace passes (${partsB.length} rows)`);
    await A.pullIndexChanges();
    ok(A._cacheForTests().get(BIG)?.tools?.[100]?.description?.startsWith("B changed") === true, "A pulls B's change");
    A.__testSeedCache([[BIG, { ...A._cacheForTests().get(BIG), fetchedAt: A._cacheForTests().get(BIG).fetchedAt + 1 }]]);
    await A.persistIndexCacheAsync();
    ok((await partRows()).length === parts0.length, "A's save sweeps the orphan");

    // ---- a sweep lands between a save's existence read and its header write -------
    // The seller's tools return to an earlier set, whose part the table still
    // holds as an orphan older than the grace (a part is never rewritten, so
    // its stamp is the one its first save gave it). A sweep interleaved at the
    // existence read (another container's, or this process's full save beside
    // a single-origin write) takes the orphan; the header must not name a row
    // that is gone.
    {
      const held = A._cacheForTests().get(BIG);
      const beforeSet = JSON.parse(JSON.stringify(projected(BIG)));
      const earlier = await splitEntry(BIG, beforeSet); // the parts of the set the seller returns to
      const altered = { ...held, fetchedAt: held.fetchedAt + 1, tools: held.tools.slice() };
      altered.tools[200] = { ...altered.tools[200], description: "away " + altered.tools[200].description };
      A.__testSeedCache([[BIG, altered]]);
      ok(await A.persistIndexCacheAsync() && (await partRows()).length === parts0.length, "the seller changes; the replaced part is swept (A's grace is zero)");
      // The orphan as another container inside its grace would have left it, then aged past any grace.
      const nowIds = new Set((await partRows()).map((r) => r.id));
      const orphan = earlier.parts.find((p) => !nowIds.has(p.id)) || earlier.parts[0];
      await sdb.stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body, updated_at) VALUES ($1, $2, $3::jsonb, now() - interval '20 minutes') ON CONFLICT (collection, id) DO UPDATE SET updated_at = now() - interval '20 minutes'`, [PARTS_COLLECTION, orphan.id, orphan.text]);
      await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.records SET updated_at = now() - interval '20 minutes' WHERE collection = $1`, [PARTS_COLLECTION]);
      ok((await partRows()).length === parts0.length + 1, "an aged orphan of the earlier set is in the table");
      const orig = sdb.records.existing.bind(sdb.records);
      let sweptInside = -1;
      sdb.records.existing = async (c, ids) => { const have = await orig(c, ids); sweptInside = await A.__testSweepOrphanParts(); return have; };
      const b4 = A.__testPartStats();
      A.__testSeedCache([[BIG, { ...held, fetchedAt: altered.fetchedAt + 1 }]]); // back to the earlier set
      const saved = await A.persistIndexCacheAsync();
      sdb.records.existing = orig;
      const after2 = A.__testPartStats();
      ok(saved === true && sweptInside === 1, `the interleaved sweep took the orphan during the save (${sweptInside} swept)`);
      const named = ((await sdb.records.get(COLLECTION, BIG))?.parts?.hashes || []).map((h) => `${BIG}#${h}`);
      const present = new Set((await partRows()).map((r) => r.id));
      ok(named.length === parts0.length && named.every((id) => present.has(id)), `every part the header names is in the table (${named.filter((id) => !present.has(id)).length} missing)`);
      ok(after2.restored - b4.restored === 1, `the part the sweep took was written again before the header landed (${after2.restored - b4.restored} restored)`);
      ok(digest(await A._storedEntryForTest(BIG)) === digest(projected(BIG)), "the stored entry assembles to the earlier set");
      ok((await askB("pull")).big === digest(projected(BIG)), "B pulls it whole");
    }

    // ---- shrink under the part size: one row again, parts swept -------------------
    const small = { ...big, fetchedAt: 2_000_000, tools: big.tools.slice(0, 1500) };
    A.__testSeedCache([[BIG, small]]);
    ok(await A.persistIndexCacheAsync(), "A saves the seller shrunk to 1,500 tools");
    const smallRow = await sdb.records.get(COLLECTION, BIG);
    ok(smallRow && !("parts" in smallRow) && smallRow.tools?.length === 1500, "the seller is one row again");
    ok((await partRows()).length === 0, "every part row of the seller was swept");
    const shrunk = await askB("pull");
    ok(shrunk.tools === 1500, `B pulls the one-row copy (${shrunk.tools} tools)`);

    // ---- grow past the part size again, then removal ------------------------------
    const grown = { ...big, fetchedAt: 3_000_000, tools: big.tools.slice(0, PART_TOOLS + 1) };
    A.__testSeedCache([[BIG, grown]]);
    ok(await A.persistIndexCacheAsync() && (await partRows()).length === 2 && (await sdb.records.get(COLLECTION, BIG))?.parts?.tools === PART_TOOLS + 1, "one tool past the part size is a header and two parts");
    ok((await askB("pull")).tools === PART_TOOLS + 1, "B pulls the parted copy");
    ok(A.removeOrigin(BIG, { note: "test removal" }).removed === true, "the operator removes the seller on A");
    await new Promise((r) => setTimeout(r, 300));
    ok(await A.persistIndexCacheAsync(), "A saves after the removal");
    ok((await sdb.records.get(COLLECTION, BIG)) == null && (await partRows()).length === 0, "the header and every part are gone");

    // ---- the single-origin write stores a large entry in parts too ---------------
    const AGAIN = "https://seller-again.example";
    A.__testSeedCache([[AGAIN, { ...sellerEntry("again", N, 4_000_000) }]]);
    ok(await A.persistOriginToStateDb(AGAIN), "a single-origin write of a large entry lands");
    ok((await sdb.records.get(COLLECTION, AGAIN))?.parts?.tools === N && (await partRows(AGAIN)).length === Math.ceil(N / PART_TOOLS), "...as a header and parts");
    ok(digest(await A._storedEntryForTest(AGAIN)) === digest(projected(AGAIN)), "...that assemble to the entry");
    const stale = await sdb.records.count(PARTS_COLLECTION);
    ok(stale === Math.ceil(N / PART_TOOLS), `no part row remains for any other seller (${stale} rows)`);

    // ---- the per-seller cap (src/seller-tool-cap.js) under the default cap -------
    // Container C runs with the default cap (A and B keep every tool). It
    // warm-starts the 77,000-tool seller A stored uncapped: the cache holds
    // 5,000 (described first) with the listing's count, and its save replaces
    // the row with a header naming 3 parts; the 39 old parts are orphans C's
    // grace keeps and A's sweep takes. A fresh 79,000-tool seller saved under
    // the cap is 3 parts from the start. Container D, also under the cap,
    // warm-starts the capped rows and its save rewrites nothing.
    const { SELLER_TOOL_CAP: DEFAULT_CAP } = await import("../src/seller-tool-cap.js");
    ok(DEFAULT_CAP > N, `A and B keep every tool (cap ${DEFAULT_CAP})`);
    const CAP = 5000, CAP_PARTS = Math.ceil(CAP / PART_TOOLS);
    const C = await forkContainer("c", { INDEX_SELLER_TOOL_CAP: String(CAP) });
    children.push(C);
    const warmC = await C.ask("warm");
    const heldC = await C.ask("held", { origin: AGAIN });
    ok(warmC.n === 22 && heldC?.tools === CAP && heldC.toolsTotal === N && heldC.toolsCapped === true, `C warm-starts every seller and holds the large one at the cap (${heldC?.tools} of ${heldC?.toolsTotal}, capped ${heldC?.toolsCapped})`);
    ok(warmC.replicaBig === null && JSON.stringify(sellers(A).filter((s) => !s.startsWith(AGAIN))) === JSON.stringify(warmC.sellers.filter((s) => !s.startsWith(AGAIN))) && warmC.sellers.includes(`${AGAIN} ${CAP}`), "C lists the other sellers as A does and the large one at the cap");
    const partsBefore = await partRows(AGAIN);
    const saveC = await C.ask("save");
    // Every tool of this fixture is described, so the kept 5,000 are the
    // listing's first 5,000 and two of the three parts are rows the table
    // already holds (content-addressed): they are kept, the third is written.
    ok(saveC.saved === true && saveC.stats.written + saveC.stats.skipped === CAP_PARTS && saveC.stats.written >= 1, `C's save stores the capped copy in ${CAP_PARTS} parts (${saveC.stats.written} written, ${saveC.stats.skipped} already held)`);
    const headC = await sdb.records.get(COLLECTION, AGAIN);
    ok(headC?.parts?.tools === CAP && headC.parts.hashes.length === CAP_PARTS && headC.toolsTotal === N && headC.toolsCapped === true, `the header names ${headC?.parts?.hashes?.length} parts for ${headC?.parts?.tools} tools and carries toolsTotal ${headC?.toolsTotal}, toolsCapped ${headC?.toolsCapped}`);
    const storedC = await A._storedEntryForTest(AGAIN);
    ok(storedC?.tools?.length === CAP && storedC.tools.every((t) => typeof t.description === "string" && t.description.length > 0) && digest(storedC) === heldC.digest, "the table assembles to the capped entry C holds, described tools first");
    const orphans = partsBefore.length + saveC.stats.written - CAP_PARTS;
    ok((await partRows(AGAIN)).length === partsBefore.length + saveC.stats.written && saveC.stats.swept === 0, `the old parts stay inside C's grace (${partsBefore.length} + ${saveC.stats.written} rows)`);
    ok((await A.__testSweepOrphanParts()) === orphans && (await partRows(AGAIN)).length === CAP_PARTS, `A's sweep takes the ${orphans} parts no header names; ${CAP_PARTS} named parts remain`);
    // A pulls the capped copy: the cap is a newer revision of the row, so both
    // containers hold the 5,000 (A, whose own cap is far above, reads the pair
    // as a cap it does not apply and drops it, as after a raised cap).
    await A.pullIndexChanges();
    ok(A._cacheForTests().get(AGAIN)?.tools?.length === CAP, `A pulls the capped copy (${A._cacheForTests().get(AGAIN)?.tools?.length} tools)`);
    // A fresh large seller saved under the cap is parts from the start.
    const FRESH = "https://seller-fresh.example";
    const seeded = await C.ask("seedAndSave", { origin: FRESH, n: 79_000, fetchedAt: 5_000_000 });
    const headF = await sdb.records.get(COLLECTION, FRESH);
    ok(seeded.saved === true && headF?.parts?.tools === CAP && headF.parts.hashes.length === CAP_PARTS && headF.toolsTotal === 79_000 && headF.toolsCapped === true && (await partRows(FRESH)).length === CAP_PARTS,
      `a 79,000-tool seller saved under the cap stores ${headF?.parts?.tools} tools in ${headF?.parts?.hashes?.length} parts with toolsTotal ${headF?.toolsTotal}`);
    // D warm-starts the capped rows: not cut again, nothing rewritten.
    const D = await forkContainer("d", { INDEX_SELLER_TOOL_CAP: String(CAP) });
    children.push(D);
    const warmD = await D.ask("warm");
    const heldD = await D.ask("held", { origin: AGAIN });
    ok(warmD.n === 23 && heldD?.tools === CAP && heldD.toolsTotal === N && heldD.digest === digest(await A._storedEntryForTest(AGAIN)), "D warm-starts the capped row as stored (not cut again, the same total)");
    const saveD = await D.ask("save");
    ok(saveD.saved === true && saveD.stats.written === 0 && saveD.stats.skipped === 0, `D's save rewrites no part (${saveD.stats.written} written)`);
    ok((await sdb.records.count(PARTS_COLLECTION)) === 2 * CAP_PARTS, `the parts collection holds the ${2 * CAP_PARTS} named parts and nothing else`);
  } catch (e) {
    fail++; console.error("FAIL - threw:", e?.stack || e);
  } finally {
    for (const c of children) await c.exit();
    await sdb.__dropStateSchema().catch(() => {});
    await sdb.closeStateDb();
    rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\ntest-index-parts-pg: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (IS_B) await containerB(); else await main();
