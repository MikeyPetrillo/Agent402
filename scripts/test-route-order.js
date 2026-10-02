#!/usr/bin/env node
// src/route-order.js is the one description of /api/route's ordering, read by
// why.tiebreaks and routerRankingSentence. This pins it to the comparator's
// own source: each step's marker must appear in routeQuery's tiebreak in the
// same order as the list, so a step added or moved in the sort without the
// list following it fails here. Offline, source-only.
import { readFileSync } from "node:fs";
import { ROUTE_ORDER, routeTiebreakLabels } from "../src/route-order.js";
import { routerRankingSentence } from "../src/routing-proof.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
const start = src.indexOf("const tiebreak = (a, b) => {");
const end = src.indexOf("\n  };", start);
ok(start > 0 && end > start, "the tiebreak comparator is found in x402-index.js");
const body = src.slice(start, end);
// Marker per tiebreak step, as the comparator writes it.
const MARKERS = {
  health: "b[1].health !== a[1].health",
  bazaarPayers30d: "qb - qa",
  price: "a[3] !== b[3]",
  bazaarCurated: "a[6] !== b[6]",
  slugLength: "(a[1].slug || \"\").length",
};
const steps = ROUTE_ORDER.slice(1);
ok(ROUTE_ORDER[0].key === "score" && /b\[0\] !== a\[0\] \? b\[0\] - a\[0\] : tiebreak\(a, b\)/.test(src), "score sorts first, then the comparator");
ok(steps.every((s) => MARKERS[s.key]), "every listed tiebreak step has a marker");
const positions = steps.map((s) => body.indexOf(MARKERS[s.key]));
ok(positions.every((p) => p >= 0), `every step appears in the comparator (${steps.map((s, i) => `${s.key}@${positions[i]}`).join(", ")})`);
ok(positions.every((p, i) => i === 0 || p > positions[i - 1]), "the comparator applies them in the listed order");
// The comparator returns once per step plus the final slug-length return: a new
// `return` means a new step the list does not name.
const returns = (body.match(/return /g) || []).length;
ok(returns === 6, `the comparator has the six returns the five listed steps account for (got ${returns})`);
ok(/tiebreaks: routeTiebreakLabels\(\)/.test(src), "why.tiebreaks reads route-order.js");
const sentence = routerRankingSentence();
ok(ROUTE_ORDER.every((o) => sentence.includes(o.prose)), "the ranking sentence names every step");
ok(routeTiebreakLabels().length === ROUTE_ORDER.length, "labels cover every step");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
