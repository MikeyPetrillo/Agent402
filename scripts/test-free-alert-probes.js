#!/usr/bin/env node
// Free alert probe adapters (src/free-alert-probes.js) - offline.
//
// Pins two things the engine cannot check for itself:
//   1. every adapter's item ids are drawn from the same key space as its ids
//      (the engine lists only items whose id is fresh, so a mismatch sends a
//      change email listing nothing), driven through the REAL kit probe for the
//      filing kind with a stubbed EDGAR read;
//   2. the filing alert ("a 10-K, 10-Q or 8-K") is triggered by those forms only.
import { readFileSync } from "node:fs";
import { makeFreeAlertProbes, FILING_ALERT_FORMS } from "../src/free-alert-probes.js";
import { probeCompanyFilings } from "../src/tools/filing-watch-kit.js";
import { ALERT_KINDS } from "../src/free-alerts.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error("FAIL:", m); } };

const rows = [
  { form: "4", accession: "0000000001-26-000001", filed: "2026-09-30", url: "https://www.sec.gov/a/1" },
  { form: "10-Q", accession: "0000000001-26-000002", filed: "2026-09-29", url: "https://www.sec.gov/a/2" },
  { form: "144", accession: "0000000001-26-000003", filed: "2026-09-28", url: "https://www.sec.gov/a/3" },
  { form: "8-K", accession: "0000000001-26-000004", filed: "2026-09-27", url: "https://www.sec.gov/a/4" },
  { form: "S-8", accession: "0000000001-26-000005", filed: "2026-09-26", url: "https://www.sec.gov/a/5" },
  { form: "SCHEDULE 13G", accession: "0000000001-26-000006", filed: "2026-09-25", url: "https://www.sec.gov/a/6" },
  { form: "10-K", accession: "0000000001-26-000007", filed: "2026-09-24", url: "https://www.sec.gov/a/7" },
];
const realFilings = (t, opts = {}) => probeCompanyFilings(t, {
  ...opts,
  resolve: async () => ({ cik: "0000000001", name: "Test Co" }),
  readSubmissions: async () => ({ name: "Test Co", tickers: ["TST"], filings: rows }),
});

const probes = makeFreeAlertProbes({
  probeInsider: async () => ({ ids: ["A1", "A2"], filings: [{ accessionNumber: "A1", filedDate: "2026-09-30", displayNames: ["X"], url: "https://x" }, { accessionNumber: "A2", filedDate: "2026-09-29", url: "" }] }),
  probeFilings: realFilings,
  resolveManager: async () => ({ cik: "1067983" }),
  latest13f: async () => ({ accessionNumber: "F1", reportDate: "2026-06-30", filedDate: "2026-08-14" }),
  probeDomain: async () => ({ fingerprint: "fp1" }),
  probeRecalls: async () => ({ ids: ["R1"], items: [{ recallNumber: "R1", classification: "Class II", product: "Tablets" }] }),
});

// Every kind in the engine has an adapter.
ok(Object.keys(ALERT_KINDS).every((k) => typeof probes[k] === "function"), "an alert kind has no probe adapter");

for (const [kind, fn] of Object.entries(probes)) {
  const r = await fn(kind === "fund" ? "Berkshire" : kind === "domain" ? "example.com" : kind === "recall" ? "losartan" : "TST");
  const ids = new Set(r.ids);
  ok(r.ids.length > 0, `${kind}: no ids`);
  ok(r.items.length === r.ids.length, `${kind}: ${r.items.length} items for ${r.ids.length} ids`);
  ok(r.items.every((it) => ids.has(String(it.id))), `${kind}: item id outside the id key space: ${r.items.map((i) => i.id).join(",")}`);
  ok(r.items.every((it) => !/undefined|null/.test(it.label)), `${kind}: label reads a field the probe does not return: ${r.items.map((i) => i.label).join(" / ")}`);
}

const f = await probes.filing("TST");
const forms = f.items.map((it) => it.label.split(" · ")[0]).sort();
ok(JSON.stringify(forms) === JSON.stringify(["10-K", "10-Q", "8-K"]), `filing alert forms: ${forms.join(",")}`);
ok(f.items.some((it) => it.label === "10-Q · filed 2026-09-29" && it.url === "https://www.sec.gov/a/2"), "filing label/url not from the probe row");
ok(FILING_ALERT_FORMS.every((x) => ALERT_KINDS.filing.cta("TST").includes(x)), "filing alert copy and the probe's forms disagree");

// server.js wires the adapters, not an inline copy.
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/probes:\s*makeFreeAlertProbes\(/.test(src), "server.js does not build the alert probes through makeFreeAlertProbes");

console.log(`test-free-alert-probes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
