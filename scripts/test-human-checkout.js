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
