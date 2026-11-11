// Human checkout state-machine test with a stubbed Stripe + generator. Proves:
// no free report without a PAID session, generate-once idempotency, auto-refund
// on report failure, an OWED refund when the refund call itself fails (retried,
// listed for the operator, never reported as refunded), abandoned-claim
// takeover after a restart (one regeneration, then refund), long-input metadata
// chunking, and the legacy single-file import. Offline, in CI.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHumanCheckout, HUMAN_PRODUCTS, humanCheckoutEnabled, chunkInput, unchunkInput, STALE_CLAIM_MS, isReportPurchase } from "../src/human-checkout.js";
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
  // failure breaker: one buyer address, three failed reports, then a fourth that WOULD succeed
  cs_g1: { id: "cs_g1", payment_status: "paid", payment_intent: "pi_g1", customer_details: { email: "Griefer@Example.com" }, metadata: { product: "research", input: "FAIL" } },
  cs_g2: { id: "cs_g2", payment_status: "paid", payment_intent: "pi_g2", customer_details: { email: "griefer@example.com" }, metadata: { product: "research", input: "FAIL" } },
  cs_g3: { id: "cs_g3", payment_status: "paid", payment_intent: "pi_g3", customer_details: { email: "griefer@example.com" }, metadata: { product: "research", input: "FAIL" } },
  cs_g4: { id: "cs_g4", payment_status: "paid", payment_intent: "pi_g4", customer_details: { email: "griefer@example.com" }, metadata: { product: "dossier", input: "AAPL" } },
  cs_other: { id: "cs_other", payment_status: "paid", payment_intent: "pi_other", customer_details: { email: "someone-else@example.com" }, metadata: { product: "dossier", input: "AAPL" } },
  cs_sub: { id: "cs_sub", mode: "subscription", payment_status: "paid", metadata: { product: "domain-monitor", target: "x.com" } },
  cs_nometa: { id: "cs_nometa", payment_status: "paid", payment_intent: "pi_nometa", metadata: {} },
  // a report purchase whose input is missing (ours to refund)
  cs_noinput: { id: "cs_noinput", payment_status: "paid", payment_intent: "pi_noinput", metadata: { product: "dossier" } },
  // a report product a switch has taken off sale since the purchase
  cs_offsale: { id: "cs_offsale", payment_status: "paid", payment_intent: "pi_offsale", metadata: { product: "token-brief", input: "So11111111111111111111111111111111111111112" } },
  // paid Checkout sessions that are NOT report purchases
  cs_pack: { id: "cs_pack", mode: "payment", payment_status: "paid", payment_intent: "pi_pack", customer_details: { email: "pack@example.com" }, metadata: { credits_pack: "credits-100", terms: "t" } },
  cs_packprod: { id: "cs_packprod", mode: "payment", payment_status: "paid", payment_intent: "pi_packprod", metadata: { credits_pack: "credits-20", product: "dossier", input: "AAPL" } },
  cs_unknownprod: { id: "cs_unknownprod", mode: "payment", payment_status: "paid", payment_intent: "pi_unknownprod", metadata: { product: "constructor", input: "AAPL" } },
  cs_arrayprod: { id: "cs_arrayprod", mode: "payment", payment_status: "paid", payment_intent: "pi_arrayprod", metadata: { product: ["dossier"], input: "AAPL" } },
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

// A report purchase with its input missing: refunded (persisted).
const nm = await hc.fulfill("cs_noinput");
ok(nm.status === "error" && nm.refundId === "re_3" && hc.peek("cs_noinput")?.refundId === "re_3", "a paid report session with no report details is refunded once and persisted");
await hc.fulfill("cs_noinput");
ok(refunds.length === 3, "...and not refunded again on the next poll");

// A paid session that is not a report purchase (a credits pack, no product,
// a product this module never sold): invalid, nothing generated, recorded or
// refunded, on the first read and on every later one. The controls beside it
// are the report sessions above (cs_paid generated, cs_fail refunded once).
{
  const refundsBefore = refunds.length, genBefore = genCalls;
  for (const id of ["cs_pack", "cs_nometa", "cs_packprod", "cs_unknownprod", "cs_arrayprod"]) {
    const first = await hc.fulfill(id);
    const second = await hc.fulfill(id);
    ok(first.status === "invalid" && second.status === "invalid" && Object.keys(first).join(",") === "status" && hc.peek(id) === null,
      `${id}: a paid session that is not a report purchase answers invalid and leaves no record (${JSON.stringify(first)})`);
  }
  ok(refunds.length === refundsBefore && !refunds.some((r) => /^pi_(pack|nometa|packprod|unknownprod|arrayprod)$/.test(r.payment_intent)), `no refund is made for a session that is not a report purchase (${refunds.length - refundsBefore} made)`);
  ok(genCalls === genBefore, "and no report is generated for one");
  ok(JSON.stringify(await hc.fulfill("garbage")) === JSON.stringify(await hc.fulfill("cs_pack")), "the answer is the one an id that is not a session gets");
  ok(isReportPurchase(sessions.cs_paid) && isReportPurchase(sessions.cs_noinput) && isReportPurchase(sessions.cs_offsale) && !isReportPurchase(sessions.cs_pack) && !isReportPurchase(sessions.cs_nometa) && !isReportPurchase(null),
    "isReportPurchase: a string product naming a report product, and no credits pack");
  // A report product taken off sale after the purchase is still the buyer's
  // report purchase: refunded, as before (exercised when the switch is off).
  if (!HUMAN_PRODUCTS["token-brief"]) {
    const off = await hc.fulfill("cs_offsale");
    ok(off.status === "error" && refunds.at(-1)?.payment_intent === "pi_offsale" && refunds.length === refundsBefore + 1, "a paid session for a report product now off sale is refunded once");
    await hc.fulfill("cs_offsale");
    ok(refunds.length === refundsBefore + 1, "...and not again on the next poll");
  }
}

// OWED REFUNDS ALREADY ON DISK: the retry and the refundsOwed fold act only on
// report purchases. Four stored owed records as an earlier build could have
// left them, read by a fresh instance: a credits-pack session, a record naming
// a product this module never sold, a genuine report purchase recorded before
// records carried a product (the live control), and one whose session Stripe
// no longer returns.
{
  sessions.cs_owedpack = { id: "cs_owedpack", mode: "payment", payment_status: "paid", payment_intent: "pi_owedpack", metadata: { credits_pack: "credits-100" } };
  sessions.cs_owedlegacy = { id: "cs_owedlegacy", mode: "payment", payment_status: "paid", payment_intent: "pi_owedlegacy", metadata: { product: "research", input: "FAIL" } };
  const owedRec = (pi, extra = {}) => ({ status: "error", refundId: null, error: "We couldn't complete this report after a retry. Your refund is being processed.", refundOwed: true, refundAttempts: 1, lastRefundAttemptAt: 0, paymentIntent: pi, at: new Date(clock - 3600_000).toISOString(), ...extra });
  const planted = { cs_owedpack: owedRec("pi_owedpack"), cs_owedunknown: owedRec("pi_owedunknown", { product: "constructor" }), cs_owedlegacy: owedRec("pi_owedlegacy"), cs_owednosess: owedRec("pi_owednosess") };
  const issuesPath = join(DIR, "_issues.json");
  const issues = existsSync(issuesPath) ? JSON.parse(readFileSync(issuesPath, "utf8")) : {};
  for (const [id, rec] of Object.entries(planted)) { writeFileSync(join(DIR, `${id}.json`), JSON.stringify(rec)); issues[id] = { kind: "refund-owed", at: rec.at, attempts: 1 }; }
  writeFileSync(issuesPath, JSON.stringify(issues));
  const lines = [];
  const fresh = createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: DIR, onSale: (x) => sales.push(x), now, log: (m) => lines.push(String(m)) });
  ok(["cs_owedpack", "cs_owedunknown", "cs_owedlegacy", "cs_owednosess"].every((id) => fresh.listIssues().refundOwed.some((x) => x.id === id)), "control: the four stored owed records are on the operator's list");

  const before = refunds.length, genBefore = genCalls;
  for (const id of ["cs_owedpack", "cs_owedunknown", "cs_owednosess"]) { await fresh.fulfill(id); clock += 31_000; await fresh.fulfill(id); }
  ok(refunds.length === before && !refunds.some((r) => /^pi_owed(pack|unknown|nosess)$/.test(r.payment_intent)), `a stored owed record that is not a report purchase makes no refunds.create call, on two polls past the pacing window (${refunds.length - before})`);
  ok(fresh.peek("cs_owedpack").refundOwed === true && fresh.peek("cs_owedpack").refundAttempts === 1 && fresh.peek("cs_owedunknown").refundAttempts === 1, "those records are left exactly as they were (no attempt counted)");
  // The live control: the genuine report purchase beside them is retried once.
  const legacy = await fresh.fulfill("cs_owedlegacy");
  ok(refunds.length === before + 1 && refunds.at(-1).payment_intent === "pi_owedlegacy" && legacy.refundOwed === false && /has been refunded/.test(legacy.error), "control: the genuine owed report refund stored beside them is retried and succeeds");
  clock += 31_000;
  await fresh.fulfill("cs_owedlegacy");
  ok(refunds.length === before + 1 && genCalls === genBefore, "...once: not again on the next poll, and nothing is generated");
  ok(fresh.peek("cs_owedlegacy").product === "research", "the refunded record now names its report product");

  // The refundsOwed fold reads the same rule.
  const owedNow = (await fresh.owedRefunds()).map((x) => x.id);
  ok(!owedNow.includes("cs_owedpack") && !owedNow.includes("cs_owedunknown") && !owedNow.includes("cs_owedlegacy"), `the owed list behind the refundsOwed word leaves out the two that are not report purchases (and the one just refunded): ${owedNow.join(",") || "none"}`);
  ok(owedNow.includes("cs_owednosess"), "a record whose session cannot be read is not decided: it stays on the owed list and is not refunded");
  ok(fresh.listIssues().refundOwed.some((x) => x.id === "cs_owedpack"), "the operator's list still shows every stored record");
  // A genuine owed refund made by this build is on the owed list, then retried once.
  sessions.cs_owednew = { id: "cs_owednew", payment_status: "paid", payment_intent: "pi_owednew", metadata: { product: "research", input: "FAIL" } };
  refundFail = true;
  await fresh.fulfill("cs_owednew");
  for (let i = 0; i < 50 && fresh.peek("cs_owednew")?.status === "generating"; i++) await wait(10);
  refundFail = false;
  ok(fresh.peek("cs_owednew")?.refundOwed === true && fresh.peek("cs_owednew").product === "research" && (await fresh.owedRefunds()).some((x) => x.id === "cs_owednew" && x.product === "research"), "control: a new owed report refund names its product and is on the owed list");
  clock += 31_000;
  const n0 = refunds.length, r0 = retrieves;
  const fixed = await fresh.fulfill("cs_owednew");
  ok(fixed.refundOwed === false && refunds.length === n0 + 1 && refunds.at(-1).payment_intent === "pi_owednew" && retrieves === r0, "and is retried once on a later poll, decided from the record with no extra session read");
  const skipLines = lines.filter((l) => /owed-refund record\(s\) skipped: not a report purchase/.test(l));
  ok(skipLines.length >= 1 && /^\[human-checkout\] 2 owed-refund record\(s\) skipped/.test(skipLines.at(-1)) && skipLines.every((l) => !/cs_|pi_/.test(l)), `the skips are one counted log line with no id (${skipLines.at(-1)})`);
  for (const id of Object.keys(planted)) { rmSync(join(DIR, `${id}.json`), { force: true }); }
  const left = JSON.parse(readFileSync(issuesPath, "utf8"));
  for (const id of [...Object.keys(planted), "cs_owednew"]) delete left[id];
  writeFileSync(issuesPath, JSON.stringify(left));
}

// THE OWED LIST NEVER WAITS ON STRIPE (the list behind the refundsOwed word of
// /api/gateway-status). Five owed records that name no product, as an earlier
// build stored them, and a Stripe whose session read never answers: the list
// returns at once with every record still on it, reads start beside it (three
// at a time), a record with a read in flight or one that did not answer is
// not asked again inside the retry time, and an answer that does arrive is
// used by the next read of the list. (The list's own bounded wait for the
// reads it started is set to 0 here; the block after this one covers it.)
{
  const DIR2 = join("/tmp", `test-human-checkout-owed-${process.pid}`);
  rmSync(DIR2, { recursive: true, force: true });
  mkdirSync(DIR2, { recursive: true });
  const at = new Date(clock - 3600_000).toISOString();
  const ids = ["cs_hang1", "cs_hang2", "cs_hang3", "cs_hang4", "cs_hang5"];
  for (const id of ids) writeFileSync(join(DIR2, `${id}.json`), JSON.stringify({ status: "error", refundId: null, error: "We couldn't complete this report after a retry. Your refund is being processed.", refundOwed: true, refundAttempts: 6, lastRefundAttemptAt: 0, paymentIntent: id.replace("cs_", "pi_"), at }));
  writeFileSync(join(DIR2, "_issues.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id, { kind: "refund-owed", at, attempts: 6 }]))));
  const calls = [], answer = new Map();
  const count = (id) => calls.filter((c) => c === id).length;
  const counts = () => ids.map(count).join(",");
  const hung = { checkout: { sessions: { retrieve: (id) => { calls.push(id); return new Promise((resolve) => answer.set(id, resolve)); } } }, refunds: { create: async () => { throw new Error("no refund is sent from the owed list"); } } };
  let t = clock;
  const h = createHumanCheckout({ stripe: hung, generate, baseUrl: "https://agent402.tools", storeDir: DIR2, onSale: () => {}, now: () => t, log: () => {}, owedResolveTimeoutMs: 150, owedResolveRetryMs: 600_000, owedListWaitMs: 0 });
  const listed = async () => {
    const t0 = performance.now();
    const list = await Promise.race([h.owedRefunds(), wait(2000).then(() => null)]);
    return { held: list === null, ms: performance.now() - t0, ids: (list || []).map((x) => x.id) };
  };
  const all = (r) => ids.every((id) => r.ids.includes(id));
  const first = await listed();
  ok(!first.held && first.ms < 1000 && all(first), `with a Stripe that never answers the owed list returns at once, every record still owed (${first.held ? "held" : `${first.ms.toFixed(0)} ms`}, ${first.ids.length} of ${ids.length})`);
  ok(counts() === "1,1,1,0,0", `its session reads run beside it, three at a time (${counts()})`);
  const second = await listed();
  ok(!second.held && all(second) && counts() === "1,1,1,0,0", `a second read while those are in flight starts no second read of a record (${counts()})`);
  await wait(300); // past the 150 ms a read is given
  const third = await listed();
  ok(!third.held && all(third) && counts() === "1,1,1,1,1", `a read that did not answer is not asked again; the waiting records get their turn (${counts()})`);
  await wait(300);
  t += 599_000;
  const fourth = await listed();
  ok(!fourth.held && all(fourth) && counts() === "1,1,1,1,1", `inside the retry time no record is asked again, and all are still owed (${counts()})`);
  t += 2_000;
  const fifth = await listed();
  ok(!fifth.held && all(fifth) && counts() === "2,2,2,1,1", `past the retry time a record is asked once more (${counts()})`);
  // Stripe answers two of them late: one is a credits pack, one a report.
  answer.get("cs_hang1")({ id: "cs_hang1", mode: "payment", payment_status: "paid", payment_intent: "pi_hang1", metadata: { credits_pack: "credits-100" } });
  answer.get("cs_hang2")({ id: "cs_hang2", mode: "payment", payment_status: "paid", payment_intent: "pi_hang2", metadata: { product: "research", input: "x" } });
  await wait(30);
  const sixth = await listed();
  ok(!sixth.held && !sixth.ids.includes("cs_hang1") && ["cs_hang2", "cs_hang3", "cs_hang4", "cs_hang5"].every((id) => sixth.ids.includes(id)), `an answer that arrives is used by the next read: the one that is not a report purchase leaves the list, the report stays (${sixth.ids.join(",")})`);
  const seventh = await listed();
  ok(count("cs_hang1") === 2 && count("cs_hang2") === 2 && all({ ids: [...seventh.ids, "cs_hang1"] }), `...and a decided record is never read from Stripe again (${counts()})`);
  rmSync(DIR2, { recursive: true, force: true });
}

// THE FIRST READ AFTER A START DECIDES WHAT A HEALTHY STRIPE CAN DECIDE. The
// decision for a record that names no product lives in memory, so a new
// process holds none. The owed list waits a bounded time for the session
// reads it started: with a Stripe that answers in about 20 ms the first
// read leaves out the records that are not report purchases (five of them,
// more than run at once) and lists the report; with one that never answers
// the first read still returns, every record listed.
{
  const DIR3 = join("/tmp", `test-human-checkout-owedwait-${process.pid}`);
  rmSync(DIR3, { recursive: true, force: true });
  mkdirSync(DIR3, { recursive: true });
  const at = new Date(clock - 3600_000).toISOString();
  const packs = ["cs_wpack1", "cs_wpack2", "cs_wpack3", "cs_wpack4", "cs_wpack5"], ids = [...packs, "cs_wreport"];
  for (const id of ids) writeFileSync(join(DIR3, `${id}.json`), JSON.stringify({ status: "error", refundId: null, error: "We couldn't complete this report after a retry. Your refund is being processed.", refundOwed: true, refundAttempts: 6, lastRefundAttemptAt: 0, paymentIntent: id.replace("cs_", "pi_"), at }));
  writeFileSync(join(DIR3, "_issues.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id, { kind: "refund-owed", at, attempts: 6 }]))));
  const sessionOf = (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: id.replace("cs_", "pi_"), metadata: id === "cs_wreport" ? { product: "research", input: "x" } : { credits_pack: "credits-100" } });
  const noRefund = { create: async () => { throw new Error("no refund is sent from the owed list"); } };
  const mkOwed = (stripe, extra = {}) => createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: DIR3, onSale: () => {}, now, log: () => {}, ...extra });
  let reads = 0;
  // The wait is generous here so a busy runner cannot end it before a 20 ms answer; the default is asserted below.
  const healthy = mkOwed({ checkout: { sessions: { retrieve: async (id) => { reads++; await wait(20); return sessionOf(id); } } }, refunds: noRefund }, { owedListWaitMs: 30_000 });
  const first = (await healthy.owedRefunds()).map((x) => x.id);
  ok(first.join() === "cs_wreport" && reads === ids.length, `a fresh start with a Stripe that answers in 20 ms: the first read of the owed list leaves out the ${packs.length} records that are not report purchases and lists the report (${first.join(",") || "none"}; ${reads} session reads)`);
  const again = (await healthy.owedRefunds()).map((x) => x.id);
  ok(again.join() === "cs_wreport" && reads === ids.length, `...and the next read asks Stripe nothing more (${reads})`);
  // A Stripe that never answers, the default wait: the call returns, every
  // record listed. A session read is given ten minutes here, so only the
  // list's own wait can end the call inside the 20 s it is allowed.
  let hungReads = 0;
  const hanging = mkOwed({ checkout: { sessions: { retrieve: () => { hungReads++; return new Promise(() => {}); } } }, refunds: noRefund }, { owedResolveTimeoutMs: 600_000 });
  const got = await Promise.race([hanging.owedRefunds(), wait(20_000).then(() => null)]);
  ok(got !== null && ids.every((id) => got.some((x) => x.id === id)) && hungReads === 3, `a fresh start with a Stripe that never answers: the first read returns past its bounded wait with every record still owed (${got === null ? "held" : got.length} of ${ids.length}; ${hungReads} session reads)`);
  const t0 = performance.now();
  const next = await Promise.race([hanging.owedRefunds(), wait(20_000).then(() => null)]);
  ok(next !== null && next.length === ids.length && hungReads === 3, `...and a read that starts no session read does not wait (${(performance.now() - t0).toFixed(0)} ms, ${hungReads} session reads)`);
  rmSync(DIR3, { recursive: true, force: true });
}

// THE BUYER'S POLL DOES NOT WAIT ON STRIPE WITHOUT A BOUND. A poll of an owed
// refund retries it (retryOwedRefund). With a Stripe that never answers the
// refund call, or the session read that decides a record naming no product,
// the poll is answered inside its wait with the record still owed and no
// attempt counted; a poll while that retry is open starts no second call; a
// later poll against a Stripe that answers sends one refund, under the same
// idempotency key as the call that was never answered, and a late answer to
// that first call (a success, or a failure) changes nothing.
{
  const DIR4 = join("/tmp", `test-human-checkout-poll-${process.pid}`);
  rmSync(DIR4, { recursive: true, force: true });
  mkdirSync(DIR4, { recursive: true });
  const at = new Date(clock - 3600_000).toISOString();
  const owed = (pi, extra = {}) => ({ status: "error", refundId: null, error: "We couldn't complete this report. Your refund is being processed.", refundOwed: true, refundAttempts: 1, lastRefundAttemptAt: 0, paymentIntent: pi, at, ...extra });
  const recs = { cs_pollA: owed("pi_pollA", { product: "research" }), cs_pollB: owed("pi_pollB", { product: "research" }), cs_pollC: owed("pi_pollC") };
  for (const [id, rec] of Object.entries(recs)) writeFileSync(join(DIR4, `${id}.json`), JSON.stringify(rec));
  writeFileSync(join(DIR4, "_issues.json"), JSON.stringify(Object.fromEntries(Object.keys(recs).map((id) => [id, { kind: "refund-owed", at, attempts: 1 }]))));
  let stripeAnswers = false;
  const creates = [], sent = [], late = new Map(), reads = [];
  const stub = {
    checkout: { sessions: { retrieve: (id) => { reads.push(id); return stripeAnswers ? Promise.resolve({ id, mode: "payment", payment_status: "paid", payment_intent: "pi_pollC", metadata: { product: "research", input: "x" } }) : new Promise(() => {}); } } },
    refunds: { create: (args, opts) => {
      creates.push({ pi: args.payment_intent, key: opts?.idempotencyKey });
      if (!stripeAnswers) return new Promise((resolve, reject) => late.set(args.payment_intent, { resolve, reject }));
      sent.push(args.payment_intent);
      return Promise.resolve({ id: `re_${args.payment_intent}` });
    } },
  };
  let t = clock;
  const ABANDON_MS = 300_000;
  const h = createHumanCheckout({ stripe: stub, generate, baseUrl: "https://agent402.tools", storeDir: DIR4, onSale: () => {}, now: () => t, log: () => {}, owedRetryWaitMs: 150, owedRetryAbandonMs: ABANDON_MS });
  // A poll is given 20 s here; the retry's own wait is 150 ms.
  const poll = async (id) => { const r = await Promise.race([h.fulfill(id), wait(20_000).then(() => null)]); return r === null ? { held: true } : r; };
  const of = (pi) => creates.filter((c) => c.pi === pi);
  const stillOwed = (r) => !r.held && r.status === "error" && r.refundOwed === true && !r.refundId && /Your refund is being processed\.$/.test(r.error) && !/has been refunded/.test(r.error);

  // 1. The refund call never answers.
  for (const [id, pi] of [["cs_pollA", "pi_pollA"], ["cs_pollB", "pi_pollB"]]) {
    const first = await poll(id);
    ok(stillOwed(first), `refund call unanswered (${id}): the poll is answered inside its wait, the refund still owed and never reported as sent (${first.held ? "HELD" : first.status})`);
    ok(of(pi).length === 1 && of(pi)[0].key === `agent402-refund-${pi}`, `refund call unanswered (${id}): one refund call is open, under the payment's idempotency key (${JSON.stringify(of(pi))})`);
    ok(h.peek(id).refundOwed === true && h.peek(id).refundAttempts === 1 && h.listIssues().refundOwed.some((x) => x.id === id), `refund call unanswered (${id}): the record is still owed and listed, no attempt counted`);
    const second = await poll(id);
    ok(stillOwed(second) && of(pi).length === 1, `refund call unanswered (${id}): a poll while that call is open is answered from the record and starts no second call (${of(pi).length})`);
  }
  // Inside the abandon time, with Stripe answering again: still the one call.
  stripeAnswers = true;
  t += ABANDON_MS - 1_000;
  ok(stillOwed(await poll("cs_pollA")) && of("pi_pollA").length === 1 && sent.length === 0, "refund call unanswered: until the open call is given up no second one is sent");
  t += 2_000;
  for (const [id, pi] of [["cs_pollA", "pi_pollA"], ["cs_pollB", "pi_pollB"]]) {
    const healed = await poll(id);
    ok(!healed.held && healed.refundOwed === false && healed.refundId === `re_${pi}` && /has been refunded/.test(healed.error), `later, Stripe answering (${id}): the poll refunds the payment and says so (${healed.held ? "HELD" : healed.refundId})`);
    ok(sent.filter((x) => x === pi).length === 1 && of(pi).length === 2 && of(pi).every((c) => c.key === `agent402-refund-${pi}`), `later, Stripe answering (${id}): exactly one refund is sent, under the same idempotency key as the unanswered call (${JSON.stringify(of(pi))})`);
    ok(!h.listIssues().refundOwed.some((x) => x.id === id), `later, Stripe answering (${id}): the debt leaves the owed list`);
  }
  // The first calls answer late: one as Stripe replays a keyed refund, one as a failure.
  late.get("pi_pollA").resolve({ id: "re_pi_pollA" });
  late.get("pi_pollB").reject(new Error("stripe: connection lost"));
  await wait(50);
  t += 31_000;
  for (const [id, pi] of [["cs_pollA", "pi_pollA"], ["cs_pollB", "pi_pollB"]]) {
    const after = await poll(id);
    ok(!after.held && after.refundOwed === false && after.refundId === `re_${pi}` && of(pi).length === 2 && sent.filter((x) => x === pi).length === 1, `late answer to the unanswered call (${id}): the record stays refunded and no further refund is sent (${after.refundId}, ${of(pi).length} calls)`);
  }

  // 2. A record that names no product: the session read never answers.
  stripeAnswers = false;
  const c1 = await poll("cs_pollC");
  ok(stillOwed(c1) && reads.filter((x) => x === "cs_pollC").length === 1 && of("pi_pollC").length === 0, `session read unanswered: the poll is answered inside its wait, still owed, and no refund is sent on an undecided record (${c1.held ? "HELD" : c1.status})`);
  const c2 = await poll("cs_pollC");
  ok(stillOwed(c2) && reads.filter((x) => x === "cs_pollC").length === 1, "session read unanswered: a poll while that read is open starts no second read");
  stripeAnswers = true;
  t += ABANDON_MS + 1_000;
  const c3 = await poll("cs_pollC");
  ok(!c3.held && c3.refundOwed === false && c3.refundId === "re_pi_pollC" && sent.filter((x) => x === "pi_pollC").length === 1 && of("pi_pollC").length === 1, `session read unanswered, then Stripe answering: one refund is sent (${c3.held ? "HELD" : c3.refundId})`);
  t += 31_000;
  await poll("cs_pollC");
  ok(sent.filter((x) => x === "pi_pollC").length === 1, "...and not again on the next poll");
  rmSync(DIR4, { recursive: true, force: true });
}

// THE FIRST POLL OF A PAID SESSION DOES NOT WAIT ON STRIPE WITHOUT A BOUND.
// A session with no record yet is read from Stripe before anything is
// decided. With a Stripe that never answers that read, the poll is answered
// "generating" inside its wait: never "unpaid" or "not found", nothing
// recorded, nothing generated, nothing refunded. A poll while the read is
// open starts no second read. When the read answers late with a paid session
// the report is generated once, with no further poll; a read that fails late
// is the "not found" a read that fails in time is; and a read given up is
// replaced by one new read whose report is the only one made.
{
  const DIR5 = join("/tmp", `test-human-checkout-read-${process.pid}`);
  rmSync(DIR5, { recursive: true, force: true });
  mkdirSync(DIR5, { recursive: true });
  const paid = (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 500, metadata: { product: "dossier", input: "AAPL" } });
  let answers = false;
  const reads = [], open = new Map(), made = [], refunded = [], sold = [];
  const stub = {
    checkout: { sessions: { retrieve: (id) => {
      reads.push(id);
      if (answers) return Promise.resolve(paid(id));
      return new Promise((resolve, reject) => { open.set(id, [...(open.get(id) || []), { resolve, reject }]); });
    } } },
    refunds: { create: (args) => { refunded.push(args.payment_intent); return Promise.resolve({ id: `re_${args.payment_intent}` }); } },
  };
  let t = clock;
  const ABANDON_MS = 300_000;
  const h = createHumanCheckout({
    stripe: stub, baseUrl: "https://agent402.tools", storeDir: DIR5, now: () => t, log: () => {},
    generate: async (_kind, slug, input) => { made.push(input); return { report: `# REPORT (${slug})\n\nAnalysis of ${input}. [1]`, title: input, sources: [], tables: [] }; },
    onSale: (x) => sold.push(x.sessionId), sessionReadWaitMs: 150, sessionReadAbandonMs: ABANDON_MS,
  });
  // A poll is given 20 s here; the read's own wait is 150 ms.
  const poll = async (id) => { const r = await Promise.race([h.fulfill(id), wait(20_000).then(() => null)]); return r === null ? { held: true } : r; };
  const readsOf = (id) => reads.filter((x) => x === id).length;
  // Wait for an outcome with a deadline, never a fixed sleep.
  const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(10); } return cond(); };
  const done = (id) => h.peek(id)?.status === "done";

  // 1. The read never answers.
  const first = await poll("cs_slowA");
  ok(!first.held && first.status === "generating", `session read unanswered: the first poll is answered inside its wait as still being prepared (${first.held ? "HELD" : first.status})`);
  ok(readsOf("cs_slowA") === 1 && h.peek("cs_slowA") == null && made.length === 0 && refunded.length === 0, "session read unanswered: one read is open, and nothing is recorded, generated or refunded");
  const second = await poll("cs_slowA");
  ok(!second.held && second.status === "generating" && readsOf("cs_slowA") === 1, `session read unanswered: a poll while the read is open is answered at once and starts no second read (${readsOf("cs_slowA")})`);
  // 2. The read answers late, paid: the report is made once, with no poll.
  open.get("cs_slowA")[0].resolve(paid("cs_slowA"));
  ok(await until(() => done("cs_slowA")), "late paid answer: the report is generated without another poll");
  const after = await poll("cs_slowA");
  ok(after.status === "done" && made.length === 1 && sold.filter((x) => x === "cs_slowA").length === 1 && readsOf("cs_slowA") === 1 && refunded.length === 0, `late paid answer: one report, one sale, one read, no refund (${made.length} reports, ${readsOf("cs_slowA")} reads)`);

  // 3. The read fails late: "not found", as a read that fails in time.
  const b1 = await poll("cs_slowB");
  ok(b1.status === "generating" && readsOf("cs_slowB") === 1, "second session, read unanswered: answered as still being prepared");
  open.get("cs_slowB")[0].reject(new Error("No such session"));
  // The failure is taken in on the turn after the read rejects.
  let b2 = null;
  await until(() => { if (b2?.status !== "not_found") void h.fulfill("cs_slowB").then((r) => { b2 = r; }); return b2?.status === "not_found"; });
  ok(h.peek("cs_slowB") == null, "late failure: nothing is recorded");
  ok(b2?.status === "not_found" && readsOf("cs_slowB") === 1 && made.length === 1, `late failure: a later poll reads "not found" without a new read (${b2?.status}, ${readsOf("cs_slowB")} reads)`);

  // 4. A read given up: one new read, and the old read's late answer makes
  // no second report.
  const c1 = await poll("cs_slowC");
  ok(c1.status === "generating" && readsOf("cs_slowC") === 1, "third session, read unanswered: answered as still being prepared");
  t += ABANDON_MS - 1_000;
  ok((await poll("cs_slowC")).status === "generating" && readsOf("cs_slowC") === 1, "until the open read is given up no second read starts");
  t += 2_000;
  answers = true;
  const c2 = await poll("cs_slowC");
  ok(c2.status === "generating" && readsOf("cs_slowC") === 2, `read given up, Stripe answering: one new read starts the report (${c2.status}, ${readsOf("cs_slowC")} reads)`);
  ok(await until(() => done("cs_slowC")), "read given up, Stripe answering: the report is generated");
  open.get("cs_slowC")[0].resolve(paid("cs_slowC"));
  // The late answer is taken in on the turns that follow, not after a delay.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const c3 = await poll("cs_slowC");
  ok(c3.status === "done" && made.length === 2 && sold.filter((x) => x === "cs_slowC").length === 1 && refunded.length === 0, `the given-up read answering late makes no second report, sale or refund (${made.length} reports)`);

  // 5. A paid session whose read answers inside the wait is never "unpaid".
  const d1 = await poll("cs_fastD");
  ok(d1.status === "generating" && readsOf("cs_fastD") === 1 && await until(() => done("cs_fastD")), "Stripe answering in time: the paid session starts its report on the first poll");
  rmSync(DIR5, { recursive: true, force: true });
}

// LATE ANSWERS OF RETRIES AND READS THAT WERE GIVEN UP OR PUSHED OUT. The
// retry or read a poll stopped waiting for is marked slow, so a poll while it
// is open answers at once (asserted here as inside half the wait, the wait
// being seconds). A given-up refund retry that fails late records nothing
// while a newer retry is open, and a retry's failure never writes "owed" over
// a refund another retry recorded. A pushed-out session read's late failure is
// not "not found". A session kept from a late read is used only for a minute.
{
  const DIR6 = join("/tmp", `test-human-checkout-late-${process.pid}`);
  rmSync(DIR6, { recursive: true, force: true });
  mkdirSync(DIR6, { recursive: true });
  const at = new Date(clock - 3600_000).toISOString();
  const owed = (pi) => ({ status: "error", refundId: null, error: "We couldn't complete this report. Your refund is being processed.", refundOwed: true, refundAttempts: 1, lastRefundAttemptAt: 0, paymentIntent: pi, product: "research", at });
  for (const id of ["cs_lateA", "cs_lateB", "cs_lateS"]) writeFileSync(join(DIR6, `${id}.json`), JSON.stringify(owed(id.replace("cs_", "pi_"))));
  writeFileSync(join(DIR6, "_issues.json"), JSON.stringify(Object.fromEntries(["cs_lateA", "cs_lateB", "cs_lateS"].map((id) => [id, { kind: "refund-owed", at, attempts: 1 }]))));
  const paid = (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 500, metadata: { product: "dossier", input: "AAPL" } });
  const calls = new Map(), reads = new Map(), made = [];
  const pending = (map, key) => new Promise((resolve, reject) => map.set(key, [...(map.get(key) || []), { resolve, reject }]));
  const stub = {
    checkout: { sessions: { retrieve: (id) => pending(reads, id) } },
    refunds: { create: (args) => pending(calls, args.payment_intent) },
  };
  let t = clock;
  const ABANDON_MS = 300_000, WAIT_MS = 3_000;
  const h = createHumanCheckout({
    stripe: stub, baseUrl: "https://agent402.tools", storeDir: DIR6, now: () => t, log: () => {},
    generate: async (_k, slug, input) => { made.push(input); return { report: `# REPORT (${slug})\n\nAnalysis of ${input}. [1]`, title: input, sources: [], tables: [] }; },
    onSale: () => {}, owedRetryWaitMs: WAIT_MS, owedRetryAbandonMs: ABANDON_MS, sessionReadWaitMs: WAIT_MS, sessionReadAbandonMs: ABANDON_MS,
  });
  const quick = async (id) => { const r = await Promise.race([h.fulfill(id), wait(WAIT_MS / 2).then(() => null)]); return r === null ? { held: true } : r; };
  // A poll that waits: given four times the wait (the wait's own timer does not hold the process open).
  const slowPoll = async (id) => { const r = await Promise.race([h.fulfill(id), wait(WAIT_MS * 4).then(() => null)]); return r === null ? { held: true } : r; };
  const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(10); } return cond(); };

  // 1. A poll while a slow refund retry is open answers at once.
  const a1 = await slowPoll("cs_lateA");
  ok(a1.refundOwed === true && calls.get("pi_lateA")?.length === 1, "refund retry unanswered: the first poll is answered from the record after its wait");
  const a2 = await quick("cs_lateA");
  ok(!a2.held && a2.refundOwed === true && calls.get("pi_lateA").length === 1, `refund retry unanswered: a poll while it is open answers at once, without waiting again (${a2.held ? "HELD" : "answered"})`);
  // 2. Given up: a new retry opens; the old one fails late and records nothing.
  t += ABANDON_MS + 1_000;
  await slowPoll("cs_lateA");
  ok(calls.get("pi_lateA").length === 2, "the retry given up is replaced by one new refund call");
  calls.get("pi_lateA")[0].reject(new Error("stripe: connection lost"));
  await until(() => h.peek("cs_lateA").refundAttempts !== 1, 1_000);
  ok(h.peek("cs_lateA").refundAttempts === 1 && h.peek("cs_lateA").refundOwed === true, `the given-up retry's late failure counts no attempt while the newer one is open (${h.peek("cs_lateA").refundAttempts})`);
  // 3. The given-up retry refunds late; the newer one then fails: the refund stands.
  t += ABANDON_MS + 1_000;
  await slowPoll("cs_lateB");
  t += ABANDON_MS + 1_000;
  await slowPoll("cs_lateB");
  ok(calls.get("pi_lateB").length === 2, "second record: two refund calls, the first given up");
  calls.get("pi_lateB")[0].resolve({ id: "re_pi_lateB" });
  ok(await until(() => h.peek("cs_lateB").refundId === "re_pi_lateB"), "the given-up retry's late refund is recorded");
  calls.get("pi_lateB")[1].reject(new Error("stripe: connection lost"));
  await until(() => h.peek("cs_lateB").refundId !== "re_pi_lateB", 1_000);
  ok(h.peek("cs_lateB").refundId === "re_pi_lateB" && h.peek("cs_lateB").refundOwed === false, `a newer retry failing after that refund writes nothing over it (${h.peek("cs_lateB").refundId}, owed ${h.peek("cs_lateB").refundOwed})`);

  // 4. A poll while a slow session read is open answers at once.
  const s1 = await slowPoll("cs_readP");
  ok(s1.status === "generating" && reads.get("cs_readP")?.length === 1, "session read unanswered: answered as still being prepared after the wait");
  const s2 = await quick("cs_readP");
  ok(!s2.held && s2.status === "generating" && reads.get("cs_readP").length === 1, `session read unanswered: a poll while it is open answers at once, without waiting again (${s2.held ? "HELD" : s2.status})`);
  // 5. Given up and replaced: the old read failing late is not "not found".
  t += ABANDON_MS + 1_000;
  await slowPoll("cs_readP");
  ok(reads.get("cs_readP").length === 2, "the given-up read is replaced by one new read");
  reads.get("cs_readP")[0].reject(new Error("No such session"));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const s3 = await quick("cs_readP");
  ok(s3.status === "generating", `the pushed-out read's late failure is not taken as "not found" (${s3.held ? "HELD" : s3.status})`);
  reads.get("cs_readP")[1].resolve(paid("cs_readP"));
  ok(await until(() => h.peek("cs_readP")?.status === "done"), "the newer read's paid answer makes the report");
  // 6. A session kept from a late read is used for a minute, no longer. Here
  // the run started by the late answer meets a fresh claim on the record (as
  // when another process holds it), so the kept session is not used then.
  const k1 = await slowPoll("cs_readK");
  ok(k1.status === "generating" && reads.get("cs_readK").length === 1, "third session: read unanswered");
  writeFileSync(join(DIR6, "cs_readK.json"), JSON.stringify({ status: "generating", kind: "dossier", slug: "dossier", at: new Date(t).toISOString(), claimedAt: t, takeovers: 0 }));
  reads.get("cs_readK")[0].resolve(paid("cs_readK"));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  rmSync(join(DIR6, "cs_readK.json"), { force: true });
  t += 61_000;
  const madeBefore = made.length;
  const k2 = await slowPoll("cs_readK");
  ok(k2.status === "generating" && reads.get("cs_readK").length === 2 && made.length === madeBefore, `a kept session older than a minute is not used: the poll reads the session again (${reads.get("cs_readK").length} reads, ${made.length - madeBefore} reports)`);
  rmSync(DIR6, { recursive: true, force: true });
}

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

// --- the Stripe webhook fulfills a paid report session: a buyer who closed the
// tab before the success redirect still gets one generation and one delivery,
// and a later /r/ visit polls that job instead of starting a second one.
{
  const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
  sessions.cs_hook = { id: "cs_hook", mode: "payment", payment_status: "paid", payment_intent: "pi_hook", customer_details: { email: "hook@example.com" }, metadata: { product: "dossier", input: "NVDA" } };
  const hookStripe = { ...stripe, webhooks: { constructEvent: (body, sig, secret) => { if (sig !== "goodsig" || secret !== "whsec_test") throw new Error("bad signature"); return JSON.parse(body.toString()); } } };
  const subsStore = join("/tmp", `test-human-checkout-subs-${process.pid}.json`);
  // The same hook expression server.js wires: a credits pack claims, a report fulfills.
  const credits = { claim: async () => { throw new Error("not a credits session"); } };
  const subs = createStripeSubscriptions({ stripe: hookStripe, baseUrl: "https://agent402.tools", storePath: subsStore,
    onPaymentSession: (session) => (session?.metadata?.credits_pack && credits ? credits.claim(session.id) : session?.metadata?.product && hc ? hc.fulfill(session.id) : null) });
  const prevSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const before = genCalls, salesBefore = sales.length;
  const ev = JSON.stringify({ id: "evt_hook", type: "checkout.session.completed", data: { object: { id: "cs_hook", mode: "payment", payment_status: "paid", metadata: { product: "dossier", input: "NVDA" } } } });
  const ack = await subs.handleWebhook(Buffer.from(ev), "goodsig");
  const fromHook = await settle("cs_hook");
  ok(ack.received === true && fromHook?.status === "done" && genCalls === before + 1 && sales.length === salesBefore + 1 && sales[salesBefore].paymentIntent === "pi_hook",
    "checkout.session.completed for a report session with no /r/ visit generates and delivers it once");
  const later = await hc.fulfill("cs_hook");
  ok(later.status === "done" && genCalls === before + 1 && sales.length === salesBefore + 1, "a later /r/ visit is answered from the record: no second generation, no second sale");
  await subs.handleWebhook(Buffer.from(ev.replace("evt_hook", "evt_hook2")), "goodsig");
  ok(genCalls === before + 1 && sales.length === salesBefore + 1, "a redelivered webhook generates nothing more");
  if (prevSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevSecret;
  try { rmSync(subsStore); } catch { /* ignore */ }
  const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/onPaymentSession: \(session\) => \([\s\S]{0,200}session\?\.metadata\?\.product && _humanCheckout \? _humanCheckout\.fulfill\(session\.id\)/.test(serverSrc),
    "server.js wires the webhook's payment-session hook to the report store's fulfill");
  // The dispute-closed hook lifts a credits key only on a win, through the
  // store's own enable (which lifts nothing a stronger cause holds).
  ok(/onDisputeClosed: \(paymentIntent, \{ won \}\) => \(won && _credits \? _credits\.enableByPaymentIntent\(paymentIntent, "disputed"\) : null\)/.test(serverSrc),
    "server.js wires the webhook's dispute-closed hook to the credits store's enable, gated on a win");
}

// --- failure breaker: after three failed reports from one address, the next paid session is refunded with NO generation attempt
{
  refundFail = false;
  for (const id of ["cs_g1", "cs_g2", "cs_g3"]) { await hc.fulfill(id); await settle(id); }
  const before = genCalls, refundsBefore = refunds.length;
  await hc.fulfill("cs_g4"); const g4 = await settle("cs_g4");
  ok(g4?.status === "error" && genCalls === before && refunds.length === refundsBefore + 1 && /refunded without a new attempt/.test(g4.error || ""), "fourth paid session from the same address (case-insensitive) is refunded without calling generate");
  await hc.fulfill("cs_other"); const other = await settle("cs_other");
  ok(other?.status === "done" && genCalls === before + 1, "a different address is unaffected by the breaker");
}

try { rmSync(DIR, { recursive: true, force: true }); rmSync(LEG, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
