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
    "forecast-naive": rec("forecast-naive", () => ({})), "forecast-ses": rec("forecast-ses", () => ({})), "forecast-holt": rec("forecast-holt", () => ({})),
  };
  const ctx = { packIndex, catalog: {}, inlineHandlers: inline };
  const equity = await runPack("trend-analysis", { series: "AAPL" }, ctx);
  const fred = equity.steps.find((s) => s.slug === "fred-series");
  ok(fred && fred.skipped === true && fred.ok === true && !calls.includes("fred-series"), "an equity series skips the fred-series leg (reported skipped, handler never called)");
  // No benchmark: the two benchmark fetches and correlation are skipped, and
  // only the winning forward forecast runs (drift wins a tie of no RMSE).
  ok(/9\/9 steps succeeded \(6 skipped as not applicable\)/.test(equity.summary), `the summary counts only attempted steps (got "${equity.summary}")`);
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

// ---- trend-analysis does what its workflow says (2026-10-02) ---------------
// The correlation step used to pass the series against itself (r = 1 on every
// run) and the bake-off ran forecast-eval once with drift.
{
  const { __test: { runPack } } = await import("../src/tools/skill-runner.js");
  const { SKILL_PACKS } = await import("../src/skills.js");
  const packIndex = new Map(SKILL_PACKS.map((p) => [p.slug, p]));
  const mk = (base) => Array.from({ length: 40 }, (_, i) => ({ close: base + i * (base === 100 ? 0.5 : -0.3) + (i % 3) }));
  const seen = { corr: null, evals: [], forward: [] };
  const RMSE = { drift: 2.5, ses: 1.1, holt: 1.7 };
  const inline = {
    "stock-history": (i) => ({ bars: i.symbol === "SPY" ? mk(400).slice(5) : mk(100) }),
    "fred-series": () => { throw Object.assign(new Error("unused"), { statusCode: 404 }); },
    "stats-summary": () => ({}), "moving-average": () => ({}), "linear-regression": () => ({}), "outliers": () => ({}),
    "correlation": (i) => { seen.corr = i; return { r: 0.5 }; },
    "forecast-eval": (i) => { seen.evals.push(i); return { method: i.method, rmse: RMSE[i.method] }; },
    "forecast-naive": (i) => { seen.forward.push(["naive", i]); return {}; },
    "forecast-ses": (i) => { seen.forward.push(["ses", i]); return { forecast: [{ lower95: 1, upper95: 2 }] }; },
    "forecast-holt": (i) => { seen.forward.push(["holt", i]); return {}; },
  };
  const r = await runPack("trend-analysis", { series: "AAPL", benchmark: "SPY" }, { packIndex, catalog: {}, inlineHandlers: inline });
  ok(seen.corr && seen.corr.x.length === 35 && seen.corr.y.length === 35, `correlation gets the series and the benchmark aligned on their shared length (got ${seen.corr?.x.length}/${seen.corr?.y.length})`);
  ok(seen.corr && JSON.stringify(seen.corr.x) !== JSON.stringify(seen.corr.y), "correlation is never the series against itself");
  ok(seen.corr && seen.corr.x[34] === mk(100)[39].close && seen.corr.y[34] === mk(400)[39].close, "both series keep their most recent observations");
  ok(JSON.stringify(seen.evals.map((e) => e.method)) === JSON.stringify(["drift", "ses", "holt"]), `the bake-off backtests drift, ses and holt (got ${seen.evals.map((e) => e.method)})`);
  ok(seen.evals.every((e) => e.testSize === 8 && e.values.length === 40), "every backtest uses the same values and a ~20% holdout");
  ok(seen.forward.length === 1 && seen.forward[0][0] === "ses" && seen.forward[0][1].horizon === 10, `only the lowest-RMSE method forecasts forward (got ${JSON.stringify(seen.forward.map((f) => f[0]))})`);
  const evalSteps = r.steps.filter((s) => s.slug === "forecast-eval");
  ok(evalSteps.map((s) => s.as).join(",") === "forecast-eval-drift,forecast-eval-ses,forecast-eval-holt", "each backtest is reported under its own key");
  const pack = SKILL_PACKS.find((p) => p.slug === "trend-analysis");
  ok((pack.promptArgs || []).some((a) => a.name === "benchmark"), "the benchmark is a declared pack argument");
}

// ---- security-audit checks subdomains the CT log names (2026-10-02) ---------
{
  const { __test: { runPack }, AUDIT_DNS_SUBDOMAINS, AUDIT_HEADER_SUBDOMAINS } = await import("../src/tools/skill-runner.js");
  const { SKILL_PACKS } = await import("../src/skills.js");
  const packIndex = new Map(SKILL_PACKS.map((p) => [p.slug, p]));
  const dns = [], headers = [];
  const inline = {
    "cert-transparency": () => ({ subdomains: ["a.b.example.com", "example.com", "www.example.com", "api.example.com", "mail.example.com", "evil.com"] }),
    "dns-lookup": (i) => { dns.push(`${i.host}/${i.type}`); return {}; },
    "spf-check": () => ({}), "dmarc-check": () => ({}),
    "http-headers": (i) => { headers.push(i.url); return {}; },
    "tls-cert": () => ({}), "tech-stack": () => ({}),
  };
  await runPack("security-audit", { domain: "example.com" }, { packIndex, catalog: {}, inlineHandlers: inline });
  ok(JSON.stringify(dns) === JSON.stringify(["example.com/A", "example.com/CAA", "api.example.com/A", "mail.example.com/A", "www.example.com/A"]),
    `DNS runs on the apex and the ${AUDIT_DNS_SUBDOMAINS} shallowest CT subdomains, never a foreign host (got ${dns.join(", ")})`);
  ok(JSON.stringify(headers) === JSON.stringify(["https://example.com", "https://api.example.com", "https://mail.example.com"]),
    `headers run on the apex and ${AUDIT_HEADER_SUBDOMAINS} CT subdomains (got ${headers.join(", ")})`);
  dns.length = 0; headers.length = 0;
  inline["cert-transparency"] = () => ({ subdomains: [] });
  const none = await runPack("security-audit", { domain: "example.com" }, { packIndex, catalog: {}, inlineHandlers: inline });
  ok(dns.length === 2 && headers.length === 1 && none.steps.filter((s) => s.skipped).length === AUDIT_DNS_SUBDOMAINS + AUDIT_HEADER_SUBDOMAINS,
    "with no subdomains logged the subdomain legs are skipped, not failed");
}

console.log(`\n${passed} passed, 0 failed (${SKILL_PACKS.length} packs checked)`);

// ---- a pack running a model-backed tool is model-backed (2026-10-02) --------
{
  const { modelBackedPackSlugs } = await import("../src/tools/skill-runner.js");
  const { SKILL_PACKS } = await import("../src/skills.js");
  const model = new Set(["pdf-summarize", "answer", "transcribe"]);
  const got = modelBackedPackSlugs(SKILL_PACKS, (s) => model.has(s)).sort();
  const want = SKILL_PACKS.filter((p) => p.toolSlugs.some((s) => model.has(s))).map((p) => `skill-${p.slug}`).sort();
  ok(got.length >= 4 && JSON.stringify(got) === JSON.stringify(want), `packs running a model-backed tool are flagged (got ${got.join(", ")})`);
  ok(["skill-document-brief", "skill-search-and-cite", "skill-article-digest", "skill-subtitle-pipeline"].every((s) => got.includes(s)), "the four packs with a model step are among them");
  ok(modelBackedPackSlugs(SKILL_PACKS, () => false).length === 0, "no model-backed tool, no model-backed pack");
}
console.log("model-backed pack derivation checked");
