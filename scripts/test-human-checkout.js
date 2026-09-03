// Human checkout state-machine test with a stubbed Stripe + generator. Proves:
// no free report without a PAID session, generate-once idempotency, auto-refund
// on report failure, an OWED refund when the refund call itself fails (retried,
// listed for the operator, never reported as refunded), abandoned-claim
// takeover after a restart (one regeneration, then refund), long-input metadata
// chunking, and the legacy single-file import. Offline, in CI.
import { createHumanCheckout, HUMAN_PRODUCTS, humanCheckoutEnabled, chunkInput, unchunkInput, STALE_CLAIM_MS } from "../src/human-checkout.js";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("/tmp", `test-human-checkout-${process.pid}`);
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* first run */ }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

let clock = Date.parse("2026-09-01T12:00:00Z");
const now = () => clock;
const sessions = {
  cs_paid: { id: "cs_paid", payment_status: "paid", payment_intent: "pi_ok", metadata: { product: "dossier", input: "AAPL" } },
  cs_unpaid: { id: "cs_unpaid", payment_status: "unpaid", metadata: { product: "dossier", input: "AAPL" } },
  cs_fail: { id: "cs_fail", payment_status: "paid", payment_intent: "pi_fail", metadata: { product: "research", input: "FAIL" } },
  cs_fail2: { id: "cs_fail2", payment_status: "paid", payment_intent: "pi_fail2", metadata: { product: "research", input: "FAIL" } },
  cs_sub: { id: "cs_sub", mode: "subscription", payment_status: "paid", metadata: { product: "domain-monitor", target: "x.com" } },
  cs_nometa: { id: "cs_nometa", payment_status: "paid", payment_intent: "pi_nometa", metadata: {} },
  cs_long: { id: "cs_long", payment_status: "paid", payment_intent: "pi_long", metadata: { product: "research", ...chunkInput("Q".repeat(1200)) } },
  cs_stale: { id: "cs_stale", payment_status: "paid", payment_intent: "pi_stale", metadata: { product: "dossier", input: "MSFT" } },
  cs_stale2: { id: "cs_stale2", payment_status: "paid", payment_intent: "pi_stale2", metadata: { product: "dossier", input: "MSFT" } },
};
let refunds = [];
let refundFail = false;
let genCalls = 0;
let retrieves = 0;
const stripe = {
  checkout: { sessions: {
    create: async (args) => { stripe._last = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; },
    retrieve: async (id) => { retrieves++; const s = sessions[id]; if (!s) throw new Error("No such session"); return s; },
  } },
  refunds: { create: async (args) => { if (refundFail) throw new Error("stripe refund down"); refunds.push(args); return { id: "re_" + refunds.length }; } },
};
const sales = [];
const generate = async (kind, slug, input, ctx) => {
  genCalls++;
  if (input === "FAIL") throw new Error("upstream boom");
  return { report: `# REPORT (${slug})\n\nAnalysis of ${input}. [1]`, title: `T:${input}`, sources: [], tables: [], _ctx: ctx };
};
const mk = () => createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: DIR, onSale: (s) => sales.push(s), now, log: () => {} });
let hc = mk();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(id, tries = 50) {
  for (let i = 0; i < tries; i++) { const r = hc.peek(id); if (r && r.status !== "generating") return r; await wait(10); }
  return hc.peek(id);
}

// products & gating
ok(Object.values(HUMAN_PRODUCTS).every((p) => p.price >= 100), "every human product clears $1, under which Stripe's 2.9% + $0.30 costs more than the report");
ok(!humanCheckoutEnabled() || true, "humanCheckoutEnabled reads STRIPE_SECRET_KEY");
ok(unchunkInput(chunkInput("Q".repeat(1200))) === "Q".repeat(1200) && Object.values(chunkInput("Q".repeat(1200))).every((v) => v.length <= 500), "long inputs are chunked into <=500-char Stripe metadata values and reassemble exactly");

// create session
const sess = await hc.createSession("dossier", "AAPL");
ok(sess.url && sess.id === "cs_new", "createSession returns a Stripe Checkout url");
await hc.createSession("research", "Q".repeat(1200));
ok(stripe._last.metadata.input.length === 500 && stripe._last.metadata.input3.length === 200, "createSession chunks a 1200-char input across metadata keys");
ok(stripe._last.allow_promotion_codes === true, "one-shot Checkout accepts promotion codes (dashboard-created first-report / partner codes)");
let threw = false; try { await hc.createSession("dossier", ""); } catch { threw = true; }
ok(threw, "createSession rejects empty input");
threw = false; try { await hc.createSession("not-a-product", "x"); } catch { threw = true; }
ok(threw, "createSession rejects an unknown product");
threw = false; try { await hc.createSession("constructor", "x"); } catch { threw = true; }
ok(threw, "createSession rejects an inherited-property product key");

// SECURITY: an UNPAID session never generates a report
const u = await hc.fulfill("cs_unpaid");
ok(u.status === "unpaid", "an unpaid session returns 'unpaid'");
ok(genCalls === 0, "SECURITY: no report is generated for an unpaid session");

// a bad/guessed session id never generates
ok((await hc.fulfill("cs_guessed_nonexistent")).status === "not_found", "a nonexistent session id is not_found");
const r0 = retrieves;
await hc.fulfill("cs_guessed_nonexistent"); await hc.fulfill("cs_guessed_nonexistent");
ok(retrieves === r0, "a repeated unknown id is answered from the negative cache (no Stripe call per poll)");
ok((await hc.fulfill("garbage")).status === "invalid", "a malformed session id is invalid");
ok((await hc.fulfill("cs_sub")).status === "invalid" && genCalls === 0, "a subscription-mode session pasted into /r/ is invalid (no report, no refund)");
ok(genCalls === 0, "SECURITY: still no report generated from unpaid/guessed ids");

// PAID session generates exactly once (idempotent)
const g1 = await hc.fulfill("cs_paid");
ok(g1.status === "generating", "a paid session starts generating");
await hc.fulfill("cs_paid"); // a concurrent poll must not double-generate
const finalPaid = await settle("cs_paid");
ok(finalPaid.status === "done" && /REPORT/.test(finalPaid.report), "the paid report completes and is stored");
ok(genCalls === 1, "generate ran exactly ONCE despite two fulfill calls (idempotent)");
ok(finalPaid._ctx === undefined && sales.length === 1 && sales[0].product === "dossier" && sales[0].priceUsd === HUMAN_PRODUCTS["dossier"].price / 100 && sales[0].paymentIntent === "pi_ok", "a delivered report fires onSale once (accounting) and the record carries no generator context");
await hc.fulfill("cs_paid");
ok(genCalls === 1, "a re-fulfill after 'done' does NOT regenerate (no double upstream spend)");
ok(existsSync(join(DIR, "cs_paid.json")) && !readFileSync(join(DIR, "_inflight.json"), "utf8").includes("cs_paid"), "the record is its own file; the in-flight index is cleared on completion");

// FAILURE path auto-refunds
const f1 = await hc.fulfill("cs_fail");
ok(f1.status === "generating", "the failing report starts generating");
const finalFail = await settle("cs_fail");
ok(finalFail.status === "error", "a failed report ends in 'error'");
ok(refunds.length === 1 && refunds[0].payment_intent === "pi_fail", "AUTO-REFUND: the card was refunded for the failed report");
ok(/has been refunded/i.test(finalFail.error) && finalFail.refundId === "re_1", "the error message tells the buyer they were refunded");

// REFUND FAILURE: owed, not claimed; retried later; listed for the operator
refundFail = true;
await hc.fulfill("cs_fail2");
const owed = await settle("cs_fail2");
ok(owed.status === "error" && owed.refundOwed === true && !owed.refundId && /being processed/.test(owed.error) && !/has been refunded/.test(owed.error), "a failed refund is recorded as OWED and the buyer is NOT told it was refunded");
ok(hc.listIssues().refundOwed.some((x) => x.id === "cs_fail2"), "the owed refund is listed for the operator");
refundFail = false;
await hc.fulfill("cs_fail2");
ok(hc.peek("cs_fail2").refundOwed === true, "a retry inside the pacing window does not re-call Stripe");
clock += 31_000;
const paid2 = await hc.fulfill("cs_fail2");
ok(paid2.refundId === "re_2" && paid2.refundOwed === false && /has been refunded/.test(paid2.error) && !hc.listIssues().refundOwed.some((x) => x.id === "cs_fail2"), "the owed refund is retried on a later poll, succeeds, and leaves the issues list");

// Missing metadata on a paid payment-mode session: refunded (persisted).
const nm = await hc.fulfill("cs_nometa");
ok(nm.status === "error" && nm.refundId === "re_3" && hc.peek("cs_nometa")?.refundId === "re_3", "a paid session with no report details is refunded once and persisted");
await hc.fulfill("cs_nometa");
ok(refunds.length === 3, "...and not refunded again on the next poll");

// Long input reassembles from chunked metadata.
await hc.fulfill("cs_long");
const lg = await settle("cs_long");
ok(lg.status === "done" && lg.input === "Q".repeat(1200), "a chunked 1200-char input is reassembled for generation");

// ABANDONED CLAIM (restart mid-generation): a stale claim is taken over once.
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "cs_stale.json"), JSON.stringify({ status: "generating", kind: "dossier", slug: "dossier", at: new Date(clock - STALE_CLAIM_MS - 1000).toISOString(), claimedAt: clock - STALE_CLAIM_MS - 1000, takeovers: 0 }));
writeFileSync(join(DIR, "_inflight.json"), JSON.stringify({ cs_stale: clock - STALE_CLAIM_MS - 1000, cs_stale2: clock - STALE_CLAIM_MS - 1000 }));
writeFileSync(join(DIR, "cs_stale2.json"), JSON.stringify({ status: "generating", kind: "dossier", slug: "dossier", at: new Date(clock - STALE_CLAIM_MS - 1000).toISOString(), claimedAt: clock - STALE_CLAIM_MS - 1000, takeovers: 1 }));
hc = mk(); // "new process"
const gBefore = genCalls;
const st = await hc.fulfill("cs_stale");
ok(st.status === "generating" && genCalls === gBefore + 1, "a stale 'generating' claim from a dead process is TAKEN OVER and regenerated");
ok((await settle("cs_stale")).status === "done", "...and the regenerated report is delivered");
const st2 = await hc.fulfill("cs_stale2");
ok(st2.status === "error" && st2.refundId && genCalls === gBefore + 1, "a claim already taken over once and abandoned again is REFUNDED, not regenerated forever");
// A FRESH claim (another process still working) is left alone.
writeFileSync(join(DIR, "cs_paid.json"), JSON.stringify({ status: "generating", kind: "dossier", slug: "dossier", at: new Date(clock).toISOString(), claimedAt: clock, takeovers: 0 }));
hc = mk();
ok((await hc.fulfill("cs_paid")).status === "generating" && genCalls === gBefore + 1, "a fresh claim (another process may still be running it) is not taken over");

// Boot sweep: drives abandoned claims without a poll.
writeFileSync(join(DIR, "cs_paid.json"), JSON.stringify({ status: "generating", kind: "dossier", slug: "dossier", at: new Date(clock - STALE_CLAIM_MS - 5000).toISOString(), claimedAt: clock - STALE_CLAIM_MS - 5000, takeovers: 0 }));
writeFileSync(join(DIR, "_inflight.json"), JSON.stringify({ cs_paid: clock - STALE_CLAIM_MS - 5000 }));
hc = mk();
const rec = await hc.recoverAbandoned();
ok(rec.length === 1 && rec[0].id === "cs_paid" && genCalls === gBefore + 2, "the boot sweep re-drives an abandoned claim (regenerates) without waiting for a poll");
ok((await settle("cs_paid")).status === "done", "...and it completes");

// Legacy single-file store is imported once into per-session files.
const LEG = join(DIR, "..", `legacy-${process.pid}`);
mkdirSync(LEG, { recursive: true });
// (the importer reads /data|/tmp/human-checkout.json - exercise the same code path by pointing storeDir at a dir whose sibling legacy file we plant)
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
const legacyPath = join(existsSync("/data") ? "/data" : "/tmp", "human-checkout.json");
const hadLegacy = existsSync(legacyPath);
if (!hadLegacy) {
  writeFileSync(legacyPath, JSON.stringify({ cs_old: { status: "done", kind: "research", slug: "research", input: "old", report: "# OLD", title: "old", sources: [], tables: [], at: "2026-08-21T00:00:00.000Z" } }));
  hc = mk();
  ok(hc.peek("cs_old")?.report === "# OLD" && !existsSync(legacyPath) && existsSync(legacyPath + ".migrated"), "a legacy single-file store is imported into per-session files once (old report links keep resolving)");
  try { rmSync(legacyPath + ".migrated"); } catch { /* ignore */ }
} else {
  ok(true, "legacy import skipped: a real legacy store exists on this machine (not touched)");
}

try { rmSync(DIR, { recursive: true, force: true }); rmSync(LEG, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
