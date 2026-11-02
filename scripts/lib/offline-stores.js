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
for (const k of ["REDIS_URL", "STATE_DATABASE_URL", "STATE_DATABASE_URL_FOR_TEST", "LEDGER_JOURNAL_REDIS"]) delete process.env[k];
