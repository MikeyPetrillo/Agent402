#!/usr/bin/env node
// Offline test: the /revenue MPP-by-rail table's "Last settled" cell shows
// the newest settlement's date only (no clock time) and marks it "ours" when
// it is newer than the rail's newest outside settlement, as the x402 table
// does. A tie, or a rail with no internal/external split, is never ours.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { JSDOM } from "jsdom";
import { revenuePage } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

const rail = (o) => ({ count: 1, external: 0, externalUsd: 0, internal: 1, lastAt: null, lastExternalAt: null, txs: [], ...o });
const html = revenuePage("https://example.test", {
  asOf: "2026-11-02T12:00:00.000Z",
  rails: [],
  allTime: { allTimeInboundCount: 0, allTimeExternalCount: 0, allTimeExternalUsd: 0 },
  standing: {},
  mpp: {
    count: 9,
    rails: {
      // Newest is ours: newer than the newest outside settlement.
      tempo: rail({ count: 5, external: 2, lastAt: "2026-11-02T10:40:12.000Z", lastExternalAt: "2026-11-01T09:00:00.000Z" }),
      // Newest is outside: the same instant as the newest outside one.
      base: rail({ count: 2, external: 1, lastAt: "2026-11-02T03:37:00.000Z", lastExternalAt: "2026-11-02T03:37:00.000Z" }),
      // Only our own settlements on record.
      celo: rail({ count: 1, external: 0, lastAt: "2026-11-02T03:37:00.000Z" }),
      // No split on record (the byNetwork fallback shape): never ours.
      stripe: rail({ count: 1, external: null, lastAt: "2026-09-03T03:19:00.000Z" }),
    },
  },
});
const doc = new JSDOM(html).window.document;
const section = doc.querySelector('[data-rv-live="mpp"]');
const rowOf = (label) => [...section.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("td strong")?.textContent === label);
const lastOf = (label) => {
  const tr = rowOf(label);
  assert.ok(tr, `row ${label} present`);
  const i = [...section.querySelectorAll("thead th")].findIndex((th) => th.textContent === "Last settled");
  assert.ok(i >= 0, "the table has a Last settled column");
  return tr.querySelectorAll("td")[i].textContent.trim();
};

check("a rail whose newest settlement is ours reads the date and \"ours\"", () => assert.equal(lastOf("Tempo"), "2026-11-02 · ours"));
check("a rail whose newest settlement is an outside one reads the date only", () => assert.equal(lastOf("Base"), "2026-11-02"));
check("a rail with only our own settlements reads \"ours\"", () => assert.equal(lastOf("Celo"), "2026-11-02 · ours"));
check("a rail with no internal/external split is never labelled ours", () => assert.equal(lastOf("Card (MPP wire)"), "2026-09-03"));
check("no Last settled cell carries a clock time", () => assert.ok(!/T\d\d:\d\d/.test(section.querySelector("tbody").textContent)));

console.log(`\ntest-revenue-mpp-last: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
