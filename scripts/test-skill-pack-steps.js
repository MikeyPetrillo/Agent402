// Every sold skill pack must have a real step config.
//
// Four packs (earnings-deep-dive, options-analytics, fixed-income-desk,
// defi-protocol-scanner) were listed in SKILL_PACKS with prices, catalog
// entries and live tool pages, and no PACK_STEPS entry at all. getStepConfig
// falls back to a stub whose every mapInput throws todoError(), so each call
// returned HTTP 200 with "0/N steps succeeded" - deterministically, for every
// buyer, from 2026-07-08 to 2026-08-31.
//
// Nothing caught it because the partial-success envelope is valid whatever the
// steps did: the "answers its own example" sweep asserts status and documented
// keys, not outcomes, and three of the four are additionally skipped there to
// avoid live Brave spend. So the guard cannot live in that sweep - it lives
// here, offline, over the source of truth.
//
// Also checks the inverse: a step naming a slug no tool provides. That is how
// a retirement cut would silently hollow out a pack that still sells.
import assert from "node:assert/strict";
import { SKILL_PACKS, PACK_PRICES } from "../src/skills.js";
import { PACK_STEPS } from "../src/tools/skill-runner.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log("ok -", msg); };

const missing = SKILL_PACKS.filter((p) => !PACK_STEPS[p.slug]);
ok(
  missing.length === 0,
  `every pack in SKILL_PACKS has a PACK_STEPS entry (a pack without one answers 200 with 0/N steps and still charges)${missing.length ? `: ${missing.map((p) => `${p.slug} ($${PACK_PRICES[p.slug] ?? 0.05})`).join(", ")}` : ""}`
);

// No step may declare a slug the pack itself does not list, and no listed tool
// should be silently dropped: the pack's toolSlugs are what the tool page, the
// catalog description and the claudePrompt all promise the buyer.
for (const pack of SKILL_PACKS) {
  const config = PACK_STEPS[pack.slug];
  if (!config) continue;
  const stepSlugs = config.steps.map((s) => s.slug);
  ok(stepSlugs.length > 0, `${pack.slug}: declares at least one step`);
  ok(
    config.mode === "chain" || config.mode === "fanout",
    `${pack.slug}: mode is chain or fanout (got ${config.mode})`
  );
  for (const s of config.steps) {
    // Either shape is valid: mapInput builds one input, mapInputs offers
    // ordered candidates the runner tries until one works. A step with
    // neither is a step that can never run.
    const buildable = typeof s.mapInput === "function" || typeof s.mapInputs === "function";
    ok(buildable, `${pack.slug}: step ${s.slug} can build its input (mapInput or mapInputs)`);
  }
  // The converse, since 2026-09-02: every tool the pack ADVERTISES is a step.
  // Ten packs listed a tool in toolSlugs their runner never invoked (the tool
  // page promised it, the buyer never got it); each now runs it or the
  // workflow was wrong. A justified omission must be named here with a reason.
  const ADVERTISED_NOT_RUN = {};
  const ran = new Set(stepSlugs);
  const notRun = (pack.toolSlugs || []).filter((slug) => !ran.has(slug) && !(ADVERTISED_NOT_RUN[pack.slug] || []).includes(slug));
  ok(notRun.length === 0, `${pack.slug}: every advertised tool runs as a step${notRun.length ? ` (advertised, never run: ${notRun.join(", ")})` : ""}`);
  const promised = new Set(pack.toolSlugs || []);
  const undeclared = stepSlugs.filter((s) => promised.size && !promised.has(s));
  ok(
    undeclared.length === 0,
    `${pack.slug}: every step is a tool the pack advertises in toolSlugs${undeclared.length ? ` (extra: ${undeclared.join(", ")})` : ""}`
  );
}

// crypto-dossier's extract step is the reason mapInputs exists: it reads
// whichever news site ranked first, and that failed 43.5% of the time (37 of
// 85 runs over 60 days) while every other step in the pack ran at 100%. The
// candidates must be the ranked results IN ORDER, deduped, and must always end
// with a page we know is readable so the step cannot be lost to a bad ranking.
{
  const extract = PACK_STEPS["crypto-dossier"].steps.find((s) => s.slug === "extract");
  const prior = { search: { results: [
    { url: "https://blocked.example/a" },
    { url: "https://blocked.example/a" },
    { url: "https://ok.example/b" },
  ] } };
  const candidates = extract.mapInputs({ coin: "bitcoin" }, prior);
  ok(candidates.length > 1, `extract offers more than one candidate (got ${candidates.length})`);
  ok(candidates[0].url === "https://blocked.example/a", "extract tries the top-ranked result first");
  ok(candidates[1].url === "https://ok.example/b", "extract dedupes repeated URLs before falling through");
  // No hardcoded fallback. The first version appended the coin's own CoinGecko
  // page as a "readable" last resort; measured, that page answers 403 to our
  // fetcher, so it was a guaranteed-dead candidate dressed as a safety net.
  // Walking more real results is the honest version, and a step with no
  // reachable source should fail rather than pretend.
  ok(
    !candidates.some((c) => /coingecko\.com/.test(c.url)),
    "extract offers no hardcoded fallback page (the CoinGecko one 403s to our fetcher)"
  );
  const noResults = extract.mapInputs({ coin: "bitcoin" }, { search: {} });
  ok(
    noResults.length === 0,
    "extract offers nothing when the search returned nothing, rather than a dead candidate"
  );
}


// ---- `when`: a conditional leg is skipped, never failed (2026-09-02) --------
{
  const { __test: { runPack } } = await import("../src/tools/skill-runner.js");
  const { SKILL_PACKS } = await import("../src/skills.js");
  const packIndex = new Map(SKILL_PACKS.map((p) => [p.slug, p]));
  const bars = Array.from({ length: 40 }, (_, i) => ({ close: 100 + Math.sin(i) * 3 + i * 0.2 }));
  const calls = [];
  const rec = (slug, out) => (input) => { calls.push(slug); return out(input); };
  const inline = {
    "stock-history": rec("stock-history", () => ({ bars })),
    "fred-series": rec("fred-series", () => ({ observations: bars.map((b, i) => ({ date: String(i), value: b.close })) })),
    "stats-summary": rec("stats-summary", (i) => ({ n: i.values.length })),
    "moving-average": rec("moving-average", () => ({})), "linear-regression": rec("linear-regression", () => ({})),
    "outliers": rec("outliers", () => ({})), "correlation": rec("correlation", () => ({})), "forecast-eval": rec("forecast-eval", () => ({})),
  };
  const ctx = { packIndex, catalog: {}, inlineHandlers: inline };
  const equity = await runPack("trend-analysis", { series: "AAPL" }, ctx);
  const fred = equity.steps.find((s) => s.slug === "fred-series");
  ok(fred && fred.skipped === true && fred.ok === true && !calls.includes("fred-series"), "an equity series skips the fred-series leg (reported skipped, handler never called)");
  ok(/7\/7 steps succeeded \(1 skipped as not applicable\)/.test(equity.summary), `the summary counts only attempted steps (got "${equity.summary}")`);
  calls.length = 0;
  inline["stock-history"] = rec("stock-history", () => { throw Object.assign(new Error("Yahoo: not found"), { statusCode: 404 }); });
  const macro = await runPack("trend-analysis", { series: "UNRATE" }, ctx);
  ok(calls.includes("fred-series") && macro.steps.find((s) => s.slug === "fred-series")?.ok === true && !macro.steps.find((s) => s.slug === "fred-series")?.skipped, "a FRED id runs the fred-series leg when stock-history served nothing");
  ok(macro.steps.find((s) => s.slug === "stats-summary")?.result?.n === 40, "downstream steps read the values from whichever fetcher served");
  const down = () => { throw Object.assign(new Error("down"), { statusCode: 502 }); };
  const dead = Object.fromEntries(Object.keys(inline).map((k) => [k, down]));
  let refused = null;
  try { await runPack("trend-analysis", { series: "AAPL" }, { ...ctx, inlineHandlers: dead }); } catch (e) { refused = e; }
  ok(refused && /No step in the "trend-analysis" pack succeeded/.test(refused.message), "all attempted steps failing still refuses (nothing to sell)");
}

console.log(`\n${passed} passed, 0 failed (${SKILL_PACKS.length} packs checked)`);
