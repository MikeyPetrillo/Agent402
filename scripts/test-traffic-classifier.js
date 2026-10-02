// Who hits us: the per-request classes, the crawler rule, the repeat-buyer
// memory, the bounded rollup and its persistence, and the operator read.
//
//   node scripts/test-traffic-classifier.js
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { classify, templatePath, createTrafficStore, indexerFor, CLASSES, DEFAULTS } from "../src/traffic-classifier.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };

// --- the classes ------------------------------------------------------------------
const base = { status: 200, path: "/api/hash", ua: "curl/8.0", accept: "*/*", hadPayment: false, hadPow: false, paidReceipt: false, priorPayerCount: 0, ipDistinctPaths: 1 };
ok(classify({ ...base, status: 402 }) === "challenge-only", "an unpaid 402 is challenge-only");
ok(classify({ ...base, status: 402, hadPayment: true }) === "payment-refused", "a 402 to a request that carried a payment is payment-refused");
ok(classify({ ...base, paidReceipt: true }) === "paid", "a settled 200 is paid");
ok(classify({ ...base, paidReceipt: true, priorPayerCount: 1 }) === "repeat-buyer", "...and a repeat payer is repeat-buyer");
ok(classify({ ...base, hadPow: true }) === "pow", "a proof-of-work 200 is pow");
ok(classify({ ...base, ipDistinctPaths: DEFAULTS.crawlerDistinctPaths }) === "crawler", "an ip past the distinct-path threshold is a crawler");
ok(classify({ ...base, status: 402, ipDistinctPaths: 99 }) === "crawler", "...even when the request itself is a 402");
ok(classify({ ...base, ua: "Mozilla/5.0 (compatible; x402scan/1.0)" , ipDistinctPaths: 99 }) === "known-indexer", "a named indexer UA is known-indexer whatever it does");
ok(classify({ ...base, path: "/docs", ua: "Mozilla/5.0 (Macintosh) Chrome/120", accept: "text/html,*/*" }) === "human", "a browser on an HTML page is human");
ok(classify({ ...base, path: "/api/hash", ua: "Mozilla/5.0 (Macintosh) Chrome/120", accept: "text/html" }) === "other", "a browser on /api is not human");
ok(classify({ ...base, ua: "Mozilla/5.0 (compatible; GPTBot/1.0)" }) === "known-indexer" && indexerFor("Mozilla/5.0 (compatible; GPTBot/1.0)").name === "ai-crawler", "AI crawlers are named");
ok(classify({ ...base, status: 402, ua: "agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)", ipDistinctPaths: 600 }) === "ours", "our own CI sweep is ours, not a crawler and not demand");
ok(CLASSES.length === 10, "ten classes");

// --- paths are templated and bounded ------------------------------------------------
ok(templatePath("/api/hash?text=x") === "/api/hash", "query dropped");
ok(templatePath("/api/skill/security-audit/x") === "/api/skill/security-audit", "pack slug kept");
ok(templatePath("/v1/metered/chat/completions") === "/v1/metered", "gateway paths keep two segments");
ok(templatePath("/tools/hash") === "/tools/*", "page paths collapse to one segment");
ok(templatePath("/.well-known/x402") === "/.well-known/x402", "well-known kept");

// --- the store: crawler detection, repeat buyers, caps, persistence ---------------------
const dir = mkdtempSync(join(tmpdir(), "a402-traffic-"));
const store = createTrafficStore({ dir, crawlerDistinctPaths: 5, salt: "test" });
const t0 = Date.parse("2026-09-22T10:00:00Z");
const rec = (over) => store.record({ ip: "203.0.113.7", ua: "curl/8.0", path: "/api/hash", method: "POST", status: 402, accept: "*/*", now: t0, ...over });
const first = [];
for (let i = 0; i < 5; i++) first.push(rec({ path: `/api/tool-${i}` }));
ok(first.slice(0, 4).every((c) => c === "challenge-only") && first[4] === "crawler", `the fifth distinct path flips the ip to crawler (${first.join(",")})`);
ok(rec({ ip: "198.51.100.9", path: "/api/hash" }) === "challenge-only", "another ip is judged on its own");
ok(rec({ ip: "198.51.100.9", path: "/api/hash", now: t0 + 30 * 60 * 1000, status: 402 }) === "challenge-only", "the window resets after windowMs");
const p1 = rec({ ip: "192.0.2.1", status: 200, paidReceipt: true, payer: "0xabc" });
const p2 = rec({ ip: "192.0.2.1", status: 200, paidReceipt: true, payer: "0xabc" });
const p3 = rec({ ip: "192.0.2.2", status: 200, paidReceipt: true, payer: "0xdef" });
ok(p1 === "paid" && p2 === "repeat-buyer" && p3 === "paid", `a payer's second settlement is a repeat (${p1},${p2},${p3})`);
rec({ ip: "192.0.2.3", ua: "Mozilla/5.0 (compatible; x402scan/1.0)", path: "/api/pricing", status: 200 });
rec({ ip: "192.0.2.4", ua: "node", path: "/api/pricing", status: 200 }); rec({ ip: "192.0.2.4", ua: "node", path: "/openapi.json", status: 200 });
const r = store.report({ days: 1, top: 5 });
const d = r.days[0];
ok(d.day === "2026-09-22" && d.total === 13 && d.classes.crawler === 1 && d.classes["repeat-buyer"] === 1 && d.classes["known-indexer"] === 1, `the day rollup counts every class (${JSON.stringify(d.classes)})`);
ok(d.indexers[0]?.key === "x402scan" && d.discovery.some((x) => x.key === "/api/pricing"), "indexers and discovery surfaces are counted by name");
const cr = d.crawlers;
ok(cr.some((c) => c.verdict === "catalog-walker" && c.distinctPaths >= 5) && cr.some((c) => c.verdict === "known-indexer (wanted)") && cr.some((c) => c.verdict === "discovery-only" && c.discovery === 2), `the crawler list carries a verdict per ip (${cr.map((c) => c.verdict).join(" | ")})`);
ok(!JSON.stringify(r).includes("203.0.113.7") && !JSON.stringify(r).includes("0xabc") && r.detection.note.includes("never addresses"), "no raw ip or payer address reaches the report");
ok(store.persist(t0) === true && existsSync(join(dir, "2026-09-22.json")) && existsSync(join(dir, "payers.json")), "the day and the payer memory persist");
const again = createTrafficStore({ dir, crawlerDistinctPaths: 5, salt: "test" }); again.load();
ok(again.report({ days: 1 }).days[0]?.total === 13 && again._payers.size === 2, "a fresh store warm-starts from disk");
ok(again.record({ ip: "192.0.2.9", ua: "curl", path: "/api/hash", method: "POST", status: 200, paidReceipt: true, payer: "0xabc", now: t0 }) === "repeat-buyer", "...and remembers the payer across a restart");
{
  // Retention: a day rollup past retentionDays is deleted from disk and memory,
  // on load and on persist; a day inside it is kept. /privacy states this figure.
  ok(DEFAULTS.retentionDays === 90, `default retention is 90 days (${DEFAULTS.retentionDays})`);
  const rdir = mkdtempSync(join(tmpdir(), "a402-traffic-ret-"));
  writeFileSync(join(rdir, "2026-06-01.json"), JSON.stringify({ day: "2026-06-01", total: 1 }));
  writeFileSync(join(rdir, "2026-09-01.json"), JSON.stringify({ day: "2026-09-01", total: 1 }));
  const rs0 = createTrafficStore({ dir: rdir, salt: "t" }); rs0.load(t0);
  ok(!existsSync(join(rdir, "2026-06-01.json")) && !rs0._days.has("2026-06-01"), "a rollup older than 90 days is deleted on load");
  ok(existsSync(join(rdir, "2026-09-01.json")) && rs0._days.has("2026-09-01"), "a rollup inside retention is kept");
  rs0.persist(t0 + 70 * 864e5);
  ok(!existsSync(join(rdir, "2026-09-01.json")) && !rs0._days.has("2026-09-01"), "persist deletes a rollup once it passes retention");
}
{
  const capped = createTrafficStore({ dir: mkdtempSync(join(tmpdir(), "a402-traffic-cap-")), keyCap: 3, salt: "t" });
  for (let i = 0; i < 10; i++) capped.record({ ip: `10.0.0.${i}`, ua: `ua-${i}`, path: `/api/t${i}`, method: "GET", status: 402, now: t0 });
  const b = capped.report({ days: 1 }).days[0].byClass["challenge-only"];
  ok(b.paths.length <= 4 && b.paths.some((x) => x.key === "_other"), "maps are capped and the overflow folds into _other");
}
ok(typeof store.summaryLine("2026-09-22") === "string" && /total=13/.test(store.summaryLine("2026-09-22")), "the daily summary line reads the rollup");

// --- the payment rail ----------------------------------------------------------------------
{
  const { railOf } = await import("../src/payment-rail.js");
  ok(railOf({ mppTempoCredential: true, headers: { "payment-signature": "x" } }) === "mpp-tempo", "a tempo credential is mpp-tempo even beside an x402 header");
  ok(railOf({ mppCredential: true, headers: { "payment-signature": "x" } }) === "mpp-evm", "an MPP evm credential translated to PAYMENT-SIGNATURE is still mpp-evm, not x402");
  ok(railOf({ mppStripeCredential: true, headers: {} }) === "mpp-stripe", "a stripe credential is mpp-stripe");
  ok(railOf({ creditsSettling: true, headers: {} }) === "credits", "a credits key is credits");
  ok(railOf({ headers: { "payment-signature": "x" } }) === "x402", "a bare PAYMENT-SIGNATURE is x402");
  ok(railOf({ headers: { authorization: "Payment abc" } }) === "mpp", "an unrecognised Payment credential is mpp");
  ok(railOf({ headers: { "x-pow-solution": "t:1" } }) === "pow", "a proof-of-work solution is pow");
  ok(railOf({ headers: {} }) === null, "an unpaid request has no rail");
  const rs = createTrafficStore({ dir: mkdtempSync(join(tmpdir(), "a402-rail-")) });
  const at = Date.parse("2026-09-22T12:00:00Z");
  rs.record({ ip: "1.1.1.1", ua: "node", path: "/api/uuid", method: "GET", status: 200, hadPayment: true, paidReceipt: true, payer: "0xa", rail: "mpp-tempo", now: at });
  rs.record({ ip: "1.1.1.1", ua: "node", path: "/api/uuid", method: "GET", status: 200, hadPayment: true, paidReceipt: true, payer: "0xa", rail: "mpp-tempo", now: at });
  rs.record({ ip: "1.1.1.2", ua: "node", path: "/api/uuid", method: "GET", status: 402, hadPayment: true, paidReceipt: false, rail: "mpp-tempo", now: at });
  rs.record({ ip: "1.1.1.3", ua: "node", path: "/api/hash", method: "POST", status: 502, hadPayment: true, paidReceipt: false, rail: "x402", now: at });
  rs.record({ ip: "1.1.1.4", ua: "node", path: "/api/hash", method: "POST", status: 200, hadPow: true, paidReceipt: false, rail: "pow", powAccepted: true, now: at });
  const rr = rs.report({ days: 1 }).days[0].rails;
  ok(rr["mpp-tempo"].attempts === 3 && rr["mpp-tempo"].paid === 2 && rr["mpp-tempo"].refused === 1, `per-rail attempts/paid/refused (${JSON.stringify(rr["mpp-tempo"])})`);
  ok(rr["mpp-tempo"].distinctPayers === 1 && rr["mpp-tempo"].paidPerPayer === 2, "distinct payers and paid calls per payer");
  ok(rr.x402.errored === 1 && rr.x402.paid === 0, "a 5xx on a paid attempt is errored, not paid");
  ok(rr.pow.paid === 1, "an accepted proof-of-work counts as paid on the pow rail");
  ok(!JSON.stringify(rr).includes("payers\":{"), "the rail summary carries no payer hashes");
  ok(/rail\.mpp-tempo=2\/3paid,1payers/.test(rs.summaryLine("2026-09-22")), "the daily summary line carries each rail");
}

// --- the wire: a free boot, a walk, the operator read -------------------------------------
const port = await getFreePort();
const base2 = `http://127.0.0.1:${port}`;
const tdir = mkdtempSync(join(tmpdir(), "a402-traffic-boot-"));
const proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), BASE_URL: "http://agent402.test", AGENT402_OPERATOR_TOKEN: "test-operator-token", TRAFFIC_DIR: tdir, TRAFFIC_CRAWLER_PATHS: "6", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off" }, stdio: ["ignore", "ignore", "inherit"] });
try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) { try { up = (await fetch(`${base2}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted with the classifier mounted");
  const noauth = await fetch(`${base2}/__operator/traffic.json`);
  ok(noauth.status === 404, "the report is operator-only (404 without the token)");
  // The browser read goes FIRST: every request here shares one ip, and once
  // that ip has walked seven tools it is a crawler whatever it fetches next
  // (that is the rule working, not a defect).
  await fetch(`${base2}/docs`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120", accept: "text/html" } });
  await fetch(`${base2}/api/pricing`, { headers: { "user-agent": "Mozilla/5.0 (compatible; x402scan/1.0)" } });
  for (const p of ["hash", "uuid", "base64", "sha256", "url-parse", "slugify", "json-format"]) await fetch(`${base2}/api/${p}`, { headers: { "user-agent": "walker/1.0" } });
  const rep = await (await fetch(`${base2}/__operator/traffic.json?days=1`, { headers: { authorization: "Bearer test-operator-token" } })).json();
  const today = rep.days[0];
  ok(today && today.total >= 9, `the operator read carries today's rollup (${today?.total} requests)`);
  ok(today.classes.crawler >= 1 && today.crawlers.some((c) => c.ua === "walker/1.0" && c.verdict === "catalog-walker"), "a client that walked seven tools is a catalog-walker");
  ok(today.classes["known-indexer"] >= 1 && today.indexers.some((x) => x.key === "x402scan"), "a named indexer is counted by name");
  ok(today.classes.human >= 1, "a browser on /docs is human");
  ok(!JSON.stringify(rep).includes("127.0.0.1"), "no raw ip in the served report");
} finally { proc.kill("SIGTERM"); }
console.log(`OK: ${pass} passed`);
