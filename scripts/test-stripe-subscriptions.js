// Subscription engine test with a stubbed Stripe. Proves: subscription checkout
// creation + validation, paid-session provisioning, webhook signature discipline
// (refuses without a secret; verifies with one) and lifecycle transitions.
// Offline, in CI. The store under test is the file at STORE, so a
// STATE_DATABASE_URL in the caller's shell is dropped before the module loads
// (with it set, the store would be the database row, read asynchronously).
import "./lib/file-mode.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
const { createStripeSubscriptions, MONITOR_PRODUCTS } = await import("../src/stripe-subscriptions.js");

const STORE = join("/tmp", `test-subs-${process.pid}.json`);
try { rmSync(STORE); } catch { /* first run */ }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const sessions = {
  cs_paid: { id: "cs_paid", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_1", customer: "cus_1", customer_details: { email: "a@b.com" }, metadata: { product: "domain-monitor", target: "example.com" } },
  cs_unpaid: { id: "cs_unpaid", mode: "subscription", payment_status: "unpaid", status: "open", subscription: "sub_2", customer: "cus_2", metadata: { product: "domain-monitor", target: "x.com" } },
  cs_notsub: { id: "cs_notsub", mode: "payment", payment_status: "paid", status: "complete" },
  cs_promo: { id: "cs_promo", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_promo", customer: "cus_p", customer_details: { email: "p@b.com" }, metadata: { product: "domain-monitor", target: "promo.example.com" }, amount_subtotal: 500, total_details: { amount_discount: 375, amount_tax: 0 } },
  cs_promo_nopreview: { id: "cs_promo_nopreview", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_promo2", customer: "cus_p2", metadata: { product: "domain-monitor", target: "p2.example.com" }, amount_subtotal: 500, total_details: { amount_discount: 500 } },
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
  // Stripe's preview of the next invoice: the renewal amount after a promotion.
  invoices: { createPreview: async ({ subscription }) => { stripe._previews = (stripe._previews || 0) + 1; if (subscription === "sub_promo2") throw new Error("preview down"); return { total_excluding_tax: 500, total: 530 }; } },
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
// A promotion code: the first period from the session, the renewal from Stripe's invoice preview.
ok(r1.priceCents === MONITOR_PRODUCTS["domain-monitor"].price && r1.firstPeriodCents === undefined && !stripe._previews, "no discount: the catalog price, no promotion figures, no invoice preview read");
const rp = await subs.recordFromSession("cs_promo");
ok(rp.firstPeriodCents === 125 && rp.renewalCents === 500 && subs.get("sub_promo")?.firstPeriodCents === 125 && subs.get("sub_promo")?.renewalCents === 500, "a promotion code: first period = subtotal less discount, renewal = the previewed invoice before tax, both stored");
const nPrev = stripe._previews;
await subs.recordFromSession("cs_promo");
ok(stripe._previews === nPrev, "a reloaded thanks page does not read the preview again");
const rp2 = await subs.recordFromSession("cs_promo_nopreview");
ok(rp2.firstPeriodCents === 0 && rp2.renewalCents === undefined, "a preview that cannot be read stores no renewal figure (the email then points to the billing portal)");
{
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  sessions.cs_promo_wh = { ...sessions.cs_promo, id: "cs_promo_wh", subscription: "sub_promo_wh" };
  await subs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_promo_wh", type: "checkout.session.completed", data: { object: sessions.cs_promo_wh } })), "goodsig");
  ok(subs.get("sub_promo_wh")?.firstPeriodCents === 125 && subs.get("sub_promo_wh")?.renewalCents === 500, "the checkout webhook stores the same promotion figures");
  delete process.env.STRIPE_WEBHOOK_SECRET;
}

// webhook: refuses without a secret (never trusts an unsigned body)
delete process.env.STRIPE_WEBHOOK_SECRET;
let code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "sig"); } catch (e) { code = e.statusCode; }
ok(code === 401, "SECURITY: the webhook refuses (401) when no signing secret is configured");

// webhook: with a secret, a bad signature is rejected
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "badsig"); } catch (e) { code = e.statusCode; }
ok(code === 400, "SECURITY: a bad signature is rejected (400)");

// webhook lifecycle: subscription.updated then .deleted
// The period end rides on the subscription item (the pinned API's shape).
const evUpdated = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "domain-monitor", target: "example.com" }, items: { data: [{ id: "si_1", current_period_end: 1893456000 }] }, cancel_at_period_end: false } } });
await subs.handleWebhook(Buffer.from(evUpdated), "goodsig");
ok(subs.get("sub_1")?.currentPeriodEnd === 1893456000, "webhook updates the subscription period from the subscription item");
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
stripe.subscriptions.retrieve = async (id) => ({ id, status: "past_due", items: { data: [{ id: "si_1", current_period_end: 1900000000 }] } });
ok((await subs.refreshStatus("sub_1")) === "past_due" && subs.get("sub_1")?.status === "past_due" && subs.get("sub_1")?.currentPeriodEnd === 1900000000, "refreshStatus stores Stripe's current status and period (a lapsed card stops fulfillment even without a webhook)");
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

// A disputed subscription payment stops its fulfillment: the invoice's
// PaymentIntent is remembered when it is paid, the dispute marks the record,
// listActive drops it, and a status webhook does not bring it back. A refund
// reaches the clawback hook with what was refunded and whether all of it.
{
  const reversed = [];
  const closed = [];
  const refundEvents = [];
  let refundHookThrows = false;
  const dsubs = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: STORE, onInvoicePaid: () => {}, onChargeReversed: (pi, type, reversal) => reversed.push({ pi, type, reversal }), onDisputeClosed: (pi, o) => closed.push({ pi, ...o }),
    onRefundUpdated: (r) => { if (refundHookThrows) throw new Error("store down"); refundEvents.push(r); } });
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d0", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "domain-monitor", target: "example.com" }, items: { data: [{ current_period_end: 1893456000 }] } } } })), "goodsig");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d1", type: "invoice.paid", data: { object: { id: "in_9", subscription: "sub_1", customer: "cus_1", amount_paid: 900, payments: { data: [{ payment: { payment_intent: "pi_in9" } }] } } } })), "goodsig");
  ok(dsubs.get("sub_1")?.lastPaymentIntent === "pi_in9" && dsubs.listActive("domain").some((x) => x.subId === "sub_1"), "a paid invoice records the PaymentIntent it was paid with; the subscription is active");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d2", type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_9", payment_intent: "pi_in9", amount: 900 } } })), "goodsig");
  ok(dsubs.get("sub_1")?.disputed === true && !dsubs.listActive("domain").some((x) => x.subId === "sub_1"), "a dispute on that payment marks the subscription and listActive drops it");
  ok(reversed.length === 1 && reversed[0].pi === "pi_in9" && reversed[0].type === "charge.dispute.created" && reversed[0].reversal.fullyRefunded === true, "the dispute still reaches the clawback hook");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d3", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "domain-monitor", target: "example.com" } } } })), "goodsig");
  ok(dsubs.get("sub_1")?.status === "active" && !dsubs.listActive("domain").some((x) => x.subId === "sub_1"), "a later active status does not resume a disputed subscription");
  ok(dsubs.listDisputed().some((d) => d.subId === "sub_1" && d.lastPaymentIntent === "pi_in9" && d.disputeOutcome === null), "the operator list names the held subscription and its payment");
  // The dispute closes. Lost: the hold stays and the outcome is noted. Won:
  // the hold ends, the subscription runs again, and the hook hears it so the
  // credits key the dispute disabled can be enabled again.
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d5", type: "charge.dispute.closed", data: { object: { id: "dp_1", charge: "ch_9", payment_intent: "pi_in9", status: "lost" } } })), "goodsig");
  ok(dsubs.get("sub_1")?.disputed === true && dsubs.get("sub_1").disputeOutcome === "lost" && !dsubs.listActive("domain").some((x) => x.subId === "sub_1") && dsubs.listDisputed().some((d) => d.subId === "sub_1" && d.disputeOutcome === "lost"), "a dispute lost leaves the hold; the operator list carries the outcome");
  ok(closed.length === 1 && closed[0].pi === "pi_in9" && closed[0].won === false && closed[0].status === "lost", "the hook hears a lost dispute as not won");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d6", type: "charge.dispute.closed", data: { object: { id: "dp_1", charge: "ch_9", payment_intent: "pi_in9", status: "won" } } })), "goodsig");
  ok(dsubs.get("sub_1")?.disputed === false && dsubs.get("sub_1").disputeOutcome === "won" && dsubs.listActive("domain").some((x) => x.subId === "sub_1") && dsubs.listDisputed().length === 0, "a dispute won ends the hold: the subscription is fulfilled again and leaves the operator list");
  ok(closed.length === 2 && closed[1].pi === "pi_in9" && closed[1].won === true, "the hook hears the win");
  // An inquiry closed without a chargeback (warning_closed) is a withdrawal: the same release.
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d7", type: "charge.dispute.created", data: { object: { id: "dp_2", charge: "ch_9", payment_intent: "pi_in9", amount: 900 } } })), "goodsig");
  ok(dsubs.get("sub_1")?.disputed === true && !dsubs.listActive("domain").some((x) => x.subId === "sub_1"), "a second dispute on the payment holds it again");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d8", type: "charge.dispute.closed", data: { object: { id: "dp_2", charge: "ch_9", payment_intent: "pi_in9", status: "warning_closed" } } })), "goodsig");
  ok(dsubs.get("sub_1")?.disputed === false && dsubs.listActive("domain").some((x) => x.subId === "sub_1") && closed.length === 3 && closed[2].won === true && closed[2].status === "warning_closed", "an inquiry closed without a chargeback releases the hold too");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d9", type: "charge.dispute.closed", data: { object: { id: "dp_x", charge: "ch_other", payment_intent: "pi_other", status: "won" } } })), "goodsig");
  ok(closed.length === 4 && dsubs.listDisputed().length === 0 && dsubs.get("sub_1")?.disputed === false, "a closed dispute on an unknown payment changes no record (the hook still hears it)");
  await dsubs.handleWebhook(Buffer.from(JSON.stringify({ id: "evt_d4", type: "charge.refunded", data: { object: { id: "ch_5", payment_intent: "pi_pack", amount: 10000, amount_refunded: 2500, refunded: false } } })), "goodsig");
  ok(reversed.length === 3 && reversed[2].pi === "pi_pack" && reversed[2].reversal.amountRefundedCents === 2500 && reversed[2].reversal.fullyRefunded === false, "a partial refund reaches the clawback hook with its amount and that it is partial");
  // A refund's own status events reach the refund hook (credits settle a
  // refund sent on request by them); a bad signature never does, a repeat is
  // dropped, and a hook that throws leaves the event unacknowledged (503) so
  // Stripe's retry applies it.
  const refundEvt = (id, type, status) => Buffer.from(JSON.stringify({ id, type, data: { object: { id: "re_9", object: "refund", payment_intent: "pi_pack", amount: 500, status, metadata: { credits_refund_request: "k_1" } } } }));
  for (const [i, [type, status]] of [["refund.updated", "succeeded"], ["refund.failed", "failed"], ["charge.refund.updated", "canceled"]].entries()) {
    await dsubs.handleWebhook(refundEvt(`evt_r${i}`, type, status), "goodsig");
    ok(refundEvents.length === i + 1 && refundEvents[i].id === "re_9" && refundEvents[i].status === status, `${type} (${status}) reaches the refund hook`);
  }
  await dsubs.handleWebhook(refundEvt("evt_r0", "refund.updated", "succeeded"), "goodsig");
  ok(refundEvents.length === 3, "a repeated delivery of the same event does not reach the hook again");
  let badSig = null;
  try { await dsubs.handleWebhook(refundEvt("evt_rbad", "refund.failed", "failed"), "badsig"); } catch (e) { badSig = e; }
  ok(badSig?.statusCode === 400 && refundEvents.length === 3, "a refund event with a bad signature is refused and reaches no hook");
  refundHookThrows = true;
  let unacked = null;
  try { await dsubs.handleWebhook(refundEvt("evt_r9", "refund.failed", "failed"), "goodsig"); } catch (e) { unacked = e; }
  refundHookThrows = false;
  ok(unacked?.statusCode === 503, "a refund hook that throws leaves the event unacknowledged (503)");
  await dsubs.handleWebhook(refundEvt("evt_r9", "refund.failed", "failed"), "goodsig");
  ok(refundEvents.length === 4 && refundEvents[3].status === "failed", "...and Stripe's retry of it reaches the hook");
}

// Every record carries its id: one created by a webhook alone (the thanks
// page never loaded) has it, and a stored record without one takes it from
// its key on load, while a record that has it loads byte for byte unchanged.
{
  const { writeFileSync, readFileSync, statSync } = await import("node:fs");
  const P = join("/tmp", `test-subs-id-${process.pid}.json`);
  try { rmSync(P); } catch { /* first run */ }
  const ws = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: P });
  let into = ws; // the instance the next event is delivered to
  const send = (id, type, obj, created) => into.handleWebhook(Buffer.from(JSON.stringify({ id, type, ...(created ? { created } : {}), data: { object: obj } })), "goodsig");
  await send("evt_w1", "checkout.session.completed", { mode: "subscription", subscription: "sub_w1", customer: "cus_w1", customer_details: { email: "w1@x.com" }, metadata: { product: "domain-monitor", target: "w1.com" } });
  await send("evt_w2", "customer.subscription.created", { id: "sub_w2", customer: "cus_w2", status: "active", metadata: { product: "domain-monitor", target: "w2.com" } });
  const onDisk = JSON.parse(readFileSync(P, "utf8"));
  ok(onDisk.sub_w1?.subId === "sub_w1" && onDisk.sub_w2?.subId === "sub_w2", "a record created by a webhook alone is stored with its subId");
  ok(ws.listActive("domain").map((r) => r.subId).sort().join() === "sub_w1,sub_w2", "listActive names each webhook-only subscription by its own id");

  // Backfill: a legacy record without the id; a current one with it.
  const legacy = { sub_old: { status: "active", product: "domain-monitor", target: "old.com", customer: "cus_old" }, sub_new: { subId: "sub_new", status: "active", product: "domain-monitor", target: "new.com", customer: "cus_new", updatedAt: "2026-11-01T00:00:00.000Z" } };
  writeFileSync(P, JSON.stringify(legacy));
  const before = readFileSync(P, "utf8"), mtime = statSync(P).mtimeMs;
  const lb = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: P });
  ok(lb.get("sub_old")?.subId === "sub_old" && lb.listActive("domain").every((r) => typeof r.subId === "string"), "a stored record without a subId takes it from its key on load");
  ok(JSON.stringify(lb.get("sub_new")) === JSON.stringify(legacy.sub_new), "a record that has its subId loads unchanged");
  ok(readFileSync(P, "utf8") === before && statSync(P).mtimeMs === mtime, "loading writes nothing (the backfill is in memory; the next write carries the id)");
  into = lb;

  // Status events out of order: a late update created before the
  // cancellation does not reactivate the subscription.
  await send("evt_o1", "customer.subscription.deleted", { id: "sub_new" }, 2_000_000_200);
  await send("evt_o2", "customer.subscription.updated", { id: "sub_new", customer: "cus_new", status: "active", metadata: {} }, 2_000_000_100);
  ok(lb.get("sub_new")?.status === "canceled" && !lb.listActive("domain").some((r) => r.subId === "sub_new"), "a status event older than the cancellation does not reactivate it");
  await send("evt_o3", "customer.subscription.updated", { id: "sub_old", customer: "cus_old", status: "past_due", metadata: {} }, 2_000_000_300);
  await send("evt_o4", "customer.subscription.updated", { id: "sub_old", customer: "cus_old", status: "active", metadata: {} }, 2_000_000_400);
  ok(lb.get("sub_old")?.status === "active", "a newer status event applies");

  // A live read, then a status update whose created time (Stripe's clock)
  // is 30 s behind ours: the update applies, so the paid run stops.
  await send("evt_s0", "customer.subscription.created", { id: "sub_skew", customer: "cus_skew", status: "active", metadata: { product: "domain-monitor", target: "skew.com" } });
  const retrieveBefore = stripe.subscriptions.retrieve;
  stripe.subscriptions.retrieve = async (id) => ({ id, status: "active", items: { data: [{ id: "si_s", current_period_end: 1900000000 }] } });
  ok((await lb.refreshStatus("sub_skew")) === "active", "setup: a live read stores active");
  stripe.subscriptions.retrieve = retrieveBefore;
  await send("evt_s1", "customer.subscription.updated", { id: "sub_skew", customer: "cus_skew", status: "unpaid", metadata: {} }, Math.floor(Date.now() / 1000) - 30);
  ok(lb.get("sub_skew")?.status === "unpaid", "a status update stamped 30 s behind our clock still applies after a live read (the read is stamped LIVE_READ_SKEW_S early)");
  // The thanks page's live read (recordFromSession) is stamped the same way.
  sessions.cs_skew2 = { id: "cs_skew2", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_skew2", customer: "cus_skew2", customer_details: { email: "s2@x.com" }, metadata: { product: "domain-monitor", target: "skew2.com" } };
  const retrieveKeep = stripe.subscriptions.retrieve;
  stripe.subscriptions.retrieve = async (id) => ({ id, status: "active" });
  ok((await lb.recordFromSession("cs_skew2")).status === "active" && Number(lb.get("sub_skew2")?.statusEventAt) > 0, "setup: the thanks page provisions from a live read, which stamps the record");
  stripe.subscriptions.retrieve = retrieveKeep;
  await send("evt_s2", "customer.subscription.updated", { id: "sub_skew2", customer: "cus_skew2", status: "unpaid", metadata: {} }, Math.floor(Date.now() / 1000) - 30);
  ok(lb.get("sub_skew2")?.status === "unpaid", "a status update stamped 30 s behind our clock still applies after the thanks page's live read");

  // A dispute on an earlier month's payment, after a later invoice was paid,
  // still finds the subscription (by payment, or by charge).
  await send("evt_p1", "invoice.paid", { id: "in_m1", subscription: "sub_old", customer: "cus_old", amount_paid: 500, payment_intent: "pi_m1", charge: "ch_m1" });
  await send("evt_p2", "invoice.paid", { id: "in_m2", subscription: "sub_old", customer: "cus_old", amount_paid: 500, payment_intent: "pi_m2", charge: "ch_m2" });
  await send("evt_p3", "charge.dispute.created", { id: "dp_m1", payment_intent: "pi_m1" });
  ok(lb.get("sub_old")?.disputed === true && !lb.listActive("domain").some((r) => r.subId === "sub_old"), "a dispute on an earlier month's payment holds the subscription");
  await send("evt_p4", "charge.dispute.closed", { id: "dp_m1", payment_intent: "pi_m1", status: "won" });
  await send("evt_p5", "charge.dispute.created", { id: "dp_m2", charge: "ch_m1" });
  ok(lb.get("sub_old")?.disputed === true, "a dispute naming only the earlier charge holds it too");
  try { rmSync(P); } catch { /* ignore */ }
}

// Signed receipts per paid period: the first invoice and each renewal, signed
// on invoice.paid with an amount paid, once per invoice; none for an invoice
// that paid nothing, none with signing off.
{
  const { generateKeyPairSync } = await import("node:crypto");
  const { loadReceiptKeys, createSubscriptionReceipt, verifyReceipt, SUBSCRIPTION_RECEIPT_PATHS } = await import("../src/receipt-signing.js");
  const { privateKey } = generateKeyPairSync("ed25519");
  const keys = loadReceiptKeys({ RECEIPT_SIGNING_KEY: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"), RECEIPT_SIGNING_KEY_ID: "t-card" });
  const RS = join("/tmp", `test-subs-rcpt-${process.pid}.json`);
  try { rmSync(RS); } catch { /* first run */ }
  let signOn = true;
  const calls = [];
  const rs = createStripeSubscriptions({
    stripe, baseUrl: "https://agent402.tools", storePath: RS, onInvoicePaid: () => {},
    signPeriod: (d) => { calls.push(d); return signOn ? createSubscriptionReceipt({ iss: "https://agent402.tools", ...d }, keys.signer) : createSubscriptionReceipt(d, null); },
  });
  stripe.subscriptions.retrieve = async (id) => ({ id, status: "active" });
  await rs.recordFromSession("cs_paid");
  const inv = (id, amount, evt) => Buffer.from(JSON.stringify({ id: evt, type: "invoice.paid", data: { object: { id, subscription: "sub_1", customer: "cus_1", amount_paid: amount } } }));
  await rs.handleWebhook(inv("in_r1", 500, "evt_rc1"), "goodsig");
  let kept = rs.get("sub_1").signedReceipts || [];
  const v = kept[0] ? verifyReceipt(kept[0].receipt, { keys: keys.keys, responseBody: kept[0].statement, request: { method: "POST", path: SUBSCRIPTION_RECEIPT_PATHS["card-subscription"], body: { product: "domain-monitor", target: "example.com", subscription: "sub_1" } } }) : {};
  ok(kept.length === 1 && v.valid === true && v.record.rail === "card-subscription" && v.record.settlement === "in_r1" && v.record.priceUsd === "5" && v.record.payer === null, `the first paid invoice is signed: rail, invoice, amount, no payer (${v.reason})`);
  const conf = await rs.recordFromSession("cs_paid");
  ok(conf.signedReceipts?.length === 1 && conf.signedReceipts[0].receipt === kept[0].receipt && conf.signedReceipts[0].statement === kept[0].statement, "the confirmation read returns the receipt with its period statement");
  await rs.handleWebhook(inv("in_r1", 500, "evt_rc1b"), "goodsig");
  ok(rs.get("sub_1").signedReceipts.length === 1, "a redelivered invoice keeps the one receipt");
  await rs.handleWebhook(inv("in_r2", 500, "evt_rc2"), "goodsig");
  kept = rs.get("sub_1").signedReceipts;
  ok(kept.length === 2 && verifyReceipt(kept[1].receipt, { keys: keys.keys, responseBody: kept[1].statement }).record?.settlement === "in_r2", "a renewal's paid invoice gets its own receipt");
  await rs.handleWebhook(inv("in_r0", 0, "evt_rc0"), "goodsig");
  ok(rs.get("sub_1").signedReceipts.length === 2, "an invoice that paid nothing (a 100% promotion) gets none");
  for (const [i, e] of [["in_r3", "evt_rc3"], ["in_r4", "evt_rc4"]]) await rs.handleWebhook(inv(i, 500, e), "goodsig");
  ok(rs.get("sub_1").signedReceipts.length === 3 && rs.get("sub_1").signedReceipts[2].settlement === "in_r4", "the last three periods' receipts are kept, newest last");
  signOn = false;
  await rs.handleWebhook(inv("in_r5", 500, "evt_rc5"), "goodsig");
  ok(rs.get("sub_1").signedReceipts.length === 3 && rs.get("sub_1").lastInvoiceId === "in_r5", "signing off: the invoice is recorded, no receipt is added");
  try { rmSync(RS); rmSync(RS + ".webhooks.json"); } catch { /* ignore */ }
}

try { rmSync(STORE); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
