// The answers the referral gate owes, at rest (src/referral-gate.js), one per
// record, apart from the book's index (src/referral-book.js): a write is the
// one answer, never the whole set, so a busy book does not hold the event loop.
//
// A file per answer under a directory on this process's own disk; with no
// directory, memory. NEVER the state database: its rows are copied by the
// nightly backup, and an answer must not outlive its few minutes there. The
// directory's name carries "cache", which the file backup leaves out
// (src/backup.js). One replica serves this route, so the process that ran a
// call is the one a re-send reaches; a restart loses the answers, and a
// charged buyer whose answer is gone is owed back (src/referral-gate.js).
// An answer is kept only while it is
// owed and at most until its `expiresAt` (the gate sets it from the published
// retention: a short time after the answer was produced, never past the
// authorization's validBefore plus a grace); `sweep` deletes what is past it.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The directory's name: it must match the backup's cache exclusion. */
export const ANSWER_DIR_NAME = "agent402-referral-answer-cache";
const ID = /^[0-9a-f]{64}$/;
/** The record id of a replay key ("referral:<sha256>"). */
export const answerIdOf = (key) => { const id = String(key || "").replace(/^referral:/, ""); return ID.test(id) ? id : null; };

export function createReferralAnswerStore({ dir = null, now = Date.now } = {}) {
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
