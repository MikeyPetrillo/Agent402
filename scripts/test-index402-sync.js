#!/usr/bin/env node
// Offline test for scripts/index402-sync.js: which 402 Index listings get
// repriced, and which are left alone.
import { microUsd, livePrices, planUpdates } from "./index402-sync.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

ok(microUsd("$0.08") === 80000 && microUsd(0.001) === 1000 && microUsd("0.010") === 10000, "prices parse to micro-dollars from $-strings and numbers");
ok(microUsd(null) === null && microUsd("") === null && microUsd("abc") === null && microUsd(-1) === null, "absent, junk and negative prices read as no price");
// The 2026-10-03 defect: base units listed as dollars.
ok(microUsd(80000) === 80000 * 1e6, "a base-unit figure listed as dollars reads as the huge number it is (so it differs and gets corrected)");

const prices = livePrices({ endpoints: [
  { path: "/api/answer", price: "$0.08" },
  { path: "/api/hash", price: "$0.001" },
  { path: "/api/search", price: "$0.01" },
  { path: "/api/broken" },
] });
ok(prices.get("/api/answer") === 80000 && prices.size === 3, "livePrices keeps priced routes only");

const D = "agent402.tools";
const { updates, unknown } = planUpdates([
  { id: "a", url: "https://agent402.tools/api/answer", protocol: "MPP", price_usd: 80000 },
  { id: "b", url: "https://agent402.tools/api/hash", protocol: "MPP", price_usd: 0.001 },
  { id: "c", url: "https://agent402.tools/api/search", protocol: "x402", price_usd: null },
  { id: "d", url: "https://agent402.tools/api/retired-thing", protocol: "MPP", price_usd: 0.05 },
  { id: "e", url: "https://evil.example/api/answer", protocol: "MPP", price_usd: 9 },
  { id: "f", url: "https://agent402.tools.evil.example/api/answer", protocol: "MPP", price_usd: 9 },
  { id: "g", url: "not a url", protocol: "MPP", price_usd: 1 },
  { id: "h", url: "https://agent402.tools/api/search?q=x", protocol: "MPP", price_usd: 0.02 },
], prices, D);
ok(updates.length === 2 && updates.some((u) => u.id === "a" && u.to === 0.08) && updates.some((u) => u.id === "h" && u.to === 0.01), "a wrong price on our host is corrected to the live price (query string ignored)");
ok(!updates.some((u) => u.id === "b"), "a listing already at the live price is not touched");
ok(!updates.some((u) => u.id === "c"), "a listing with no price is left alone");
ok(unknown.length === 1 && unknown[0].id === "d" && !updates.some((u) => u.id === "d"), "a priced listing on a route we no longer sell is reported, never repriced");
ok(!updates.some((u) => ["e", "f", "g"].includes(u.id)), "listings on other hosts (including a lookalike suffix) and junk urls are never touched");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
