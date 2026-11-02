#!/usr/bin/env node
// Shared answers (src/answer-share.js): web.answer with share=true.
//
// Offline, two parts:
//   1. In process: the opt-in parser, the id, the record caps, the renderer
//      against a hostile answer (markup, a script tag, images, javascript:
//      links, links to hosts no citation names), the page's noindex, the
//      expiry and tombstone reads, the switch (ANSWER_SHARE), the claim-time
//      share budget, the outcome hook (written on a settled 200 only; no
//      link without a watched response or under an allowance grant), the
//      operator takedown, the rendered-page cache, and the privacy and terms
//      lines in both switch states.
//   2. A PAID server with the switch on (stub facilitator, the web answer
//      upstream stubbed by scripts/lib/brave-answer-stub-preload.js): an
//      unpaid call, a call whose settlement fails, and a failed handler leave
//      no page; a settled call without share carries no link and writes
//      nothing; a settled call with share answers a link whose page (HTML at
//      /answers/<id>, whatever Accept says), JSON (/answers/<id>.json) and
//      card are served with noindex and a cache lifetime inside the share's;
//      unknown ids are 404, an expired share is 410, and the operator
//      takedown turns page, JSON and card into 410 "removed".
//   3. The same server with the switch off: share=true is ignored (no field,
//      no page), the catalog does not offer it, /privacy and /terms do not
//      describe it, and a page made earlier still serves.
import "./lib/file-mode.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { STUB_ANSWER, STUB_CITATIONS } from "./lib/brave-answer-stub-preload.js";

const SHARE_DIR = mkdtempSync(join(tmpdir(), "answer-share-"));
process.env.ANSWER_SHARE_DIR = SHARE_DIR;
process.env.ANSWER_SHARE = "on";
// A budget of 3 an hour is 1 a minute: the second claim in a minute is refused.
process.env.ANSWER_SHARE_PER_HOUR = "3";
const { EventEmitter } = await import("node:events");
const AS = await import("../src/answer-share.js");

let pass = 0, proc = null, facilitator = null;
const serverLog = [];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = () => readdirSync(SHARE_DIR).filter((f) => f.endsWith(".json"));

// ---- 1. in process ----------------------------------------------------------
ok(!AS.wantsShare(undefined) && !AS.wantsShare(false) && !AS.wantsShare("false") && !AS.wantsShare("") && !AS.wantsShare(0), "share is off unless asked for");
ok(AS.wantsShare(true) && AS.wantsShare("true") && AS.wantsShare("1"), "share=true (boolean or query string) opts in");
{
  const ids = new Set(Array.from({ length: 200 }, () => AS.newShareId()));
  ok(ids.size === 200 && [...ids].every((id) => AS.SHARE_ID_RE.test(id) && Buffer.from(id, "base64url").length === 18), "ids are 144 random bits, unique, base64url");
}
{
  const rec = AS.shareRecord({ id: AS.newShareId(), query: "q".repeat(900), answer: "a".repeat(40_000), citations: Array.from({ length: 50 }, (_, n) => ({ url: `https://s${n}.example/`, snippet: "s".repeat(5000), number: n + 1 })), now: 1000 });
  ok(rec.question.length === AS.CAPS.question && rec.answer.length === AS.CAPS.answer && rec.citations.length === AS.CAPS.citations && rec.citations[0].snippet.length === AS.CAPS.snippet, "the stored record is size-capped");
  ok(rec.expiresAt === 1000 + AS.SHARE_TTL_MS && AS.SHARE_TTL_MS === AS.SHARE_TTL_DAYS * 86_400_000, `records expire after the retention period (${AS.SHARE_TTL_DAYS} days)`);
  ok(!("payer" in rec) && !("ip" in rec), "the record holds no payer or address");
}
const checkHostile = (html, where) => {
  ok(!/<script(?![^>]*src="\/js\/)/i.test(html.replace(/<script type="application\/(ld\+)?json"[^>]*>[\s\S]*?<\/script>/g, "").replace(/<script src="\/js\/[^"]*"( defer)?><\/script>/g, "")), `${where}: no inline script survives`);
  ok(!/<img/i.test(html.split("<main>")[1] || html), `${where}: no image survives`);
  ok(!/href="javascript:/i.test(html) && !/href="data:/i.test(html), `${where}: no javascript: or data: link`);
  ok(!/href="https?:\/\/evil\.example/i.test(html), `${where}: no link to a host no citation names`);
  ok(!/onerror=|onmouseover=/i.test(html.replace(/&lt;[^&]*&gt;/g, "")), `${where}: no live event-handler attribute`);
};
{
  const html = AS.renderAnswerHtml(STUB_ANSWER, STUB_CITATIONS);
  checkHostile(html, "answer body");
  ok(html.includes('<a href="https://www.x402.org/spec" rel="nofollow noopener noreferrer ugc">the spec</a>'), "a link to a cited host survives, with rel nofollow noopener noreferrer");
  ok(!html.includes("pixel.png") && !html.includes("cited-host image"), "an image is removed whole, even one on a cited host (the sanitizer runs before the renderer)");
  const inline = AS.__renderInline("[a](https://evil.example/x) https://evil.example/y [b](https://www.x402.org/z) [c](javascript:alert(1))", STUB_CITATIONS);
  ok(!/href="https:\/\/evil|href="javascript/.test(inline) && inline.includes('href="https://www.x402.org/z"'), "the renderer alone links only http(s) URLs on a cited host");
  ok(html.includes('<a href="#source-1" class="as-cite">[1]</a>') && html.includes("<strong>details</strong>") && /<ul><li>first point/.test(html), "citation markers link to their source; bold and lists render");
}
{
  const id = AS.newShareId();
  const rec = AS.shareRecord({ id, query: `<script>alert("q")</script> what is x402?`, answer: STUB_ANSWER, citations: STUB_CITATIONS, now: Date.UTC(2026, 10, 3) });
  const page = AS.answerSharePage(rec, { baseUrl: "https://agent402.example", price: "$0.08" });
  checkHostile(page, "page");
  ok(page.includes("&lt;script&gt;alert(&quot;q&quot;)&lt;/script&gt; what is x402?"), "the question is escaped");
  ok(/<meta name="robots" content="noindex, nofollow">/.test(page), "the page carries a noindex robots meta");
  ok(page.includes(`<meta property="og:image" content="https://agent402.example/answers/${id}/card.png">`), "the page's og:image is its own card");
  ok(/model-backed answer/.test(page) && /generated for the caller/.test(page) && page.includes("2026-11-03"), "the page says it is model-backed, generated for the caller, with the date");
  ok(page.includes('<a href="/tools/answer">web.answer</a> · $0.08 per call'), "a footer link to the tool page, with the catalog price");
  ok(page.includes("&lt;b onmouseover=alert(3)&gt;") && page.includes('<span class="as-src-link">javascript:alert(4)</span>'), "a hostile snippet is text and a non-web source URL is not a link");
  const svg = AS.answerShareCardSvg(rec, { BRAND: { paper: "#000", ink: "#fff", faint: "#888", muted: "#aaa", hairline: "#333", accent: "#0f0", mono: "mono", display: "sans" } });
  ok(!svg.includes("<script>") && svg.includes("&lt;script&gt;") && /width="1200" height="630"/.test(svg), "the card is 1200x630 and escapes the question");
  const lines = AS.wrapLines("word ".repeat(80), 32, 3);
  ok(lines.length === 3 && lines.every((l) => l.length <= 32) && lines[2].endsWith("…"), "the card wraps a long question to three lines with an ellipsis");
}
{
  // The store: live, expired (410 before and after the sweep's tombstone), unknown.
  AS.__setShareStore(AS.__createFileStore(SHARE_DIR));
  const now = Date.now();
  const live = AS.shareRecord({ id: AS.newShareId(), query: "q", answer: "a", citations: [], now });
  const old = AS.shareRecord({ id: AS.newShareId(), query: "q", answer: "secret", citations: [], now: now - AS.SHARE_TTL_MS - 1000 });
  const ancient = AS.shareRecord({ id: AS.newShareId(), query: "q", answer: "a", citations: [], now: now - AS.SHARE_TTL_MS - AS.TOMBSTONE_MS - 1000 });
  for (const r of [live, old, ancient]) await AS.shareStore().put(r);
  ok((await AS.readShare(live.id, now)).status === "ok", "a live share reads ok");
  ok((await AS.readShare(old.id, now)).status === "gone", "an expired share reads gone (410) before the sweep");
  ok((await AS.readShare("AAAAAAAAAAAAAAAAAAAAAAAA", now)).status === "unknown" && (await AS.readShare("../etc/passwd", now)).status === "unknown", "an unknown or malformed id reads unknown (404)");
  const sw = await AS.shareStore().sweep(now);
  ok(sw.expired === 1 && sw.dropped === 1, `the sweep tombstones the expired share and drops the past-tombstone one (${JSON.stringify(sw)})`);
  const tomb = await AS.shareStore().get(old.id);
  ok(tomb.gone === true && !("answer" in tomb) && !("question" in tomb) && (await AS.readShare(old.id, now)).status === "gone", "the tombstone keeps only the expiry and still reads gone (410)");
  ok((await AS.readShare(ancient.id, now)).status === "unknown", "past the tombstone period it reads unknown");
  for (const f of files()) (await import("node:fs")).unlinkSync(join(SHARE_DIR, f));
}
const clearFiles = async () => { for (const f of files()) (await import("node:fs")).unlinkSync(join(SHARE_DIR, f)); };
// A request with a response whose outcome can be watched (src/hangup-settlement.js reads finish/close).
let ipN = 0;
const fakeReq = () => {
  const res = new EventEmitter();
  res.statusCode = 200; res.headersSent = false;
  const req = { ip: `198.51.100.${++ipN}`, headers: {}, header: () => null, res };
  return req;
};
const DATA = { query: "q", answer: "a", citations: [] };
{
  // The outcome hook: nothing is written until the outcome, and only for a settled 200.
  const req = fakeReq();
  const slot = AS.reserveShare(req);
  const link = AS.prepareShare(req, DATA);
  ok(slot && link && AS.SHARE_ID_RE.test(link.url.split("/").pop()) && link.cardUrl === `${link.url}/card.png` && !Number.isNaN(Date.parse(link.expiresAt)), "reserveShare + prepareShare answer { url, cardUrl, expiresAt }");
  await sleep(50);
  ok(files().length === 0, "a reserved share writes nothing by itself");
  req.res.emit("finish"); await sleep(50);
  ok(files().length === 1, "a settled 200 writes the share");
  await clearFiles();

  const bad = fakeReq();
  AS.reserveShare(bad); AS.prepareShare(bad, DATA);
  bad.res.statusCode = 402; bad.res.emit("finish"); await sleep(50);
  ok(files().length === 0, "a call that ends 402 (settlement failed) writes nothing");

  ok(AS.prepareShare(null, DATA) === null && AS.prepareShare({ ip: "x" }, DATA) === null, "no reservation: no link is handed out");
  ok(AS.reserveShare({ ip: "198.51.100.200", headers: {} }) === null, "no response to watch (a direct in-process call): no reservation, so no link");
  {
    // A response whose outcome is already decided cannot be watched either.
    const { onResponseEnd } = await import("../src/hangup-settlement.js");
    const done = fakeReq();
    onResponseEnd(done, done.res, () => {});
    done.res.emit("finish");
    ok(AS.reserveShare(done) === null && AS.prepareShare(done, DATA) === null, "a response already decided: no reservation, so no link");
  }
  // A first-call allowance grant is never settled: no link, ever.
  const granted = fakeReq();
  Object.defineProperty(granted, "__a402Allowance", { value: { granted: true, state: "claimed" }, writable: true, configurable: true, enumerable: false });
  ok(AS.reserveShare(granted) === null && AS.prepareShare(granted, DATA) === null, "an allowance grant gets no reservation and no link");
  // A grant decided after the reservation (served unsettled): the outcome skips the write.
  const late = fakeReq();
  AS.reserveShare(late); const lateLink = AS.prepareShare(late, DATA);
  Object.defineProperty(late, "__a402Allowance", { value: { granted: true, state: "served" }, writable: true, configurable: true, enumerable: false });
  late.res.emit("finish"); await sleep(50);
  ok(lateLink && files().length === 0, "a call whose settlement was skipped writes nothing, though its 200 said 200");
  await clearFiles();
}
{
  // The switch: off, nothing is reserved and nothing is linked.
  process.env.ANSWER_SHARE = "";
  const req = fakeReq();
  ok(!AS.answerShareEnabled() && AS.reserveShare(req) === null && AS.prepareShare(req, DATA) === null, "switch off: no reservation and no link");
  process.env.ANSWER_SHARE = "true";
  ok(!AS.answerShareEnabled(), "the switch takes exactly \"on\"");
  process.env.ANSWER_SHARE = "on";
}
{
  // The budget is claimed before the call: parallel calls cannot overshoot,
  // and a claim whose call does not settle is given back.
  const mk = () => { const r = fakeReq(); r.ip = "192.0.2.77"; return r; };
  const first = mk();
  ok(AS.reserveShare(first) !== null, "the first claim in the minute is granted");
  let refused = null;
  try { AS.reserveShare(mk()); } catch (e) { refused = e; }
  ok(refused?.statusCode === 429 && /Not charged/.test(refused.message), "a second claim while the first is still running is refused 429 (counted at claim time)");
  first.res.statusCode = 500; first.res.emit("finish"); await sleep(20);
  const again = mk();
  let regranted = null;
  try { regranted = AS.reserveShare(again); } catch { regranted = null; }
  ok(regranted !== null, "a claim whose call failed is given back: the next claim is granted");
  again.res.statusCode = 404; again.res.emit("finish"); await sleep(20);
}
{
  // The operator takedown, and the expiry wording on /privacy.
  const rec = AS.shareRecord({ id: AS.newShareId(), query: "q", answer: "a", citations: [], now: Date.now() });
  await AS.shareStore().put(rec);
  const logs = [];
  const r = await AS.removeShare(rec.id, "reported\nphishing", { log: (l) => logs.push(l) });
  const tomb = await AS.shareStore().get(rec.id);
  ok(r.status === "removed" && (await AS.readShare(rec.id)).status === "removed", "a removed share reads removed");
  ok(tomb.removed && tomb.gone && !("answer" in tomb) && !("question" in tomb) && tomb.note === "reported phishing" && tomb.expiresAt === rec.expiresAt, "the takedown keeps a tombstone with the note and the original expiry, no content");
  ok(logs.length === 1 && logs[0].includes(rec.id.slice(0, 6)) && !logs[0].includes(rec.id), "the takedown is logged without the full id (the bearer)");
  ok((await AS.removeShare(rec.id, "")).status === "already_removed" && (await AS.removeShare("AAAAAAAAAAAAAAAAAAAAAAAA")).status === "unknown" && (await AS.removeShare("../x")).status === "unknown", "removing twice, an unknown id or a malformed id changes nothing");
  await clearFiles();
}
{
  const { privacyPage } = await import("../src/privacy.js");
  const { termsPage } = await import("../src/terms.js");
  const p = privacyPage("https://agent402.example");
  ok(/share=true<\/code>, and only\s+such a call, publishes its question/.test(p) && new RegExp(`deleted ${AS.SHARE_TTL_DAYS} days after it was made`).test(p) && /Sharing is off unless the\s+caller asks for it/.test(p), "switch on: the privacy page describes shared answers: opt-in, what is kept, for how long");
  ok(new RegExp(`expired\\s+for ${AS.TOMBSTONE_DAYS} days, and after that as an unknown address`).test(p) && /answers that it was removed/.test(p), "the privacy page says how long an address answers expired (the tombstone) and that a page can be removed");
  ok(/caller-supplied question and a model-generated answer, and we may remove it/.test(termsPage("https://agent402.example")), "switch on: the terms say a shared page shows a caller-supplied question and a model-generated answer, and may be removed");
  process.env.ANSWER_SHARE = "";
  AS.noteLiveShares(0);
  ok(!/share=true|\/answers\//.test(privacyPage("https://agent402.example")) && !/share=true|caller-supplied/.test(termsPage("https://agent402.example")), "switch off, no live pages: neither /privacy nor /terms describes shared answers");
  AS.noteLiveShares(2);
  ok(/share=true<\/code>, and only/.test(privacyPage("https://agent402.example")) && /caller-supplied/.test(termsPage("https://agent402.example")), "switch off but pages still served: /privacy and /terms keep describing them until they expire");
  AS.noteLiveShares(0);
  process.env.ANSWER_SHARE = "on";
  // The first-call allowance line follows its own switch.
  process.env.FIRST_CALL_ALLOWANCE = "";
  ok(!/first-call allowance/.test(privacyPage("https://agent402.example")), "allowance off: /privacy does not describe the first-call allowance");
  process.env.FIRST_CALL_ALLOWANCE = "on";
  const pa = privacyPage("https://agent402.example");
  ok(/first-call allowance/.test(pa) && /keeps the address of each wallet granted one,\s+without expiry/.test(pa) && /daily count of grants per client\s+address, kept under a keyed hash of the address \(never the address itself\) and deleted after two days/.test(pa) && /one free first call/.test(pa), "allowance on: /privacy says what it keeps (granted wallet, no expiry; per-address daily count under a keyed hash, two days) and why");
  process.env.FIRST_CALL_ALLOWANCE = "";
}
{
  // The page cache and the routes, mounted in process: a record is rendered once.
  const express = (await import("express")).default;
  const app = express();
  AS.mountAnswerShares(app, { baseUrl: "http://share.test", notFoundPage: (res) => res.status(404).send("nf"), rasterizeSvg: async () => { throw new Error("no renderer"); }, brand: { BRAND: { paper: "#000", ink: "#fff", faint: "#888", muted: "#aaa", hairline: "#333", accent: "#0f0", mono: "mono", display: "sans" } }, sweepEveryMs: 0 });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const L = `http://127.0.0.1:${srv.address().port}`;
  const rec = AS.shareRecord({ id: AS.newShareId(), query: "cached question", answer: "first render", citations: [], now: Date.now() });
  await AS.shareStore().put(rec);
  const a = await (await fetch(`${L}/answers/${rec.id}`)).text();
  writeFileSync(join(SHARE_DIR, `${rec.id}.json`), JSON.stringify({ ...rec, answer: "second render" }));
  const b = await (await fetch(`${L}/answers/${rec.id}`)).text();
  ok(a.includes("first render") && b === a && AS.__htmlCache.has(rec.id), "the rendered page is cached per id (a record is sanitized once)");
  ok(a.includes('<p class="as-asked">Asked by the caller</p>'), "the page labels the question as the caller's");
  await AS.removeShare(rec.id, "test", { log: () => {} });
  const g = await fetch(`${L}/answers/${rec.id}`);
  ok(g.status === 410 && /was removed/.test(await g.text()) && !AS.__htmlCache.has(rec.id), "after a takedown the page answers 410 removed and the cached render is dropped");
  await new Promise((r) => srv.close(r));
  await clearFiles();
}

// ---- 2. paid server ---------------------------------------------------------
const [PORT, FAC_PORT] = await getFreePorts(2);
let B = `http://127.0.0.1:${PORT}`;
const OP_TOKEN = "answer-share-test-operator-token-0123456789";
let settleMode = "ok", settles = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = "0x00000000000000000000000000000000000000a1"; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* default */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") {
      settles++;
      if (settleMode === "fail") return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer });
      return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const boot = (port, shareSwitch) => spawn("node", ["--import", "./scripts/lib/brave-answer-stub-preload.js", "src/server.js"], {
  env: {
    ...process.env, PORT: String(port), FREE_MODE: "", BRAVE_API_KEY: "stub-never-sent", BRAVE_ANSWERS_API_KEY: "",
    ANSWER_SHARE: shareSwitch, ANSWER_SHARE_PER_HOUR: "", AGENT402_OPERATOR_TOKEN: OP_TOKEN, FIRST_CALL_ALLOWANCE: "",
    ANSWER_SHARE_DIR: SHARE_DIR, BASE_URL: `http://127.0.0.1:${port}`,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 400)); } if (serverLog.length > 80) serverLog.splice(0, serverLog.length - 80); };
const start = (port, shareSwitch) => { proc = boot(port, shareSwitch); proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog); };
start(PORT, "on");

let nonceN = 0;
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
})).toString("base64");
const accepts = new Map();
const acceptFor = async (path) => {
  if (accepts.has(path)) return accepts.get(path);
  const r = await fetch(`${B}${path}`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  const a = (req402.accepts || []).find((x) => x.network === "eip155:8453");
  accepts.set(path, a);
  return a;
};
let payerN = 0;
const pay = async (path) => fetch(`${B}${path}`, { headers: { "payment-signature": credential(await acceptFor(path), `0x${(++payerN).toString(16).padStart(40, "0")}`) } });

try {
  const waitUp = async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* booting */ } await sleep(500); } fail("server did not boot"); };
  await waitUp();
  // The tool as /openapi.json publishes it (description and parameters).
  const answerDesc = async () => { const o = await (await fetch(`${B}/openapi.json`)).json(); const op = o.paths?.["/api/answer"]; if (!op) fail("/openapi.json lists /api/answer"); return JSON.stringify(op); };
  { const d = await answerDesc(); ok(/share=true/.test(d) && /"share"/.test(d), "switch on: the catalog (openapi) offers share=true and its parameter"); }
  ok(/share=true/.test(await (await fetch(`${B}/privacy`)).text()) && /caller-supplied/.test(await (await fetch(`${B}/terms`)).text()), "switch on: /privacy and /terms describe shared answers");
  const SHARE = "/api/answer?q=what+is+x402&share=true";
  const PLAIN = "/api/answer?q=what+is+x402";

  {
    const r = await fetch(`${B}${SHARE}`);
    ok(r.status === 402, `unpaid share call -> 402 (got ${r.status})`);
    await sleep(200);
    ok(files().length === 0, "an unpaid call leaves no page");
  }
  {
    settleMode = "fail";
    const before = settles;
    const r = await pay(SHARE);
    const body = await r.json().catch(() => ({}));
    ok(r.status === 402 && settles === before + 1, `the handler ran, then settlement failed -> 402 (got ${r.status})`);
    ok(!JSON.stringify(body).includes("/answers/"), "the settle-failure 402 carries no share link");
    await sleep(300);
    ok(files().length === 0, "a call whose settlement failed leaves no page");
    settleMode = "ok";
  }
  {
    // A handler failure (a malformed question) is a 4xx: never settled, nothing written.
    const r = await pay("/api/answer?q=&share=true");
    ok(r.status >= 400 && r.status < 500 && r.status !== 402, `a failed call answers ${r.status}`);
    await sleep(200);
    ok(files().length === 0, "a failed call leaves no page");
  }
  {
    const r = await pay(PLAIN);
    const body = await r.json();
    ok(r.status === 200 && body.answer && !("share" in body), "a settled call without share=true carries no share field (off by default)");
    await sleep(200);
    ok(files().length === 0, "...and writes nothing");
  }
  let link;
  {
    const r = await pay(SHARE);
    const body = await r.json();
    link = body.share;
    ok(r.status === 200 && link && link.url.startsWith(`${B}/answers/`) && link.cardUrl === `${link.url}/card.png` && Date.parse(link.expiresAt) > Date.now() + 29 * 86_400_000, `a settled share call answers share { url, cardUrl, expiresAt } (${JSON.stringify(link)})`);
    for (let i = 0; i < 20 && !files().length; i++) await sleep(100);
    ok(files().length === 1, "the settled 200 wrote exactly one share");
  }
  {
    const r = await fetch(link.url);
    const html = await r.text();
    ok(r.status === 200 && /^text\/html/.test(r.headers.get("content-type") || ""), "the share page answers 200 HTML");
    ok(r.headers.get("x-robots-tag") === "noindex, nofollow" && /<meta name="robots" content="noindex, nofollow">/.test(html), "the page is noindex in the header and the meta");
    const cc = r.headers.get("cache-control") || "";
    const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
    ok(/^public,/.test(cc) && !/immutable/.test(cc) && maxAge > 0 && maxAge <= 300, `public, not immutable, and cached at most five minutes so a removal takes effect (${cc})`);
    ok(/default-src 'self'/.test(r.headers.get("content-security-policy") || ""), "the page carries the site CSP");
    ok(html.includes("what is x402") && html.includes('<li id="source-2">'), "the page shows the question and its sources");
    checkHostile(html, "served page");
    ok(html.includes('<p class="as-asked">Asked by the caller</p>'), "the served page labels the question as the caller's");
    ok(!/(^|,)\s*accept\s*(,|$)/i.test(r.headers.get("vary") || ""), `the page does not vary on Accept (vary: ${r.headers.get("vary")})`);
    const viaAccept = await fetch(link.url, { headers: { accept: "application/json" } });
    ok(viaAccept.status === 200 && /^text\/html/.test(viaAccept.headers.get("content-type") || ""), "the page address answers HTML whatever Accept says");
    await viaAccept.text();
    const j = await fetch(`${link.url}.json`);
    const jb = await j.json().catch(() => ({}));
    ok(j.status === 200 && jb.question === "what is x402" && jb.modelBacked === true && jb.citations.length === STUB_CITATIONS.length && /max-age=([1-9]\d?|[12]\d\d|300)\b/.test(j.headers.get("cache-control") || "") && !/immutable/.test(j.headers.get("cache-control") || "") && j.headers.get("x-robots-tag") === "noindex, nofollow", "the JSON record lives at <url>.json (question, answer, citations, modelBacked), noindex");
    const svg = await fetch(`${link.url}/card.svg`);
    ok(svg.status === 200 && /image\/svg\+xml/.test(svg.headers.get("content-type") || "") && /<svg[^>]+width="1200" height="630"/.test(await svg.text()), "the SVG card answers 1200x630");
    const png = await fetch(link.cardUrl, { redirect: "manual" });
    ok((png.status === 200 && /image\/png/.test(png.headers.get("content-type") || "")) || (png.status === 302 && /card\.svg$/.test(png.headers.get("location") || "")), `the PNG card answers a PNG, or the SVG card when no renderer is available (${png.status})`);
  }
  {
    // Operator takedown.
    const id = link.url.split("/").pop();
    const del = (headers, body) => fetch(`${B}/__operator/answer-shares/delete`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const anon = await del({}, { id, note: "x" });
    ok(anon.status === 404 && (await fetch(link.url)).status === 200, "the takedown without the operator token answers 404 and removes nothing");
    const r = await del({ "x-operator-token": OP_TOKEN }, { id, note: "reported" });
    const rb = await r.json();
    ok(r.status === 200 && rb.status === "removed" && /no-store/.test(r.headers.get("cache-control") || "") && /private/.test(r.headers.get("cache-control") || ""), `the operator takedown answers removed, private no-store (${JSON.stringify(rb)})`);
    await sleep(100);
    ok(serverLog.some((l) => l.includes(`removed ${id.slice(0, 6)}`) && l.includes("reported")), "the takedown is logged");
    const p = await fetch(link.url);
    ok(p.status === 410 && /was removed/.test(await p.text()) && p.headers.get("cache-control") === "no-store", "the removed page answers 410 removed, not cached");
    const jr = await fetch(`${link.url}.json`);
    ok(jr.status === 410 && (await jr.json()).status === "removed" && (await fetch(`${link.url}/card.svg`)).status === 410, "its JSON and card answer 410 removed");
    const unk = await del({ "x-operator-token": OP_TOKEN }, { id: "AAAAAAAAAAAAAAAAAAAAAAAA" });
    ok(unk.status === 404 && (await unk.json()).status === "unknown", "the takedown of an unknown id answers 404 unknown");
  }
  {
    const r = await fetch(`${B}/answers/AAAAAAAAAAAAAAAAAAAAAAAA`);
    ok(r.status === 404 && r.headers.get("x-robots-tag") === "noindex, nofollow", "an unknown id answers 404");
    ok((await fetch(`${B}/answers/not-an-id`)).status === 404 && (await fetch(`${B}/answers/AAAAAAAAAAAAAAAAAAAAAAAA/card.png`)).status === 404, "a malformed id and an unknown card answer 404");
    const id = AS.newShareId();
    const old = AS.shareRecord({ id, query: "old", answer: "old", citations: [], now: Date.now() - AS.SHARE_TTL_MS - 1000 });
    writeFileSync(join(SHARE_DIR, `${id}.json`), JSON.stringify(old));
    const g = await fetch(`${B}/answers/${id}`);
    ok(g.status === 410 && /expired/.test(await g.text()) && g.headers.get("cache-control") === "no-store", "an expired share answers 410, not cached");
    ok((await fetch(`${B}/answers/${id}/card.png`)).status === 410, "an expired share's card answers 410");
  }
  // ---- 3. the switch off ------------------------------------------------------
  {
    const kept = AS.shareRecord({ id: AS.newShareId(), query: "made while on", answer: "kept", citations: [], now: Date.now() });
    writeFileSync(join(SHARE_DIR, `${kept.id}.json`), JSON.stringify(kept));
    proc.kill("SIGKILL");
    const [PORT2] = await getFreePorts(1);
    B = `http://127.0.0.1:${PORT2}`;
    accepts.clear();
    start(PORT2, "");
    await waitUp();
    const before = files().length;
    const r = await pay(SHARE);
    const body = await r.json();
    ok(r.status === 200 && body.answer && !("share" in body), "switch off: a settled share=true call answers without a share field");
    await sleep(300);
    ok(files().length === before, "switch off: ...and writes nothing");
    { const d = await answerDesc(); ok(/max_tokens/.test(d) && !/share=true|"share"/.test(d), "switch off: the catalog (openapi) does not offer share"); }
    ok(/share=true/.test(await (await fetch(`${B}/privacy`)).text()) && /caller-supplied/.test(await (await fetch(`${B}/terms`)).text()), "switch off with a page made while on still served: /privacy and /terms keep describing shared answers");
    const k = await fetch(`${B}/answers/${kept.id}`);
    ok(k.status === 200 && (await k.text()).includes("made while on"), "switch off: a page made while it was on still serves until it expires");
    ok((await fetch(`${B}/answers/AAAAAAAAAAAAAAAAAAAAAAAA`)).status === 404, "switch off: an unknown id is 404");
  }
} finally {
  proc?.kill("SIGKILL");
  facilitator?.close();
}
console.log(`\n${pass} passed`);
process.exit(0);
