// Subscription engine test with a stubbed Stripe. Proves: subscription checkout
// creation + validation, paid-session provisioning, webhook signature discipline
// (refuses without a secret; verifies with one) and lifecycle transitions.
// Offline, in CI.
import { createStripeSubscriptions, MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";

const STORE = join("/tmp", `test-subs-${process.pid}.json`);
try { rmSync(STORE); } catch { /* first run */ }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const sessions = {
  cs_paid: { id: "cs_paid", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_1", customer: "cus_1", customer_details: { email: "a@b.com" }, metadata: { product: "domain-monitor", target: "example.com" } },
  cs_unpaid: { id: "cs_unpaid", mode: "subscription", payment_status: "unpaid", status: "open", subscription: "sub_2", customer: "cus_2", metadata: { product: "domain-monitor", target: "x.com" } },
  cs_notsub: { id: "cs_notsub", mode: "payment", payment_status: "paid", status: "complete" },
};
const stripe = {
  checkout: { sessions: {
    create: async (args) => { stripe._lastCreate = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; },
    retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; },
  } },
  billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/p/session_x" }) } },
  // The live Subscription object is the status source; sub_1 is canceled once the
  // lifecycle webhook says so (mirrors Stripe: the Checkout Session stays paid).
  subscriptions: { retrieve: async (id) => ({ id, status: stripe._subStatus?.[id] || "active" }) },
  webhooks: { constructEvent: (body, sig, secret) => { if (sig !== "goodsig" || secret !== "whsec_test") throw new Error("bad signature"); return JSON.parse(body.toString()); } },
};

const invoices = [];
const subs = createStripeSubscriptions({
  stripe, baseUrl: "https://agent402.tools", storePath: STORE,
  validateTarget: { domain: (t) => { const d = String(t).toLowerCase().replace(/^https?:\/\//, ""); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { const e = new Error("not a domain"); e.statusCode = 400; throw e; } return d; } },
  onInvoicePaid: (i) => invoices.push(i),
});

// products
ok(Object.values(MONITOR_PRODUCTS).every((p) => p.price >= 300 && p.kind), "every monitor product clears the Stripe fee floor ($3) and has a kind");

// createCheckout
const c = await subs.createCheckout("domain-monitor", "example.com");
ok(c.url === "https://checkout.stripe.com/pay/cs_new", "createCheckout returns a Stripe checkout url");
ok(stripe._lastCreate.mode === "subscription", "checkout is subscription mode");
ok(stripe._lastCreate.line_items[0].price_data.recurring.interval === "month", "price is monthly recurring");
ok(stripe._lastCreate.subscription_data.metadata.target === "example.com", "target rides on subscription metadata");
let threw = false; try { await subs.createCheckout("nope", "x"); } catch { threw = true; }
ok(threw, "createCheckout rejects an unknown product");
threw = false; try { await subs.createCheckout("domain-monitor", ""); } catch { threw = true; }
ok(threw, "createCheckout rejects empty target");
threw = false; try { await subs.createCheckout("domain-monitor", "not a domain"); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "createCheckout VALIDATES the target before billing (an invalid domain is a 400, no session)");
await subs.createCheckout("domain-monitor", "https://Example.com");
ok(stripe._lastCreate.metadata.target === "example.com", "the target is normalized before it rides on the subscription");

// recordFromSession (belt-and-suspenders provisioning)
const r1 = await subs.recordFromSession("cs_paid");
ok(r1.status === "active" && r1.target === "example.com" && r1.customer === "cus_1", "a paid subscription session provisions active");
ok(subs.get("sub_1")?.status === "active", "the subscription is stored active");
ok((await subs.recordFromSession("cs_unpaid")).status === "unpaid", "an unpaid session is not provisioned");
ok((await subs.recordFromSession("cs_notsub")).status === "invalid", "a non-subscription session is invalid");
ok((await subs.recordFromSession("garbage")).status === "invalid", "a malformed session id is invalid");
ok((await subs.recordFromSession("cs_missing")).status === "not_found", "a nonexistent session id is not_found");

// webhook: refuses without a secret (never trusts an unsigned body)
delete process.env.STRIPE_WEBHOOK_SECRET;
let code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "sig"); } catch (e) { code = e.statusCode; }
ok(code === 401, "SECURITY: the webhook refuses (401) when no signing secret is configured");

// webhook: with a secret, a bad signature is rejected
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "badsig"); } catch (e) { code = e.statusCode; }
ok(code === 400, "SECURITY: a bad signature is rejected (400)");

// webhook lifecycle: subscription.updated then .deleted
const evUpdated = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "domain-monitor", target: "example.com" }, current_period_end: 1893456000, cancel_at_period_end: false } } });
await subs.handleWebhook(Buffer.from(evUpdated), "goodsig");
ok(subs.get("sub_1")?.currentPeriodEnd === 1893456000, "webhook updates the subscription period");
ok(subs.listActive("domain").some((x) => x.subId === "sub_1"), "listActive('domain') includes the active sub");

const evDeleted = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1" } } });
await subs.handleWebhook(Buffer.from(evDeleted), "goodsig");
ok(subs.get("sub_1")?.status === "canceled", "webhook marks a deleted subscription canceled");
ok(!subs.listActive("domain").some((x) => x.subId === "sub_1"), "a canceled sub is no longer active");

// SECURITY: the thanks page (recordFromSession) must not re-activate a canceled
// subscription - the Checkout Session is paid forever, the Subscription is not.
stripe._subStatus = { sub_1: "canceled" };
const again = await subs.recordFromSession("cs_paid");
ok(again.status === "canceled" && subs.get("sub_1")?.status === "canceled" && !subs.listActive("domain").some((x) => x.subId === "sub_1"), "SECURITY: reloading the thanks page after cancellation does NOT re-activate the subscription");
// ...nor does a replayed/late checkout.session.completed webhook.
const evCompleted = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_paid", mode: "subscription", subscription: "sub_1", customer: "cus_1", metadata: { product: "domain-monitor", target: "example.com" } } } });
await subs.handleWebhook(Buffer.from(evCompleted), "goodsig");
ok(subs.get("sub_1")?.status === "canceled", "SECURITY: a replayed checkout.session.completed does not overwrite a terminal status");
// When the live status read FAILS, an existing record keeps its status; a first
// provisioning still assumes active (the session itself is verified paid).
stripe.subscriptions.retrieve = async () => { throw new Error("stripe down"); };
ok((await subs.recordFromSession("cs_paid")).status === "canceled", "status-read failure keeps the existing (canceled) status");
ok(!(await subs.createCheckout("constructor", "x").catch((e) => e)).url, "an inherited-property product key is refused");

// refreshStatus: the scheduler's pre-run check reads Stripe's current status.
stripe.subscriptions.retrieve = async (id) => ({ id, status: "past_due", current_period_end: 1900000000 });
ok((await subs.refreshStatus("sub_1")) === "past_due" && subs.get("sub_1")?.status === "past_due", "refreshStatus stores Stripe's current status (a lapsed card stops fulfilment even without a webhook)");
stripe.subscriptions.retrieve = async () => { throw new Error("down"); };
ok((await subs.refreshStatus("sub_1")) === null, "refreshStatus returns null when Stripe is unreadable (caller decides)");

// invoice.paid -> accounting hook (recurring revenue is recorded)
const evInv = JSON.stringify({ type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_1", customer: "cus_1", amount_paid: 900 } } });
await subs.handleWebhook(Buffer.from(evInv), "goodsig");
ok(invoices.length === 1 && invoices[0].amountUsd === 9 && invoices[0].product === "domain-monitor" && invoices[0].invoiceId === "in_1", "a paid invoice reaches the accounting hook with product + amount");

// Webhook receipt tally: the only on-server evidence that Stripe is delivering.
{
  const w = subs.webhookStats();
  ok(w.configured === true && w.received === w.verified + w.rejected + w.unconfigured, `tally reconciles: received ${w.received} = verified ${w.verified} + rejected ${w.rejected} + unconfigured ${w.unconfigured}`);
  ok(w.rejected >= 1 && w.lastRejectReason === "bad-signature" && w.unconfigured >= 1, "bad signature and missing secret are counted separately, with the reason");
  ok(w.byType["invoice.paid"] === 1 && w.byType["customer.subscription.updated"] >= 1 && w.lastType === "invoice.paid" && typeof w.lastAt === "string", "verified events are counted by type and stamp lastAt/lastType");
  w.byType.forged = 99; w.received = 0;
  ok(subs.webhookStats().received > 0 && !subs.webhookStats().byType.forged, "webhookStats returns a snapshot, not the live tally");
  // Persisted: a fresh engine on the same store path reads the same counts (a deploy must not reset it to zero).
  const again = createStripeSubscriptions({ stripe, baseUrl: "https://example.test", storePath: STORE, onInvoicePaid: () => {} });
  const w2 = again.webhookStats();
  ok(w2.received === subs.webhookStats().received && w2.byType["invoice.paid"] === 1, "the tally survives a process restart (persisted beside the store)");
  try { rmSync(STORE + ".webhooks.json"); } catch { /* ignore */ }
}

// The same invoice delivered again after a restart (a fresh instance on the
// same store remembers no event ids) books no second sale; a new one does.
{
  const after = [];
  const restarted = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: STORE, onInvoicePaid: (i) => after.push(i) });
  await restarted.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_re_1", type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_1", customer: "cus_1", amount_paid: 900 } } })), "goodsig");
  ok(after.length === 0, `a redelivered invoice after a restart books nothing (${after.length})`);
  await restarted.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_re_2", type: "invoice.paid", data: { object: { id: "in_2", subscription: "sub_1", customer: "cus_1", amount_paid: 900 } } })), "goodsig");
  ok(after.length === 1 && after[0].invoiceId === "in_2", "...and the next invoice is booked");
}

try { rmSync(STORE); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
