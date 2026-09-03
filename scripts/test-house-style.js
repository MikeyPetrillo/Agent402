#!/usr/bin/env node
// House style is enforced in CODE on every report tier's output: no em or en
// dashes reach a buyer, whichever door they came through. Offline.
import { readFileSync } from "node:fs";
import { houseStyleText, houseStyleMarkdown, houseStyleBundle, withHouseStyle } from "../src/house-style.js";
import { REPORT_TIERS } from "../src/report-tiers.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const EM = "—", EN = "–";
ok(houseStyleText(`Revenue rose ${EM} margins fell`) === "Revenue rose - margins fell", "prose em dash becomes a spaced hyphen");
ok(houseStyleText(`2024${EN}2026`) === "2024-2026", "a numeric range keeps a plain hyphen");
ok(houseStyleText(`NVIDIA CORP (NVDA) ${EM} Company Dossier`, { heading: true }) === "NVIDIA CORP (NVDA): Company Dossier", "a heading's dash becomes a colon");
ok(houseStyleText("no dashes here") === "no dashes here", "untouched text returns as is");
const md = `# BERKSHIRE ${EM} FUND REPORT\n\nBuys ${EM} sells ${EN} holds.\n\n## Risks ${EM} and gaps\n`;
const out = houseStyleMarkdown(md);
ok(!/[—–]/.test(out), "markdown carries no em or en dash after the pass");
ok(out.startsWith("# BERKSHIRE: FUND REPORT") && out.includes("## Risks: and gaps") && out.includes("Buys - sells - holds."), "headings get colons, prose gets hyphens");
const bundle = { report: md, title: `NVDA ${EM} dossier`, sources: [{ n: 1, title: `Filing ${EM} 10-K`, url: `https://x.test/a${EM}b` }], images: [{ files: [{ b64: `abc${EM}` }] }], nested: { deep: { text: `a ${EN} b` } } };
Object.defineProperty(bundle, "__meterUpstreamUsd", { value: 0.12, enumerable: false });
const styled = houseStyleBundle(bundle);
ok(!/[—–]/.test(styled.report) && styled.title === "NVDA: dossier" && styled.sources[0].title === "Filing: 10-K" && styled.nested.deep.text === "a - b", "every prose string in a bundle is styled");
ok(styled.sources[0].url.includes(EM) && styled.images[0].files[0].b64.includes(EM), "urls and binary fields are never rewritten");
ok(styled.__meterUpstreamUsd === 0.12 && !Object.keys(styled).includes("__meterUpstreamUsd"), "a non-enumerable sentinel survives, still hidden");
const wrapped = withHouseStyle(async (input) => ({ report: `# ${input.q} ${EM} answer\n\ntext ${EM} more`, echo: input }));
const r = await wrapped({ q: "why" });
ok(r.report === "# why: answer\n\ntext - more" && r.echo.q === "why", "withHouseStyle styles a handler's result");
// The model's re-title at the top of its prose is dropped; later headings never are.
{
  const { dropModelTitle } = await import("../src/house-style.js");
  const twice = "# SEC Filing Report: Apple Inc. (AAPL)\n\n**Last 30 days** · 6 filings\n\n# Apple Inc. (AAPL): Company Filing Report\n## SEC filings in the last 30 days\n\n---\n\n## SNAPSHOT\n\nSix filings.\n\n# Not a title: a real late H1\n";
  const out = dropModelTitle(twice);
  ok(out.startsWith("# SEC Filing Report: Apple Inc. (AAPL)") && !out.includes("# Apple Inc. (AAPL): Company Filing Report") && !out.includes("## SEC filings in the last 30 days") && out.includes("## SNAPSHOT") && out.includes("# Not a title: a real late H1"), "the second H1 and its subtitle H2 go; the kit header, the sections and a later H1 stay");
  const one = "# Only Title\n\nBody.\n\n## Section\n";
  ok(dropModelTitle(one) === one && dropModelTitle("no heading at all") === "no heading at all", "a single-title report and a headingless string are untouched");
  ok(houseStyleMarkdown("# A\n\n# B\n\niPad (\u22126%)").includes("(-6%)") && !houseStyleMarkdown("# A\n\n# B\n\nx").includes("# B"), "houseStyleMarkdown drops the re-title and turns a Unicode minus into a hyphen");
}
// The catalog wraps EVERY report tier: pinned at the source so a new tier cannot skip it.
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/for \(const def of ALL_KIT\) if \(Object\.hasOwn\(REPORT_TIERS, def\.slug\)[^\n]*withHouseStyle\(def\.handler\)/.test(src), "server.js wraps every REPORT_TIERS handler with withHouseStyle");
ok(Object.keys(REPORT_TIERS).length >= 15, `REPORT_TIERS lists the report products (${Object.keys(REPORT_TIERS).length})`);
// Every served sample obeys the rule as loaded.
const { SAMPLES } = await import("../src/sample-reports.js");
for (const s of Object.values(SAMPLES || {})) ok(!/[—–]/.test(String(s.report || "")) && !/[—–]/.test(String(s.title || "")), `sample ${s.product} carries no em or en dash`);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
