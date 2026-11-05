// Verifies the self-check semantic invariants (src/selfcheck.js INVARIANTS) are
// MEANINGFUL: each must pass a known-good result AND fail a broken one, so a
// green self-check on prod genuinely means the tool returned the right answer —
// not that a rubber-stamp invariant always returns true. Pure logic, no network;
// the live tools are exercised against these same invariants by /api/selfcheck.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert";
import { INVARIANTS } from "../src/selfcheck.js";

// good = a correct result the invariant MUST accept; bad = a broken/garbage
// result (empty, wrong value, shape drift) the invariant MUST reject.
const FIXTURES = {
  "vin-decode":         { good: { vehicle: { make: "HONDA", year: "2003" } }, bad: { vehicle: { make: "TOYOTA", year: "2003" } } },
  "vehicle-recalls":    { good: { count: 2, recalls: [{ campaign: "20V314000" }] }, bad: { count: 0, recalls: [] } },
  "drug-recalls":       { good: { count: 1, recalls: [{ classification: "Class II" }] }, bad: { count: 0, recalls: [] } },
  "food-recalls":       { good: { count: 3 }, bad: { count: 0 } },
  "drug-adverse-events":{ good: { topReactions: [{ reaction: "NAUSEA", reports: 100 }] }, bad: { topReactions: [] } },
  "device-recalls":     { good: { count: 3, recalls: [{ classification: "Class II" }] }, bad: { count: 0, recalls: [] } },
  "college-lookup":     { good: { count: 1, colleges: [{ name: "Stanford University", state: "CA" }] }, bad: { count: 1, colleges: [{ name: "Harvard University", state: "MA" }] } },
  "fec-candidates":     { good: { count: 2, candidates: [{ candidateId: "S2MA00170" }] }, bad: { count: 0, candidates: [] } },
  "federal-awards":     { good: { count: 2, awards: [{ amountUsd: 48063737196.35 }] }, bad: { count: 0, awards: [] } },
  "geo-lookup":         { good: { state: "CA", county: "Los Angeles County" }, bad: { state: "NY", county: "New York County" } },
  "fema-disasters":     { good: { count: 3, disasters: [{ disasterNumber: 4812 }] }, bad: { count: 0, disasters: [] } },
  "stock-quote":        { good: { symbol: "AAPL", price: 200.5 }, bad: { symbol: "AAPL", price: 0 } },
  "treasury-debt":      { good: { totalPublicDebtOutstanding: 39e12 }, bad: { totalPublicDebtOutstanding: 5 } },
  "crypto-global":      { good: { totalMarketCap: 2e12, btcDominancePct: 52 }, bad: { totalMarketCap: 0, btcDominancePct: 0 } },
  "whois":              { good: { domain: "example.com", nameservers: ["a.iana-servers.net"] }, bad: { domain: "", nameservers: null } },
};

// Every invariant must have a fixture — guards against shipping an untested one.
assert.deepStrictEqual(
  Object.keys(INVARIANTS).sort(),
  Object.keys(FIXTURES).sort(),
  "every INVARIANT needs a good/bad fixture (and vice-versa)",
);

let n = 0;
for (const [slug, inv] of Object.entries(INVARIANTS)) {
  const { good, bad } = FIXTURES[slug];
  assert.strictEqual(!!inv(good), true, `invariant "${slug}" must PASS its good fixture`);
  assert.strictEqual(!!inv(bad), false, `invariant "${slug}" must FAIL its broken fixture`);
  n++;
}
console.log(`invariants: ${n}/${n} meaningful (good passes, broken fails)`);
