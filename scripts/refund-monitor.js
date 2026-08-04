#!/usr/bin/env node
// Watch the refund ledger for the states that need a human.
//
//   AGENT402_OPERATOR_TOKEN=… node scripts/refund-monitor.js
//
// The refund executor is dispatch-only, so a person is watching whenever it
// RUNS. The states that matter are the ones that arise when nobody is:
//
//   STUCK   a row sat in `sending` past the grace window. The claim happens
//           BEFORE the broadcast, so this means a send began and never
//           resolved - the money may already be gone with no recorded tx. It
//           cannot self-heal: the claim guard that prevents double-sends also
//           prevents retries, deliberately. This is the loudest state and the
//           only one that can silently cost money twice if mishandled.
//   OWED    debts are on the books and nobody has repaid them. Each row is a
//           buyer who paid and got nothing. Ageing matters more than count.
//   PAID    money left. Reported, never alarmed - it is the pipeline working.
//
// COUNTS AND AGES ONLY, NEVER ADDRESSES. This writes to a PUBLIC issue on a
// public repo, and a roster of who we owe is a customer list - the same rule
// that retired the revenue digest. The operator resolves ids to wallets
// privately through /__operator/refunds.json.
//
// Exit codes: 0 clean, 1 needs attention (the workflow opens an issue), 2 the
// ledger could not be read - which is NOT "clean", because an unreadable
// ledger and an empty one look identical and that confusion is how the
// charged-failure alarm sat dead for months.

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const TOKEN = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
// How long a row may legitimately sit in `sending`. A live run holds a row for
// seconds; anything past this means the run died mid-send.
const STUCK_AFTER_MIN = Number(process.env.REFUND_STUCK_AFTER_MIN || "30");
// How long a debt may sit unpaid before it is worth a nudge. Generous: the
// executor is dispatch-only and a real debt may wait for a human to run it.
const OWED_AGE_HOURS = Number(process.env.REFUND_OWED_AGE_HOURS || "48");

const hrs = (ms) => Math.round((ms / 3_600_000) * 10) / 10;

/**
 * Pure classifier - exported so the states can be tested without a server.
 * `rows` is the ledger listing; `totals` the aggregate. Returns
 * `{ level, reasons[], summary }` where level is "clean" | "attention".
 */
export function classifyLedger({ totals = {}, rows = [], now = Date.now(),
  stuckAfterMin = STUCK_AFTER_MIN, owedAgeHours = OWED_AGE_HOURS } = {}) {
  const reasons = [];
  const t = (k) => (totals?.[k] && typeof totals[k].n === "number" ? totals[k] : { n: 0, usd: 0 });

  // STUCK: claimed but never resolved. Age-gated so a run in flight right now
  // is not reported as broken.
  const sending = rows.filter((r) => r.status === "sending");
  const stuck = sending.filter((r) => now - Number(r.createdAt || 0) > stuckAfterMin * 60_000);
  if (stuck.length) {
    reasons.push(
      `${stuck.length} refund(s) STUCK in \`sending\` for over ${stuckAfterMin}m ` +
      `(ids ${stuck.map((r) => `#${r.id}`).join(", ")}). A send began and never resolved - ` +
      `the money may already have left with no recorded tx. These never retry by design; ` +
      `check the chain, then resolve each with paid+tx or void+note.`,
    );
  }

  // OWED: real buyers waiting. Report the OLDEST age, since one ancient debt
  // matters more than many fresh ones.
  const owed = rows.filter((r) => r.status === "owed");
  const oldest = owed.reduce((a, r) => Math.min(a, Number(r.createdAt) || now), now);
  if (owed.length && now - oldest > owedAgeHours * 3_600_000) {
    reasons.push(
      `${owed.length} debt(s) owed, oldest ${hrs(now - oldest)}h - past the ${owedAgeHours}h window. ` +
      `Each is a buyer who paid and received nothing. Dispatch refund.yml (dry run first).`,
    );
  }

  const summary =
    `owed ${t("owed").n} ($${t("owed").usd}) · sending ${t("sending").n} · ` +
    `paid ${t("paid").n} ($${t("paid").usd}) · void ${t("void").n}`;
  return { level: reasons.length ? "attention" : "clean", reasons, summary };
}

async function main() {
  if (!TOKEN) { console.error("AGENT402_OPERATOR_TOKEN is required"); process.exit(2); }
  let totals, rows;
  try {
    const [aRes, bRes] = await Promise.all([
      fetch(`${TARGET}/__operator/refunds.json?status=all&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      fetch(`${TARGET}/__operator/refunds.json?status=sending&limit=500`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
    ]);
    if (!aRes.ok) throw new Error(`refunds.json HTTP ${aRes.status}`);
    const a = await aRes.json();
    totals = a.totals;
    rows = a.refunds || [];
    // `all` is capped, so pull `sending` separately - the rows that matter most
    // must never fall off the end of a page.
    if (bRes.ok) {
      const b = await bRes.json();
      const ids = new Set(rows.map((r) => r.id));
      for (const r of b.refunds || []) if (!ids.has(r.id)) rows.push(r);
    }
  } catch (e) {
    // Unreadable is NOT clean. Saying "no problems" because we could not look
    // is exactly how the charged-failure alarm stayed dead for months.
    console.error(`refund-monitor: could not read the ledger - ${e.message}`);
    process.exit(2);
  }

  const v = classifyLedger({ totals, rows });
  console.log(`refund ledger: ${v.summary}`);
  if (v.level === "clean") { console.log("refund-monitor OK - nothing needs a human."); return; }
  console.error("\nREFUND LEDGER NEEDS ATTENTION:");
  for (const r of v.reasons) console.error(`  - ${r}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
