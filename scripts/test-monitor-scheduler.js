// Monitor scheduler test - offline, stubbed report pipeline / probes /
// EDGAR / email, injected clock. Proves the cost + delivery invariants:
//   - first sight = welcome report + email; a quiet domain is re-probed FREE
//     daily and never regenerated; the 30-day full re-run fires on schedule;
//   - a fingerprint change triggers a full re-run with the diff in the email,
//     bounded by the 12h anti-flap gap (alert-only, no paid re-run inside it);
//   - a TLS certificate inside the alert window alerts ONCE per certificate;
//   - fund: manager resolved once, latest 13F accession polled cheaply, a NEW
//     accession = one full report + "filing" email, the same accession = nothing;
//     the accession only advances after a SUCCESSFUL report;
//   - failure = backoff, no email, retried later; per-tick paid cap defers;
//   - canceled subs are not processed; reports are served by id; the shared
//     lock makes a second owner skip; state persists across instances.
import { createMonitorScheduler, describeDomainChanges, DOMAIN_CHECK_MS, DOMAIN_FULL_MS, MIN_FULL_GAP_MS, MAX_FULL_PER_TICK, LOCK_STALE_MS, MAX_FULL_PER_SUB_30D } from "../src/monitor-scheduler.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";

const STORE = join("/tmp", `test-monitors-${process.pid}.json`);
try { rmSync(STORE); } catch { /* first run */ }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };
const HOUR = 3600_000, DAY = 24 * HOUR;

// --- stubs -----------------------------------------------------------------
let clock = Date.parse("2026-09-01T12:00:00Z");
const now = () => clock;
const active = new Map(); // subId -> rec
const subs = { listActive: () => [...active.values()].filter((r) => r.status === "active"), get: (id) => active.get(id) || null };

const calls = { generate: [], probe: [], filing: [], resolve: [], mail: [] };
let generateFail = false;
const generate = async (kind, slug, input) => {
  calls.generate.push({ kind, slug, input });
  if (generateFail) throw new Error("upstream 502 (not charged)");
  return { report: `# Report ${kind} ${JSON.stringify(input)}\n\nbody`, title: `T:${kind}`, sources: [{ title: "s", url: "https://x" }], tables: [] };
};
let signals = { grade: "B", composite: 82, assessed: ["email auth", "security headers", "TLS"], spf: "present:~all:valid=true", dmarc: "p=none:pct=100:valid=true", dkim: ["s1:2048"], mx: 2, headers: ["strict-transport-security"], tls_issuer: "R3", tls_valid_to: "2026-12-01", tls_days_remaining: 90 };
const fpOf = (s) => { const { tls_days_remaining: _d, tls_issuer: _i, tls_valid_to: _v, ...rest } = s; return JSON.stringify(rest); };
let probeFail = false;
const probeDomain = async (domain) => { calls.probe.push(domain); if (probeFail) throw new Error("all probes failed"); return { domain, signals: { ...signals }, fingerprint: fpOf(signals) }; };
const normDomain = (t) => { const d = String(t).toLowerCase(); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error("bad domain"); return d; };
let accession = "0001-26-000001";
const latestFiling = async ({ cik }) => { calls.filing.push(cik); return { cik, managerName: "FUND X", accessionNumber: accession, filedDate: "2026-08-14", reportDate: "2026-06-30" }; };
const resolveManager = async (a) => { calls.resolve.push(a); return { cik: "0001067983", name: "FUND X" }; };
const notify = async (m) => { calls.mail.push(m); return true; };
let recallItems = [{ recallNumber: "D-1", firm: "Acme", classification: "Class II", product: "Losartan", reason: "impurity", recallInitiated: "2026-08-01" }];
const probeRecalls = async (q) => { calls.recalls = (calls.recalls || 0) + 1; return { query: q, items: recallItems, ids: recallItems.map((x) => x.recallNumber).sort(), fingerprint: "" }; };
let ipoRows = [{ stage: "priced", name: "Newco", accessionNumber: "A-1" }];
const probeIpos = async () => { calls.ipos = (calls.ipos || 0) + 1; return { rows: ipoRows, ids: ipoRows.map((r) => r.accessionNumber) }; };
let form4 = [{ accessionNumber: "F-1", filedDate: "2026-08-01", displayNames: ["COOK TIM (CIK 1)"] }];
const probeInsiderFilings = async () => { calls.form4 = (calls.form4 || 0) + 1; return { filings: form4, ids: form4.map((f) => f.accessionNumber).sort() }; };

const mk = (opts = {}) => createMonitorScheduler({ subs, generate, probeDomain, normDomain, latestFiling, resolveManager, notify, probeRecalls, probeIpos, probeInsiderFilings, baseUrl: "https://agent402.tools", storePath: STORE, now, ownerId: "A", log: () => {}, sleep: async () => {}, manageUrlFor: (id) => `https://agent402.tools/monitors/manage?report=${id}&k=TOKEN`, ...opts });
let sch = mk();

ok(Object.values(MONITOR_PRODUCTS).every((p) => p.slug && p.kind), "every monitor product names the report slug it runs");

// --- domain: welcome ---------------------------------------------------------
active.set("sub_d", { subId: "sub_d", status: "active", product: "domain-monitor", target: "Example.com", email: "d@x.com", customer: "cus_d" });
let r = await sch.tick();
ok(r.full === 1 && calls.generate.length === 1 && calls.generate[0].slug === "domain-audit" && calls.generate[0].input === "Example.com", "first sight: one full domain report via the domain-audit slug");
ok(calls.mail.length === 1 && calls.mail[0].reason === "welcome" && /\/m\/[A-Za-z0-9_-]{10,}$/.test(calls.mail[0].reportUrl) && calls.mail[0].to === "d@x.com", "welcome email carries a /m/<id> report link");
const welcomeId = calls.mail[0].reportUrl.split("/m/")[1];
const view = sch.reportView(welcomeId);
ok(view && view.status === "done" && view.kind === "domain" && view.monitor.reason === "welcome" && !JSON.stringify(view).includes("manage"), "the report is served by id with monitor context and NO portal bearer in the JSON");
ok(calls.mail[0].manageUrl === `https://agent402.tools/monitors/manage?report=${welcomeId}&k=TOKEN`, "the keyed manage link rides only in the email");
ok(sch.subIdOfReport(welcomeId) === "sub_d" && sch.reportView("nope") === null, "report id resolves to its subscription; unknown id is null");

// --- domain: quiet day = free probe, no regen ----------------------------------
clock += DOMAIN_CHECK_MS + 1;
r = await sch.tick();
ok(r.checked === 1 && r.full === 0 && calls.generate.length === 1 && calls.probe.length === 2, "a day later: free re-probe, no paid regeneration on an unchanged fingerprint");
clock += HOUR;
r = await sch.tick();
ok(r.skip === 1 && calls.probe.length === 2, "inside the check interval: nothing probed");

// --- domain: change -> full re-run + diff email ---------------------------------
signals = { ...signals, dmarc: "p=reject:pct=100:valid=true", grade: "A", composite: 91 };
clock += DOMAIN_CHECK_MS;
r = await sch.tick();
ok(r.full === 1 && calls.generate.length === 2, "a fingerprint change triggers a paid full re-run");
let m = calls.mail[calls.mail.length - 1];
ok(m.reason === "change" && m.changes.some((c) => /DMARC/.test(c)) && m.changes.some((c) => /grade B.*-> A/.test(c)), "the change email lists what changed (DMARC + grade)");

// --- domain: flap inside the 12h gap -> alert only, no paid re-run -----------------
// The change full ran just now; 1h later another change must NOT buy a re-run.
signals = { ...signals, headers: [] };
clock += HOUR;
r = await sch.tick({ force: true, subId: "sub_d" });
ok(r.alert === 1 && r.full === 0 && calls.generate.length === 2, "a change inside the anti-flap gap is an ALERT (no paid re-run)");
m = calls.mail[calls.mail.length - 1];
ok(m.reason === "change" && /removed strict-transport-security/.test(m.changes.join(" ")), "the alert-only email still says what changed");
// A paid re-run that FAILS after a detected change keeps the old baseline so the
// retry re-detects the change (and the retry is due after the backoff, not a day).
clock += MIN_FULL_GAP_MS + DOMAIN_CHECK_MS;
signals = { ...signals, mx: 5 };
generateFail = true;
r = await sch.tick();
ok(r.error === 1 && calls.generate.length === 3, "a failing paid re-run after a change is an error");
generateFail = false; clock += HOUR + 1;
r = await sch.tick();
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && m.reason === "change" && /MX records: 2 -> 5/.test(m.changes.join(" ")), "the retry (after the 1h backoff) re-detects the change and delivers it");

// --- domain: TLS expiring alerts once per certificate ----------------------------
// Wait out the gap + check interval so the full can run; keep fingerprint stable.
clock += MIN_FULL_GAP_MS + DOMAIN_CHECK_MS;
signals = { ...signals, tls_days_remaining: 10 };
r = await sch.tick();
ok(r.full === 1, "a certificate inside the alert window triggers a full re-run (gap satisfied)");
m = calls.mail[calls.mail.length - 1];
ok(m.reason === "tls-expiring" && /expires in 10 days/.test(m.changes[0]), "the TLS-expiry email names the days remaining");
clock += DOMAIN_CHECK_MS;
signals = { ...signals, tls_days_remaining: 9 };
const before = calls.mail.length;
r = await sch.tick();
ok(r.checked === 1 && calls.mail.length === before, "the same expiring certificate does not alert again the next day");
signals = { ...signals, tls_days_remaining: 89, tls_valid_to: "2027-03-01" };
clock += DOMAIN_CHECK_MS;
const mailsBeforeRenew = calls.mail.length;
r = await sch.tick();
ok(r.checked === 1 && calls.mail.length === mailsBeforeRenew, "a certificate RENEWAL alone is not a paid change (CDN rotation is noise) but re-arms the expiry alert");
signals = { ...signals, tls_days_remaining: 7 };
clock += DOMAIN_CHECK_MS;
r = await sch.tick();
m = calls.mail[calls.mail.length - 1];
ok(m.reason === "tls-expiring" && /expires in 7 days/.test(m.changes[0]), "...so the NEW certificate nearing expiry alerts again");
signals = { ...signals, tls_days_remaining: 80, tls_valid_to: "2027-06-01" };

// --- domain: 30-day scheduled full --------------------------------------------------
clock += DOMAIN_FULL_MS + 1;
r = await sch.tick();
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && m.reason === "scheduled", "30 days after the last full report: a scheduled re-run + email");

// --- domain: probe failure = backoff, no email; recovers later ---------------------
probeFail = true; clock += DOMAIN_CHECK_MS;
const mails = calls.mail.length;
r = await sch.tick();
ok(r.error === 1 && calls.mail.length === mails, "a failed probe is an error with no email");
clock += 10 * 60_000;
r = await sch.tick();
ok(r.skip === 1, "backoff: not retried 10 minutes later");
probeFail = false; clock += HOUR;
r = await sch.tick();
ok(r.checked === 1 && sch.status().subs[0].failures === 0, "after the backoff it retries and a success clears the failure count");

// --- fund ----------------------------------------------------------------------------
active.set("sub_f", { subId: "sub_f", status: "active", product: "fund-monitor", target: "Berkshire Hathaway", email: "f@x.com", customer: "cus_f" });
clock += HOUR;
r = await sch.tick();
const fg = calls.generate.filter((g) => g.kind === "fund");
ok(fg.length === 1 && fg[0].slug === "fund-report" && fg[0].input.cik === "0001067983" && calls.resolve.length === 1, "fund first sight: manager resolved ONCE, full report run with the pinned CIK");
m = calls.mail[calls.mail.length - 1];
ok(m.reason === "welcome" && m.to === "f@x.com", "fund welcome email sent");
clock += DAY + 1;
r = await sch.tick();
ok(calls.generate.filter((g) => g.kind === "fund").length === 1 && calls.filing.length === 2 && calls.resolve.length === 1, "same accession a day later: cheap filing check only, no report, no re-resolve");
accession = "0001-26-000002"; clock += DAY + 1;
generateFail = true;
r = await sch.tick();
ok(calls.generate.filter((g) => g.kind === "fund").length === 2 && sch.status().subs.find((s) => s.subId === "sub_f").accession === "0001-26-000001", "a new accession triggers a report; on failure the accession does NOT advance (retry later)");
generateFail = false; clock += HOUR + 1;
r = await sch.tick();
const fs = sch.status().subs.find((s) => s.subId === "sub_f");
m = calls.mail[calls.mail.length - 1];
ok(fs.accession === "0001-26-000002" && m.reason === "filing" && /0001-26-000002/.test(m.changes[0]), "the retry succeeds, the accession advances, the 'filing' email names it");

// --- cancel stops processing ----------------------------------------------------------
active.get("sub_f").status = "canceled";
clock += DAY + 1; accession = "0001-26-000003";
r = await sch.tick();
ok(calls.generate.filter((g) => g.kind === "fund").length === 3 && r.active === 1, "a canceled subscription is not processed");

// --- per-tick paid cap defers ---------------------------------------------------------
for (let i = 0; i < MAX_FULL_PER_TICK + 3; i++) active.set(`sub_b${i}`, { subId: `sub_b${i}`, status: "active", product: "domain-monitor", target: `d${i}.example.com`, email: null });
const g0 = calls.generate.length;
r = await sch.tick();
ok(calls.generate.length - g0 === MAX_FULL_PER_TICK && r.deferred >= 3, `at most ${MAX_FULL_PER_TICK} paid reports per tick; the rest are deferred`);
r = await sch.tick();
ok(calls.generate.length - g0 === MAX_FULL_PER_TICK + 3, "the deferred welcome reports run on the next tick");
for (let i = 0; i < MAX_FULL_PER_TICK + 3; i++) active.delete(`sub_b${i}`);

// --- invalid target never loops -------------------------------------------------------
active.set("sub_bad", { subId: "sub_bad", status: "active", product: "domain-monitor", target: "not a domain", email: "b@x.com" });
const gb = calls.generate.length, mb = calls.mail.length;
await sch.tick();
ok(calls.generate.length === gb && calls.mail.length === mb && sch.status().subs.find((s) => s.subId === "sub_bad").nextAttemptAt, "an invalid target is skipped (no report, no email) and parked");
active.delete("sub_bad");

// --- Stripe status re-verified before a PAID run ------------------------------------------
active.set("sub_s", { subId: "sub_s", status: "active", product: "domain-monitor", target: "s.example.com", email: "s@x.com" });
const statusSch = mk({ refreshStatus: async () => "canceled" });
const gS = calls.generate.length, mS = calls.mail.length;
r = await statusSch.tick({ force: true, subId: "sub_s" });
ok(calls.generate.length === gS && calls.mail.length === mS && r.full === 0, "a sub Stripe now reports canceled gets NO paid run and no email even though the local store says active");
const statusSch2 = mk({ refreshStatus: async () => null });
r = await statusSch2.tick({ force: true, subId: "sub_s" });
ok(calls.generate.length === gS + 1, "an unreadable Stripe status proceeds on the stored status (fail-open for delivery, the stored status is still verified-paid)");
active.delete("sub_s");

// --- per-sub 30-day paid cap -------------------------------------------------------------------
active.set("sub_c", { subId: "sub_c", status: "active", product: "domain-monitor", target: "c.example.com", email: "c@x.com" });
let capSignals = { ...signals };
const capProbe = async (d) => ({ domain: d, signals: { ...capSignals }, fingerprint: fpOf(capSignals) });
const capSch = mk({ probeDomain: capProbe });
await capSch.tick({ force: true, subId: "sub_c" }); // welcome
let fulls = 1;
for (let i = 0; i < 12; i++) {
  clock += MIN_FULL_GAP_MS + 1;
  capSignals = { ...capSignals, mx: 10 + i };
  const rr = await capSch.tick({ force: true, subId: "sub_c" });
  fulls += rr.full || 0;
}
const capRow = capSch.status().subs.find((x) => x.subId === "sub_c");
ok(fulls === MAX_FULL_PER_SUB_30D && capRow.capReached === true && capRow.fullsLast30d === MAX_FULL_PER_SUB_30D, `a flapping target is capped at ${MAX_FULL_PER_SUB_30D} paid runs per 30 days; further changes are alert-only`);
active.delete("sub_c");

// --- permanent failure notice (once) -----------------------------------------------------------
active.set("sub_p", { subId: "sub_p", status: "active", product: "fund-monitor", target: "Nonexistent Fund", email: "p@x.com" });
const failSch = mk({ resolveManager: async () => { const e = new Error("Could not confidently resolve"); e.statusCode = 404; throw e; } });
const mP = calls.mail.length;
for (let i = 0; i < 7; i++) { clock += DAY + 1; await failSch.tick({ force: true, subId: "sub_p" }); }
const pMails = calls.mail.slice(mP).filter((x) => x.reason === "problem");
ok(pMails.length === 1 && pMails[0].to === "p@x.com" && /Could not confidently resolve/.test(pMails[0].changes[0]), "after 5 consecutive failures the subscriber is told ONCE (with the manage link), not every day");
active.delete("sub_p");

// --- recall watch: welcome, free daily probe, paid run only on a NEW recall number ------------
active.set("sub_r", { subId: "sub_r", status: "active", product: "recall-monitor", target: "losartan", email: "r@x.com" });
clock += HOUR;
r = await sch.tick({ force: true, subId: "sub_r" });
let rg = calls.generate.filter((g) => g.kind === "recall");
ok(r.full === 1 && rg.length === 1 && rg[0].slug === "recall-report" && rg[0].input.query === "losartan" && rg[0].input.allowEmpty === true, "recall first sight: welcome report via recall-report (allowEmpty for a quiet term)");
ok(calls.mail[calls.mail.length - 1].reason === "welcome", "recall welcome email");
clock += DAY + 1; const rc = calls.recalls;
r = await sch.tick({ force: true, subId: "sub_r" });
ok(calls.recalls === rc + 1 && calls.generate.filter((g) => g.kind === "recall").length === 1, "a day later with the same recall numbers: free probe only, no paid run");
recallItems = [...recallItems, { recallNumber: "D-2", firm: "Beta Pharma", classification: "Class I", product: "Losartan 50mg", reason: "NDMA above limit", recallInitiated: "2026-09-10" }];
clock += DAY + 1;
r = await sch.tick({ force: true, subId: "sub_r" });
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && m.reason === "recall" && /Beta Pharma/.test(m.changes[0]) && /Class I/.test(m.changes[0]), "a NEW recall number triggers a paid re-run + a 'recall' email naming the new record");
active.delete("sub_r");

// --- ipo watch: weekly deterministic digest, no email on an empty week ------------------------
active.set("sub_i", { subId: "sub_i", status: "active", product: "ipo-monitor", target: "all", email: "i@x.com" });
clock += HOUR;
r = await sch.tick({ force: true, subId: "sub_i" });
const ig = calls.generate.filter((g) => g.kind === "ipo");
ok(r.full === 1 && ig.length === 1 && ig[0].slug === "ipo-report" && ig[0].input.days === 7 && ig[0].input.keyword === "", "ipo first sight: welcome digest for the whole market (keyword '' for target 'all')");
clock += DAY; r = await sch.tick({ subId: "sub_i" });
ok(r.skip === 1 && calls.generate.filter((g) => g.kind === "ipo").length === 1, "inside the week: nothing runs");
ipoRows = []; clock += 7 * DAY;
const mi = calls.mail.length;
r = await sch.tick({ subId: "sub_i" });
ok(r.checked === 1 && calls.mail.length === mi, "an empty week: checked, no digest, no email");
ipoRows = [{ stage: "registration", name: "Later Inc", accessionNumber: "A-2" }]; clock += 7 * DAY;
r = await sch.tick({ subId: "sub_i" });
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && m.reason === "digest" && /1 new registration/.test(m.changes[0]), "a week with filings: digest run + 'digest' email with the counts");

// --- research watch: the product IS the weekly re-run (no cheap probe) ------------------------
active.set("sub_q", { subId: "sub_q", status: "active", product: "research-monitor", target: "Which US airlines hedge jet fuel and how?", email: "q@x.com" });
clock += HOUR;
r = await sch.tick({ force: true, subId: "sub_q" });
let qg = calls.generate.filter((g) => g.kind === "research");
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && qg.length === 1 && qg[0].slug === "research" && qg[0].input === "Which US airlines hedge jet fuel and how?" && m.reason === "welcome", "research first sight: welcome run with the question as the input");
clock += 3 * DAY; r = await sch.tick({ subId: "sub_q" });
ok(r.skip === 1 && calls.generate.filter((g) => g.kind === "research").length === 1, "inside the week: nothing runs, nothing is emailed");
clock += 5 * DAY; r = await sch.tick({ subId: "sub_q" });
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && calls.generate.filter((g) => g.kind === "research").length === 2 && m.reason === "scheduled" && /Weekly re-run/.test(m.changes[0]), "a week later: a fresh paid run + 'scheduled' email");
for (let w = 0; w < 2; w++) { clock += 7 * DAY; await sch.tick({ subId: "sub_q" }); }
const qBefore = calls.generate.filter((g) => g.kind === "research").length;
clock += 7 * DAY; r = await sch.tick({ subId: "sub_q" });
ok(qBefore === 4 && r.checked === 1 && calls.generate.filter((g) => g.kind === "research").length === 4, "the 30-day cap holds a 5th weekly run (checked, not full) until old runs age out");

active.delete("sub_i");

// --- insider watch: welcome, daily free probe, paid run only on a NEW Form 4 accession ----------
active.set("sub_n", { subId: "sub_n", status: "active", product: "insider-monitor", target: "AAPL", email: "n@x.com" });
clock += HOUR;
r = await sch.tick({ force: true, subId: "sub_n" });
const ng = calls.generate.filter((g) => g.kind === "insider");
ok(r.full === 1 && ng.length === 1 && ng[0].slug === "insider-report" && ng[0].input.ticker === "AAPL", "insider first sight: welcome report via insider-report");
clock += DAY + 1; r = await sch.tick({ force: true, subId: "sub_n" });
ok(calls.generate.filter((g) => g.kind === "insider").length === 1, "same Form 4 set a day later: probe only");
form4 = [...form4, { accessionNumber: "F-2", filedDate: "2026-09-12", displayNames: ["LEVINSON ART (CIK 2)"] }]; clock += DAY + 1;
r = await sch.tick({ force: true, subId: "sub_n" });
m = calls.mail[calls.mail.length - 1];
ok(r.full === 1 && m.reason === "filing" && /LEVINSON ART/.test(m.changes[0]), "a NEW Form 4 accession triggers a paid re-run + 'filing' email naming the filer");
active.delete("sub_n");

// --- lock: a second owner skips while held; stale lock is reclaimed --------------------
const other = mk({ ownerId: "B" });
// Simulate A holding the lock: write it directly via a tick that is interrupted is hard; instead set the lock in the file.
import("node:fs").then(() => {});
{
  const fs = await import("node:fs");
  const j = JSON.parse(fs.readFileSync(STORE, "utf8"));
  j.lock = { owner: "A", at: clock };
  fs.writeFileSync(STORE, JSON.stringify(j));
  r = await other.tick();
  ok(r.skipped === "locked", "a second replica skips while another holds a fresh lock");
  j.lock = { owner: "A", at: clock - LOCK_STALE_MS - 1 };
  fs.writeFileSync(STORE, JSON.stringify(j));
  r = await other.tick();
  ok(r.skipped !== "locked", "a stale lock is reclaimed");
}

// --- persistence across instances ---------------------------------------------------------
const again = mk({ ownerId: "C" });
ok(again.reportView(welcomeId)?.title === "T:domain" && again.status().subs.find((s) => s.subId === "sub_d")?.lastReportId, "a fresh instance reads reports + per-sub state from the shared store");

// --- describeDomainChanges unit ------------------------------------------------------------
const d = describeDomainChanges({ grade: "B", composite: 80, spf: "present", dmarc: "missing", dkim: [], mx: 1, headers: ["a"], tls_issuer: "X", tls_valid_to: "1" }, { grade: "B", composite: 80, spf: "present", dmarc: "missing", dkim: [], mx: 1, headers: ["a", "b"], tls_issuer: "X", tls_valid_to: "2" });
ok(d.length === 2 && /added b/.test(d[0]) && /renewed/.test(d[1]), "describeDomainChanges reports header additions and renewals, nothing else");
ok(describeDomainChanges(null, { grade: "A" }).length === 0, "no baseline = no changes described");

try { rmSync(STORE); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
