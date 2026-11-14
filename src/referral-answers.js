// The answers the referral gate owes, at rest (src/referral-gate.js), one per
// record, apart from the book's index (src/referral-book.js): a write is the
// one answer, never the whole set, so a busy book does not hold the event loop.
//
// With a state database each answer is a row of the `referral-answers`
// collection; without one a file per answer under a directory (beside the
// book's file); with neither, memory. An answer is kept only while it is
// owed and at most until its `expiresAt` (the gate sets it from the published
// retention: a short time after the answer was produced, never past the
// authorization's validBefore plus a grace); `sweep` deletes what is past it.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { records, stateDbEnabled } from "./state-db.js";

export const ANSWER_COLLECTION = "referral-answers";
const ID = /^[0-9a-f]{64}$/;
/** The record id of a replay key ("referral:<sha256>"). */
export const answerIdOf = (key) => { const id = String(key || "").replace(/^referral:/, ""); return ID.test(id) ? id : null; };

export function createReferralAnswerStore({ dir = null, now = Date.now } = {}) {
  if (stateDbEnabled()) {
    return {
      backend: "pg",
      async put(key, body) { const id = answerIdOf(key); if (!id) return false; await records.put(ANSWER_COLLECTION, id, body); return true; },
      async get(key) { const id = answerIdOf(key); if (!id) return null; const b = await records.get(ANSWER_COLLECTION, id); return b && Number(b.expiresAt) > now() ? b : null; },
      async del(key) { const id = answerIdOf(key); if (!id) return false; return records.del(ANSWER_COLLECTION, id); },
      async sweep() {
        let n = 0, after = "";
        for (;;) {
          const page = await records.list(ANSWER_COLLECTION, { limit: 500, after });
          if (!page.length) break;
          for (const r of page) if (!(Number(r.body?.expiresAt) > now())) { await records.del(ANSWER_COLLECTION, r.id); n++; }
          after = page[page.length - 1].id;
          if (page.length < 500) break;
        }
        return n;
      },
    };
  }
  if (dir) {
    const fileOf = (id) => join(dir, `${id}.json`);
    const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); };
    return {
      backend: "file",
      async put(key, body) {
        const id = answerIdOf(key);
        if (!id) return false;
        ensure();
        const tmp = `${fileOf(id)}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(body));
        renameSync(tmp, fileOf(id));
        return true;
      },
      async get(key) {
        const id = answerIdOf(key);
        if (!id) return null;
        try { const b = JSON.parse(readFileSync(fileOf(id), "utf8")); return b && Number(b.expiresAt) > now() ? b : null; } catch { return null; }
      },
      async del(key) { const id = answerIdOf(key); if (!id) return false; try { rmSync(fileOf(id), { force: true }); return true; } catch { return false; } },
      async sweep() {
        let n = 0, files = [];
        try { files = readdirSync(dir); } catch { return 0; }
        for (const f of files) {
          if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
          let b = null;
          try { b = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { b = null; }
          if (!(Number(b?.expiresAt) > now())) { try { rmSync(join(dir, f), { force: true }); n++; } catch { /* the next pass */ } }
        }
        return n;
      },
    };
  }
  const mem = new Map();
  return {
    backend: "memory",
    async put(key, body) { const id = answerIdOf(key); if (!id) return false; mem.set(id, body); return true; },
    async get(key) { const id = answerIdOf(key); const b = id ? mem.get(id) : null; return b && Number(b.expiresAt) > now() ? b : null; },
    async del(key) { const id = answerIdOf(key); return id ? mem.delete(id) : false; },
    async sweep() { let n = 0; for (const [id, b] of mem) if (!(Number(b?.expiresAt) > now())) { mem.delete(id); n++; } return n; },
  };
}
