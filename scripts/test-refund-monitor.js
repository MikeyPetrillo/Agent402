// Offline proof for the refund-ledger monitor.
//
// This alarm exists for the states nobody is watching: the executor is
// dispatch-only, so a human is present whenever it RUNS. What it must catch is
// a row STUCK in `sending` — where a send began and never resolved, so money
// may already be gone with no recorded tx and nothing will retry by design —
// and debts left OWED, each of which is a buyer who paid and got nothing.
//
// The failure mode being guarded against is the charged-failure alarm's: an
// alarm that reports "fine" because it could not look, or because its
// condition can never fire.
import { classifyLedger } from "./refund-monitor.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const MIN = 60_000, HOUR = 3_600_000;
const NOW = Date.parse("2026-08-05T12:00:00Z");
const row = (o) => ({ id: 1, status: "owed", createdAt: NOW - HOUR, ...o });
const totals = (o = {}) => ({ owed: { n: 0, usd: 0 }, sending: { n: 0, usd: 0 }, paid: { n: 0, usd: 0 }, void: { n: 0, usd: 0 }, ...o });

// 1. An empty ledger is clean — the normal state, and it must not cry wolf.
{
  const v = classifyLedger({ totals: totals(), rows: [], now: NOW });
  ok(v.level === "clean", "an empty ledger is clean");
  ok(/owed 0/.test(v.summary) && /paid 0/.test(v.summary), "the summary still reports every bucket");
}

// 2. THE LOUD ONE. A row claimed and never resolved: the send began, and the
//    claim guard that prevents double-sends also prevents any retry.
{
  const v = classifyLedger({
    totals: totals({ sending: { n: 1, usd: 0.001 } }),
    rows: [row({ id: 7, status: "sending", createdAt: NOW - 2 * HOUR })], now: NOW,
  });
  ok(v.level === "attention", "a long-stuck sending row raises attention");
  ok(/STUCK/.test(v.reasons[0]) && /#7/.test(v.reasons[0]), "it names the id so a human can resolve it");
  ok(/may already have left/.test(v.reasons[0]), "and says plainly that money may already be gone");
}

// 3. A run IN FLIGHT is not a fault. Claim-then-send takes seconds; alarming on
//    it would page on every healthy live run.
{
  const v = classifyLedger({
    totals: totals({ sending: { n: 1 } }),
    rows: [row({ id: 8, status: "sending", createdAt: NOW - 30_000 })], now: NOW,
  });
  ok(v.level === "clean", "a freshly-claimed row (30s) is in flight, not stuck");
}
{
  const v = classifyLedger({
    totals: totals({ sending: { n: 1 } }),
    rows: [row({ id: 9, status: "sending", createdAt: NOW - 31 * MIN })], now: NOW, stuckAfterMin: 30,
  });
  ok(v.level === "attention", "past the grace window it IS stuck");
}

// 4. Debts left unpaid. Fresh ones are fine — the executor is dispatch-only, so
//    a debt legitimately waits for a human — but an ageing one is a buyer who
//    paid and got nothing.
{
  const fresh = classifyLedger({ totals: totals({ owed: { n: 3, usd: 0.01 } }), rows: [row({ createdAt: NOW - HOUR })], now: NOW });
  ok(fresh.level === "clean", "a debt owed for an hour does not page");
  const old = classifyLedger({
    totals: totals({ owed: { n: 3, usd: 0.01 } }),
    rows: [row({ id: 2, createdAt: NOW - 72 * HOUR }), row({ id: 3, createdAt: NOW - HOUR })],
    now: NOW, owedAgeHours: 48,
  });
  ok(old.level === "attention", "a debt older than the window does page");
  ok(/oldest 72h/.test(old.reasons[0]), `it reports the OLDEST age, not the newest (${old.reasons[0].slice(0, 60)})`);
}

// 5. NEVER ADDRESSES. This writes to a public issue; a roster of who we owe is
//    a customer list — the rule that retired the revenue digest.
{
  const v = classifyLedger({
    totals: totals({ sending: { n: 1 }, owed: { n: 1 } }),
    rows: [
      row({ id: 5, status: "sending", createdAt: NOW - 2 * HOUR, payer: "0xVICTIM0000000000000000000000000000000001" }),
      row({ id: 6, status: "owed", createdAt: NOW - 99 * HOUR, payer: "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE" }),
    ], now: NOW,
  });
  const text = [v.summary, ...v.reasons].join(" ");
  ok(!/0xVICTIM/i.test(text), "no EVM address reaches the issue body");
  ok(!/C7IIHG7SPL/i.test(text), "no base32 address reaches the issue body");
  ok(/#5/.test(text), "ids ARE included - they are the operator's private lookup key");
}

// 6. Paid rows are reported, never alarmed — that is the pipeline working.
{
  const v = classifyLedger({ totals: totals({ paid: { n: 4, usd: 0.02 } }), rows: [row({ status: "paid" })], now: NOW });
  ok(v.level === "clean", "successful refunds do not raise an alarm");
  ok(/paid 4 \(\$0.02\)/.test(v.summary), "but they ARE surfaced in the summary");
}

// 7. Resolved rows never trigger anything, however old.
{
  const v = classifyLedger({
    totals: totals({ paid: { n: 1 }, void: { n: 1 } }),
    rows: [row({ status: "paid", createdAt: NOW - 999 * HOUR }), row({ status: "void", createdAt: NOW - 999 * HOUR })],
    now: NOW,
  });
  ok(v.level === "clean", "ancient paid/void rows are settled history, not a fault");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
