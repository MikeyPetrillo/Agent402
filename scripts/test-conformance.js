#!/usr/bin/env node
// The conformance document (/.well-known/agent402-conformance.json,
// src/conformance.js) states, per payment rail, which features this server
// implements, and carries the refund terms as data. Its cells are computed
// from the serving code; this suite holds them to what the code does.
//
//   1. Offline: every row has every feature as a cell; the repayment family
//      each row names is the one scripts/refund-run.js sends on; the refund
//      clauses are the sentences /terms prints, word for word.
//   2. A paid server with every wire that settles after the handler
//      (scripts/lib/paid-wires-rig.js: x402 on Base, Solana, Algorand and
//      Stellar, MPP evm, Tempo pull). The document lists those rails as
//      offered, and each claim is tried on the wire: an answer that fails is
//      not settled and one that succeeds is, with the receipt header the cell
//      names; a resent x402 payment with an Idempotency-Key replays without a
//      second settlement and a Tempo one does not (its cell says no); a resent
//      Tempo credential is refused by the replay guard.
//   3. Switches flipped (HANGUP_FORGIVE=off, TEMPO_RELAY=off, no MPP key, one
//      network): the hang-up, Tempo screening and MPP evm cells change with
//      them, and the x402 rows follow the offer.
//   4. FREE_MODE: no paid rail is offered, and the document says it runs
//      in free mode.
//   5. The x402 and Tempo relay sanctions cells with a list loaded (a stored
//      list file), and without one (section 2: they say the screen fails
//      open); the document is built once per window and dropped when the
//      server listens. Section 2 also reads the refund terms document
//      (src/refund-terms-doc.js): its rails are these rows, and every wire
//      whose error answer is shown unsettled reads chargedOnErrorAnswer false.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires } from "./lib/paid-wires-rig.js";
import { bootPaidServer } from "./lib/paid-boot.js";
import { bootServer } from "./lib/boot-server.js";
import { FEATURES, conformanceRails, repaymentFamilyOf, refundTermsDocument, CONFORMANCE_PATH, conformanceDocumentCached, resetConformanceCache, CONFORMANCE_CACHE_MS } from "../src/conformance.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refundClauses, REPAYMENT_FAMILIES, LATE_LANDING_FAMILIES, OUTBOUND_PROOF_FAMILIES } from "../src/refund-terms.js";
import { familyOf } from "./refund-run.js";
import { RAILS } from "../src/rails.js";
import { termsPage } from "../src/terms.js";
import { REFUND_TERMS_PATH } from "../src/refund-terms-path.js";

let pass = 0, rig = null, refundTermsServed = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const row = (doc, id) => doc.rails.find((r) => r.id === id);
const FEATURE_IDS = FEATURES.map((f) => f.id);

// ---- 1. offline ----
{
  const rows = conformanceRails();
  await ok(rows.length > RAILS.length, `offline: ${rows.length} rows, one exact row per listed chain and every other rail`);
  for (const r of rows) {
    await ok(JSON.stringify(Object.keys(r.features)) === JSON.stringify(FEATURE_IDS), `${r.id}: one cell per feature, in column order`);
    for (const [k, c] of Object.entries(r.features)) {
      if (!([true, false, null].includes(c.supported) && typeof c.detail === "string" && c.detail.length > 10 && !c.detail.includes("—"))) await fail(`${r.id} ${k}: a cell is { supported: true|false|null, detail } (${JSON.stringify(c)})`);
    }
    await ok(r.offered === false, `${r.id}: offline nothing is mounted, so nothing is offered`);
  }
  for (const r of RAILS) await ok(rows.some((x) => x.id === `x402:exact:${r.caip2}`), `listed chain ${r.name} has an exact row`);
  // The repayment family a row names is the one the refund run sends on.
  for (const n of [...RAILS.map((r) => r.caip2), "eip155:4217", "stripe", "card"]) {
    const mine = repaymentFamilyOf(n), theirs = familyOf(n);
    await ok(mine === (theirs === "unknown" ? null : theirs), `${n}: repayment family ${mine} agrees with refund-run familyOf (${theirs})`);
  }
  const sample = { evm: "eip155:8453", tempo: "eip155:4217", solana: RAILS.find((r) => r.name === "Solana").caip2, stellar: "stellar:pubnet", algorand: RAILS.find((r) => r.name === "Algorand").caip2 };
  for (const [f] of REPAYMENT_FAMILIES) await ok(familyOf(sample[f]) === f, `/terms names ${f} as a repayment chain and the refund run sends on it`);
  for (const f of [...LATE_LANDING_FAMILIES, ...OUTBOUND_PROOF_FAMILIES]) await ok(REPAYMENT_FAMILIES.some(([k]) => k === f), `${f} is a repayment family`);
  // The clauses are the /terms sentences.
  const terms = text(termsPage("https://agent402.tools"));
  const clauses = refundClauses({ gatewayBatched: false });
  for (const c of clauses) await ok(terms.includes(c.text), `/terms prints clause ${c.id} word for word`);
  await ok(!clauses.some((c) => c.id === "gateway-pending") && !terms.includes("Gateway's records"), "the Gateway clause is absent while the batched option is not offered");
  const gw = refundClauses({ gatewayBatched: true });
  await ok(gw.some((c) => c.id === "gateway-pending") && gw.find((c) => c.id === "repayment-proof").text.includes("(for a Circle Gateway batched payment, in Gateway's records)"), "with the batched option the Gateway clause joins and the proof sentence names Gateway's records");
  await ok(JSON.stringify(refundTermsDocument("").clauses) === JSON.stringify(clauses), "the document's refundTerms are the same clauses");
  await ok(terms.includes(`A machine-readable copy of these refund terms is published at ${CONFORMANCE_PATH}`) && terms.includes("where the two differ, these terms govern"), "/terms points to the document and keeps itself the governing text");
  await ok(terms.includes("the EVM chains, Tempo, Solana, Stellar and Algorand") && terms.includes("on Tempo and Solana we also confirm the repayment itself"), "the family lists render as /terms has printed them");
}

// ---- 2. paid, every wire ----
const DUB = { method: "POST", path: "/api/dub", body: { text: "hello world", targetLanguage: "es" } };
const SCREEN_DIR = mkdtempSync(join(tmpdir(), "conformance-screen-"));
rig = await bootPaidWires({ label: "conformance", env: { SANCTIONS_SCREEN_FILE: join(SCREEN_DIR, "none.json") } });
try {
  const res = await fetch(`${rig.url}${CONFORMANCE_PATH}`);
  const doc = await res.json();
  await ok(res.status === 200 && doc.document === "agent402-conformance" && /max-age/.test(res.headers.get("cache-control") || ""), `the document is served (${res.status})`);
  for (const id of ["x402:exact:eip155:8453", `x402:exact:${RAILS.find((r) => r.name === "Solana").caip2}`, "x402:exact:stellar:pubnet", `x402:exact:${RAILS.find((r) => r.name === "Algorand").caip2}`, "mpp:evm:eip155:8453", "mpp:tempo:pull", "mpp:tempo:push", "pow"]) {
    await ok(row(doc, id)?.offered === true, `${id} is offered on the booted server`);
  }
  for (const id of ["x402:exact:eip155:137", "mpp:evm:eip155:42220", "mpp:stripe", "credits", "card:checkout"]) await ok(row(doc, id)?.offered === false, `${id} is not offered (not configured on this boot)`);
  await ok(row(doc, "x402:exact:eip155:8453").features.hangupForgiveness.supported === true && row(doc, "mpp:tempo:pull").features.hangupForgiveness.supported === true, "hang-up forgiveness reads on (the default)");
  {
    const t = row(doc, "mpp:tempo:pull").features.sanctionsScreening;
    await ok(t.supported === false && /fails open/.test(t.detail) && typeof t.identifier === "string", `Tempo through the relay with no list loaded: the payer screen fails open, and the cell says so (${JSON.stringify(t)})`);
  }
  // The refund terms document: the same rails and money cells, served.
  {
    const r = await fetch(`${rig.url}${REFUND_TERMS_PATH}`);
    const terms = await r.json();
    await ok(r.status === 200 && terms.document === "agent402-refund-terms" && /max-age/.test(r.headers.get("cache-control") || ""), `the refund terms document is served (${r.status})`);
    await ok(JSON.stringify(terms.rails.map((x) => x.id)) === JSON.stringify(doc.rails.map((x) => x.id)) && terms.rails.every((x) => JSON.stringify(x.settleAfterAnswer) === JSON.stringify(row(doc, x.id).features.settleAfterAnswer) && x.offered === row(doc, x.id).offered), "its rails are the conformance rows, offered and settle cells alike");
    refundTermsServed = terms;
  }
  {
    const c = row(doc, "x402:exact:eip155:8453").features.sanctionsScreening;
    await ok(c.supported === false && /no sanctions list is loaded/.test(c.detail) && /fails open/.test(c.detail), `the x402 payer screen is mounted with no list loaded: the cell says it fails open (${JSON.stringify(c)})`);
  }
  await ok(doc.freeMode === false, "a paid server: freeMode false");
  const again = await (await fetch(`${rig.url}${CONFORMANCE_PATH}`)).json();
  await ok(again.generatedAt === doc.generatedAt, "a second read inside the window is the cached document");
  await ok(JSON.stringify(doc.refundTerms.clauses) === JSON.stringify(refundClauses({ gatewayBatched: false })), "the served refund terms are the clauses");
  const servedTerms = text(await (await fetch(`${rig.url}/terms`)).text());
  for (const c of doc.refundTerms.clauses) await ok(servedTerms.includes(c.text), `the served /terms prints ${c.id}`);

  const WIRE_ROW = { evm: "x402:exact:eip155:8453", svm: `x402:exact:${RAILS.find((r) => r.name === "Solana").caip2}`, avm: `x402:exact:${RAILS.find((r) => r.name === "Algorand").caip2}`, stellar: "x402:exact:stellar:pubnet", "mpp-evm": "mpp:evm:eip155:8453", tempo: "mpp:tempo:pull" };
  const receiptHeaderOf = (cellDetail) => cellDetail.split(/[:,]/)[0].trim().toLowerCase();
  for (const [wire, id] of Object.entries(WIRE_ROW)) {
    const f = row(doc, id).features;
    await ok(f.settleAfterAnswer.supported === true && refundTermsServed.rails.find((x) => x.id === id).chargedOnErrorAnswer === false, `${id}: the cell claims settle after a successful answer, and the refund terms say an error answer is not charged`);
    const w = await rig.wallet(wire);
    rig.fund(w, 10n ** 12n);
    rig.st.llmStatus = 500;
    const s0 = rig.st.settleAttempts;
    const bad = await rig.pay(w, DUB);
    await ok(bad.status >= 400 && rig.outcomesOf(w).attempts === 0 && rig.outcomesOf(w).settled === 0, `${wire}: an answer that failed (${bad.status}) was not settled (attempts ${rig.outcomesOf(w).attempts}, global ${rig.st.settleAttempts - s0})`);
    rig.st.llmStatus = 0;
    const headers = await rig.credentialFor(w, DUB);
    const good = await rig.send(DUB, headers);
    await ok(good.status === 200 && rig.outcomesOf(w).settled === 1, `${wire}: a successful answer was settled once (${good.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
    const h = receiptHeaderOf(f.receipt.detail);
    await ok(f.receipt.supported === true && !!good.headers.get(h), `${wire}: the paid answer carries ${h}, the receipt the cell names`);
    await ok(f.signedReceipt.supported === false, `${id}: the cell does not claim a receipt signed by this server`);
    // The same credential again: the replay guard (and, on x402, the implicit
    // replay of the first answer) - never a second settlement.
    const again = await rig.send(DUB, headers);
    await ok(rig.outcomesOf(w).settled === 1 && (again.status === 200 ? again.headers.get("x-replayed-answer") === "1" : again.status >= 400), `${wire}: the same credential again is not settled twice (${again.status}${again.headers.get("x-replayed-answer") ? ", replayed" : ""})`);
    await ok(f.replayGuard.supported === true, `${id}: the cell claims a replay guard`);
  }
  // Idempotency-Key: honored where the cell says so, and not where it says no
  // (on a route that answers JSON, the answers the store keeps).
  const HASH = { method: "POST", path: "/api/hash", body: { text: "conformance" } };
  for (const [wire, id] of [["evm", WIRE_ROW.evm], ["mpp-evm", WIRE_ROW["mpp-evm"]], ["tempo", WIRE_ROW.tempo]]) {
    const claim = row(doc, id).features.idempotencyKey.supported;
    const w = await rig.wallet(wire);
    rig.fund(w, 10n ** 12n);
    const headers = { ...(await rig.credentialFor(w, HASH)), "Idempotency-Key": `conformance-${wire}-${Date.now()}` };
    const first = await rig.send(HASH, headers);
    await new Promise((r) => setTimeout(r, 300)); // the answer commits on finish
    const second = await rig.send(HASH, headers);
    const replayed = second.status === 200 && second.headers.get("x-idempotent-replay") === "true";
    await ok(first.status === 200 && replayed === claim && rig.outcomesOf(w).settled === 1, `${wire}: the cell says idempotency ${claim} and a keyed resend ${replayed ? "replays" : "is not replayed"} (${first.status}, ${second.status}, settled ${rig.outcomesOf(w).settled})`);
  }
} finally { await rig.stop(); rig = null; }

// ---- 3. switches flipped ----
{
  const srv = await bootPaidServer({ label: "conformance-flip", env: { HANGUP_FORGIVE: "off", TEMPO_RELAY: "off", TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD", MPP_SECRET_KEY: "" } });
  try {
    const doc = await (await fetch(`${srv.url}${CONFORMANCE_PATH}`)).json();
    const base = row(doc, "x402:exact:eip155:8453");
    await ok(base.offered === true && row(doc, `x402:exact:${RAILS.find((r) => r.name === "Solana").caip2}`).offered === false, "one network configured: the Base row is offered and Solana's is not");
    await ok(base.features.hangupForgiveness.supported === false && /HANGUP_FORGIVE=off/.test(base.features.hangupForgiveness.detail), "HANGUP_FORGIVE=off: the hang-up cell reads no");
    await ok(row(doc, "mpp:tempo:pull").features.sanctionsScreening.supported === true, "TEMPO_RELAY=off: the Tempo screening cell reads yes");
    await ok(row(doc, "mpp:tempo:pull").offered === false, "TEMPO_RELAY=off with no list loaded: Tempo is not offered");
    await ok(row(doc, "mpp:evm:eip155:8453").offered === false, "no MPP key: the MPP evm row is not offered");
  } finally { await srv.stop(); }
}

// ---- 4. FREE_MODE ----
{
  const srv = await bootServer({ stores: "conformance-free", env: { FREE_MODE: "true", NODE_ENV: "test", STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off", REDIS_URL: "", TARGET_URL: "", STRIPE_SECRET_KEY: "" } });
  try {
    const doc = await (await fetch(`${srv.url}${CONFORMANCE_PATH}`)).json();
    await ok(doc.rails.every((r) => r.offered === false), `FREE_MODE: no rail is offered (${doc.rails.filter((r) => r.offered).map((r) => r.id).join(", ") || "none"})`);
    await ok(doc.rails.find((r) => r.id === "x402:exact:eip155:8453").features.replayGuard.supported === false, "FREE_MODE: the replay guard cell reads no (the paywall is not mounted)");
    await ok(doc.freeMode === true && typeof doc.legend.freeMode === "string", "FREE_MODE: the document says so (freeMode true), so no rail offered is not read as no free tier");
  } finally { await srv.stop(); }
}

// ---- 5. the x402 screen with a list loaded; the document cache ----
{
  const file = join(SCREEN_DIR, "loaded.json");
  writeFileSync(file, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: ["0x00000000000000000000000000000000000000aa"] }));
  const srv = await bootPaidServer({ label: "conformance-screen", env: { SANCTIONS_SCREEN_FILE: file, SANCTIONS_LIST_URL: "http://127.0.0.1:9/SDN.XML" } });
  try {
    const doc = await (await fetch(`${srv.url}${CONFORMANCE_PATH}`)).json();
    for (const id of ["x402:exact:eip155:8453", `x402:exact:${RAILS.find((r) => r.name === "Solana").caip2}`]) {
      const c = row(doc, id).features.sanctionsScreening;
      await ok(c.supported === true && /refused 403/.test(c.detail) && /no list is loaded the screen fails open/.test(c.detail), `${id}: a list loaded, the cell reads yes and names the fail-open case (${JSON.stringify(c)})`);
    }
    const t = row(doc, "mpp:tempo:pull").features.sanctionsScreening;
    await ok(t.supported === true && /relay/.test(t.detail) && /fails open/.test(t.detail), `Tempo through the relay, a list loaded: the payer screen cell reads yes (${JSON.stringify(t)})`);
  } finally { await srv.stop(); }
}
{
  const t0 = Date.now();
  resetConformanceCache();
  const a = conformanceDocumentCached("https://a.example", { now: t0 });
  await ok(conformanceDocumentCached("https://a.example", { now: t0 + CONFORMANCE_CACHE_MS - 1 }) === a, "cache: the same document inside the window");
  await ok(conformanceDocumentCached("https://a.example", { now: t0 + CONFORMANCE_CACHE_MS }) !== a, "cache: rebuilt once the window ends");
  const b = conformanceDocumentCached("https://a.example", { now: t0 });
  await ok(conformanceDocumentCached("https://a.example", { freeMode: true, now: t0 }) !== b, "cache: keyed on free mode");
  const c = conformanceDocumentCached("https://a.example", { now: t0 });
  resetConformanceCache();
  await ok(conformanceDocumentCached("https://a.example", { now: t0 }) !== c, "cache: a reset drops it");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const listen = server.slice(server.indexOf("const httpServer = app.listen("), server.indexOf("const httpServer = app.listen(") + 600);
  await ok(/resetConformanceCache\(\)/.test(listen), "cache: the server drops it when it starts listening (gates mounted)");
}
rmSync(SCREEN_DIR, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
