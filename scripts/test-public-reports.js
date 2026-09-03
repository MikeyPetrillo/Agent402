#!/usr/bin/env node
// Public reports: a buyer makes a delivered report public by its session id
// (the only credential), it gets an unguessable rp_ id served indexable at
// /reports/public/<id> through the shared viewer with its own title, canonical
// and JSON-LD, the readers work with no Stripe engine (files on the volume),
// revoking makes the link dead, and a re-publish brings the SAME link back.
// Offline: stub Stripe + generator for the engine; a FREE_MODE boot (no Stripe)
// for the routes, reading the real default store dir.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { createHumanCheckout, readPublicReport, listPublicReports } from "../src/human-checkout.js";

let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
// Page titles for EVERY report kind derive from the report H1 (normalised), never the bare input.
const { reportHeadline, HUMAN_PRODUCTS: HP } = await import("../src/human-checkout.js");
ok(reportHeadline({ report: "# NVIDIA CORP (NVDA): Company Due-Diligence Dossier\n\ntext", title: "NVDA", product: "dossier" }) === "NVIDIA CORP (NVDA): Company Due-Diligence Dossier", "page title is the report H1 when it has one (any kind)");
ok(reportHeadline({ report: "no heading here", title: "havok.holdings", product: "domain-audit" }) === "Domain security audit: havok.holdings", "no H1: product label + subject, never the bare input");
ok(Object.keys(HP).every((k) => reportHeadline({ report: "", input: "x", product: k }).startsWith(HP[k].label + ": ")), "every product in HUMAN_PRODUCTS falls back to its own label");
ok(reportHeadline({ report: "# BERKSHIRE HATHAWAY INC — FUND PORTFOLIO REPORT\n" }) === "Berkshire Hathaway Inc: Fund Portfolio Report", "H1 normalised: no em dashes, all-caps title-cased");
ok(reportHeadline({ report: "# NVIDIA CORP (NVDA) — Company Due-Diligence Dossier\n" }) === "NVIDIA CORP (NVDA): Company Due-Diligence Dossier", "mixed-case H1 keeps its casing, dash becomes a colon");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The booted server reads DEFAULT_DIR (the same resolver the engine uses), so
// the record must live there; unique ids + cleanup keep it hermetic.
const DIR = join(existsSync("/data") ? "/data" : "/tmp", "human-checkout");
mkdirSync(DIR, { recursive: true });
const SID = `cs_pubtest_${Date.now().toString(36)}`;
const created = [];
function cleanup() { for (const f of created) { try { unlinkSync(f); } catch { /* gone */ } } }

const stripe = { checkout: { sessions: { retrieve: async (id) => (id === SID ? { id, payment_status: "paid", mode: "payment", metadata: { product: "domain-audit", input: "example.com" }, customer_details: { email: null } } : null) } }, refunds: { create: async () => ({ id: "re_x" }) } };
const generate = async () => ({ report: "# Domain Security Audit: example.com\n\n**Overall grade: A**\n\n" + "Detail line. ".repeat(400), title: "example.com", sources: [{ n: 1, title: "DNS", url: "https://example.com" }], tables: [{ label: "Checks", columns: ["a"], rows: [["b"]] }] });
const hc = createHumanCheckout({ stripe, generate, baseUrl: "http://x.test", storeDir: DIR, onSale: () => {}, log: () => {} });
created.push(join(DIR, `${SID}.json`));

let done = await hc.fulfill(SID);
for (let i = 0; i < 100 && done.status !== "done"; i++) { await sleep(50); done = await hc.fulfill(SID); }
ok(done.status === "done" && done.public === undefined, `a fresh delivered report is not public (status ${done.status})`);
ok(hc.setPublic("cs_nope_000000", true).status === "not_found" && hc.setPublic("junk", true).status === "invalid", "publishing needs a real, delivered session id");
const pub = hc.setPublic(SID, true);
ok(pub.status === "done" && pub.public === true && /^rp_[A-Za-z0-9_-]{12,24}$/.test(pub.publicId), `publishing mints an unguessable public id (${pub.publicId})`);
const again = hc.setPublic(SID, true);
ok(again.publicId === pub.publicId, "publishing twice keeps the same id");
const rec = JSON.parse(readFileSync(join(DIR, `${SID}.json`), "utf8"));
ok(rec.public === true && rec.publicId === pub.publicId && rec.publishedAt, "the record carries public, publicId and publishedAt");
ok((await hc.fulfill(SID)).publicId === pub.publicId, "the buyer's own fetch now carries the public id (the viewer shows the link)");

const view = readPublicReport(pub.publicId, DIR);
ok(view && view.publicView === true && view.status === "done" && view.product === "domain-audit" && view.report === rec.report && view.input === "example.com" && view.priceUsd >= 2, "the module-level reader serves the report with the product key and card price, no engine needed");
ok(readPublicReport("rp_000000000000000000", DIR) === null && readPublicReport("__proto__", DIR) === null && readPublicReport(SID, DIR) === null, "unknown, hostile and session-shaped ids read nothing");
ok(listPublicReports(DIR).some((r) => r.publicId === pub.publicId && r.title === "example.com"), "the public list (sitemap source) carries it");

const off = hc.setPublic(SID, false);
ok(off.public === false && off.publicId === null && readPublicReport(pub.publicId, DIR) === null && !listPublicReports(DIR).some((r) => r.publicId === pub.publicId), "revoking makes the link dead and drops it from the list");
const back = hc.setPublic(SID, true);
ok(back.publicId === pub.publicId && readPublicReport(pub.publicId, DIR)?.publicId === pub.publicId, "re-publishing brings the SAME link back to life");

// ---- routes on a FREE_MODE boot with no Stripe ----
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], { env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", STRIPE_SECRET_KEY: "" }, stdio: "ignore" });
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  const page = await fetch(`${B}/reports/public/${pub.publicId}`);
  const html = await page.text();
  ok(page.status === 200 && !/noindex/i.test(page.headers.get("x-robots-tag") || "") && !/<meta name="robots" content="noindex/.test(html), "the public page is 200 and indexable");
  ok(html.includes("<title>Domain Security Audit: example.com</title>") && html.includes(`/reports/public/${pub.publicId}"`) && html.includes('"@type":"Report"') && html.includes('"isAccessibleForFree":true'), "own title, canonical and Report JSON-LD");
  ok(html.includes('data-api="/api/reports/public/"') && html.includes("/js/report-view.js"), "renders through the shared viewer");
  const j = await (await fetch(`${B}/api/reports/public/${pub.publicId}`)).json();
  ok(j.status === "done" && j.publicView === true && j.product === "domain-audit" && j.report === rec.report && !("email" in j) && !("refundId" in j), "the JSON is the report with nothing buyer-identifying");
  const sm = await (await fetch(`${B}/sitemap-reports.xml`)).text();
  ok(sm.includes(`/reports/public/${pub.publicId}</loc>`), "the public report is in sitemap-reports.xml");
  ok((await fetch(`${B}/reports/public/rp_000000000000000000`)).status === 404 && (await fetch(`${B}/api/reports/public/nope`)).status === 404, "unknown ids 404 on both routes");
  hc.setPublic(SID, false);
  ok((await fetch(`${B}/api/reports/public/${pub.publicId}`)).status === 404, "a revoked report 404s at once on the JSON route (the page cache is bounded by max-age)");
  console.log(`\nPASS - ${pass} checks (public reports: session-id toggle, unguessable id, indexable, revocable)`);
  proc.kill("SIGKILL"); cleanup(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
