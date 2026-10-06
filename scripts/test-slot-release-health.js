#!/usr/bin/env node
// The slot-release pass went silent in production (2026-10-06): about 200
// dead quick-tunnel submissions past their 3-day window were still holding
// slots, 51 more had no registration row (and the pass only reads rows), the
// tunnel share sat over its cap so new tunnel sellers were refused, and the
// log said nothing about why. This pins the three repairs: a submitted origin
// with no row gets one and ages out like everyone else, every crawl cycle logs
// what the release did or why it did not, and the operator view shows how
// full the door is.
import { readFileSync } from "node:fs";
import { selectReleasableOrigins, submissionSlotStatus } from "../src/x402-index.js";
import { ensureSellerRegistrations, getSellerRegistrations, deleteSellerRegistration, recordSellerRegistrationSeen } from "../src/stats.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const DAY = 86_400_000;

// --- a rowless submission gets a row, and a real row is never overwritten ----
{
  const fresh = `https://zz-rowless-${Date.now()}.trycloudflare.com`;
  const real = `https://zz-real-${Date.now()}.example`;
  try {
    recordSellerRegistrationSeen(real);
    const before = getSellerRegistrations().find((r) => r.origin === real);
    const added = ensureSellerRegistrations([fresh, real]);
    const rows = getSellerRegistrations();
    const f = rows.find((r) => r.origin === fresh), r = rows.find((x) => x.origin === real);
    ok(added === 1, `only the origin with no row gets one (added ${added})`);
    ok(f && f.last_routable_seen == null && f.first_seen > 0, "the new row is never-routable, with first_seen set, so it ages out by first_seen");
    ok(r && r.first_seen === before.first_seen && r.last_routable_seen === before.last_routable_seen, "an existing row keeps its own dates");
    ok(ensureSellerRegistrations([fresh]) === 0, "a second pass adds nothing");
    // The release rule then frees it once a never-answering tunnel is 3 days old.
    const aged = { ...f, first_seen: f.first_seen - 4 * DAY };
    const out = selectReleasableOrigins({ registrations: [aged], isSubmitted: () => true, hasSettled: () => false, cycleOkFraction: 1, now: Date.now() });
    ok(out.join() === fresh, "a rowless dead tunnel is released after its 3-day window once it has a row");
  } finally { deleteSellerRegistration(fresh); deleteSellerRegistration(real); }
}

// --- the cycle reports what the release did, and one failing step cannot skip it ---
{
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const L = src.indexOf("async function runCrawl()");
  const body = src.slice(L, src.indexOf("\n}\n", L));
  ok(/console\.log\(`\[x402-index\] cycle \$\{crawlCycle\}: probed/.test(body), "every crawl cycle logs one line with the release outcome");
  ok(/try \{ recordSubmittedSellerObservations\(\); \} catch/.test(body), "a throw in the observation pass is caught on its own");
  ok(/try \{ release = releaseDeadSubmissions\(fraction\); \} catch/.test(body), "a throw in the release pass is caught and reported, not swallowed");
  ok(/ensureSellerRegistrations\(/.test(body), "rowless submissions get their row every cycle");
  const rel = src.slice(src.indexOf("function releaseDeadSubmissions("), src.indexOf("function releaseDeadSubmissions(") + 1400);
  ok(/outage guard: cycle ok/.test(rel) && /nothing past its idle window/.test(rel), "a skipped release names its reason (outage guard, or nothing eligible)");
}

// --- the operator view shows how full the door is -----------------------------
{
  const s = submissionSlotStatus();
  ok(["submitted", "cap", "tunnels", "tunnelCap", "lastReleaseAt", "lastCycle"].every((k) => k in s), `slot status carries submitted/cap/tunnels/tunnelCap/lastReleaseAt/lastCycle (${Object.keys(s).join(",")})`);
  ok(s.tunnelCap === Math.floor(s.cap * 0.25) || s.tunnelCap > 0, "the tunnel cap is reported beside the total");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/slots: submissionSlotStatus\(\)/.test(server), "/__operator/seller-registrations.json carries the slot status");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
