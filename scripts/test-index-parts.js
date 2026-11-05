#!/usr/bin/env node
// A large seller's index entry is stored as a header and parts
// (src/index-parts.js). Offline: the split and the assembly are pure.
//   - a seller of 77,000 synthetic tools splits into ceil(77000 / 2000) parts
//     of at most 2,000 tools, and the entry assembled from them deep-equals
//     the whole entry the single-row format stores;
//   - a change inside one part changes that part's hash alone, so a save
//     rewrites that one part;
//   - a seller that shrinks under the part size is one row again, and every
//     part it had is named for deletion;
//   - parts from another save (a hash the header does not name, or a stored
//     hash that is not the named one) are refused, never mixed in.
import "./lib/offline-stores.js"; // per-process backends whatever the caller exports
import { PART_TOOLS, PARTS_COLLECTION, splitEntry, assembleEntry, changedPartHashes, orphanPartIds, isParted, isPartedHeader, headerPartIds, partId, parsePartId, partHash, canonicalJson } from "../src/index-parts.js";
import { deepStrictEqual } from "node:assert";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const deepEqual = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };

const ORIGIN = "https://seller-big.example/catalog";
function tool(k) {
  return {
    route: `/api/item/${k}`, method: k % 3 ? "GET" : "POST", name: `item ${k} 漢字 \u{1F600}`,
    description: `Returns item ${k} with pagination, filters and documented error codes. `.repeat(4),
    price: `$0.00${1 + (k % 9)}`, network: "eip155:8453", payTo: "0x" + "ab".repeat(20), tags: ["item", "x402"],
    quotedAt: 1_700_000_000_000 + k, networks: ["eip155:8453", "eip155:137"], nested: { a: [1, 2, { b: null }], c: false },
  };
}
const N = 77_000;
const tools = Array.from({ length: N }, (_, k) => tool(k));
const entry = { manifest: { name: "Big", homepage: ORIGIN, x402Version: 2 }, tools, fetchedAt: 1_000_000, error: null, source: "crawl", discoveryPath: "/.well-known/x402", history: [{ at: 1, ok: true }], paywall: null, updatedAt: 1_000_001 };
// What a single row holds after a jsonb round trip: the same entry (key order aside).
const asStored = (v) => JSON.parse(JSON.stringify(v));

// ---- split and assemble -----------------------------------------------------
ok(PART_TOOLS === 2000, `the part size is 2,000 tools (${PART_TOOLS})`);
ok(PARTS_COLLECTION !== "x402-index", `parts live in their own collection (${PARTS_COLLECTION}), so a page of seller rows never lists one`);
ok(isParted(entry) && !isParted({ tools: tools.slice(0, PART_TOOLS) }) && isParted({ tools: tools.slice(0, PART_TOOLS + 1) }), "an entry is parted only past the part size");
let ticks = 0;
const { header, parts } = await splitEntry(ORIGIN, entry, { tick: async () => { ticks++; } });
const expectedParts = Math.ceil(N / PART_TOOLS);
ok(parts.length === expectedParts, `${N} tools split into ${parts.length} parts (expected ${expectedParts})`);
ok(parts.every((p) => p.count <= PART_TOOLS) && parts.slice(0, -1).every((p) => p.count === PART_TOOLS) && parts.at(-1).count === N % PART_TOOLS, "every part but the last holds exactly the part size; the last holds the rest");
ok(ticks >= parts.length, `the split yields between parts (${ticks} ticks)`);
ok(isPartedHeader(header) && header.parts.tools === N && header.parts.hashes.length === parts.length && !("tools" in header), "the header names its parts and total and carries no tools");
{ const h = { ...header }, e = { ...entry }; delete h.parts; delete e.tools; ok(deepEqual(h, e), "the header carries every other field of the entry"); }
ok(parts.every((p) => p.id === partId(ORIGIN, p.hash) && parsePartId(p.id)?.origin === ORIGIN && parsePartId(p.id)?.hash === p.hash), "a part id is the origin and its content hash, and parses back");
ok(parts.every((p) => p.hash === partHash(canonicalJson(JSON.parse(p.text).tools))), "a part's hash is the hash of its tools' JSON text with sorted keys");
{
  // The same tools with their keys in another order (as jsonb returns them) hash the same.
  const reordered = tools.slice(0, 2500).map((t) => Object.fromEntries(Object.keys(t).reverse().map((k) => [k, k === "nested" ? Object.fromEntries(Object.keys(t[k]).reverse().map((n) => [n, t[k][n]])) : t[k]])));
  const r = await splitEntry(ORIGIN, { ...entry, tools: reordered });
  const o = await splitEntry(ORIGIN, { ...entry, tools: tools.slice(0, 2500) });
  ok(r.header.parts.hashes.join() === o.header.parts.hashes.join() && JSON.stringify(reordered[0]) !== JSON.stringify(tools[0]), "a copy read back with its keys reordered hashes as the same parts");
  ok(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }) === '{"a":[{"c":2,"d":1}],"b":1}' && canonicalJson([1, , 3]) === "[1,null,3]", "the canonical text sorts keys at every depth and writes a hole as null");
}
const largest = Math.max(...parts.map((p) => p.text.length));
ok(largest < 8 * 1_048_576, `the largest part row is ${(largest / 1_048_576).toFixed(1)} MB of text, far under the large-row limit`);
const stored = new Map(parts.map((p) => [p.hash, asStored(JSON.parse(p.text))]));
const assembled = assembleEntry(ORIGIN, asStored(header), stored);
ok(assembled && deepEqual(assembled, asStored(entry)), "the entry assembled from the stored header and parts deep-equals the stored single row");
ok(assembled.tools.length === N && assembled.tools[N - 1].route === `/api/item/${N - 1}` && assembled.tools[2000].route === "/api/item/2000", "every tool is back, in order, across part boundaries");
ok(!("parts" in assembled), "the assembled entry carries no parts key");
// A hole in the tool array stores as null either way.
{
  const holey = { ...entry, tools: tools.slice(0, 4100) };
  delete holey.tools[2500];
  const s = await splitEntry(ORIGIN, holey);
  const back = assembleEntry(ORIGIN, asStored(s.header), new Map(s.parts.map((p) => [p.hash, asStored(JSON.parse(p.text))])));
  ok(deepEqual(back, asStored(holey)) && back.tools[2500] === null, "a hole in the tools stores as null in parts as in one row");
}

// ---- only the changed part is rewritten ---------------------------------------
{
  const changed = { ...entry, fetchedAt: entry.fetchedAt + 1, tools: tools.slice() };
  changed.tools[40_123] = { ...changed.tools[40_123], description: "changed" };
  const s2 = await splitEntry(ORIGIN, changed);
  const toWrite = changedPartHashes(header.parts.hashes, s2.header.parts.hashes);
  ok(toWrite.length === 1 && toWrite[0] === s2.header.parts.hashes[Math.floor(40_123 / PART_TOOLS)], `one tool changed: one part to write (${toWrite.length}), the part holding it`);
  ok(s2.header.parts.hashes.filter((h, i) => h === header.parts.hashes[i]).length === parts.length - 1, "every other part keeps its hash, so its row is not sent again");
  const orphans = orphanPartIds(ORIGIN, parts.map((p) => p.id), s2.header);
  ok(orphans.length === 1 && orphans[0] === parts[Math.floor(40_123 / PART_TOOLS)].id, "the replaced part is the one orphan to delete");
  ok(changedPartHashes(undefined, s2.header.parts.hashes).length === parts.length, "with nothing stored every part is written");
  // The stamp alone changing (a re-crawl with the same catalogue) rewrites no part.
  const s3 = await splitEntry(ORIGIN, { ...entry, fetchedAt: entry.fetchedAt + 5 });
  ok(changedPartHashes(header.parts.hashes, s3.header.parts.hashes).length === 0, "a re-crawl that changes only the stamp writes the header alone");
}

// ---- shrink under the part size: one row again ------------------------------------
{
  const small = { ...entry, tools: tools.slice(0, 1500) };
  ok(!isParted(small), "a seller of 1,500 tools is not parted");
  const gone = orphanPartIds(ORIGIN, parts.map((p) => p.id), null);
  ok(gone.length === parts.length, `with no header every stored part of the origin is named for deletion (${gone.length})`);
  const other = orphanPartIds(ORIGIN, [...parts.map((p) => p.id), partId("https://other.example", "a".repeat(40)), "not-a-part"], null);
  ok(other.length === parts.length, "another origin's parts, and ids that are not part ids, are never named");
  ok(headerPartIds(ORIGIN, small).length === 0 && !isPartedHeader(small), "a whole entry names no parts");
}

// ---- a mix of two saves is refused -------------------------------------------------
{
  const s2 = await splitEntry(ORIGIN, { ...entry, tools: tools.map((t, k) => (k === 10 ? { ...t, name: "other save" } : t)) });
  const mixed = new Map(stored);
  // The reader holds the old header but the table now has the new first part.
  mixed.delete(parts[0].hash);
  mixed.set(s2.parts[0].hash, asStored(JSON.parse(s2.parts[0].text)));
  ok(assembleEntry(ORIGIN, asStored(header), mixed) === null, "a part the header names that is missing refuses the assembly (another save replaced it)");
  const wrongHash = new Map(stored);
  wrongHash.set(parts[3].hash, { ...stored.get(parts[3].hash), hash: s2.parts[0].hash });
  ok(assembleEntry(ORIGIN, asStored(header), wrongHash) === null, "a part whose stored hash is not the named one is refused");
  const wrongOrigin = new Map(stored);
  wrongOrigin.set(parts[5].hash, { ...stored.get(parts[5].hash), origin: "https://other.example" });
  ok(assembleEntry(ORIGIN, asStored(header), wrongOrigin) === null, "a part stored for another origin is refused");
  const short = new Map(stored);
  short.set(parts[7].hash, { ...stored.get(parts[7].hash), tools: stored.get(parts[7].hash).tools.slice(0, 10) });
  ok(assembleEntry(ORIGIN, asStored(header), short) === null, "a total that is not the header's is refused");
  ok(assembleEntry(ORIGIN, { ...header, parts: { tools: N, hashes: ["zz"] } }, stored) === null, "a header whose hashes are not hashes is refused");
  ok(assembleEntry(ORIGIN, asStored(entry), stored) === null, "a whole entry is not a header");
  // The same tools stored twice (two parts with one content) read once, placed twice.
  const dup = { ...entry, tools: [...tools.slice(0, 2000), ...tools.slice(0, 2000), ...tools.slice(0, 100)] };
  const sd = await splitEntry(ORIGIN, dup);
  ok(sd.parts.length === 3 && sd.header.parts.hashes[0] === sd.header.parts.hashes[1], "two parts with the same tools share one row");
  const dupBack = assembleEntry(ORIGIN, asStored(sd.header), new Map(sd.parts.map((p) => [p.hash, asStored(JSON.parse(p.text))])));
  ok(deepEqual(dupBack, asStored(dup)), "...and the entry assembles whole");
}

console.log(`\ntest-index-parts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
