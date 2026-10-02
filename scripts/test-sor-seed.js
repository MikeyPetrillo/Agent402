// Validates the committed SOR seed list: a discovery hint, never gate evidence
// (the gate side of that is pinned in test-sor-payto-binding.js).
//   node scripts/test-sor-seed.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const seed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sor-seed-sellers.json"), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

ok(seed.threshold === 50, "threshold is 50");
ok(typeof seed.origins === "object" && seed.origins, "origins is an object");
const entries = Object.entries(seed.origins);
ok(entries.length >= 50, `has a real floor of proven origins (${entries.length})`);
ok(entries.length === seed.count, "count matches origins length");
ok(entries.every(([, c]) => Number(c) >= 50), "every seeded origin is >= threshold (no sub-threshold noise)");
ok(entries.every(([o]) => /^https?:\/\//.test(o) && o === o.toLowerCase()), "origins are normalized http(s) lowercase");
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
ok(!entries.some(([o]) => hostOf(o) === "agent402.tools"), "our own host is NOT in the external-seller seed (F4)");
// the sellers that resolved a live external buy must be in the floor
ok(entries.some(([o]) => o.includes("agentutility")), "a known live-settled seller is in the floor");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
