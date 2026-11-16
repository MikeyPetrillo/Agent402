#!/usr/bin/env node
// The keep-alive passes beyond the weekly ceiling: which routes the scheduled
// tail pass buys, which routes a deploy's price change buys, the spend caps
// that refuse a pass, and the burner low-water figure derived from one pass.
// Offline: a stub catalog on port 0. refresh-bazaar.js runs under DRY_RUN, or,
// for the in-pass cap, signs with a throwaway key against a loopback stub that
// records each signed authorization and settles nothing (no broadcast).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { load } from "js-yaml";
import {
  KEEPALIVE_CEILING_USD, usdMicros, exemptKind, aboveCeilingRoutes, passMicros, spendCapVerdict, routeCountVerdict,
  priceSnapshot, changedPriceRoutes, burnerLowWaterUsd, PRICE_CHANGE_MAX_ROUTES,
} from "./lib/keepalive-plan.js";
import { LASTING_EFFECT_SLUG_LIST } from "../src/lasting-effect-slugs.js";
import { LASTING_EFFECT_SLUG_LIST as SERVER_LASTING, defHasLastingEffect } from "../src/hangup-forgiveness.js";
import { signedSpendBudget } from "./refresh-bazaar.js";
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
  // Routes whose effect outlives the answer: our wallet spends, an outside
  // seller is paid, or something lasting is written. Priced above the
  // ceiling here so only the exemption keeps them out.
  row("seller-payability", "$0.25"),
  row("flight-search", "$0.20"),
  row("attest", "$0.50"),
  row("memory-write", "$0.30"),
  row("decide-execute", "$0.40"),
  row("flagged-buyer", "$0.70", { paysThirdPartySeller: true }),
  row("flagged-spender", "$0.70", { spendsOwnWallet: true }),
];
// A $ followed by a figure: what no keep-alive log line may carry.
const DOLLAR_FIGURE = /\$\s?\d/;

// --- route selection: above the ceiling only, exempt kinds excluded ---------
{
  const sel = aboveCeilingRoutes({ endpoints: CATALOG });
  ok(JSON.stringify(sel.map((r) => r.slug)) === JSON.stringify(["just-over", "report", "pack"]), `the tail pass buys only fixed-price routes above the ceiling (${sel.map((r) => r.slug).join(", ")})`);
  ok(exemptKind(CATALOG[5]) === "quoted" && exemptKind(CATALOG[6]) === "model-priced" && exemptKind(CATALOG[7]) === "route-execute" && exemptKind(CATALOG[0]) === null, "quoted, model-priced and route-execute routes are exempt kinds");
  const lasting = CATALOG.filter((r) => ["seller-payability", "flight-search", "attest", "memory-write", "decide-execute", "flagged-buyer", "flagged-spender"].includes(r.slug));
  ok(lasting.every((r) => exemptKind(r) === "lasting-effect"), `every route that spends our wallet, pays an outside seller or writes something lasting is exempt (${lasting.map((r) => `${r.slug}:${exemptKind(r)}`).join(", ")})`);
  ok(LASTING_EFFECT_SLUG_LIST.every((slug) => exemptKind(row(slug, "$5.00")) !== null), `every slug on the server's lasting-effect list is exempt (${LASTING_EFFECT_SLUG_LIST.length})`);
  ok(SERVER_LASTING === LASTING_EFFECT_SLUG_LIST && defHasLastingEffect({ slug: "attest" }) && /from "\.\/lasting-effect-slugs\.js"/.test(read("src/hangup-forgiveness.js")), "the plan reads the server's own list (src/hangup-forgiveness.js re-exports the same frozen array), not a copy");
  ok(!/^import\s/m.test(read("src/lasting-effect-slugs.js")) && (read("scripts/lib/keepalive-plan.js").match(/^import .*$/gm) || []).every((l) => /lasting-effect-slugs\.js/.test(l)), "the plan's only import is the import-free list, so it runs before any install");
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
  const bud = signedSpendBudget("1");
  ok(bud.fits("0.85") && bud.signCapUsd(2) === 1, "a fresh budget fits a route under the cap and lets a signature reach the cap");
  bud.forRoute("0.60");
  ok(bud.signCapUsd(2) === 0.6 && bud.signCapUsd(0.5) === 0.5, "a signature is held to the route's planned price and to the per-signature ceiling");
  bud.record(600_000);
  ok(!bud.fits("0.60") && bud.fits("0.40") && bud.signCapUsd(2) === 0.4 && bud.signatures === 1, "what was signed is counted: the next route must fit what is left, and so must the next signature");
  bud.record(400_000);
  ok(bud.signCapUsd(2) === 0 && !signedSpendBudget("0").fits("0.01"), "a spent budget, or no cap, refuses every signature");
  ok(routeCountVerdict(new Array(25), 25).ok && !routeCountVerdict(new Array(26), 25).ok && !routeCountVerdict([], "x").ok && PRICE_CHANGE_MAX_ROUTES === 25, "the price-change set is refused above its route-count cap");
  const outFile = join(mkdtempSync(join(tmpdir(), "ka-plan-")), "out");
  writeFileSync(outFile, "");
  const logs = [];
  const fetchPricing = async () => ({ endpoints: CATALOG });
  const code = await run(["tail"], { env: { MAX_SPEND_USD: "2", GITHUB_OUTPUT: outFile }, log: (m) => logs.push(m), err: (m) => logs.push(m), fetchPricing });
  ok(code === 3 && /refusing/.test(logs.join("\n")) && /^slugs=$/m.test(readFileSync(outFile, "utf8")), "the tail plan over its cap exits 3 and hands the buy step no slugs");
  const L = (m) => logs.push(m);
  writeFileSync(outFile, "");
  const code2 = await run(["tail"], { env: { MAX_SPEND_USD: "25", GITHUB_OUTPUT: outFile }, log: L, err: L, fetchPricing });
  const out = readFileSync(outFile, "utf8");
  ok(code2 === 0 && /^slugs=just-over,report,pack$/m.test(out) && /^max_price=2$/m.test(out), `the tail plan under its cap writes the slugs and the highest price (${out.trim().replace(/\n/g, " ")})`);
  const snap = join(mkdtempSync(join(tmpdir(), "ka-snap-")), "before.json");
  writeFileSync(snap, JSON.stringify(priceSnapshot([row("report", "$0.60"), row("pack", "$1.10")])));
  writeFileSync(outFile, "");
  const code3 = await run(["changed", snap], { env: { MAX_SPEND_USD: "1", GITHUB_OUTPUT: outFile }, log: L, err: L, fetchPricing });
  ok(code3 === 3 && /^slugs=$/m.test(readFileSync(outFile, "utf8")), "a price-change set over its cap exits 3 with no slugs");
  writeFileSync(outFile, "");
  const code4 = await run(["changed", snap], { env: { MAX_SPEND_USD: "5", GITHUB_OUTPUT: outFile }, log: L, err: L, fetchPricing });
  ok(code4 === 0 && /^slugs=report,pack$/m.test(readFileSync(outFile, "utf8")), "a price-change set under its cap names its routes");
  writeFileSync(outFile, "");
  const code4b = await run(["changed", snap], { env: { MAX_SPEND_USD: "5", MAX_ROUTES: "1", GITHUB_OUTPUT: outFile }, log: L, err: L, fetchPricing });
  ok(code4b === 3 && /^slugs=$/m.test(readFileSync(outFile, "utf8")) && /route-count cap/.test(logs.join("\n")), "a price-change set over its route-count cap exits 3 with no slugs");
  const many = Array.from({ length: 30 }, (_, i) => row(`r${i}`, "$0.20"));
  const snapMany = join(mkdtempSync(join(tmpdir(), "ka-snap-")), "before.json");
  writeFileSync(snapMany, JSON.stringify(priceSnapshot(many.map((r) => ({ ...r, price: "$0.10" })))));
  writeFileSync(outFile, "");
  const code4c = await run(["changed", snapMany], { env: { MAX_SPEND_USD: "100", GITHUB_OUTPUT: outFile }, log: L, err: L, fetchPricing: async () => ({ endpoints: many }) });
  ok(code4c === 3 && /^slugs=$/m.test(readFileSync(outFile, "utf8")), "with no MAX_ROUTES set the default cap of 25 still refuses 30 changed routes");
  ok(logs.length >= 6 && !logs.some((m) => DOLLAR_FIGURE.test(m)), `the plan's log lines carry no dollar figure (${logs.filter((m) => DOLLAR_FIGURE.test(m)).join(" | ")})`);
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
    const p = spawn(process.execPath, [fileURLToPath(new URL("./refresh-bazaar.js", import.meta.url))], { env: { ...env, ...extra } });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  const plan = aboveCeilingRoutes(CATALOG);
  const slugs = plan.map((r) => r.slug).join(",");
  const a = await rb({ SLUGS: slugs, MAX_PRICE_USD: "2", MAX_SPEND_USD: "25" });
  ok(a.code === 0 && /sweeping 3 routes/.test(a.out) && /The 3 routes' list prices together are within the MAX_SPEND_USD cap/.test(a.out), `refresh-bazaar sweeps exactly the plan's routes within the cap (exit ${a.code})`);
  const b = await rb({ SLUGS: slugs, MAX_PRICE_USD: "2", MAX_SPEND_USD: "2.9" });
  ok(b.code === 2 && /Refusing to run/.test(b.out), `refresh-bazaar refuses the pass when its estimate is over MAX_SPEND_USD (exit ${b.code})`);
  const c = await rb({ SLUGS: "", MAX_PRICE_USD: "2", MAX_SPEND_USD: "25" });
  ok(c.code === 2 && /REQUIRE_SLUGS/.test(c.out) && !/sweeping/.test(c.out), `an empty plan never becomes a sweep of every route (exit ${c.code})`);
  ok(![a, b, c].some((x) => DOLLAR_FIGURE.test(x.out)), "refresh-bazaar's pass logs carry route counts, no dollar figure");
  server.close();
}

// --- the in-pass cap counts what was SIGNED, held to each route's plan -------
// A loopback stub: /api/pricing lists each route at its list price, each paid
// route's 402 asks `ask` (a deploy that raised the price mid-pass asks more),
// and a route marked failFirst answers its first signed call 502 (a buy that
// may have settled and reads as failed). Every signed authorization is
// recorded; nothing is settled or broadcast. The key is thrown away.
async function signedPass({ routes, cap, maxPrice = "2" }) {
  const endpoints = routes.map((r) => ({ slug: r.slug, path: `/api/${r.slug}`, method: "POST", price: r.list }));
  const spec = { paths: Object.fromEntries(endpoints.map((r) => [r.path, { post: { requestBody: { content: { "application/json": { example: { q: "x" } } } } } }])) };
  const signed = [];
  const seen = new Map();
  const srv = createServer((req, res) => {
    req.resume();
    if (req.url === "/api/pricing") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ endpoints }));
    if (req.url === "/openapi.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(spec));
    const slug = req.url.replace("/api/", "");
    const r = routes.find((x) => x.slug === slug);
    if (!r) return res.writeHead(404).end("{}");
    const sig = req.headers["payment-signature"];
    if (sig) {
      const p = JSON.parse(Buffer.from(sig, "base64").toString());
      signed.push([slug, Number(p.payload.authorization.value)]);
      const n = (seen.get(slug) || 0) + 1;
      seen.set(slug, n);
      if (r.failFirst && n === 1) return res.writeHead(502, { "content-type": "application/json" }).end("{}");
      return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    const pr = { x402Version: 2, error: "payment required", resource: { url: `http://127.0.0.1${req.url}`, description: "", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(r.ask), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] };
    res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") }).end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TARGET_URL: `http://127.0.0.1:${srv.address().port}`, MODE: "sweep", PAY_NETWORK: "base",
    SLUGS: routes.map((r) => r.slug).join(","), REQUIRE_SLUGS: "1", MAX_PRICE_USD: maxPrice, MAX_SPEND_USD: cap, STALE_DAYS: "0", BATCH_COUNT: "1",
    BURNER_KEY: `0x${randomBytes(32).toString("hex")}` };
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL("./refresh-bazaar.js", import.meta.url))], { env });
    let o = "";
    p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
    p.on("close", (code) => resolve({ code, out: o }));
  });
  srv.close();
  return { ...out, signed, total: signed.reduce((s, [, v]) => s + v, 0) };
}
{
  // Raised mid-pass: listed at $0.60, the live 402 asks $2.00. The plan-time
  // estimate ($1.80) is under the $4 cap; signing the asked price would come
  // to $6.
  const raised = await signedPass({ routes: ["a1", "a2", "a3"].map((slug) => ({ slug, list: "$0.60", ask: 2_000_000 })).concat([{ slug: "ok1", list: "$0.60", ask: 600_000 }]), cap: "4" });
  ok(raised.total <= 4_000_000 && raised.signed.every(([slug, v]) => v <= 600_000 && slug === "ok1") && raised.signed.length === 1, `a 402 asking more than the route's planned price is refused, and the pass stays under its cap (signed ${JSON.stringify(raised.signed)})`);
  ok(!DOLLAR_FIGURE.test(raised.out), "the signing pass's logs carry no dollar figure");
  // A buy that answers 502 after signing is retried: both signatures count.
  // Cap $1.30 (the plan's $1.30 fits): r1 signs twice ($1.20 in all), so r2
  // ($0.70, bought after r1, cheapest first) must not be bought.
  const retry = await signedPass({ routes: [{ slug: "r1", list: "$0.60", ask: 600_000, failFirst: true }, { slug: "r2", list: "$0.70", ask: 700_000 }], cap: "1.3" });
  ok(JSON.stringify(retry.signed.map(([s]) => s)) === JSON.stringify(["r1", "r1"]) && retry.total === 1_200_000 && /CAP POST \/api\/r2/.test(retry.out), `a retry's signature counts too: the next route is not bought past the cap (signed ${JSON.stringify(retry.signed)})`);
  // Cap $1.00: the retry itself would take the signed total to $1.20, so it is refused.
  const clamp = await signedPass({ routes: [{ slug: "r1", list: "$0.60", ask: 600_000, failFirst: true }], cap: "1" });
  ok(clamp.signed.length === 1 && clamp.total === 600_000, `a retry that would sign past the cap is refused before signing (signed ${JSON.stringify(clamp.signed)})`);
  // Cap $25: 95 routes at $0.26 sign $24.70, then a route listed at $0.29
  // (the plan estimate stays under the cap) whose 402 asks $0.50 meets the
  // guard with $0.30 left. The refusal line says it was over the cap and
  // names no amount, in dollars or base units.
  const fillers = Array.from({ length: 95 }, (_, i) => ({ slug: `f${i}`, list: "$0.26", ask: 260_000 }));
  const left = await signedPass({ routes: fillers.concat([{ slug: "probe", list: "$0.29", ask: 500_000 }]), cap: "25" });
  const refusals = left.out.split("\n").filter((l) => /over the cap/.test(l));
  const BASE_UNITS = /\d+\s*base units|\d+ at \d+ decimals|no positive cap \(/;
  ok(left.total === 24_700_000 && !left.signed.some(([s]) => s === "probe") && refusals.length >= 1, `the guard refuses the probe with $0.30 left (signed ${left.signed.length}, refusals ${refusals.length})`);
  ok(!refusals.some((l) => BASE_UNITS.test(l) || /over the cap \(/.test(l)) && !BASE_UNITS.test(left.out) && !DOLLAR_FIGURE.test(left.out), `a budgeted refusal names no amount (${refusals.join(" | ")})`);
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
  ok(b["continue-on-error"] === true, "the price-change buy can never fail the deploy job (continue-on-error)");
  ok(Number.isInteger(b["timeout-minutes"]) && b["timeout-minutes"] >= 15 && b["timeout-minutes"] <= 20, `the price-change buy has its own 15 to 20 minute bound (${b["timeout-minutes"]})`);
  ok(String(b.env?.MAX_ROUTES) === "25", `the price-change buy refuses more than 25 routes (MAX_ROUTES ${b.env?.MAX_ROUTES})`);
  const warnings = String(b.run).split("\n").filter((l) => /::warning::/.test(l));
  ok(warnings.length >= 3 && !warnings.some((l) => DOLLAR_FIGURE.test(l) || /\$OUT\b/.test(l) || /\$MAXP\b|\$MAX_SPEND_USD\b/.test(l)), "no warning in the price-change step echoes a figure, the cap or the plan's output");
  const tailWf = read(".github/workflows/bazaar-keepalive-tail.yml");
  ok(!/removes a resource|30-day (removal|rule)|rank|quality/i.test(tailWf) && /observed to leave the Bazaar listing after about 30 days/.test(tailWf) && /keep (them|those routes) listed/.test(tailWf), "the tail workflow and its issue state the 30-day behavior as observed and the purpose as keeping routes listed");
  const weeklyWf = read(".github/workflows/bazaar-keepalive.yml");
  const CDP_RULE = /CDP(?:'s)?\s+(?:own\s+)?(?:seller\s+)?docs|CDP\s+(?:removes|culls|deletes)|removes a resource|30-day (?:removal|rule)|\bcull\b/i;
  ok(![tailWf, weeklyWf].some((t) => CDP_RULE.test(t)) && /observed to leave the Bazaar listing after about 30 days/.test(weeklyWf) && /keep(s)? (them|routes) listed/.test(weeklyWf), `neither keep-alive workflow states the 30-day removal as a CDP rule (${[tailWf, weeklyWf].map((t) => (t.match(CDP_RULE) || [""])[0]).join(" | ")})`);

  const hb = read(".github/workflows/heartbeat.yml");
  const burnerRun = String(Object.values(load(hb).jobs || {}).flatMap((j) => j.steps || []).find((st) => /Canary burner balance watch/.test(st.name || ""))?.run || "");
  ok(/\$WARN_USD/.test(burnerRun) && !burnerRun.split("\n").some((l) => /(?:echo|--body)\s+["']?[^"'\n]*\$\{?WARN_USD\b/.test(l)), "the burner balance step never echoes its derived mark");
  ok(/keepalive-plan\.js low-water/.test(hb) && /FLOOR_USD: \$\{\{ vars\.CANARY_BURNER_LOW_USD/.test(hb) && /WARN_USD="\$FLOOR_USD"/.test(hb), "the burner alarm reads the derived mark, floored by the repo variable, which also stands in when the catalog is unreadable");
  const claude = read("CLAUDE.md");
  ok(/`BAZAAR_PRICE_CHANGE_MAX_USD`/.test(claude) && /`CANARY_BURNER_LOW_USD`[^\n]*floor/.test(claude), "CLAUDE.md documents both repo variables");
}

// --- the burner alarm, run as written with stubbed node, curl and gh ---------
{
  const hbSteps = Object.values(load(read(".github/workflows/heartbeat.yml")).jobs).flatMap((j) => j.steps || []);
  const step = hbSteps.find((s) => /^Canary burner balance watch/.test(String(s.name || "")));
  const dir = mkdtempSync(join(tmpdir(), "ka-hb-"));
  writeFileSync(join(dir, "node"), `#!/usr/bin/env bash\nif [ "$1" = "scripts/keepalive-plan.js" ]; then [ -n "$LW_OUT" ] && echo "$LW_OUT"; exit \${LW_CODE:-0}; fi\nexec "${process.execPath}" "$@"\n`);
  writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash\nprintf '{"jsonrpc":"2.0","id":1,"result":"%s"}' "$BAL_HEX"\n`);
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
jqx=""; prev=""; for a in "$@"; do [ "$prev" = "--jq" ] && jqx="$a"; prev="$a"; done
if [ "$1 $2" = "issue list" ]; then printf '%s' "$ISSUES_JSON" | jq -r "$jqx"; exit 0; fi
if [ "$1 $2" = "issue view" ]; then printf '%s' "$VIEW_JSON" | jq -r "$jqx"; exit 0; fi
echo "$1 $2 $3" >> "$GH_LOG"
`);
  for (const f of ["node", "curl", "gh"]) await chmod(join(dir, f), 0o755);
  const TITLE = "Canary burner LOW (Base)";
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const runHb = ({ lw = "21", open = false, view = null, balance = 10 }) => {
    const log = join(dir, "gh.log");
    writeFileSync(log, "");
    const r = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", BURNER: step.env.BURNER, FLOOR_USD: "1", LW_OUT: lw,
        BAL_HEX: `0x${(balance * 1e6).toString(16)}`, ISSUES_JSON: JSON.stringify(open ? [{ number: 5, title: TITLE }] : []), VIEW_JSON: JSON.stringify(view || {}), GH_LOG: log },
      encoding: "utf8",
    });
    return { status: r.status, calls: readFileSync(log, "utf8").split("\n").filter(Boolean), out: r.stdout + r.stderr };
  };
  const a = runHb({});
  ok(a.status === 0 && a.calls.length === 1 && /^issue create/.test(a.calls[0]), `below the derived mark with no issue open files one (${a.calls.join(" | ")})`);
  const b = runHb({ open: true, view: { createdAt: hoursAgo(30), comments: [{ createdAt: hoursAgo(2) }] } });
  ok(b.status === 0 && b.calls.length === 0, `an open LOW issue noted within the last day gets no comment (${b.calls.join(" | ")})`);
  const c = runHb({ open: true, view: { createdAt: hoursAgo(50), comments: [{ createdAt: hoursAgo(25) }] } });
  ok(c.status === 0 && c.calls.length === 1 && /^issue comment 5/.test(c.calls[0]), `an open LOW issue last noted over a day ago gets one comment (${c.calls.join(" | ")})`);
  const c2 = runHb({ open: true, view: { createdAt: hoursAgo(3), comments: [] } });
  ok(c2.status === 0 && c2.calls.length === 0, "an issue opened within the last day with no comment yet gets none");
  const d = runHb({ open: true, lw: "" });
  ok(d.status === 0 && d.calls.length === 0 && /stand-in mark/.test(d.out), `an unreadable catalog (the floor stands in) never closes an open LOW issue (${d.calls.join(" | ")})`);
  const e = runHb({ open: true, balance: 30 });
  ok(e.status === 0 && e.calls.length === 1 && /^issue close 5/.test(e.calls[0]), `above the derived mark the open issue closes (${e.calls.join(" | ")})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
