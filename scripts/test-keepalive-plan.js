#!/usr/bin/env node
// The keep-alive passes beyond the weekly ceiling: which routes the scheduled
// tail pass buys, which routes a deploy's price change buys, the spend caps
// that refuse a pass, and the burner low-water figure derived from one pass.
// Offline: a stub catalog on port 0; refresh-bazaar.js runs under DRY_RUN, so
// nothing is signed or paid.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { load } from "js-yaml";
import {
  KEEPALIVE_CEILING_USD, usdMicros, exemptKind, aboveCeilingRoutes, passMicros, spendCapVerdict, buyFits,
  priceSnapshot, changedPriceRoutes, burnerLowWaterUsd,
} from "./lib/keepalive-plan.js";
import { run } from "./keepalive-plan.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const row = (slug, price, extra = {}) => ({ slug, path: `/api/${slug}`, method: "POST", price, ...extra });
const CATALOG = [
  row("cheap", "$0.010"),
  row("at-ceiling", "$0.10"),
  row("just-over", "$0.101"),
  row("report", "$0.85", { async: true }),
  row("pack", "$2.00"),
  row("quoted-one", "$0.14", { quoted: true }),
  row("model-one", "$0.50", { pricedByModel: true }),
  row("route-execute-pro", "$3.30"),
  row("route-execute-max", "$0.55"),
  row("Bad Slug\nslugs=x", "$1.00"),
  row("unpriced", "free"),
];

// --- route selection: above the ceiling only, exempt kinds excluded ---------
{
  const sel = aboveCeilingRoutes({ endpoints: CATALOG });
  ok(JSON.stringify(sel.map((r) => r.slug)) === JSON.stringify(["just-over", "report", "pack"]), `the tail pass buys only fixed-price routes above the ceiling (${sel.map((r) => r.slug).join(", ")})`);
  ok(exemptKind(CATALOG[5]) === "quoted" && exemptKind(CATALOG[6]) === "model-priced" && exemptKind(CATALOG[7]) === "route-execute" && exemptKind(CATALOG[0]) === null, "quoted, model-priced and route-execute routes are exempt kinds");
  ok(passMicros(sel) === 2_951_000, `one pass is the sum of the selected list prices in micro-USD (${passMicros(sel)})`);
  ok(KEEPALIVE_CEILING_USD === 0.1 && usdMicros("$0.10") === 100_000 && usdMicros("free") === 0 && usdMicros(0.101) === 101_000, "prices read as integer micro-USD");
  const weekly = load(read(".github/workflows/bazaar-keepalive.yml"));
  ok(weekly.on.workflow_dispatch.inputs.max_price_usd.default === String(KEEPALIVE_CEILING_USD.toFixed(2)), `the tail starts where the weekly pass's ceiling ends (${weekly.on.workflow_dispatch.inputs.max_price_usd.default})`);
}

// --- changed-price detection -----------------------------------------------
{
  const before = priceSnapshot([row("same", "$0.02"), row("up", "$0.60"), row("down", "$0.85"), row("gone", "$0.10"), row("now-quoted", "$0.10"), row("was-unpriced", "free")]);
  const after = priceSnapshot([row("same", "$0.020"), row("up", "$0.85"), row("down", "$0.60"), row("new", "$0.30"), row("now-quoted", "$0.20", { quoted: true }), row("was-unpriced", "$0.05")]);
  const ch = changedPriceRoutes(before, after);
  ok(JSON.stringify(ch.map((r) => r.slug)) === JSON.stringify(["down", "up"]), `a deploy buys the routes whose fixed price changed, and no new, removed, exempt or unreadable one (${ch.map((r) => r.slug).join(", ")})`);
  ok(ch[1].beforeMicros === 600_000 && ch[1].micros === 850_000 && ch[0].path === "/api/down", "a change carries the old and new price and the route");
  ok(changedPriceRoutes(before, before).length === 0, "the same catalog twice changes nothing");
  ok(changedPriceRoutes(after, priceSnapshot([row("same", "$0.02"), row("up", "$0.85", { pricedByModel: true })])).length === 0, "a route that is model-priced after the deploy is exempt");
}

// --- spend caps -------------------------------------------------------------
{
  const sel = aboveCeilingRoutes(CATALOG);
  ok(spendCapVerdict(sel, "2.951").ok && !spendCapVerdict(sel, "2.95").ok, "a pass at its cap starts and a pass a tenth of a cent over it is refused");
  ok(!spendCapVerdict(sel, "").ok && !spendCapVerdict(sel, "0").ok && spendCapVerdict(sel, "").reason === "no cap set", "no cap refuses everything");
  ok(buyFits(0, 850_000, 1_000_000) && !buyFits(200_000, 850_000, 1_000_000) && buyFits(150_000, 850_000, 1_000_000) && !buyFits(0, 1, 0), "a buy fits only while what the pass settled plus its price stays under the cap");
  const outFile = join(mkdtempSync(join(tmpdir(), "ka-plan-")), "out");
  writeFileSync(outFile, "");
  const logs = [];
  const fetchPricing = async () => ({ endpoints: CATALOG });
  const code = await run(["tail"], { env: { MAX_SPEND_USD: "2", GITHUB_OUTPUT: outFile }, log: (m) => logs.push(m), err: (m) => logs.push(m), fetchPricing });
  ok(code === 3 && /refusing/.test(logs.join("\n")) && /^slugs=$/m.test(readFileSync(outFile, "utf8")), "the tail plan over its cap exits 3 and hands the buy step no slugs");
  writeFileSync(outFile, "");
  const code2 = await run(["tail"], { env: { MAX_SPEND_USD: "25", GITHUB_OUTPUT: outFile }, log: () => {}, err: () => {}, fetchPricing });
  const out = readFileSync(outFile, "utf8");
  ok(code2 === 0 && /^slugs=just-over,report,pack$/m.test(out) && /^max_price=2$/m.test(out), `the tail plan under its cap writes the slugs and the highest price (${out.trim().replace(/\n/g, " ")})`);
  const snap = join(mkdtempSync(join(tmpdir(), "ka-snap-")), "before.json");
  writeFileSync(snap, JSON.stringify(priceSnapshot([row("report", "$0.60"), row("pack", "$1.10")])));
  writeFileSync(outFile, "");
  const code3 = await run(["changed", snap], { env: { MAX_SPEND_USD: "1", GITHUB_OUTPUT: outFile }, log: () => {}, err: () => {}, fetchPricing });
  ok(code3 === 3 && /^slugs=$/m.test(readFileSync(outFile, "utf8")), "a price-change set over its cap exits 3 with no slugs");
  writeFileSync(outFile, "");
  const code4 = await run(["changed", snap], { env: { MAX_SPEND_USD: "5", GITHUB_OUTPUT: outFile }, log: () => {}, err: () => {}, fetchPricing });
  ok(code4 === 0 && /^slugs=report,pack$/m.test(readFileSync(outFile, "utf8")), "a price-change set under its cap names its routes");
  const code5 = await run(["changed", join(tmpdir(), "no-such-snapshot.json")], { env: {}, log: () => {}, err: () => {}, fetchPricing });
  const code6 = await run(["tail"], { env: { MAX_SPEND_USD: "25" }, log: () => {}, err: () => {}, fetchPricing: async () => { throw new Error("down"); } });
  ok(code5 === 2 && code6 === 2, "no snapshot or no catalog is exit 2, never a plan");
}

// --- burner low-water derivation --------------------------------------------
{
  ok(burnerLowWaterUsd(15.801) === 21, `one pass of $15.801 plus the $5 minimum margin is $21 (${burnerLowWaterUsd(15.801)})`);
  ok(burnerLowWaterUsd(40) === 50 && burnerLowWaterUsd(0) === 5 && burnerLowWaterUsd(15) === 20, "the margin is a quarter of the pass, never under $5, rounded up to a dollar");
  ok(burnerLowWaterUsd(15.801, { floorUsd: 30 }) === 30 && burnerLowWaterUsd(15.801, { floorUsd: 2 }) === 21, "never under the repo variable's floor");
  const logs = [];
  const code = await run(["low-water"], { env: { FLOOR_USD: "2" }, log: (m) => logs.push(m), err: () => {}, fetchPricing: async () => ({ endpoints: CATALOG }) });
  ok(code === 0 && logs.join("") === "8", `the CLI prints the mark alone, from the live tail pass (${logs.join("")})`);
}

// --- the caller path: refresh-bazaar buys exactly the plan, under the cap ----
{
  const spec = { paths: Object.fromEntries(CATALOG.map((r) => [r.path, { post: { requestBody: { content: { "application/json": { example: { q: "x" } } } } } }])) };
  const server = createServer((req, res) => {
    const body = req.url === "/api/pricing" ? { endpoints: CATALOG } : req.url === "/openapi.json" ? spec : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body || {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TARGET_URL: target, MODE: "sweep", DRY_RUN: "1", STALE_DAYS: "0", BATCH_COUNT: "1", REQUIRE_SLUGS: "1" };
  const rb = (extra) => new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL("./refresh-bazaar.js", import.meta.url).pathname], { env: { ...env, ...extra } });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  const plan = aboveCeilingRoutes(CATALOG);
  const slugs = plan.map((r) => r.slug).join(",");
  const a = await rb({ SLUGS: slugs, MAX_PRICE_USD: "2", MAX_SPEND_USD: "25" });
  ok(a.code === 0 && /sweeping 3 routes/.test(a.out) && /Estimated total cost to sweep all routes: \$2\.951/.test(a.out), `refresh-bazaar sweeps exactly the plan's routes at the plan's total (exit ${a.code})`);
  const b = await rb({ SLUGS: slugs, MAX_PRICE_USD: "2", MAX_SPEND_USD: "2.9" });
  ok(b.code === 2 && /Refusing to run/.test(b.out), `refresh-bazaar refuses the pass when its estimate is over MAX_SPEND_USD (exit ${b.code})`);
  const c = await rb({ SLUGS: "", MAX_PRICE_USD: "2", MAX_SPEND_USD: "25" });
  ok(c.code === 2 && /REQUIRE_SLUGS/.test(c.out) && !/sweeping/.test(c.out), `an empty plan never becomes a sweep of every route (exit ${c.code})`);
  server.close();
  const src = read("scripts/refresh-bazaar.js");
  ok(/if \(!buyFits\(spentMicros, usdMicros\(t\.priceUsd\), capMicros\)\) \{[\s\S]{0,400}continue;/.test(src) && /results\.ok\+\+;\s*\n\s*spentMicros \+= usdMicros\(t\.priceUsd\);/.test(src), "each buy is checked against what the pass already settled, and only a 200 counts as settled");
}

// --- the workflows wire it ---------------------------------------------------
{
  const wf = load(read(".github/workflows/bazaar-keepalive-tail.yml"));
  const crons = (wf.on?.schedule || []).map((x) => x.cron);
  const days = (crons[0] || "").split(/\s+/)[2]?.split(",").map(Number) || [];
  const gaps = days.map((d, i) => (i + 1 < days.length ? days[i + 1] - d : 31 - d + days[0]));
  ok(crons.length === 1 && days.length >= 2 && Math.max(...gaps) <= 17 && wf.on.workflow_dispatch, `the tail pass is scheduled about every two weeks, at most 17 days apart, and can be dispatched (${crons.join(" | ")})`);
  ok(wf.concurrency?.group === load(read(".github/workflows/bazaar-keepalive.yml")).concurrency?.group, "it shares the weekly keep-alive's concurrency group: one burner, one pass at a time");
  const steps = wf.jobs?.sweep?.steps || [];
  const planStep = steps.find((s) => s.id === "plan") || {};
  const buy = steps.find((s) => /refresh-bazaar\.js/.test(String(s.run || ""))) || {};
  ok(/node scripts\/keepalive-plan\.js tail/.test(planStep.run || "") && planStep.env?.MAX_SPEND_USD === buy.env?.MAX_SPEND_USD && /'25'/.test(String(buy.env?.MAX_SPEND_USD)), "the plan and the buy read one pass cap");
  ok(buy.env?.SLUGS === "${{ steps.plan.outputs.slugs }}" && buy.env?.REQUIRE_SLUGS === "1" && buy.env?.BATCH_COUNT === "1" && buy.env?.MODE === "sweep" && buy.env?.PAY_NETWORK === "base", "the buy is the keep-alive's sweep over the plan's slugs, in one process");
  ok(/steps\.plan\.outputs\.slugs != ''/.test(String(buy.if)) && !planStep.env?.BURNER_KEY, "no plan, no buy; the plan step holds no key");
  ok(buy.env?.BURNER_KEY === "${{ secrets.BURNER_KEY }}" && /BURNER_KEY is not set[^\n]*exit 1/.test(buy.run) && /add-mask::\$BURNER_KEY/.test(buy.run), "a missing burner key fails the pass, and the key is masked");
  ok(/gh issue create/.test(JSON.stringify(wf.jobs?.report || {})) && wf.jobs?.report?.if === "always()", "a failed pass pages");

  const dep = load(read(".github/workflows/deploy.yml")).jobs.deploy.steps;
  const snapAt = dep.findIndex((s) => /keepalive-plan\.js snapshot/.test(String(s.run || "")));
  const trigAt = dep.findIndex((s) => /serviceInstanceDeployV2/.test(String(s.run || "")));
  const valAt = dep.findIndex((s) => /bazaar-validate\.js/.test(String(s.run || "")));
  const buyAt = dep.findIndex((s) => /keepalive-plan\.js changed/.test(String(s.run || "")));
  ok(snapAt >= 0 && snapAt < trigAt && buyAt > valAt, `the deploy snapshots prices before it ships and buys after the Bazaar validation (${snapAt} < ${trigAt}, ${valAt} < ${buyAt})`);
  const b = dep[buyAt] || {};
  ok(/REQUIRE_SLUGS=1/.test(b.run) && /STALE_DAYS=0/.test(b.run) && /node scripts\/refresh-bazaar\.js/.test(b.run) && /BAZAAR_PRICE_CHANGE_MAX_USD/.test(String(b.env?.MAX_SPEND_USD)), "the price-change buy is the keep-alive's sweep, every changed route, under its own cap");
  ok(/BURNER_KEY="" POW_SECRET="" node scripts\/keepalive-plan\.js changed/.test(b.run) && /steps\.verify\.outcome == 'success'/.test(String(b.if)), "the plan runs without the key, and only on a verified deploy");

  const hb = read(".github/workflows/heartbeat.yml");
  ok(/keepalive-plan\.js low-water/.test(hb) && /FLOOR_USD: \$\{\{ vars\.CANARY_BURNER_LOW_USD/.test(hb) && /WARN_USD="\$FLOOR_USD"/.test(hb), "the burner alarm reads the derived mark, floored by the repo variable, which also stands in when the catalog is unreadable");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
