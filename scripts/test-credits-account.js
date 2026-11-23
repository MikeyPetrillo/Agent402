// Prepaid credits for people (src/credits.js, src/credits-account.js): top-ups
// to the same balance within the cap, a refund on request split over the
// payments that loaded a balance, the balance page's email sign-in and
// session, history by tool with a CSV export, a new key for a lost one, our
// own receipt and low-balance emails, and every route of the page absent while
// sales are off. Offline: file backend, a stubbed Stripe, mail captured (the
// real sender runs once with fetch replaced, so nothing leaves the process).
process.env.EMAIL_FROM = "credits@agent402.tools";
process.env.ZEPTOMAIL_TOKEN = "zepto-test-token";
process.env.RESEND_API_KEY = "";
process.env.COMPANY_POSTAL_ADDRESS = "PO Box 1, Test Town, NC 00000";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { looseCreditsChecks } from "./lib/credits-loose-checks.js"; // wide purchase checks (see the file)
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const DIR = mkdtempSync(join(tmpdir(), "credits-account-"));
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }));
process.env.EMAIL_STATUS_FILE = join(DIR, "email-status.json");
delete process.env.CREDITS_SALES;
delete process.env.CREDITS_BALANCE_MAX_USD;
looseCreditsChecks();

const { createCredits, hashKey, CREDIT_PACKS, LOW_BALANCE_MICRO } = await import("../src/credits.js");
const { createCreditsAccount, mountCreditsAccount, accountSecretFrom, historyCsv, SIGN_IN_ANSWER, SIGN_IN_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, ACCOUNT_COOKIE, NEW_KEY_FRESH_SIGN_IN_MS, buildLowBalanceEmail } = await import("../src/credits-account.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { createLimiter } = await import("../src/rate-limit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const on = () => { process.env.CREDITS_SALES = "on"; };
const offSales = () => { delete process.env.CREDITS_SALES; };

// ---- Stripe stub ------------------------------------------------------------
let clock = Date.parse("2026-11-18T12:00:00Z");
const sessions = {}, charges = {}, made = {}, byIdem = {}, creates = [];
let seq = 0, refundStatus = "succeeded";
const paid = (id, pack, pi, email, meta = {}) => {
  sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: pi, customer_details: { email }, metadata: { credits_pack: pack, ...meta } };
  charges[pi] = { amount: CREDIT_PACKS[pack].cents, amount_refunded: 0 };
};
const stripe = {
  checkout: { sessions: {
    create: async (a) => { creates.push(a); const id = `cs_new${creates.length}`; return { id, url: `https://checkout.stripe.com/c/${id}` }; },
    retrieve: async (id) => { if (!sessions[id]) throw new Error("no"); return sessions[id]; },
  } },
  paymentIntents: { retrieve: async (pi) => { const c = charges[pi]; return { id: pi, latest_charge: c ? { amount: c.amount, amount_refunded: c.amount_refunded, payment_method_details: { card: { fingerprint: `fp_${pi}` } } } : null }; } },
  refunds: {
    create: async (a, opts = {}) => {
      if (opts.idempotencyKey && byIdem[opts.idempotencyKey]) return { ...made[byIdem[opts.idempotencyKey]] };
      const c = charges[a.payment_intent];
      const amt = a.amount ?? (c.amount - c.amount_refunded);
      if (c.amount_refunded + amt > c.amount) throw new Error("amount exceeds charge");
      const r = { id: `re_${++seq}`, amount: amt, status: refundStatus, payment_intent: a.payment_intent, metadata: a.metadata || {} };
      made[r.id] = r; if (opts.idempotencyKey) byIdem[opts.idempotencyKey] = r.id;
      if (r.status !== "failed" && r.status !== "canceled") c.amount_refunded += amt;
      return { ...r };
    },
    retrieve: async (id) => ({ ...made[id] }),
    list: async ({ payment_intent }) => ({ data: Object.values(made).filter((r) => r.payment_intent === payment_intent).map((r) => ({ ...r })) }),
  },
};
const lows = [], receipts = [], newKeys = [];
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock,
  onLowBalance: (n) => lows.push(n), onReceipt: (r) => receipts.push(r), onNewKey: (n) => newKeys.push(n) });
const recOf = (key) => JSON.parse(readFileSync(join(DIR, `k_${hashKey(key)}.json`), "utf8"));
const spend = (key, usd, slug = "whois") => { const a = cr.authorize(key, usd); if (!a.ok) throw new Error(`authorize ${a.reason}`); return cr.settle(a.hash, a.heldMicro, slug); };

// ---- (1) top-ups -------------------------------------------------------------
on();
paid("cs_t1", "credits-20", "pi_t1", "Buyer@X.com");
const T = await cr.claim("cs_t1");
ok(T.status === "minted" && T.balanceUsd === 20, "a $20 purchase mints a key");
ok(receipts.length === 1 && receipts[0].kind === "purchase" && receipts[0].amountUsd === 20 && receipts[0].email === "Buyer@X.com", "the purchase sends our own receipt");
spend(T.key, 1.5, "whois");
spend(T.key, 0.5, "dns-lookup");
// Before payment: a top-up the cap has no room for is refused with the room left.
let err = null;
creates.length = 0;
try { await cr.createTopupCheckout(T.keyId, "buyer@x.com", "credits-100"); } catch (e) { err = e; }
ok(err?.statusCode === 400 && err.roomUsd === 82 && err.capUsd === 100 && /room for \$82\.00 more/.test(err.message) && creates.length === 0, `an over-cap top-up is refused before any checkout, with the room left ("${String(err?.message).slice(0, 90)}")`);
err = null;
try { await cr.createTopupCheckout(T.keyId, "other@x.com", "credits-20"); } catch (e) { err = e; }
ok(err?.statusCode === 404 && creates.length === 0, "a top-up for a balance another email bought is refused");
const co = await cr.createTopupCheckout(T.keyId, "buyer@x.com", "credits-50");
const made50 = creates.at(-1);
ok(co.url && made50.metadata.credits_topup === T.keyId && made50.metadata.credits_account === "buyer@x.com" && made50.customer_email === "Buyer@X.com" && made50.line_items[0].price_data.unit_amount === 5000 && /\/credits\/account\?topup=/.test(made50.success_url), "a top-up checkout names the balance, the signed-in email and the pack, and returns to the balance page");
ok(!/a402_/.test(JSON.stringify(made50)), "the checkout carries no key");
paid("cs_t2", "credits-50", "pi_t2", "buyer@x.com", { credits_topup: T.keyId, credits_account: "buyer@x.com" });
const t2 = await cr.claim("cs_t2");
ok(t2.status === "topped_up" && t2.addedUsd === 50 && t2.balanceUsd === 68 && t2.keyId === T.keyId && !t2.key, "a paid top-up adds to the same balance and shows no key");
ok(cr.balance(T.key).balanceUsd === 68 && cr.balance(T.key).loadedUsd === 70, "the same key now holds $68 of $70 loaded");
ok((await cr.claim("cs_t2")).status === "topped_up" && cr.balance(T.key).balanceUsd === 68, "a second claim of the top-up adds nothing");
ok(receipts.length === 2 && receipts[1].kind === "topup" && receipts[1].amountUsd === 50 && receipts[1].balanceUsd === 68, "the top-up sends our own receipt");
// The cap checked again when the payment lands: a second top-up paid meanwhile is refunded in full.
paid("cs_t3", "credits-50", "pi_t3", "buyer@x.com", { credits_topup: T.keyId, credits_account: "buyer@x.com" });
const t3 = await cr.claim("cs_t3");
ok(t3.status === "over_balance_cap" && t3.refunded === true && cr.balance(T.key).balanceUsd === 68 && charges.pi_t3.amount_refunded === 5000, "a paid top-up that no longer fits under the cap is refunded in full and adds nothing");
paid("cs_t4", "credits-20", "pi_t4", "buyer@x.com", { credits_topup: T.keyId, credits_account: "someone@else.com" });
const t4 = await cr.claim("cs_t4");
ok(t4.status === "topup_refused" && t4.refunded === true && charges.pi_t4.amount_refunded === 2000 && cr.balance(T.key).balanceUsd === 68, "a top-up naming a balance the account does not hold is refunded and adds nothing");
// The daily limit counts each payment on its own day.
process.env.CREDITS_DAILY_MAX_USD = "80";
paid("cs_t5", "credits-20", "pi_t5", "buyer@x.com", { credits_topup: T.keyId, credits_account: "buyer@x.com" });
ok((await cr.claim("cs_t5")).status === "over_limit" && charges.pi_t5.amount_refunded === 2000, "a top-up past the daily purchase limit (purchase + top-up today) is refunded");
clock += 86_400_001;
paid("cs_t6", "credits-20", "pi_t6", "buyer@x.com", { credits_topup: T.keyId, credits_account: "buyer@x.com" });
const t6 = await cr.claim("cs_t6");
ok(t6.status === "topped_up" && t6.balanceUsd === 88, "a day later the same top-up lands");
looseCreditsChecks();

// ---- (2) history by tool ------------------------------------------------------
const hist = await cr.historyFor(T.keyId, "BUYER@x.com");
ok(hist && hist.byTool.map((t) => `${t.tool}:${t.calls}:${t.spentUsd}`).join() === "whois:1:1.5,dns-lookup:1:0.5", `history totals by tool (${hist?.byTool.map((t) => t.tool).join()})`);
ok(hist.rows.map((r) => r.type).join() === "topup,topup,charge,charge,purchase", `history lists top-ups, charges and the purchase, newest first (${hist.rows.map((r) => r.type).join()})`);
ok((await cr.historyFor(T.keyId, "other@x.com")) === null, "another email cannot read the history");
const csv = historyCsv({ rows: [...hist.rows, { at: "2026-11-18T00:00:00.000Z", type: "charge", tool: "=HYPERLINK(\"x\")", amountUsd: 0.001 }], holds: [] });
ok(csv.startsWith("date,type,tool,amount_usd\n") && csv.includes(",charge,whois,1.500000") && csv.includes(`"'=HYPERLINK(""x"")"`), "the CSV has a header, one row per entry, and a cell a spreadsheet would run is quoted");
const listed = await cr.balancesForEmail(" buyer@X.COM ");
ok(listed.length === 1 && listed[0].keyId === T.keyId && listed[0].roomUsd === 12 && !JSON.stringify(listed).includes("a402_") && !JSON.stringify(listed).includes(hashKey(T.key)), "the email's balances are listed by key id with the room left, never the key or its hash");

// ---- (3) refund on request across payments --------------------------------------
const rr0 = await cr.requestRefundFor(T.keyId, "buyer@x.com");
ok(rr0.status === "refunded" && rr0.refundedUsd === 88, `the unspent balance is refunded without the key ($${rr0.refundedUsd})`);
const parts = recOf(T.key).refundRequest.parts;
ok(parts.map((p) => `${p.pi}:${p.cents}`).join() === "pi_t6:2000,pi_t2:5000,pi_t1:1800" && parts.every((p) => p.state === "done"), `newest payment first, never more than a payment has left (${parts.map((p) => `${p.pi}:${p.cents}`).join()})`);
ok(charges.pi_t6.amount_refunded === 2000 && charges.pi_t2.amount_refunded === 5000 && charges.pi_t1.amount_refunded === 1800, "each charge shows exactly its part");
ok(cr.balance(T.key).disabled && cr.balance(T.key).balanceUsd === 0, "the balance is closed");
err = null;
try { await cr.createTopupCheckout(T.keyId, "buyer@x.com", "credits-20"); } catch (e) { err = e; }
ok(err?.statusCode === 400 && /closed/.test(err.message), "a refunded balance cannot be topped up");
// A part that fails is owed; the others stay done; asking again sends that part alone.
paid("cs_u1", "credits-20", "pi_u1", "u@x.com");
const U = await cr.claim("cs_u1");
paid("cs_u2", "credits-20", "pi_u2", "u@x.com", { credits_topup: U.keyId, credits_account: "u@x.com" });
await cr.claim("cs_u2");
const createsBefore = seq;
refundStatus = "failed";
const u1 = await cr.requestRefund(U.key);
ok(u1.status === "pending" && recOf(U.key).refundRequest.state === "failed" && (await cr.refundRequestsOwed()).includes(U.keyId), "a refund Stripe fails leaves the request owed");
refundStatus = "succeeded";
const u2 = await cr.requestRefund(U.key);
ok(u2.status === "refunded" && charges.pi_u1.amount_refunded === 2000 && charges.pi_u2.amount_refunded === 2000 && seq === createsBefore + 4 && !(await cr.refundRequestsOwed()).includes(U.keyId), "asking again sends each failed part anew, once, and the request is done");
// A refund made by hand of one top-up takes it off the balance and keeps the key working.
paid("cs_v1", "credits-20", "pi_v1", "v@x.com");
const V = await cr.claim("cs_v1");
paid("cs_v2", "credits-20", "pi_v2", "v@x.com", { credits_topup: V.keyId, credits_account: "v@x.com" });
await cr.claim("cs_v2");
cr.disableByPaymentIntent("pi_v2", "refunded", { amountRefundedCents: 2000, fullyRefunded: true });
ok(cr.balance(V.key).balanceUsd === 20 && !cr.balance(V.key).disabled, "a top-up refunded in full in Stripe takes its amount off and the key keeps working");
cr.disableByPaymentIntent("pi_v1", "refunded", { amountRefundedCents: 2000, fullyRefunded: true });
ok(cr.balance(V.key).balanceUsd === 0 && cr.balance(V.key).disabled, "once every payment is refunded in full the key is disabled");

// ---- (4) low-balance notice --------------------------------------------------------
paid("cs_l1", "credits-20", "pi_l1", "l@x.com");
const L = await cr.claim("cs_l1");
spend(L.key, 17, "research");
ok(lows.length === 0, "no notice while the balance stays at or above $2.00");
spend(L.key, 1.5);
ok(lows.length === 1 && lows[0].keyId === L.keyId && lows[0].email === "l@x.com" && lows[0].balanceUsd === 1.5, "a charge that crosses under $2.00 sends one notice");
spend(L.key, 0.5);
ok(lows.length === 1, "...and only once for that crossing");
paid("cs_l2", "credits-20", "pi_l2", "l@x.com", { credits_topup: L.keyId, credits_account: "l@x.com" });
await cr.claim("cs_l2");
spend(L.key, 19.5);
ok(lows.length === 2, "a top-up re-arms it: the next crossing sends again");
await cr.setLowNotice(L.keyId, false);
paid("cs_l3", "credits-20", "pi_l3", "l@x.com", { credits_topup: L.keyId, credits_account: "l@x.com" });
await cr.claim("cs_l3");
spend(L.key, 19.5);
ok(lows.length === 2, "a balance with the notice turned off gets none");
offSales();
paid("cs_l4", "credits-20", "pi_l4", "l4@x.com");
const L4 = await cr.claim("cs_l4");
spend(L4.key, 19);
ok(lows.length === 2 && receipts.length === receipts.filter((r) => r.email !== "l4@x.com").length, "with sales off no notice and no receipt is sent");
ok(LOW_BALANCE_MICRO === 2_000_000, "the notice threshold is $2.00");
on();

// ---- (5) a new key for a lost one ---------------------------------------------------
paid("cs_k1", "credits-20", "pi_k1", "k@x.com");
const K = await cr.claim("cs_k1");
spend(K.key, 1, "whois");
const held = cr.authorize(K.key, 1);
ok((await cr.issueNewKey(K.keyId, "k@x.com")).status === "in_flight", "a balance with a call in flight keeps its key");
cr.release(held.hash, held.heldMicro);
ok((await cr.issueNewKey(K.keyId, "not@x.com")).status === "unknown", "another email cannot issue a key for it");
const nk = await cr.issueNewKey(K.keyId, "K@x.com");
ok(nk.status === "issued" && /^a402_/.test(nk.key) && nk.key !== K.key && nk.keyId === K.keyId && nk.balanceUsd === 19, "a new key is issued for the same balance");
ok(cr.authorize(K.key, 0.001).reason === "unknown", "the old key stops working at once");
const a2 = cr.authorize(nk.key, 0.5); cr.settle(a2.hash, a2.heldMicro, "whois");
ok(cr.balance(nk.key).balanceUsd === 18.5 && (await cr.historyFor(K.keyId, "k@x.com")).rows.some((r) => r.type === "key"), "the new key spends the same balance and the history keeps the change");
ok(readdirSync(DIR).filter((f) => f === `k_${hashKey(K.key)}.json`).length === 0, "the old key's record is gone from the store");
ok((await cr.claim("cs_k1")).status === "claimed" && (await cr.claim("cs_k1")).keyId === K.keyId, "the purchase's thanks page still finds the balance");
ok(newKeys.length === 1 && newKeys[0].email === "k@x.com", "the email on the balance is told a new key was issued");

// ---- (5b) the balance page reads one record, not every key file ----------------------
{
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  paid("cs_idx", "credits-20", "pi_idx", "idx@x.com");
  const KI = await cr.claim("cs_idx");
  ok((await cr.balancesForEmail("IDX@x.com")).map((b) => b.keyId).join() === KI.keyId && (await cr.historyFor(KI.keyId, "idx@x.com"))?.keyId === KI.keyId, "file store: a balance bought after the lookup index was built is found by email and by key id");
  // Count the store's directory walks and file reads during the lookups.
  const real = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
  let walks = 0, reads = 0;
  fs.readdirSync = (...a) => { walks++; return real.readdirSync(...a); };
  fs.readFileSync = (...a) => { reads++; return real.readFileSync(...a); };
  syncBuiltinESMExports();
  let found;
  try {
    found = [await cr.balancesForEmail("idx@x.com"), await cr.historyFor(KI.keyId, "idx@x.com"), await cr.setLowNotice(KI.keyId, true), await cr.balancesForEmail("nobody@x.com")];
  } finally { Object.assign(fs, real); syncBuiltinESMExports(); }
  ok(found[0].length === 1 && found[1] && found[2] === true && found[3].length === 0 && walks === 0 && reads <= 1, `file store: the sign-in, history and top-up lookups walk no directory and read no other key's file (${walks} walks, ${reads} reads)`);
}

// ---- (6) sign-in, sessions -----------------------------------------------------------
const mail = [];
const store = createJsonDocument({ name: "credits-account-test", file: join(DIR, "_account.json"), log: () => {} });
const acct = createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async (m) => { mail.push(m); return true; }, store,
  ipLimiter: createLimiter("t-ip", { perMin: 1000, perHour: 1000 }), emailLimiter: createLimiter("t-email", { perMin: 2, perHour: 6 }), now: () => clock, log: () => {} });
const known = acct.requestSignIn("K@x.com", "1.1.1.1"), unknown = acct.requestSignIn("nobody@x.com", "1.1.1.1");
ok(known.status === 200 && unknown.status === 200 && known.message === unknown.message && known.message === SIGN_IN_ANSWER, "a known and an unknown address get the same answer");
await known.work; await unknown.work;
ok(mail.length === 2 && mail.map((m) => m.to).sort().join() === "k@x.com,nobody@x.com" && mail.every((m) => /\/credits\/account\/verify\?t=/.test(m.text)), "every address is sent a link, so a new buyer signs in before a first purchase");
{ const k = mail.find((m) => m.to === "k@x.com"); mail.length = 0; mail.push(k); }
ok(!/a402_/.test(mail[0].text + mail[0].html), "the sign-in email carries no key");
ok(acct.requestSignIn("not-an-email", "1.1.1.1").status === 400, "a malformed address is refused");
acct.requestSignIn("k@x.com", "1.1.1.1");
ok(acct.requestSignIn("k@x.com", "2.2.2.2").status === 429 && acct.requestSignIn("nobody@x.com", "2.2.2.2").status === 200, "requests are limited per address (from any client address)");
// The limit counts a mailbox, not a spelling: "+tag" and Gmail's dots and
// googlemail.com reach one inbox, so they share it; mail goes as typed.
{
  const { mailboxKey } = await import("../src/mailbox-key.js");
  ok(mailboxKey(" V.Ictim+news@GoogleMail.com ") === "victim@gmail.com" && mailboxKey("a.b+c@example.com") === "a.b@example.com" && mailboxKey("plain@x.com") === "plain@x.com" && mailboxKey("+only@x.com") === "+only@x.com", "the mailbox key folds +tags, and Gmail's dots and domain");
  const sentTo = [];
  const mb = createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async (m) => { sentTo.push(m.to); return true; }, store, ipLimiter: createLimiter(`t-mb-ip-${Math.random()}`, { perMin: 1000, perHour: 1000 }), emailLimiter: createLimiter(`t-mb-e-${Math.random()}`, { perMin: 2, perHour: 6 }), now: () => clock, log: () => {} });
  const codes = ["victim@gmail.com", "victim+1@gmail.com", "v.ictim@gmail.com", "victim+2@googlemail.com"].map((e, i) => mb.requestSignIn(e, `5.5.5.${i + 1}`).status);
  ok(codes[0] === 200 && codes[1] === 200 && codes[2] === 429 && codes[3] === 429, `spellings of one mailbox share its limit (${codes.join(",")})`);
}
const ipAcct = createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async () => true, store, ipLimiter: createLimiter("t-ip2", { perMin: 2, perHour: 40 }), emailLimiter: createLimiter("t-email2", { perMin: 100, perHour: 100 }), now: () => clock, log: () => {} });
ipAcct.requestSignIn("a1@x.com", "3.3.3.3"); ipAcct.requestSignIn("a2@x.com", "3.3.3.3");
ok(ipAcct.requestSignIn("a3@x.com", "3.3.3.3").status === 429, "...and per client address");
// The sign-in email draws on hourly send budgets from the private table, one
// for the whole service and one per client network (an IPv6 /64): past either
// the answer is the same and no mail is sent.
{
  const { useGuardsTable, guardsTable } = await import("./lib/credits-guards-table.js");
  const { createMemoryLimits } = await import("../src/shared-limits.js");
  const keep = guardsTable();
  const sentTo = [];
  const mk = () => createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async (m) => { sentTo.push(m.to); return true; }, store, limits: createMemoryLimits(), now: () => clock, log: () => {} });
  try {
    useGuardsTable({ ...keep, account: { ...keep.account, sendsGlobalPerHour: 2 } });
    const g = mk();
    const rs = [];
    for (let i = 0; i < 3; i++) { const r = g.requestSignIn(`spray${i}@x.com`, `10.0.${i}.1`); rs.push(r); await r.work; }
    ok(rs.every((r) => r.status === 200 && r.message === SIGN_IN_ANSWER) && sentTo.length === 2, `past the service-wide hourly send budget the answer is the same and no mail is sent (${sentTo.length} sent)`);
    sentTo.length = 0;
    useGuardsTable({ ...keep, account: { ...keep.account, sendsPerNetHour: 1 } });
    const n = mk();
    const rn = [];
    for (const [e, ip] of [["n1@x.com", "2001:db8:1:2::1"], ["n2@x.com", "2001:db8:1:2::99"], ["n3@x.com", "2001:db8:1:3::1"]]) { const r = n.requestSignIn(e, ip); rn.push(r); await r.work; }
    ok(rn.every((r) => r.status === 200 && r.message === SIGN_IN_ANSWER) && sentTo.join() === "n1@x.com,n3@x.com", `past one /64's hourly send budget the answer is the same and no mail is sent; another /64 has its own (${sentTo.join()})`);
  } finally { useGuardsTable(keep); }
}
const token = new URL(mail[0].text.match(/https:\/\/\S+/)[0]).searchParams.get("t");
const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
ok((await acct.redeem(tampered)) === null, "a tampered token signs nobody in");
const s1 = await acct.redeem(token);
ok(s1 && s1.email === "k@x.com" && (await acct.sessionEmail(s1.sid)) === "k@x.com", "the link signs the purchase email in");
ok((await acct.redeem(token)) === null, "the link works once");
const late = acct.signInToken("k@x.com", clock - SIGN_IN_TTL_MS - 1);
ok((await acct.redeem(late)) === null, "an expired link signs nobody in");
const stored = readFileSync(join(DIR, "_account.json"), "utf8");
ok(!stored.includes(s1.sid), "the server keeps a hash of the session id, never the id");
clock += SESSION_IDLE_MS - 1000;
ok((await acct.sessionEmail(s1.sid)) === "k@x.com", "use inside the idle window keeps the session");
clock += SESSION_IDLE_MS - 1000;
ok((await acct.sessionEmail(s1.sid)) === "k@x.com", "...and moves the idle deadline");
clock += SESSION_IDLE_MS + 1;
ok((await acct.sessionEmail(s1.sid)) === null, "a session unused for 30 minutes ends");
const s2 = await acct.redeem(acct.signInToken("k@x.com"));
for (let t = 0; t < SESSION_MAX_MS; t += SESSION_IDLE_MS / 2) { clock += SESSION_IDLE_MS / 2; await acct.sessionEmail(s2.sid); }
ok((await acct.sessionEmail(s2.sid)) === null, "a session ends after 12 hours however it is used");
const s3 = await acct.redeem(acct.signInToken("k@x.com"));
await acct.signOut(s3.sid);
ok((await acct.sessionEmail(s3.sid)) === null, "signing out ends the session");

// ---- (6b) retention: ended sessions and expired link records are deleted -------------
{
  const RET = join(DIR, "_account-retention.json");
  const retStore = createJsonDocument({ name: "credits-account-retention", file: RET, log: () => {} });
  const mk = (extra = {}) => createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail: async () => true, store: retStore,
    ipLimiter: createLimiter(`t-ret-ip-${Math.random()}`, { perMin: 1000, perHour: 1000 }), emailLimiter: createLimiter(`t-ret-e-${Math.random()}`, { perMin: 1000, perHour: 1000 }), now: () => clock, log: () => {}, sweepEveryMs: 0, ...extra });
  const ra = mk();
  const doc = () => { try { return JSON.parse(readFileSync(RET, "utf8")); } catch { return {}; } };
  const counts = () => { const d = doc(); return `${Object.keys(d.sessions || {}).length}/${Object.keys(d.used || {}).length}`; };
  // Two sessions that end (idle), their two used links past expiry; then a fresh session.
  const ended = async () => { await ra.redeem(ra.signInToken("k@x.com")); await ra.redeem(ra.signInToken("k@x.com")); clock += Math.max(SESSION_IDLE_MS, SIGN_IN_TTL_MS) + 1; };
  await ended();
  const fresh = await ra.redeem(ra.signInToken("k@x.com"));
  ok(counts() === "1/1", `redeeming a link deletes the ended sessions and expired link records (${counts()})`);
  await ended();
  ok(counts() === "2/2" || counts() === "3/3", `two more sessions end (${counts()})`);
  ok((await ra.sessionEmail(fresh.sid)) === null && counts() === "0/0", `a session read deletes every ended session and expired link record, not only its own (${counts()})`);
  await ra.redeem(ra.signInToken("k@x.com"));
  await ra.redeem(ra.signInToken("k@x.com"));
  const keep = await ra.redeem(ra.signInToken("k@x.com"));
  clock += Math.max(SESSION_IDLE_MS, SIGN_IN_TTL_MS) + 1;
  await ra.signOut(keep.sid);
  ok(counts() === "0/0", `signing out deletes its own session and every ended one (${counts()})`);
  const k2 = await ra.redeem(ra.signInToken("k@x.com"));
  clock += SESSION_MAX_MS + 1;
  const r = ra.requestSignIn("nobody@x.com", "9.9.9.9");
  await r.work;
  ok(counts() === "0/0" && (await ra.sessionEmail(k2.sid)) === null, `a sign-in request deletes ended sessions and expired link records after its answer (${counts()})`);
  await ended();
  ok((await ra.sweep()) === 4 && counts() === "0/0", `the sweep deletes them with no request at all (${counts()})`);
  // The timer: an account built with a sweep interval deletes them on its own, and the timer never holds the process open.
  await ended();
  const timed = mk({ sweepEveryMs: 40 });
  await new Promise((res) => setTimeout(res, 200));
  timed.stopSweep();
  ok(counts() === "0/0", `the periodic sweep deletes ended sessions and expired link records unprompted (${counts()})`);
}

// ---- (7) the routes -------------------------------------------------------------------
const app = express();
app.use(express.json());
const pageOf = (name) => (...a) => `<html>${name}:${a.join("|")}</html>`;
mountCreditsAccount(app, { express, account: acct, credits: cr, baseUrl: "https://agent402.tools", salesOn: () => /^on$/.test(process.env.CREDITS_SALES || ""), clientIp: (req) => req.ip,
  page: { account: pageOf("account"), verify: pageOf("verify"), notice: pageOf("notice"), noticeOff: pageOf("noticeOff") }, writeLimiter: createLimiter("t-w", { perMin: 1000, perHour: 1000 }),
  packs: () => Object.entries(CREDIT_PACKS).map(([id, p]) => ({ id, usd: p.cents / 100 })), capUsd: () => 100 });
app.use((_req, res) => res.status(404).send("absent"));
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const B = `http://127.0.0.1:${server.address().port}`;
const SAME = { "sec-fetch-site": "same-origin" };
const req = (path, { method = "GET", body, headers = {}, form = false } = {}) => fetch(`${B}${path}`, { method, redirect: "manual", headers: { ...(body !== undefined ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}), ...headers }, body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) });

const ROUTES = [["GET", "/credits/account"], ["GET", "/credits/account/app.js"], ["POST", "/credits/account/sign-in"], ["GET", "/credits/account/verify?t=x"], ["POST", "/credits/account/verify"], ["POST", "/credits/account/sign-out"], ["GET", "/credits/account/session.json"], ["GET", "/credits/account/history.json?key=abc"], ["GET", "/credits/account/history.csv?key=abc"], ["POST", "/credits/account/top-up"], ["POST", "/credits/account/refund"], ["POST", "/credits/account/new-key"], ["POST", "/credits/account/low-notice"], ["GET", "/credits/low-balance/off?key=a&k=b"], ["POST", "/credits/low-balance/off"]];
offSales();
const offAnswers = await Promise.all(ROUTES.map(async ([m, p]) => { const r = await req(p, { method: m, body: m === "POST" ? {} : undefined, headers: SAME }); return `${r.status}:${await r.text()}`; }));
ok(offAnswers.every((a) => a === "404:absent"), `with sales off every route of the page falls through as absent (${ROUTES.length} routes)`);
on();
ok((await req("/credits/account")).status === 200 && (await (await req("/credits/account/app.js")).text()).includes("credits/account"), "with sales on the page and its script are served");
ok((await req("/credits/account/sign-in", { method: "POST", body: { email: "k@x.com" } })).status === 403, "a sign-in request from another site is refused");
const signInR = await req("/credits/account/sign-in", { method: "POST", body: { email: "fresh@x.com" }, headers: { origin: "https://agent402.tools" } });
ok(signInR.status === 200 && (await signInR.json()).message === SIGN_IN_ANSWER, "a sign-in request from our own page is answered");
const tok = acct.signInToken("k@x.com");
const vGet = await req(`/credits/account/verify?t=${encodeURIComponent(tok)}`);
ok(vGet.status === 200 && (await vGet.text()).startsWith("<html>verify:") && !vGet.headers.get("set-cookie") && vGet.headers.get("referrer-policy") === "no-referrer", "opening the link shows a button and signs nobody in (a mail scanner's fetch spends nothing)");
ok((await req("/credits/account/verify", { method: "POST", body: { t: tok }, form: true })).status === 403, "the button's POST must come from our own page");
const vPost = await req("/credits/account/verify", { method: "POST", body: { t: tok }, form: true, headers: SAME });
const setCookie = vPost.headers.get("set-cookie") || "";
ok(vPost.status === 303 && vPost.headers.get("location") === "/credits/account", "pressing it signs in and returns to the balance page");
ok(new RegExp(`^${ACCOUNT_COOKIE}=[A-Za-z0-9_-]{43}; Path=/credits/account; HttpOnly; SameSite=Strict; Max-Age=\\d+; Secure$`).test(setCookie), `the session cookie is scoped, HttpOnly, SameSite=Strict and Secure (${setCookie.replace(/=[A-Za-z0-9_-]{43}/, "=<sid>")})`);
const C = { cookie: setCookie.split(";")[0] };
ok((await req("/credits/account/verify", { method: "POST", body: { t: tok }, form: true, headers: SAME })).status === 400, "the same link cannot sign in twice");
const sess = await (await req("/credits/account/session.json", { headers: C })).json();
ok(sess.email === "k@x.com" && sess.balances.length === 1 && sess.balances[0].keyId === K.keyId && sess.capUsd === 100, "the session lists the balances bought with that email");
ok((await req("/credits/account/session.json")).status === 401, "without the cookie the page reads nothing");
const csvR = await req(`/credits/account/history.csv?key=${K.keyId}`, { headers: C });
ok(csvR.status === 200 && /text\/csv/.test(csvR.headers.get("content-type")) && /attachment; filename="agent402-credits-[0-9a-f]{12}\.csv"/.test(csvR.headers.get("content-disposition")) && (await csvR.text()).includes(",charge,whois,"), "the CSV downloads by key id");
ok((await req(`/credits/account/history.json?key=${T.keyId}`, { headers: C })).status === 404, "a balance on another email is not found");
ok((await req("/credits/account/top-up", { method: "POST", body: { key: K.keyId, pack: "credits-20" }, headers: C })).status === 403, "a write with the cookie from another site is refused");
const over = await req("/credits/account/top-up", { method: "POST", body: { key: K.keyId, pack: "credits-100" }, headers: { ...C, ...SAME } });
const overJ = await over.json();
ok(over.status === 400 && overJ.roomUsd === 81.5 && /\$81\.50/.test(overJ.error), `an over-cap top-up is refused before payment with the room left (${overJ.error})`);
const topR = await (await req("/credits/account/top-up", { method: "POST", body: { key: K.keyId, pack: "credits-20" }, headers: { ...C, ...SAME } })).json();
ok(/^https:\/\/checkout\.stripe\.com\//.test(topR.url), "a top-up that fits opens checkout");
// A new key needs a fresh sign-in: a session whose link was used more than
// NEW_KEY_FRESH_SIGN_IN_MS ago is refused (and the old key keeps working).
const clockAtSignIn = clock;
clock = clockAtSignIn + NEW_KEY_FRESH_SIGN_IN_MS + 1_000;
const stale = await req("/credits/account/new-key", { method: "POST", body: { key: K.keyId }, headers: { ...C, ...SAME } });
const staleJ = await stale.json();
ok(stale.status === 403 && staleJ.status === "sign_in_again" && !staleJ.key && cr.balance(nk.key)?.balanceUsd === 18.5, `a new key on a sign-in older than ten minutes is refused, the current key untouched (${stale.status} ${staleJ.status})`);
ok((await req("/credits/account/session.json", { headers: C })).status === 200, "the same session still reads the balance page");
clock = clockAtSignIn + NEW_KEY_FRESH_SIGN_IN_MS - 1_000;
const newK = await req("/credits/account/new-key", { method: "POST", body: { key: K.keyId }, headers: { ...C, ...SAME } });
const newKJ = await newK.json();
ok(newK.status === 200 && /^a402_/.test(newKJ.key) && newK.headers.get("cache-control") === "no-store", "a new key is answered once in the POST body, not stored by any cache");
ok(cr.authorize(nk.key, 0.001).reason === "unknown" && cr.balance(newKJ.key).balanceUsd === 18.5, "the previous key stops working and the new one holds the balance");
const lowOff = await req("/credits/account/low-notice", { method: "POST", body: { key: K.keyId, on: false }, headers: { ...C, ...SAME } });
ok(lowOff.status === 200 && (await cr.balancesForEmail("k@x.com"))[0].lowNotice === false, "the page turns the low-balance email off");
const refundR = await req("/credits/account/refund", { method: "POST", body: { key: K.keyId }, headers: { ...C, ...SAME } });
const refundJ = await refundR.json();
ok(refundR.status === 200 && refundJ.status === "refunded" && refundJ.refundedUsd === 18.5, "the refund button refunds the unspent balance without the key");
const out = await req("/credits/account/sign-out", { method: "POST", headers: { ...C, ...SAME } });
ok(out.status === 200 && /Max-Age=0/.test(out.headers.get("set-cookie")) && (await req("/credits/account/session.json", { headers: C })).status === 401, "signing out clears the cookie and ends the session");
// The low-balance email's own link.
const offLink = new URL(acct.noticeOffLink(L.keyId));
ok((await req(`${offLink.pathname}?key=${L.keyId}&k=bad`)).status === 400, "a forged notice-off link is refused");
await cr.setLowNotice(L.keyId, true);
const oneClick = await req(`${offLink.pathname}${offLink.search}`, { method: "POST", body: { "List-Unsubscribe": "One-Click" }, form: true });
ok(oneClick.status === 200 && (await oneClick.json()).ok === true && (await cr.balancesForEmail("l@x.com"))[0].lowNotice === false, "the mail client's one-click unsubscribe turns the notice off");
const keyInUrl = ROUTES.some(([, p]) => /a402_/.test(p)) || /a402_/.test(acct.noticeOffLink(L.keyId)) || /a402_/.test(acct.signInLink("k@x.com"));
ok(!keyInUrl, "no route or link of the page carries a key");
server.close();

// ---- (8) our emails, through the real sender (fetch replaced) -----------------------------
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => "{}" }; };
const { sendEmail } = await import("../src/email.js");
const real = createCreditsAccount({ credits: cr, baseUrl: "https://agent402.tools", secret: accountSecretFrom("sk_test_fixture"), sendEmail, store, termsVersion: () => "2026-11-18", log: () => {} });
await real.sendLowBalance({ keyId: L.keyId, email: "l@x.com", balanceUsd: 1.5 });
const lowMail = sent.at(-1).body;
ok(/zeptomail/.test(sent.at(-1).url) && lowMail.to[0].email_address.address === "l@x.com", "the low-balance email goes through the transactional sender");
ok(lowMail.mime_headers?.["List-Unsubscribe"] === `<${real.noticeOffLink(L.keyId)}>` && lowMail.mime_headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "it carries a one-click unsubscribe for that notice");
ok(lowMail.textbody.includes(real.noticeOffLink(L.keyId)) && lowMail.htmlbody.includes("Stop low-balance emails"), "...and the same link in its body");
ok(lowMail.textbody.includes("PO Box 1, Test Town, NC 00000") && lowMail.htmlbody.includes("PO Box 1, Test Town, NC 00000"), "...and the company postal address");
await real.sendReceipt({ kind: "topup", email: "k@x.com", keyId: K.keyId, amountUsd: 20, balanceUsd: 38.5, at: "2026-11-18T12:00:00.000Z", paymentIntent: "pi_abcdefghijklmnop" });
const rc = sent.at(-1).body;
ok(/receipt/.test(rc.subject) && /Amount paid: \$20\.00/.test(rc.textbody) && /Balance now: \$38\.50/.test(rc.textbody) && /Terms accepted: version 2026-11-18/.test(rc.textbody) && rc.textbody.includes("PO Box 1, Test Town, NC 00000") && !/a402_/.test(rc.textbody), "the receipt states the amount, the balance, the terms version and the postal address, and no key");
ok(!/—/.test(JSON.stringify(sent)) && !/—/.test(buildLowBalanceEmail({ balanceUsd: 1, keyId: "x", accountUrl: "u", unsubscribeUrl: "v" }).text), "no em dash in our emails");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
