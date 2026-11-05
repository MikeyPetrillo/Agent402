// A large seller's index entry stored in parts.
//
// The crawled seller index keeps one state-database row per seller origin
// (collection "x402-index", id = origin). One seller lists about 77,000 tools,
// and its row ran to 84 MB: the statement carrying it outlasted the default
// limit, and a boot held the event loop reading it. An entry with more than
// PART_TOOLS tools is stored instead as a HEADER row under the origin, holding
// every field but the tools and naming its parts, plus one PART row per
// PART_TOOLS tools in the collection PARTS_COLLECTION.
//
// A part is content-addressed: its id is `${origin}#${sha1 hex of its tools'
// JSON, keys sorted}`, its body `{ origin, hash, tools }`. The header lists the hashes in
// order (`parts.hashes`) and the total (`parts.tools`). So:
//   - a save writes only the parts whose hash the table does not hold yet
//     (an unchanged part keeps its row), then the header under the same
//     newer-wins rule as a whole row; a part row is never rewritten;
//   - a reader takes the header, then the parts it names, and accepts a part
//     only when its stored hash is the one the header names; a part missing
//     or different belongs to another save, so the reader takes the header
//     again (a save may have landed between the two reads) or keeps the copy
//     it holds. Two saves can never be mixed into one entry, because a part
//     is immutable and the header is the one row that changes;
//   - the entry assembled from a header and its parts deep-equals the whole
//     row the single-row format would have stored (the same slim entry, the
//     tools in order);
//   - a part no header names (the seller shrank or changed, or a header write
//     was refused as older) is swept once it is older than the orphan grace,
//     which outlasts any save, so a sibling container's parts written ahead
//     of its header are never taken from under it.
// An entry of PART_TOOLS tools or fewer is one row, as before; a header row
// moves back to one row on the save that finds it small, and its parts are
// swept.
import { createHash } from "node:crypto";

/** Tools per part; a seller with more tools than this is stored in parts.
 *  INDEX_PART_TOOLS overrides it (a very large value keeps every seller in
 *  one row, the fallback the large-row statement limit still serves). */
export const PART_TOOLS = (() => { const n = Number(process.env.INDEX_PART_TOOLS); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2000; })();
export const PARTS_COLLECTION = "x402-index-parts";
/** A part row not named by any header is deleted once older than this. It
 *  must exceed the longest save (parts written, then the touch-and-header
 *  transaction): a sweep that waits on that transaction re-reads the touched
 *  rows' stamps against its own now(), so 0 is for single-process tests only. */
export const PARTS_ORPHAN_GRACE_MS = (() => { const n = Number(process.env.INDEX_PARTS_ORPHAN_GRACE_MS); return Number.isFinite(n) && n >= 0 && String(process.env.INDEX_PARTS_ORPHAN_GRACE_MS ?? "").trim() !== "" ? n : 10 * 60_000; })();
const PART_ID_SEP = "#";
const HASH_HEX_LEN = 40;

export const partHash = (text) => createHash("sha1").update(text).digest("hex");
/** JSON.stringify(value) with every object's keys in sorted order, at every
 *  depth. A part's hash is taken over this text: a copy read back from jsonb
 *  has its keys in another order, and a part re-saved from such a copy must
 *  hash as the part it is, or every part would be written again after a
 *  warm start or a pull. */
const sortedKeys = (k, v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const keys = Object.keys(v);
  for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) { keys.sort(); return Object.fromEntries(keys.map((key) => [key, v[key]])); }
  return v;
};
export const canonicalJson = (value) => JSON.stringify(value, sortedKeys);
export const partId = (origin, hash) => `${origin}${PART_ID_SEP}${hash}`;
/** The origin and hash a part id names, or null when it is not one. */
export function parsePartId(id) {
  if (typeof id !== "string" || id.length <= HASH_HEX_LEN + 1 || id[id.length - HASH_HEX_LEN - 1] !== PART_ID_SEP) return null;
  const hash = id.slice(-HASH_HEX_LEN);
  return /^[0-9a-f]{40}$/.test(hash) ? { origin: id.slice(0, -HASH_HEX_LEN - 1), hash } : null;
}
/** Whether a persisted entry is stored in parts. */
export function isParted(entry, partTools = PART_TOOLS) {
  return Array.isArray(entry?.tools) && entry.tools.length > partTools;
}
/** Whether a stored body is a header naming parts. */
export function isPartedHeader(body) {
  return Boolean(body && typeof body === "object" && body.parts && typeof body.parts === "object" && Array.isArray(body.parts.hashes));
}
/** The hashes a header names, each read as a hash or the header is not one. */
export function headerHashes(header) {
  if (!isPartedHeader(header)) return null;
  const hs = header.parts.hashes;
  return hs.every((h) => typeof h === "string" && /^[0-9a-f]{40}$/.test(h)) ? hs : null;
}
export const headerPartIds = (origin, header) => (headerHashes(header) || []).map((h) => partId(origin, h));

/** Split a persisted entry into its header and parts. `tick` is awaited
 *  between parts (one part is about 2 MB of JSON, a few milliseconds).
 *  Resolves { header, parts: [{ hash, id, text, count }] }: `text` is the
 *  part row's JSON body; `header` is the entry without its tools plus
 *  `parts: { tools, size, hashes }`. */
export async function splitEntry(origin, entry, { partTools = PART_TOOLS, tick = async () => {} } = {}) {
  const tools = Array.isArray(entry?.tools) ? entry.tools : [];
  const parts = [];
  for (let from = 0; from < tools.length; from += partTools) {
    const slice = tools.slice(from, from + partTools);
    // A hole in the array serializes as null, as it does in the whole row.
    const text = canonicalJson(slice);
    const hash = partHash(text);
    parts.push({ hash, id: partId(origin, hash), text: `{"origin":${JSON.stringify(origin)},"hash":${JSON.stringify(hash)},"tools":${text}}`, count: slice.length });
    await tick();
  }
  const { tools: _tools, ...rest } = entry;
  const header = { ...rest, parts: { tools: tools.length, size: partTools, hashes: parts.map((p) => p.hash) } };
  return { header, parts };
}
/** The hashes of `next` that `previous` (the hashes already stored) does not hold: the parts a save writes. */
export function changedPartHashes(previous, next) {
  const had = new Set(Array.isArray(previous) ? previous : []);
  return [...new Set((Array.isArray(next) ? next : []).filter((h) => !had.has(h)))];
}
/** The stored part ids of `origin` that `header` does not name (every one when `header` is null or not a header): the parts to delete. */
export function orphanPartIds(origin, storedIds, header) {
  const named = new Set(headerPartIds(origin, header));
  return (Array.isArray(storedIds) ? storedIds : []).filter((id) => { const p = parsePartId(id); return p && p.origin === origin && !named.has(id); });
}
/** The entry a header and its parts make, or null when the parts do not
 *  match the header: a hash it names is missing, a part's stored hash is not
 *  the one named, a part holds no tool array, or the total is not the
 *  header's. `partsByHash` maps hash -> part body ({ hash, tools }). The
 *  result has every header field but `parts`, and `tools` in part order. */
export function assembleEntry(origin, header, partsByHash) {
  const hashes = headerHashes(header);
  if (!hashes) return null;
  const get = (h) => (partsByHash instanceof Map ? partsByHash.get(h) : partsByHash?.[h]);
  let total = 0;
  const tools = [];
  for (const h of hashes) {
    const p = get(h);
    if (!p || typeof p !== "object" || p.hash !== h || !Array.isArray(p.tools)) return null;
    if (typeof p.origin === "string" && p.origin !== origin) return null;
    total += p.tools.length;
    for (const t of p.tools) tools.push(t);
  }
  if (Number(header.parts.tools) !== total) return null;
  const { parts: _parts, ...rest } = header;
  return { ...rest, tools };
}
