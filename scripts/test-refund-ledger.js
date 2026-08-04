// Offline proof for the refund pipeline: the ledger (src/refund-ledger.js)
// and the planner (scripts/refund-run.js planRefunds).
//
// Money leaves a wallet at the end of this pipeline, so the tests concentrate
// on the mistakes that cost someone money or erase a debt: double-booking,
// silent write-offs, refunding the canary to ourselves, skipping caps, and
// case-folding an address on a case-sensitive rail.
process.env.REFUND_DB_DIR = process.env.TMPDIR || "/tmp";
import { recordRefundOwed, listRefunds, markRefundPaid, markRefundVoid, refundTotals, __resetRefunds } from "../src/refund-ledger.js";
import { planRefunds, familyOf } from "./refund-run.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

__resetRefunds();

// ---- ledger ----

// 1. A debt is recorded once per settle tx, however often detection fires.
{
  const row = { slug: "hash", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000001", priceUsd: 0.001, tx: "0xevidence1", httpStatus: 502 };
  ok(recordRefundOwed(row) === true, "first record creates the debt");
  ok(recordRefundOwed(row) === false, "same settle tx again is a no-op, not a second debt");
  ok(listRefunds().length === 1, "exactly one row on the books");
}

// 2. Without a tx the fallback identity still cannot double-book a burst.
{
  const row = { slug: "uuid", network: "stellar:pubnet", payer: "GBUYER", priceUsd: 0.002 };
  recordRefundOwed(row); recordRefundOwed(row);
  ok(listRefunds().filter((r) => r.slug === "uuid").length === 1, "no-tx fallback identity dedupes within the minute");
}

// 3. Addresses are stored verbatim - case-folding merges distinct buyers on
//    base58/base32 rails and misdirects a refund.
{
  recordRefundOwed({ slug: "t", network: "algorand:x", payer: "MiXeDcAsEaDdReSs", priceUsd: 0.001, tx: "algo-tx-1" });
  const r = listRefunds().find((x) => x.evidence === "algo-tx-1");
  ok(r.payer === "MiXeDcAsEaDdReSs", "payer case preserved exactly");
}

// 4. Paid requires the outbound tx; void requires a note. Neither can be
//    silent, and a resolved row cannot resolve again.
{
  const r = listRefunds().find((x) => x.evidence === "0xevidence1");
  ok(markRefundPaid(r.id, "") === false, "paid without a tx is refused");
  ok(markRefundPaid(r.id, "0xrefundtx") === true, "paid with the tx succeeds");
  ok(markRefundPaid(r.id, "0xagain") === false, "an already-paid row cannot be paid twice");
  const v = listRefunds().find((x) => x.evidence === "algo-tx-1");
  ok(markRefundVoid(v.id, "") === false, "void without a note is refused");
  ok(markRefundVoid(v.id, "test write-off") === true, "void with a note succeeds");
  const t = refundTotals();
  ok(t.paid.n === 1 && t.void.n === 1, `totals track transitions (paid ${t.paid.n}, void ${t.void.n})`);
}

// 5. Synthetic rows are recorded (the ledger reflects reality) and flagged.
{
  recordRefundOwed({ slug: "canary", network: "eip155:8453", payer: "0xburner", priceUsd: 0.001, tx: "0xsynth", synthetic: true });
  const r = listRefunds().find((x) => x.evidence === "0xsynth");
  ok(r && r.synthetic === 1, "canary self-harm lands on the books, flagged synthetic");
}

// ---- planner ----

const mk = (over) => ({ id: 1, status: "owed", slug: "hash", network: "eip155:8453", payer: "0xB", priceUsd: 0.001, synthetic: 0, ...over });
const SENDERS = { evm: true, stellar: true, algorand: true, solana: false };

// 6. The plain case sends; total is the sum.
{
  const p = planRefunds([mk({ id: 1 }), mk({ id: 2, priceUsd: 0.002 })], { senders: SENDERS });
  ok(p.send.length === 2 && p.totalUsd === 0.003, `sends both and sums the total ($${p.totalUsd})`);
}

// 7. Synthetic rows are HELD by default - refunding our own canary is churn.
{
  const p = planRefunds([mk({ synthetic: 1 })], { senders: SENDERS });
  ok(p.send.length === 0 && Object.keys(p.held).some((k) => /synthetic/.test(k)), "canary rows held, with the reason named");
  const p2 = planRefunds([mk({ synthetic: 1 })], { senders: SENDERS, includeSynthetic: true });
  ok(p2.send.length === 1, "explicit opt-in includes them");
}

// 8. Caps. Per-refund over-cap is held; the run total stops adding, and the
//    overflow is HELD as deferred rather than silently dropped.
{
  const p = planRefunds([mk({ priceUsd: 0.5 })], { senders: SENDERS, maxEachUsd: 0.25 });
  ok(p.send.length === 0 && Object.keys(p.held).some((k) => /per-refund cap/.test(k)), "over per-refund cap -> held");
  const rows = Array.from({ length: 12 }, (_, i) => mk({ id: i + 1, priceUsd: 0.2 }));
  const p2 = planRefunds(rows, { senders: SENDERS, maxEachUsd: 0.25, maxTotalUsd: 1 });
  ok(p2.send.length === 5 && p2.totalUsd === 1, `run cap enforced (sent ${p2.send.length}, $${p2.totalUsd})`);
  ok((p2.held[Object.keys(p2.held).find((k) => /deferred/.test(k))] || []).length === 7, "overflow is deferred and listed");
}

// 9. A chain with no sender keeps its debt ON the ledger and says so - the
//    silent-drop is the failure mode this planner exists to prevent.
{
  const p = planRefunds([mk({ network: "solana:mainnet" })], { senders: SENDERS });
  ok(p.send.length === 0 && Object.keys(p.held).some((k) => /no sender\/key for solana/.test(k)), "solana held with the reason named");
  const p2 = planRefunds([mk({ network: "cosmos:hub" })], { senders: SENDERS });
  ok(Object.keys(p2.held).some((k) => /unsupported network/.test(k)), "an unknown chain is unsupported, not guessed");
}

// 10. Guard rails: no payer, zero amount, already-resolved rows.
{
  const p = planRefunds([mk({ payer: null }), mk({ priceUsd: 0 }), mk({ status: "paid" })], { senders: SENDERS });
  ok(p.send.length === 0, "no-payer, zero-amount and resolved rows never send");
  ok(Object.keys(p.held).some((k) => /no payer/.test(k)) && Object.keys(p.held).some((k) => /zero amount/.test(k)),
    "each held bucket names its reason");
}

// 11. familyOf routing - the wrong family would use the wrong signer.
{
  ok(familyOf("eip155:42220") === "evm", "celo -> evm family");
  ok(familyOf("stellar:pubnet") === "stellar", "stellar family");
  ok(familyOf("algorand:wGHE2Pw") === "algorand", "algorand family");
  ok(familyOf("solana:5eykt4") === "solana", "solana family");
  ok(familyOf("") === "unknown" && familyOf(null) === "unknown", "empty/None -> unknown, never a default family");
}

__resetRefunds();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
