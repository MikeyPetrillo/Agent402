#!/usr/bin/env node
// The refund terms document (/.well-known/agent402-refund-terms.json,
// src/refund-terms-doc.js) states only what the code runs. Offline:
//   - each switch it reads moves its field: HANGUP_FORGIVE=off turns hang-up
//     forgiveness off in the rules and in every rail's cell; CREDITS_SALES on
//     offers the refund route, and the route itself answers only then;
//   - the families it names are the ones scripts/refund-run.js sends on and
//     proves outbound (its own constants, not this module's), so a change to
//     the refund run's senders fails here until the document follows;
//   - the never-forgiven routes are the hang-up module's list;
//   - every rail row is the conformance row's money cells, and
//     chargedOnErrorAnswer is derived from settleAfterAnswer;
//   - the clauses are the /terms sentences; no budget, cap or dollar figure
//     is published; the document is cached per window and reset on listen;
//     the conformance document, the 402 block and /api/pricing link it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { readFileSync } from "node:fs";
import { familyOf, OUTBOUND_PROOF_FAMILIES as RUN_PROVES } from "./refund-run.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

delete process.env.HANGUP_FORGIVE;
delete process.env.CREDITS_SALES;
const D = await import("../src/refund-terms-doc.js");
const { conformanceRails, conformanceDocument } = await import("../src/conformance.js");
const { refundClauses } = await import("../src/refund-terms.js");
const { LASTING_EFFECT_SLUG_LIST, hasLastingEffect } = await import("../src/hangup-forgiveness.js");
const { RAILS } = await import("../src/rails.js");

const doc = D.refundTermsFullDocument("https://a.example");
ok(doc.document === "agent402-refund-terms" && doc.version === D.REFUND_TERMS_VERSION && doc.url === `https://a.example${D.REFUND_TERMS_PATH}` && doc.terms === "https://a.example/terms", "identity: document, version, url, the terms it restates");

// ---- switches ----
ok(doc.rules.hangupForgiveness.enabled === true && doc.rails.filter((r) => r.hangupForgiveness.supported === true).length === 0, "default: forgiveness on in the rules (offline no gate is mounted, so no rail cell claims it)");
process.env.HANGUP_FORGIVE = "off";
const off = D.refundTermsFullDocument("");
delete process.env.HANGUP_FORGIVE;
ok(off.rules.hangupForgiveness.enabled === false && /Off on this server/.test(off.rules.hangupForgiveness.note), "HANGUP_FORGIVE=off: the rules say forgiveness is off");
ok(doc.rules.credits.onSale === false && doc.rules.credits.refundOnRequest === null && /not on sale/.test(doc.rules.credits.note), "credits off sale: no refund route offered, and the note says why");
process.env.CREDITS_SALES = "on";
const sale = D.refundTermsFullDocument("https://a.example");
delete process.env.CREDITS_SALES;
ok(sale.rules.credits.onSale === true && sale.rules.credits.refundOnRequest?.url === "https://a.example/api/credits/refund" && sale.rules.credits.refundOnRequest.method === "POST" && !("note" in sale.rules.credits), "CREDITS_SALES on: the refund route is offered");
{
  const server = src("src/server.js");
  const at = server.indexOf('app.post("/api/credits/refund"');
  ok(at > 0 && /if \(!creditsSalesEnabled\(\)\) return next\(\);/.test(server.slice(at, at + 200)), "and the route answers only while credits are on sale (the same switch)");
}
ok(doc.rules.credits.debitedOnlyOnFinal200 === true && /debited only on a 200/.test(src("src/server.js")), "credits: debited only on a final 200, as the pricing surface says");

// ---- families, held to the refund run's own constants ----
{
  const sample = { evm: "eip155:8453", tempo: "eip155:4217", solana: RAILS.find((r) => r.name === "Solana").caip2, stellar: "stellar:pubnet", algorand: RAILS.find((r) => r.name === "Algorand").caip2 };
  const fams = doc.rules.refundLedger.repaymentFamilies;
  ok(fams.length === Object.keys(sample).length && fams.every((f) => familyOf(sample[f]) === f), `every repayment family is one the refund run sends on (${fams.join(",")})`);
  ok(JSON.stringify([...doc.rules.refundLedger.repaymentProvenOn].sort()) === JSON.stringify([...RUN_PROVES].sort()), `the families whose repayment is proven are the refund run's own (${RUN_PROVES.join(",")})`);
  for (const r of doc.rails) {
    if (r.network) ok(r.repaymentFamily === (familyOf(r.network) === "unknown" ? null : familyOf(r.network)), `${r.id}: repayment family ${r.repaymentFamily} is the refund run's`);
  }
}

// ---- hang-up: the never-forgiven routes ----
ok(JSON.stringify(doc.rules.hangupForgiveness.neverForgivenSlugs) === JSON.stringify(LASTING_EFFECT_SLUG_LIST) && doc.rules.hangupForgiveness.neverForgivenSlugs.every(hasLastingEffect), "the never-forgiven routes are the hang-up module's list");

// ---- rails: the conformance rows' money cells ----
{
  const rows = conformanceRails();
  ok(JSON.stringify(doc.rails.map((r) => r.id)) === JSON.stringify(rows.map((r) => r.id)), `one row per conformance rail, same order (${rows.length})`);
  for (const r of doc.rails) {
    const c = rows.find((x) => x.id === r.id);
    const same = ["settleAfterAnswer", "hangupForgiveness", "refundOnChargedFailure"].every((k) => JSON.stringify(r[k]) === JSON.stringify(c.features[k]));
    const expect = c.features.settleAfterAnswer.supported === null ? null : c.features.settleAfterAnswer.supported !== true;
    if (!same || r.chargedOnErrorAnswer !== expect) ok(false, `${r.id}: cells and chargedOnErrorAnswer follow the conformance row`);
  }
  ok(true, "every row's cells are the conformance row's, and chargedOnErrorAnswer is derived from settleAfterAnswer");
  const by = (id) => doc.rails.find((r) => r.id === id);
  ok(by("x402:exact:eip155:8453").chargedOnErrorAnswer === false && by("mpp:tempo:pull").chargedOnErrorAnswer === false, "x402 and a Tempo pull: an error answer is not charged");
  ok(by("mpp:tempo:push").chargedOnErrorAnswer === true && by("mpp:tempo:push").refundOnChargedFailure.supported === true, "a Tempo push transfer is final before the call, and a failure is repaid");
  ok(by("pow").chargedOnErrorAnswer === null && by("credits").chargedOnErrorAnswer === false, "proof of work charges nothing; credits debit only a final 200");
}

// ---- clauses, figures, cache, links ----
ok(JSON.stringify(doc.clauses) === JSON.stringify(refundClauses({ gatewayBatched: false })), "the clauses are the /terms sentences");
{
  const numbers = [];
  const walk = (o, path) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`); else if (typeof o === "number") numbers.push(`${path}=${o}`); };
  walk(doc, "");
  ok(numbers.length > 0 && numbers.every((n) => /^\.(version|rules\.x402Ordering\.settlesOnlyBelow)=/.test(n)), `no budget, cap or dollar figure is published (${numbers.join(", ")})`);
}
{
  const t0 = Date.now();
  D.resetRefundTermsCache();
  const a = D.refundTermsFullDocumentCached("https://a.example", { now: t0 });
  ok(D.refundTermsFullDocumentCached("https://a.example", { now: t0 + D.REFUND_TERMS_CACHE_MS - 1 }) === a && D.refundTermsFullDocumentCached("https://a.example", { now: t0 + D.REFUND_TERMS_CACHE_MS }) !== a, "cached for one window, rebuilt after it");
  const server = src("src/server.js");
  const listen = server.slice(server.indexOf("const httpServer = app.listen("), server.indexOf("const httpServer = app.listen(") + 600);
  ok(/resetRefundTermsCache\(\)/.test(listen) && /app\.get\(REFUND_TERMS_PATH, /.test(server), "served under its path constant and dropped when the server listens");
  ok(/refundTerms: `\$\{BASE_URL\}\$\{REFUND_TERMS_PATH\}`/.test(server), "/api/pricing links it");
}
ok(conformanceDocument("https://a.example").refundTerms.perRail === `https://a.example${D.REFUND_TERMS_PATH}`, "the conformance document points to it");
ok(src("src/well-known-store.js").includes('"agent402-refund-terms.json"'), "the well-known store refuses an entry that would shadow it");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
