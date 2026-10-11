// Is a value kept in a money journal (src/ledger-mirror.js createDeadLetter)?
// With REDIS_URL set the journal is in Redis (src/ledger-journal-redis.js),
// under a key named for the state schema and the journal; else it is the
// NDJSON file beside the store. A suite that runs in either mode asks here.
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "redis";

/** True when the journal `prefix` (e.g. "decide", "subscriptions:") of `schema` holds `needle`, in Redis or in `file`. */
export async function journalHolds({ schema, prefix, needle, file = null }) {
  if (file && existsSync(file) && readFileSync(file, "utf8").includes(needle)) return true;
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) return false;
  const c = createClient({ url });
  c.on("error", () => {});
  await c.connect();
  try {
    const keys = await c.keys(`a402:journal:{${schema}:${prefix}*}:items`);
    for (const k of keys) for (const v of await c.hVals(k)) if (v.includes(needle)) return true;
    return false;
  } finally { await c.quit().catch(() => {}); }
}
