#!/usr/bin/env node
// Post-purchase follow-up sequence (src/followups.js) - offline, stubbed mail.
// Pins: at most two follow-ups per purchase and only when due, a kind with no
// monitor skips the monitor step silently, the stop link and a repeat purchase
// end the sequence, the failure email goes out at once with the refund state,
// idempotent enqueue, signed links, counts-only stats, bounded store.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createFollowups, STEP_DELAYS_MS, ADDRESS_MAX_AGE_MS, MAX_SEND_FAILURES, RECORD_KEEP_MS } from "../src/followups.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };
const dir = mkdtempSync(join(tmpdir(), "followups-"));
let clock = 1_800_000_000_000; const now = () => clock;
const mail = []; let mailOk = true;
const sendEmail = async (m) => { mail.push(m); return mailOk; };
const monitorFor = (kind) => (kind === "domain" ? { product: "domain-monitor", label: "Domain security monitor", priceUsd: "$5" } : null);
const samples = () => [{ product: "dossier", label: "Company due-diligence dossier", url: "https://x.test/reports/sample/dossier" }];
const events = [];
const fu = createFollowups({ storePath: join(dir, "f.json"), sendEmail, monitorFor, samples, secret: "s3", baseUrl: "https://x.test", now, log: () => {}, onEvent: (e) => events.push(e.step) });
const DAY = 24 * 60 * 60_000;

const r1 = fu.enqueue({ sessionId: "cs_1", email: "Buyer@Example.com", product: "domain-audit", kind: "domain", label: "Domain security audit", input: "example.com" });
ok(r1 && r1.email === "buyer@example.com" && fu.enqueue({ sessionId: "cs_1", email: "x@y.z" }) === r1, "enqueue normalizes the address and is idempotent on the session");
ok(mail.length === 0 && (await fu.tick()).monitor === 0, "nothing is sent on delivery day (the report-ready email is the only day-0 mail)");
clock += STEP_DELAYS_MS.monitor - 60_000;
ok((await fu.tick()).monitor === 0 && mail.length === 0, "not due yet -> nothing");
clock += 120_000;
let t = await fu.tick();
ok(t.monitor === 1 && mail.length === 1 && /Keep example.com watched/.test(mail[0].subject) && mail[0].text.includes("/monitors?product=domain-monitor&target=example.com") && /followups\/stop\?id=cs_1&k=/.test(mail[0].text) && mail[0].headers["List-Unsubscribe"], "day 2: the monitor offer for the same target with a signed stop link and List-Unsubscribe");
ok((await fu.tick()).monitor === 0 && mail.length === 1, "the monitor offer is sent once");
clock += STEP_DELAYS_MS.another - STEP_DELAYS_MS.monitor + 1000;
t = await fu.tick();
ok(t.another === 1 && mail.length === 2 && /Another report\?/.test(mail[1].subject) && mail[1].text.split("\n").some((l) => l === "- Company due-diligence dossier: https://x.test/reports/sample/dossier") && mail[1].text.includes("/reports"), "day 7: the 'another report' email points at the free samples and the storefront");
clock += 30 * DAY;
ok((await fu.tick()).another === 0 && mail.length === 2, "after both steps the sequence is silent for good");

// a kind with no monitor skips the monitor step, still gets day 7
fu.enqueue({ sessionId: "cs_2", email: "r@example.com", product: "research", kind: "research", label: "Deep research report", input: "airlines" });
clock += STEP_DELAYS_MS.monitor + 1000;
t = await fu.tick();
ok(t.skipped === 1 && mail.length === 2 && fu._store().seqs.cs_2.sent.monitor === "no-monitor", "no monitor for the kind -> the step is skipped silently, nothing sent");
clock += STEP_DELAYS_MS.another;
t = await fu.tick();
ok(t.another === 1 && mail.length === 3 && mail[2].to === "r@example.com", "the day-7 email still goes to a research buyer");

// stop link
fu.enqueue({ sessionId: "cs_3", email: "s@example.com", product: "dossier", kind: "domain", label: "Dossier", input: "acme.com" });
const m = fu.stop("cs_3", "forged");
ok(m.ok === false, "a forged stop link is refused");
clock += STEP_DELAYS_MS.monitor + 1000;
await fu.tick();
const link = mail[mail.length - 1].text.match(/stop\?id=([^&]+)&k=([A-Za-z0-9_-]+)/);
ok(link && fu.stop(decodeURIComponent(link[1]), link[2]).ok && fu._store().seqs.cs_3.stopped === true, "the signed stop link ends the sequence");
clock += 10 * DAY;
const before = mail.length;
await fu.tick();
ok(mail.length === before, "a stopped sequence sends nothing more");

// repeat buyer
fu.enqueue({ sessionId: "cs_4", email: "again@example.com", product: "dossier", kind: "domain", label: "Dossier", input: "one.com" });
ok(fu.markRepeat("Again@Example.com") === 1 && fu._store().seqs.cs_4.stopped && fu._store().seqs.cs_4.stoppedReason === "repeat-buyer", "a repeat purchase stops the open sequence (never re-sold what they already buy)");

// failure email
mail.length = 0;
ok(await fu.sendFailed({ email: "f@example.com", label: "FDA recall report", refunded: true }) && /could not be completed/.test(mail[0].subject) && /refunded in full/.test(mail[0].text), "a failed report emails the buyer at once with the refund state");
ok(await fu.sendFailed({ email: "f@example.com", label: "FDA recall report", refunded: false }) && /being processed/.test(mail[1].text), "an owed refund says so instead of claiming it was paid");

// mail failure leaves the step unsent for the next tick
mailOk = false;
fu.enqueue({ sessionId: "cs_5", email: "m@example.com", product: "dossier", kind: "domain", label: "Dossier", input: "two.com" });
clock += STEP_DELAYS_MS.monitor + 1000;
t = await fu.tick();
ok(t.failed === 1 && !fu._store().seqs.cs_5.sent.monitor, "a mail failure leaves the step pending (retried next tick), never marks it sent");
mailOk = true;

// stats, persistence, disabled
const st = fu.stats();
ok(st.total === 4 && !fu._store().seqs.cs_1 && !JSON.stringify(st).includes("@"), "stats are counts only (cs_1, finished over 30 days ago, was removed)");
const fu2 = createFollowups({ storePath: join(dir, "f.json"), sendEmail, monitorFor, samples, secret: "s3", now, log: () => {} });
ok(fu2._store().seqs.cs_2?.sent.another, "the store survives a restart");
const off = createFollowups({ storePath: join(dir, "off.json"), sendEmail, secret: "", now, log: () => {} });
ok(off.enqueue({ sessionId: "x", email: "a@b.co" }) === null && (await off.sendFailed({ email: "a@b.co", label: "x" })) === false, "no secret -> nothing enqueued, nothing sent (links would be forgeable)");

// ---- address retention: deleted when the sequence ends ------------------------
{
  const d2 = mkdtempSync(join(tmpdir(), "followups-ret-"));
  const file = join(d2, "f.json");
  let c = 1_900_000_000_000; const n2 = () => c;
  const sent2 = []; let okSend = true;
  const f = createFollowups({ storePath: file, sendEmail: async (m) => { sent2.push(m); return okSend; }, monitorFor, samples, secret: "s3", now: n2, log: () => {} });
  const onDisk = () => JSON.parse(readFileSync(file, "utf8"));
  const flush = () => f.flush();
  // a: both steps sent -> the address is gone from memory and from the file
  f.enqueue({ sessionId: "ra_1", email: "keep@example.com", product: "domain-audit", kind: "domain", label: "Audit", input: "a.com" });
  c += STEP_DELAYS_MS.monitor + 1000; await f.tick();
  ok(f._store().seqs.ra_1.email === "keep@example.com", "retention: the address stays while a follow-up is still to be sent");
  c += STEP_DELAYS_MS.another; await f.tick(); await flush();
  ok(sent2.length === 2 && f._store().seqs.ra_1.email === null && !JSON.stringify(onDisk()).includes("keep@example.com"), "retention: the final follow-up deletes the stored address (memory and file)");
  // b: no monitor for the kind -> the day-7 email is still the last; address gone after it
  f.enqueue({ sessionId: "ra_2", email: "nomon@example.com", product: "research", kind: "research", label: "Research", input: "q" });
  c += STEP_DELAYS_MS.another + 1000; await f.tick(); await f.tick(); await flush();
  ok(f._store().seqs.ra_2.sent.monitor === "no-monitor" && f._store().seqs.ra_2.email === null && !JSON.stringify(onDisk()).includes("nomon@example.com"), "retention: a sequence with no monitor step deletes the address after its one email");
  // c: stop link and repeat buyer delete the address at once
  f.enqueue({ sessionId: "ra_3", email: "stop@example.com", product: "d", kind: "domain", label: "D", input: "s.com" });
  c += STEP_DELAYS_MS.monitor + 1000;
  await f.tick(); await flush();
  const lk = sent2[sent2.length - 1].text.match(/stop\?id=([^&]+)&k=([A-Za-z0-9_-]+)/);
  ok(lk && f.stop(decodeURIComponent(lk[1]), lk[2]).ok, "retention: setup, the signed stop link works");
  await flush();
  ok(f._store().seqs.ra_3.email === null && !JSON.stringify(onDisk()).includes("stop@example.com"), "retention: a stopped sequence keeps no address");
  // d: a bouncing address: MAX_SEND_FAILURES failed deliveries end the sequence and delete it
  okSend = false;
  f.enqueue({ sessionId: "ra_4", email: "bounce@example.com", product: "d", kind: "domain", label: "D", input: "b.com" });
  c += STEP_DELAYS_MS.monitor + 1000;
  for (let i = 0; i < MAX_SEND_FAILURES - 1; i++) await f.tick();
  ok(f._store().seqs.ra_4.email === "bounce@example.com" && !f._store().seqs.ra_4.stopped, `retention: ${MAX_SEND_FAILURES - 1} failed deliveries keep retrying`);
  await f.tick(); await flush();
  const r4 = f._store().seqs.ra_4;
  ok(r4.stopped && r4.stoppedReason === "undeliverable" && r4.email === null && !JSON.stringify(onDisk()).includes("bounce@example.com"), `retention: the ${MAX_SEND_FAILURES}th failed delivery ends the sequence and deletes the address`);
  const before4 = sent2.length; okSend = true; await f.tick();
  ok(sent2.filter((m) => m.to === "bounce@example.com").length === MAX_SEND_FAILURES && sent2.length === before4, "retention: an undeliverable sequence is never tried again");
  // e: a success resets the failure count
  okSend = false;
  f.enqueue({ sessionId: "ra_5", email: "flaky@example.com", product: "d", kind: "domain", label: "D", input: "f.com" });
  c += STEP_DELAYS_MS.monitor + 1000;
  for (let i = 0; i < MAX_SEND_FAILURES - 1; i++) await f.tick();
  okSend = true; await f.tick();
  ok(f._store().seqs.ra_5.failures === 0 && f._store().seqs.ra_5.email === "flaky@example.com", "retention: a delivered step resets the failure count");
  // f: backstop: whatever state a sequence is in, its address is gone ADDRESS_MAX_AGE_MS after purchase
  f.enqueue({ sessionId: "ra_6", email: "stuck@example.com", product: "d", kind: "domain", label: "D", input: "x.com" });
  f._store().seqs.ra_6.sent = { monitor: "sending:1:stuck" }; // a claim whose send never confirmed
  c += ADDRESS_MAX_AGE_MS - 1000; await f.tick();
  ok(f._store().seqs.ra_6.email === "stuck@example.com", "retention: before the backstop the stuck sequence still holds its address");
  c += 2000; await f.tick(); await flush();
  const r6 = f._store().seqs.ra_6;
  ok(r6.email === null && r6.stopped && r6.stoppedReason === "expired" && !JSON.stringify(onDisk()).includes("stuck@example.com"), "retention: ADDRESS_MAX_AGE_MS after purchase the address is deleted whatever the state");
  // g: finished records leave the store RECORD_KEEP_MS after purchase
  c += RECORD_KEEP_MS; await f.tick(); await flush();
  ok(Object.keys(f._store().seqs).length === 0 && Object.keys(onDisk().seqs).length === 0, "retention: finished records are removed after RECORD_KEEP_MS");
  ok(ADDRESS_MAX_AGE_MS > STEP_DELAYS_MS.another + 2 * DAY, "retention: the backstop leaves room for the last step to be sent");
}

console.log(`\nPASS - ${pass} checks (post-purchase follow-ups: two emails at most, stoppable, failure notice)`);
