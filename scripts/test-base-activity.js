// Offline tests for baseActivityViaSql — the guard/fail-safe paths that must
// hold without CDP credentials (the happy path is validated against prod CDP via
// railway run; ClickHouse isn't reachable from CI). Ensures a missing-creds or
// bad-input call returns a clean, well-shaped "empty" result so the marketplace
// panel falls back to the RPC scan instead of throwing.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { baseActivityViaSql } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("NOT OK -", m); } };
const shapeOk = (a) =>
  a && typeof a === "object" && Array.isArray(a.buckets) && a.totals &&
  ["tx", "usd", "buyers", "internalTx", "internalUsd"].every((k) => typeof a.totals[k] === "number") &&
  typeof a.truncated === "boolean";

// Guard: CI has no CDP_API_KEY_* — every call must return a clean empty result,
// never throw, so getActivityForChain can fall back to evmActivity.
delete process.env.CDP_API_KEY_ID;
delete process.env.CDP_API_KEY_SECRET;

const good = await baseActivityViaSql("0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808");
ok(shapeOk(good), "no creds: returns a well-shaped result object");
ok(good.error === "cdp not configured", "no creds: reports 'cdp not configured' so caller falls back");
ok(good.totals.tx === 0 && good.buckets.length === 0, "no creds: empty totals + buckets (never a partial number)");
ok(good.rail === "Base", "result is tagged rail=Base");

const bad = await baseActivityViaSql("not-an-address");
ok(shapeOk(bad) && bad.error === "invalid wallet", "invalid wallet: clean 'invalid wallet' error, no throw");

const empty = await baseActivityViaSql("");
ok(shapeOk(empty) && empty.error === "invalid wallet", "empty wallet: clean error, no throw");

// A checksummed wallet must still be accepted (regex is case-insensitive) — the
// guard rejects only genuinely malformed input, not valid mixed-case addresses.
const mixed = await baseActivityViaSql("0xAbCdef0123456789abcdef0123456789ABCDef01");
ok(mixed.error === "cdp not configured", "mixed-case valid address passes shape validation (fails only on creds)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
