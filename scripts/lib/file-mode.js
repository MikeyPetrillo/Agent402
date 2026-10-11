// Side-effect import for a test that exercises the FILE backends: the state
// database and Redis are switched off for this process and every child it
// spawns with `{ ...process.env }`.
//
// Why it exists: STATE_DATABASE_URL and REDIS_URL select a store's backend when
// the module is first imported. A test that asserts file behavior (a ledger on
// disk, a cache file warm-started synchronously, "off without a state
// database") fails, or never exits, when the caller's shell exports either one,
// and it would write its fixtures into whatever database that shell points at.
// CI runs these tests without the variables, so only a local run saw it.
//
// Import it FIRST, before any module under src/: ES modules evaluate their
// imports in order, so this runs before a later import reads the environment.
//   import "./lib/file-mode.js";
// The tests that are meant to run against a real database are the *-pg.js
// suites and the CI step that sets STATE_DATABASE_URL; they never import this.
delete process.env.STATE_DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.LEDGER_JOURNAL_REDIS;
