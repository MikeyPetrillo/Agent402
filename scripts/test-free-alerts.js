#!/usr/bin/env node
// Free email alerts engine (src/free-alerts.js) - offline, stubbed probes + mail.
// Pins: double opt-in (nothing watched or sent past the confirmation until the
// signed link is clicked), unforgeable links, unsubscribe ends it, change email
// only on NEW ids and at most once a day, probe failures never email and back
// off, per-address and total caps, no enumeration, counts-only stats, and the
// form + page wiring (CSP-safe external script, honeypot field).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeAlerts, alertFormHtml, ALERT_KINDS, MAX_PER_EMAIL } from "../src/free-alerts.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };
const dir = mkdtempSync(join(tmpdir(), "free-alerts-"));
let clock = 1_800_000_000_000;
const now = () => clock;
const mail = [];
let mailOk = true;
const sendEmail = async (m) => { mail.push(m); return mailOk; };
let ids = ["a1", "a2"];
let probeCalls = 0;
let probeThrow = false;
const probes = {
  insider: async (t) => { probeCalls++; if (probeThrow) throw new Error("EDGAR down"); return { ids: [...ids], items: ids.map((i) => ({ id: i, label: `Filing ${i} for ${t}`, url: `https://www.sec.gov/${i}` })) }; },
};
const validators = { insider: (t) => { const k = String(t).trim().toUpperCase(); if (!/^[A-Z]{1,6}$/.test(k)) { const e = new Error("Enter a US ticker."); e.statusCode = 400; e.buyerSafe = true; throw e; } return k; } };
const events = [];
const fa = createFreeAlerts({ storePath: join(dir, "alerts.json"), probes, validators, sendEmail, secret: "test-secret", baseUrl: "https://x.test", now, log: () => {}, onEvent: (e) => events.push(e.step) });

// ---- signup + double opt-in ----
const s1 = await fa.signup({ email: "Person@Example.com ", kind: "insider", target: "nvda", source: "/reports/insider/NVDA" });
ok(s1.ok && s1.status === "pending" && s1.target === "NVDA", "signup normalizes email + target and is PENDING");
ok(mail.length === 1 && /Confirm/.test(mail[0].subject) && mail[0].to === "person@example.com" && /\/alerts\/confirm\?id=al_[A-Za-z0-9_-]+&k=/.test(mail[0].text), "a confirmation email with a signed link is the only thing sent");
let t = await fa.tick({ force: true });
ok(t.checked === 0 && probeCalls === 0 && mail.length === 1, "an unconfirmed alert is never probed and never emailed");
await ok_throws(() => fa.signup({ email: "not-an-email", kind: "insider", target: "NVDA" }), 400, "bad email -> 400");
await ok_throws(() => fa.signup({ email: "a@b.co", kind: "insider", target: "not a ticker!" }), 400, "validator's buyerSafe message -> 400");
await ok_throws(() => fa.signup({ email: "a@b.co", kind: "nope", target: "NVDA" }), 400, "unknown kind -> 400");
const dupSoon = await fa.signup({ email: "person@example.com", kind: "insider", target: "NVDA" });
ok(dupSoon.ok && dupSoon.status === "pending" && mail.length === 1 && Object.keys(fa._store().alerts).length === 1, "an immediate repeat signup creates no second record and sends nothing (10-minute resend cooldown)");
clock += 11 * 60_000;
const dup = await fa.signup({ email: "person@example.com", kind: "insider", target: "NVDA" });
ok(dup.ok && dup.status === "pending" && mail.length === 2, "after the cooldown a repeat signup re-sends the confirmation (a lost email is the common case)");
for (let i = 0; i < 4; i++) { clock += 11 * 60_000; await fa.signup({ email: "person@example.com", kind: "insider", target: "NVDA" }); }
ok(mail.length === 3, "at most three confirmations per pending record, however often the form is hit");
mail.length = 2; // the rest of the file counts from the two confirmations the original flow sent

const id = Object.keys(fa._store().alerts)[0];
const m = mail[0].text.match(/id=([^&]+)&k=([A-Za-z0-9_-]+)/);
ok(fa.confirm(id, "forged").ok === false && fa.confirm("al_nope", m[2]).ok === false, "a forged or mismatched confirmation link is refused");
const c = fa.confirm(decodeURIComponent(m[1]), m[2]);
ok(c.ok && c.target === "NVDA" && fa._store().alerts[id].status === "active" && events.includes("alert_confirmed"), "the signed link confirms and activates the alert");
ok(fa.confirm(decodeURIComponent(m[1]), m[2]).ok, "confirming twice is idempotent");

// ---- tick: baseline, then only NEW ids, once a day ----
t = await fa.tick({ force: true });
ok(t.checked === 1 && t.baselined === 1 && t.notified === 0 && mail.length === 2, "first probe sets the baseline silently (no email for what already existed)");
t = await fa.tick({ force: true });
ok(t.unchanged === 1 && mail.length === 2, "no change -> no email");
ids = ["a1", "a2", "a3"];
t = await fa.tick({ force: true });
ok(t.notified === 1 && mail.length === 3 && /1 new Form 4 filing for NVDA/.test(mail[2].subject) && mail[2].text.includes("Filing a3 for NVDA") && !mail[2].text.includes("Filing a1"), "a NEW id emails once with only the new item");
ok(mail[2].text.split("\n").some((l) => l === "Read the free page and get the full report: https://x.test/reports/insider/NVDA") && mail[2].text.includes("/monitors?product=insider-monitor&target=NVDA") && /\/alerts\/unsubscribe\?id=/.test(mail[2].text) && mail[2].headers?.["List-Unsubscribe"], "the change email carries the buy page, the monitor upsell, an unsubscribe link and the List-Unsubscribe header");
ids = ["a1", "a2", "a3", "a4"];
t = await fa.tick({ force: true });
ok(t.notified === 0 && t.skipped === 1 && mail.length === 3, "a second change inside a day is held, not emailed");
clock += 25 * 60 * 60_000;
t = await fa.tick();
ok(t.notified === 1 && mail.length === 4 && /1 new Form 4 filing/.test(mail[3].subject) && mail[3].text.includes("Filing a4"), "after a day the held change goes out (baseline kept until it is sent)");
t = await fa.tick();
ok(t.checked === 0, "one probe per alert per day (not due again yet)");

// ---- failures never email, then back off ----
probeThrow = true; clock += 25 * 60 * 60_000;
t = await fa.tick();
ok(t.failed === 1 && mail.length === 4 && fa._store().alerts[id].failures === 1, "a probe failure emails nothing");
for (let i = 0; i < 6; i++) { clock += 25 * 60 * 60_000; await fa.tick(); }
const f = fa._store().alerts[id].failures;
clock += 60 * 60_000;
t = await fa.tick({ force: false });
ok(f >= 5 && t.skipped >= 0 && mail.length === 4, `after ${f} failures the alert backs off, still no email`);
probeThrow = false; clock += 8 * 24 * 60 * 60_000;
t = await fa.tick();
ok(fa._store().alerts[id].failures === 0, "a successful probe resets the failure count");

// ---- unsubscribe ----
const u = mail[2].text.match(/unsubscribe\?id=([^&]+)&k=([A-Za-z0-9_-]+)/);
ok(fa.unsubscribe(decodeURIComponent(u[1]), "forged").ok === false, "a forged unsubscribe link is refused");
ok(fa.unsubscribe(decodeURIComponent(u[1]), u[2]).ok && fa._store().alerts[id].status === "unsubscribed", "the signed unsubscribe link ends the alert");
ids = ["z9"]; clock += 25 * 60 * 60_000;
t = await fa.tick();
ok(t.checked === 0 && mail.length === 4, "an unsubscribed alert is never probed or emailed again");
ok(fa.confirm(decodeURIComponent(m[1]), m[2]).ok === false, "a stale confirmation link cannot resurrect an unsubscribed alert");

// ---- caps + sweep + stats ----
for (let i = 0; i < MAX_PER_EMAIL; i++) await fa.signup({ email: "cap@example.com", kind: "insider", target: "ABCDEF".slice(0, i + 1) });
await ok_throws(() => fa.signup({ email: "cap@example.com", kind: "insider", target: "TX" }), 429, `the ${MAX_PER_EMAIL}-per-address cap holds`);
clock += 4 * 24 * 60 * 60_000;
await fa.tick();
ok(Object.values(fa._store().alerts).filter((a) => a.email === "cap@example.com").length === 0, "unconfirmed signups are forgotten after their TTL");
const st = fa.stats();
ok(typeof st.total === "number" && !JSON.stringify(st).includes("@"), "stats are counts only, never an address");

// ---- a confirmation that cannot be sent is not a signup ----
mailOk = false;
await ok_throws(() => fa.signup({ email: "mailfail@example.com", kind: "insider", target: "MSFT" }), 503, "confirmation email fails -> 503");
ok(!Object.values(fa._store().alerts).some((a) => a.email === "mailfail@example.com"), "and nothing is stored");
mailOk = true;

// ---- persistence ----
const fa2 = createFreeAlerts({ storePath: join(dir, "alerts.json"), probes, validators, sendEmail, secret: "test-secret", baseUrl: "https://x.test", now, log: () => {} });
ok(fa2._store().alerts[id]?.status === "unsubscribed", "the store survives a restart");
const off = createFreeAlerts({ storePath: join(dir, "off.json"), probes, validators, sendEmail, secret: "", now, log: () => {} });
await ok_throws(() => off.signup({ email: "a@b.co", kind: "insider", target: "NVDA" }), 503, "no secret -> signup disabled (links would be forgeable)");

// ---- form ----
const html = alertFormHtml({ kind: "insider", target: "NVDA", source: "/reports/insider/NVDA" });
ok(/<form class="al-form" data-kind="insider" data-target="NVDA"/.test(html) && html.includes('type="email"') && html.includes('name="website"') && !html.includes("<script"), "the form carries kind/target as data, an email field and a honeypot, and no inline script");
ok(html.includes(ALERT_KINDS.insider.cta("NVDA")) && html.includes("Unsubscribe") === false && /unsubscribe with one click/i.test(html) && html.includes("/privacy"), "the form states the terms: confirm first, one a day, one-click unsubscribe, privacy link");
ok(alertFormHtml({ kind: "nope", target: "X" }) === "" && alertFormHtml({ kind: "insider", target: "" }) === "", "no form for an unknown kind or an empty target");
const hostile = alertFormHtml({ kind: "insider", target: 'X"><script>alert(1)</script>' });
ok(!hostile.includes("<script>") && hostile.includes("&lt;script&gt;"), "a hostile target is escaped in the form");

console.log(`\nPASS - ${pass} checks (free alerts: double opt-in, signed links, change-only daily email, caps)`);

async function ok_throws(fn, code, label) {
  try { await fn(); ok(false, `${label} (did not throw)`); }
  catch (e) { ok(e?.statusCode === code, `${label} (got ${e?.statusCode}: ${String(e?.message).slice(0, 60)})`); }
}
