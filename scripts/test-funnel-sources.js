#!/usr/bin/env node
// Where a paid-route caller came from and why it did not pay
// (src/funnel-sources.js), and the funnel counting them (src/funnel.js), offline.
//
//   node scripts/test-funnel-sources.js
//
// Classifiers: User-Agent family, Referer class (the host is never kept),
// discovery documents by path. The discovery trail: keyed hash only, window,
// cap, newest document wins. The no-payment fold over stored refusal words.
// The funnel: probes count ua, referrer and found; settlements count the
// *Paid twins; a refused funding attempt counts its next-step state; a 504
// counts as a timeout; every key it writes lands in a real traffic store.
import "./lib/file-mode.js";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = await import("../src/funnel-sources.js");
const { createFunnel, funnelEventOf, emptyFunnelRow } = await import("../src/funnel.js");
const { createTrafficStore } = await import("../src/traffic-classifier.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL: ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// ---- classifiers -------------------------------------------------------------------
eq(S.uaFamilyOf(undefined), "none", "no User-Agent reads none");
eq(S.uaFamilyOf("curl/8.4.0"), "curl", "curl");
eq(S.uaFamilyOf("python-requests/2.31.0"), "python", "python requests");
eq(S.uaFamilyOf("node"), "node", "bare node fetch");
eq(S.uaFamilyOf("Go-http-client/2.0"), "go", "Go client");
eq(S.uaFamilyOf("Mozilla/5.0 (Macintosh) Safari/605"), "browser", "a browser");
eq(S.uaFamilyOf("Mozilla/5.0 (compatible; ClaudeBot/1.0)"), "bot", "a crawler claiming a browser engine reads bot");
eq(S.uaFamilyOf("langchain-agent/0.3 python-httpx"), "agent", "an agent framework wins over its HTTP library");
eq(S.uaFamilyOf("x".repeat(100_000)), "other", "a long unknown value reads other");
ok(S.UA_FAMILIES.every((f) => /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(f)), "every UA family is a valid store key");

eq(S.referrerClassOf(undefined), "none", "no Referer reads none");
eq(S.referrerClassOf("https://www.google.com/search?q=x402"), "search", "a search engine");
eq(S.referrerClassOf("https://github.com/org/repo"), "code", "a code host");
eq(S.referrerClassOf("https://t.co/abc"), "social", "a social link shortener");
eq(S.referrerClassOf("https://chatgpt.com/c/1"), "assistant", "an assistant");
eq(S.referrerClassOf("https://agent402.tools/tools/search", "agent402.tools"), "self", "our own page reads self");
eq(S.referrerClassOf("https://www.agent402.tools/", "agent402.tools"), "self", "our www reads self");
eq(S.referrerClassOf("https://agent402.tools.evil.example/", "agent402.tools"), "other", "a look-alike host is not self");
eq(S.referrerClassOf("not a url"), "other", "an unreadable Referer reads other");
ok(S.REFERRER_CLASSES.every((f) => /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(f)), "every referrer class is a valid store key");

eq(S.discoveryDocOf("/llms.txt"), "llms", "llms.txt");
eq(S.discoveryDocOf("/openapi.json?x=1"), "openapi", "openapi.json with a query");
eq(S.discoveryDocOf("/.well-known/x402"), "wellKnown", "well-known x402");
eq(S.discoveryDocOf("/api/find"), "find", "find");
eq(S.discoveryDocOf("/api/search"), null, "a tool route is no discovery document");
ok(S.FOUND_VALUES.every((f) => /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(f)), "every found value is a valid store key");

// ---- discovery trail ---------------------------------------------------------------
{
  const t = S.createDiscoveryTrail({ windowMs: 1000, cap: 3 });
  t.note("1.2.3.4", "llms", 0);
  eq(t.foundVia("1.2.3.4", 10), "llms", "a caller's document is read back");
  t.note("1.2.3.4", "openapi", 20);
  eq(t.foundVia("1.2.3.4", 30), "openapi", "the newest document wins");
  eq(t.foundVia("9.9.9.9", 30), "none", "an unseen caller reads none");
  eq(t.foundVia("1.2.3.4", 2000), "none", "an entry past the window reads none");
  t.note("a", "llms", 3000); t.note("b", "llms", 3000); t.note("c", "llms", 3000); t.note("d", "llms", 3000);
  ok(t.size() <= 3, "the trail is capped");
  eq(t.foundVia("a", 3001), "none", "the oldest caller is dropped past the cap");
  t.note("e", "not-a-doc", 3000);
  eq(t.foundVia("e", 3001), "none", "an unknown document word is not kept");
}

// ---- the no-payment fold -----------------------------------------------------------
{
  const row = { neverRetried: 5, timeouts: 2, reasons: { "insufficient-funds": 3, "no-token-account": 1, "unsupported-network": 2, "malformed-header": 1, "requirements-mismatch": 1, "not-checked": 1, "facilitator-quota": 1, "authorization-expired": 4, other: 1, none: 2 } };
  eq(S.noPaymentReasonsOf(row), { noWalletHeader: 5, wrongNetwork: 2, belowBalance: 4, malformed: 2, timeout: 3, refused: 7, ourSide: 1 }, "refusal words fold into the no-payment reasons");
  eq(Object.values(S.noPaymentReasonsOf(null)).reduce((a, b) => a + b, 0), 0, "an empty row folds to zeros");
  const conv = S.conversionBySource({ ua: { curl: 4 }, uaPaid: { curl: 1, node: 2 }, found: { llms: 2 }, foundPaid: {} });
  eq(conv.ua.curl, { probes: 4, settled: 1, settledPerProbe: 0.25 }, "settled per probe by client family");
  eq(conv.ua.node, { probes: 0, settled: 2, settledPerProbe: null }, "a settlement with no probe of its family reads null per probe");
  eq(conv.found.llms.settled, 0, "a document with probes and no settlement reads zero");
}

// ---- the funnel counts them --------------------------------------------------------
const req = (headers = {}, extra = {}) => ({ originalUrl: "/api/search", headers, ...extra });
const res = (status, headers = {}) => ({ statusCode: status, headersSent: true, writableEnded: true, getHeader: (k) => headers[String(k).toLowerCase()] ?? null });
{
  const dir = mkdtempSync(join(tmpdir(), "funnel-sources-"));
  try {
    const store = createTrafficStore({ dir, salt: "t", backend: "file" });
    const writes = [];
    const trail = S.createDiscoveryTrail();
    const f = createFunnel({ bump: (d, a, field, n, sub) => { const okw = store.bumpFunnel(d, a, field, n, sub); writes.push({ field, sub, ok: okw }); return okw; }, foundVia: (ip) => trail.foundVia(ip) });
    trail.note("10.0.0.1", "llms");
    const probe = funnelEventOf(req({ "user-agent": "python-httpx/0.27", referer: "https://github.com/x/y" }), res(402), { ownHost: "agent402.tools" });
    eq([probe.outcome, probe.ua, probe.ref], ["probe", "python", "code"], "a probe event carries its UA family and referrer class");
    f.record(probe, { ip: "10.0.0.1" });
    const paidReq = req({ "user-agent": "python-httpx/0.27", "payment-signature": "x" });
    f.record(funnelEventOf(paidReq, res(200, { "payment-response": "r" })), { ip: "10.0.0.1" });
    const refusedReq = req({ "user-agent": "curl/8", "payment-signature": "y" }, { __paymentRejectReason: "insufficient-funds", __paymentNextStepState: "wallet-empty" });
    f.record(funnelEventOf(refusedReq, res(402)), { ip: "10.0.0.2" });
    const bogusStep = req({ "payment-signature": "z" }, { __paymentRejectReason: "insufficient-funds", __paymentNextStepState: "made-up" });
    f.record(funnelEventOf(bogusStep, res(402)), { ip: "10.0.0.3" });
    f.record(funnelEventOf(req({ "payment-signature": "w" }), res(504)), { ip: "10.0.0.4" });
    ok(writes.every((w) => w.ok), `every funnel key is accepted by the traffic store (${writes.filter((w) => !w.ok).map((w) => `${w.field}.${w.sub}`).join(",") || "all"})`);
    const day = store.funnelDays(1)[0].funnel.direct;
    eq(day.ua, { python: 1 }, "probes by UA family");
    eq(day.referrer, { code: 1 }, "probes by referrer class");
    eq(day.found, { llms: 1 }, "the probe is counted under the document its caller read");
    eq(day.uaPaid, { python: 1 }, "settlements by UA family");
    eq(day.foundPaid, { llms: 1 }, "the settlement is counted under the same document");
    eq(day.nextStep, { "wallet-empty": 1 }, "a refused funding attempt counts its next-step state; an unknown state is not counted");
    eq(day.timeouts, 1, "an attempt answered 504 counts as a timeout");
    eq(S.noPaymentReasonsOf(day).belowBalance, 2, "both funding refusals read belowBalance");
    // The stored day holds words and counts only: no address, header value or Referer host.
    store.flush?.(); store.persist?.();
    const raw = readdirSync(dir).map((n) => { try { return readFileSync(join(dir, n), "utf8"); } catch { return ""; } }).join("\n") + JSON.stringify(store.funnelDays(1));
    ok(!/10\.0\.0\.|github\.com|python-httpx/.test(raw), "the stored counts carry no address, Referer host or User-Agent string");
    const empty = emptyFunnelRow();
    ok(["ua", "referrer", "found", "uaPaid", "referrerPaid", "foundPaid", "nextStep"].every((k) => typeof empty[k] === "object") && empty.timeouts === 0, "the empty row carries the new groups");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
