// Monitor renewal terms and the "Already subscribed? Manage or cancel" path.
// Proves: every Subscribe button on /monitors has the renewal sentence and a
// /terms link beside it; the subscription Checkout Session carries the same
// sentence as custom_text.submit.message; the manage-link route answers the
// same for a known and an unknown email, sends exactly one email for a known
// one and none otherwise, and returns 429 past its per-IP and per-address
// limits; server.js mounts the route and verifies the signed sub link.
// Offline (stubbed Stripe, stubbed sender), port 0, in CI.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import express from "express";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStripeSubscriptions, RENEWAL_TERMS, renewalCheckoutMessage, MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { monitorsPage } from "../src/monitors-page.js";
import { createManageLinkHandler, MANAGE_LINK_ANSWER, subManageMessage } from "../src/monitor-manage-link.js";
import { createLimiter } from "../src/rate-limit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok - " + m); } else { fail++; console.error("NOT OK - " + m); } };

// ---- 1. the renewal line beside every Subscribe button ------------------------
const html = monitorsPage("https://agent402.tools");
const cards = html.split('<div class="pcard').slice(1);
ok(cards.length === Object.keys(MONITOR_PRODUCTS).length && cards.length > 0, `one card per monitor product (${cards.length})`);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
ok(/renews each month until you cancel/i.test(RENEWAL_TERMS) && /cancel anytime from the manage link/i.test(RENEWAL_TERMS), "the renewal sentence says it renews monthly until canceled and how to cancel");
ok(cards.every((c) => {
  const btn = c.indexOf("data-sub=");
  const renew = c.indexOf('<p class="renew">');
  return btn > 0 && renew > btn && c.slice(renew).startsWith(`<p class="renew">${esc(RENEWAL_TERMS)} <a href="/terms">Terms</a></p>`);
}), "every card states the renewal terms with a /terms link right after its Subscribe button");
ok(/<form class="manage-form" method="post" action="\/monitors\/manage-link">/.test(html) && /id="manage"/.test(html) && /Already subscribed\? Manage or cancel/.test(html),
  "/monitors carries the Already subscribed form, posting to /monitors/manage-link");
ok(!/\u2014/.test(html), "no em dash on /monitors");
{
  // The wallet path (MPP) is offered only where the server mounts it.
  const on = monitorsPage("https://agent402.tools", null, { wallet: true });
  ok(!/id="wallet"|\/api\/mpp\/monitors|href="#wallet"|card or wallet/.test(html), "wallet path off: /monitors offers the card checkout only");
  ok(/<section class="manage" id="wallet">/.test(on) && (on.match(/https:\/\/[^\s"'<>&]+/g) || []).some((u) => u === "https://agent402.tools/api/mpp/monitors/subscribe") && on.includes('href="#wallet"') && /beyond your card or wallet/.test(on),
    "wallet path on: /monitors shows the wallet subscribe request beside the card checkout");
  ok(on.indexOf('id="wallet"') > on.indexOf('class="products"') && on.indexOf('id="wallet"') < on.indexOf('id="manage"'), "the wallet section sits after the cards and before manage");
  ok(Object.keys(MONITOR_PRODUCTS).every((k) => on.includes(`<code>${k}</code>`)), "every product name is listed for the wallet request");
  ok(!/\u2014/.test(on), "no em dash in the wallet section");
}

// ---- 2. the Checkout Session states the same terms ------------------------------
const STORE = join(tmpdir(), `test-manage-link-${process.pid}.json`);
for (const f of [STORE, STORE + ".webhooks.json"]) { try { rmSync(f); } catch { /* first run */ } }
const sessions = {
  cs_a: { id: "cs_a", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_a", customer: "cus_a", customer_details: { email: "Known@Example.com" }, metadata: { product: "domain-monitor", target: "example.com" } },
  cs_c: { id: "cs_c", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_c", customer: "cus_c", customer_details: { email: "gone@example.com" }, metadata: { product: "domain-monitor", target: "gone.example" } },
};
const subStatus = { sub_a: "active", sub_c: "canceled" };
let created = null;
const stripe = {
  checkout: { sessions: {
    create: async (args) => { created = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; },
    retrieve: async (id) => { if (!sessions[id]) throw new Error("No such session"); return sessions[id]; },
  } },
  subscriptions: { retrieve: async (id) => ({ id, status: subStatus[id] || "active" }) },
  billingPortal: { sessions: { create: async () => { throw new Error("the manage-link route must never mint a portal"); } } },
};
const subs = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: STORE });
await subs.createCheckout("domain-monitor", "example.com");
const msg = created?.custom_text?.submit?.message;
const { monitorRenewalStatement, termsAcceptanceMessage } = await import("../src/checkout-consent.js");
const dm = MONITOR_PRODUCTS["domain-monitor"];
ok(typeof msg === "string" && msg.startsWith(monitorRenewalStatement(dm.price, "https://agent402.tools")) && msg.includes(RENEWAL_TERMS), "the subscription Checkout Session states the renewal terms with the monthly price above the pay button");
ok(msg === `${monitorRenewalStatement(dm.price, "https://agent402.tools")} ${renewalCheckoutMessage("https://agent402.tools")}` && msg.length <= 1200, `the message is the shared one, within Stripe's 1200-character limit (${msg?.length})`);
ok(msg.includes(`$${(dm.price / 100).toFixed(2)} a month`) && /If a promotion code lowers the first month, every later month is \$/.test(msg), "the renewal statement names the monthly price and the price after any promotional first month");
ok(/\[Terms of Service\]\(https:\/\/agent402\.tools\/terms\)/.test(msg) && /\(https:\/\/agent402\.tools\/monitors#manage\)/.test(msg), "the message links the terms and the manage form");
ok(created.consent_collection?.terms_of_service === "required" && created.custom_text?.terms_of_service_acceptance?.message === termsAcceptanceMessage("https://agent402.tools") && /arbitration and the class-action waiver\]\(https:\/\/agent402\.tools\/terms#disputes\)/.test(created.custom_text.terms_of_service_acceptance.message), "the Terms checkbox is required, and its line names arbitration and the class waiver with a link");
{
  const ar = (created.custom_fields || []).find((f) => f.key === "autorenew");
  ok(ar && ar.optional === false && ar.type === "dropdown" && ar.dropdown.options.length === 1 && ar.dropdown.options[0].label.includes(`$${(dm.price / 100).toFixed(2)}`) && ar.dropdown.options[0].label.length <= 100 && ar.label.custom.length <= 50, "a separate, required automatic-renewal consent names the monthly price (within Stripe's field limits)");
}
// An account with no Terms URL in its public details: Stripe refuses the
// checkbox, and the session is made again with a required terms dropdown, so
// no buyer is turned away for a dashboard setting.
{
  const calls = [];
  const refusing = { ...stripe, checkout: { sessions: { ...stripe.checkout.sessions, create: async (args) => { calls.push(args); if (args.consent_collection?.terms_of_service) throw new Error("You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard. Update your public details at https://dashboard.stripe.com/settings/public."); return { id: "cs_fb", url: "https://checkout.stripe.com/pay/cs_fb" }; } } } };
  const subsFb = createStripeSubscriptions({ stripe: refusing, baseUrl: "https://agent402.tools", storePath: STORE + ".fb" });
  const r = await subsFb.createCheckout("domain-monitor", "example.com");
  const second = calls[1] || {};
  ok(r.id === "cs_fb" && calls.length === 2 && !second.consent_collection?.terms_of_service && second.custom_fields?.some((f) => f.key === "terms" && f.optional === false) && second.custom_fields?.some((f) => f.key === "autorenew"), "with no Terms URL set, the session is made with a required terms dropdown and keeps the renewal consent");
}
// The consent is kept with the subscription when it is provisioned.
{
  const { consentRecordOf } = await import("../src/checkout-consent.js");
  const c = consentRecordOf({ id: "cs_x", created: 1_800_000_000, consent: { terms_of_service: "accepted" }, custom_fields: [{ key: "autorenew", dropdown: { value: "agreed" } }] }, { priceCents: 500 });
  ok(c.terms === "accepted" && c.autoRenew === "agreed" && c.autoRenewPriceCents === 500 && c.session === "cs_x", "the consent record holds the terms, the renewal consent and the price agreed to");
}

// ---- 3. the manage-link route -----------------------------------------------------
await subs.recordFromSession("cs_a");
await subs.recordFromSession("cs_c");
ok(subs.get("sub_a")?.status === "active" && subs.get("sub_c")?.status === "canceled", "fixtures: one active and one canceled subscription");
ok((await subs.findManageableByEmail("known@example.com")).map((r) => r.subId).join() === "sub_a", "findManageableByEmail matches case-insensitively and returns the subscription id");
ok((await subs.findManageableByEmail("gone@example.com")).length === 0, "a canceled subscription is not offered a manage link");

const sent = [];
const send = async (m) => { sent.push(m); return true; };
const app = express();
app.use(express.json());
app.post("/monitors/manage-link", express.urlencoded({ extended: false }), createManageLinkHandler({
  findSubs: (e) => subs.findManageableByEmail(e), send,
  linkFor: (subId, exp) => `https://agent402.tools/monitors/manage?sub=${subId}&exp=${exp}&k=SIGNED(${subManageMessage(subId, exp)})`,
  labelOf: (p) => MONITOR_PRODUCTS[p]?.label || "monitor",
  ipLimiter: createLimiter("t-manage-ip", { perMin: 6, perHour: 40 }),
  emailLimiter: createLimiter("t-manage-email", { perMin: 2, perHour: 5 }),
  clientIp: (req) => String(req.get("x-test-ip") || "ip0"),
  page: (title, body) => `<h1>${title}</h1>${body}`,
}));
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const post = (email, ip, { form = false } = {}) => fetch(`${base}/monitors/manage-link`, {
  method: "POST",
  headers: form ? { "content-type": "application/x-www-form-urlencoded", "x-test-ip": ip } : { "content-type": "application/json", accept: "application/json", "x-test-ip": ip },
  body: form ? `email=${encodeURIComponent(email)}` : JSON.stringify({ email }),
});
const settle = async (n) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10)); await new Promise((r) => setTimeout(r, 50)); };

const rUnknown = await post("nobody@example.com", "ip1");
const bUnknown = await rUnknown.text();
await settle(1);
ok(sent.length === 0, "an unknown email triggers no send");
const rKnown = await post("KNOWN@example.com", "ip2");
const bKnown = await rKnown.text();
await settle(1);
ok(rUnknown.status === 200 && rKnown.status === 200 && bKnown === bUnknown, "a known and an unknown email get the same status and the same body");
ok(JSON.parse(bKnown).message === MANAGE_LINK_ANSWER, "the answer is the fixed no-discovery sentence");
ok(sent.length === 1, `a known email triggers exactly one send (${sent.length})`);
ok(sent[0]?.to === "known@example.com" && /sub=sub_a&exp=\d+&k=SIGNED\(sub:sub_a:\d+\)/.test(sent[0]?.text || "") && sent[0].html.includes("sub=sub_a"),
  "the email goes to that address and carries a signed manage link for its subscription");
ok(!/sub_c/.test(sent[0]?.text || ""), "the canceled subscription is not in the email");
const exp = Number((sent[0]?.text.match(/exp=(\d+)/) || [])[1]);
ok(exp > Date.now() / 1000 + 6 * 86400 && exp < Date.now() / 1000 + 8 * 86400, "the link expires in 7 days");
const rCanceled = await post("gone@example.com", "ip3");
await settle(2);
ok(rCanceled.status === 200 && (await rCanceled.text()) === bUnknown && sent.length === 1, "an email whose only subscription is canceled gets the same answer and no send");
const rForm = await post("nobody@example.com", "ip4", { form: true });
ok(rForm.status === 200 && /Check your email/.test(await rForm.text()), "a plain form post (no script) gets an HTML answer");
const rBad = await post("not-an-email", "ip5");
ok(rBad.status === 400, "a malformed address is a 400");

// Per-IP: 6 a minute.
const codes = [];
for (let i = 0; i < 7; i++) codes.push((await post(`x${i}@example.com`, "ip-burst")).status);
ok(codes.slice(0, 6).every((c) => c === 200) && codes[6] === 429, `the 7th request from one IP in a minute is 429 (${codes.join(",")})`);
// Per-address: 2 a minute, from any IP.
const eCodes = [];
for (let i = 0; i < 3; i++) eCodes.push((await post("target@example.com", `rot-${i}`)).status);
ok(eCodes[0] === 200 && eCodes[1] === 200 && eCodes[2] === 429, `the 3rd request for one address in a minute is 429 across IPs (${eCodes.join(",")})`);
await settle(2);
ok(sent.length === 1, "no request after the first known one sent anything");
srv.close();

// ---- 4. server.js wiring -------------------------------------------------------------
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/app\.post\("\/monitors\/manage-link", express\.urlencoded\([^)]*\), createManageLinkHandler\(\{/.test(server), "server.js mounts the manage-link handler with a form body parser");
ok(/findSubs: \(email\) => \(_subs \? _subs\.findManageableByEmail\(email\)/.test(server) && /send: faSendEmail,/.test(server), "server.js looks up stored subscriptions and sends through the existing email sender");
ok(/linkFor: \(subId, exp\) => `\$\{BASE_URL\}\/monitors\/manage\?sub=\$\{encodeURIComponent\(subId\)\}&exp=\$\{exp\}&k=\$\{_manageToken\(subManageMessage\(subId, exp\)\)\}`/.test(server),
  "the emailed link is signed with the existing manage-token key over the subscription id and expiry");
const manageRoute = server.slice(server.indexOf('app.get("/monitors/manage"'), server.indexOf('app.get("/m/:reportId"'));
ok(/exp \* 1000 < Date\.now\(\) \|\| !_manageTokenOk\(subManageMessage\(subId, exp\), req\.query\.k\)\) return res\.redirect/.test(manageRoute), "/monitors/manage refuses an expired or unsigned sub link before any portal");
ok(!subManageMessage("abc", 1).match(/^[A-Za-z0-9_-]{10,64}$/), "a sub-link message can never be a report id (so a report token never verifies as one)");

for (const f of [STORE, STORE + ".webhooks.json"]) { try { rmSync(f); } catch { /* gone */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
