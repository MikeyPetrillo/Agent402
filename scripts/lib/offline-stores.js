// Pins an offline suite to the per-process and file backends.
//
// Several modules choose their backend once, at import: REDIS_URL puts the
// shared controls (spend guard, composite guard, hang-up budget, CoinGecko and
// Databento shared budgets, replay guard, registration limits) in shared mode,
// where a decision is a promise and the state outlives the process, and
// STATE_DATABASE_URL moves the stores (refund ledger, sales ledger, seller
// index, task store) to Postgres. A suite written against the per-process
// backend then reads a promise as a decision, or a key or row an earlier run
// left (a fixed nonce read as consumed, a cached quote read as a hit), when a
// developer's shell or a runner exports either variable. CI runs these suites
// with neither; the shared and Postgres backends have their own suites
// (the *-redis.js and *-pg.js scripts).
//
// Import this FIRST (before any src/ module), so it runs before those modules
// read the environment; children the suite spawns inherit the pinned env.
// scripts/test-offline-stores-import.js checks that every offline suite does.
//
// A suite that re-runs itself in a child with a store variable it chose (a
// dead Redis address that an injected test client stands in for) names that
// variable in OFFLINE_STORES_KEEP in the child's env, comma-separated; the
// child keeps it and drops the rest. The list is read once and removed, so a
// grandchild starts pinned again.
import "./own-stats.js"; // a stats store of this suite's own (see the file)
const keep = new Set(String(process.env.OFFLINE_STORES_KEEP || "").split(",").map((s) => s.trim()).filter(Boolean));
delete process.env.OFFLINE_STORES_KEEP;
for (const k of ["REDIS_URL", "STATE_DATABASE_URL", "STATE_DATABASE_URL_FOR_TEST", "LEDGER_JOURNAL_REDIS"]) if (!keep.has(k)) delete process.env[k];
