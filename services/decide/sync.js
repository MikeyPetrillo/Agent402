// Pull the unified index from the main app and bring the local index, and its
// store, in step: new or changed rows upserted, vanished rows dropped, missing
// vectors embedded (a bounded number per cycle).
//
// A partial stream (the connection drops before the __end line) changes
// nothing: dropping every row the stream did not reach would empty the index
// on a network blip. Only a complete stream may delete.

import { embedText } from "../../src/decide/tool-rows.js";
import { quantize } from "./vectors.js";

const perCycle = () => {
  const n = Number(process.env.DECIDE_EMBED_PER_CYCLE);
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
};

const MAX_LINE = 1_000_000;

/** Parse an NDJSON body (string or async iterable of chunks). */
export async function* ndjsonRows(body) {
  let buf = "";
  const chunks = typeof body === "string" ? [body] : body;
  const dec = new TextDecoder();
  for await (const c of chunks) {
    buf += typeof c === "string" ? c : dec.decode(c, { stream: true });
    if (buf.length > MAX_LINE && buf.indexOf("\n") < 0) throw new Error("index stream line too long");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}

export async function syncIndex({ index, store, source, embed, now = Date.now() }) {
  const seen = new Set();
  const changed = [];
  let complete = false, total = 0, dupes = 0;
  for await (const row of ndjsonRows(await source())) {
    if (row && row.__end) { complete = true; total = row.rows; break; }
    if (!row || typeof row.id !== "string") continue;
    // An id seen earlier in this same stream is skipped: the first row wins,
    // and a batch never names one row twice (Postgres refuses an upsert that
    // touches the same row twice, which would fail the whole sync).
    if (seen.has(row.id)) { dupes++; continue; }
    seen.add(row.id);
    const prev = index.rows.get(row.id);
    // Besides the text, the fields a plan acts on: whether execute can pay the
    // tool, how well its inputs are described, and its output fields. A change
    // to any of them alone used to leave the old row in place until the text
    // or live time also moved.
    if (!prev || prev.contentHash !== row.contentHash || prev.lastLiveAt !== row.lastLiveAt || prev.health !== row.health
      || (prev.executable !== false) !== (row.executable !== false) || prev.schemaQuality !== row.schemaQuality
      || JSON.stringify(prev.outputFields || []) !== JSON.stringify(row.outputFields || [])) {
      index.upsert(row);
      changed.push(row);
    }
  }
  if (changed.length) await store.upsert(changed);
  let removed = 0;
  if (complete) {
    const gone = [...index.rows.keys()].filter((id) => !seen.has(id));
    for (const id of gone) index.delete(id);
    if (gone.length) await store.deleteIds(gone);
    removed = gone.length;
  }
  let embedded = 0, embedError = null;
  const missing = index.missingVectors().slice(0, perCycle());
  for (let i = 0; i < missing.length; i += 512) {
    const ids = missing.slice(i, i + 512);
    try {
      const vecs = await embed(ids.map((id) => embedText(index.rows.get(id))));
      const pairs = ids.map((id, j) => ({ id, hash: index.rows.get(id).contentHash, vec: quantize(vecs[j]) }));
      for (const p of pairs) index.setVector(p.id, p.vec);
      await store.setVectors(pairs);
      embedded += ids.length;
    } catch (e) {
      embedError = String(e?.message || e).slice(0, 160);
      break;
    }
  }
  return { complete, streamed: seen.size, duplicates: dupes, declared: total, changed: changed.length, removed, embedded, embedError, rows: index.size, vectors: index.vectors.count, at: now };
}

/** Load a persisted index at boot. */
export async function loadIndex({ index, store }) {
  let n = 0;
  await store.load((row, vec) => {
    index.upsert(row);
    if (vec) index.setVector(row.id, vec);
    n++;
  });
  return n;
}
