// Offline proof for the refund pipeline: the ledger (src/refund-ledger.js)
// and the planner (scripts/refund-run.js planRefunds).
//
// Money leaves a wallet at the end of this pipeline, so the tests concentrate
// on the mistakes that cost someone money or erase a debt: double-booking,
// silent write-offs, refunding the canary to ourselves, skipping caps, and
// case-folding an address on a case-sensitive rail.
process.env.REFUND_DB_DIR = process.env.TMPDIR || "/tmp";
import { recordRefundOwed, receiptProvesCharge, listRefunds, markRefundPaid, markRefundVoid, claimRefundForSend, refundTotals, __resetRefunds } from "../src/refund-ledger.js";
import { planRefunds, familyOf, ourPayToSet } from "./refund-run.js";
import { readFileSync } from "node:fs";

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

// 6b. A row carrying the SALES LEDGER's short chain name plans exactly like
// its CAIP-2 twin. The 2026-09-01 backfill minted "base" where receipts write
// "eip155:8453", and familyOf + the accepts lookup both key on CAIP-2 - four
// provably-owed Base rows were held "unsupported network base" on the first
// live dry run. Normalization at intake is what un-held them; this pins it.
{
  const p = planRefunds([mk({ id: 1, network: "base" }), mk({ id: 2, network: "solana" })], { senders: SENDERS });
  ok(p.send.length === 1 && p.send[0].network === "eip155:8453",
    "a short-name base row normalizes to eip155:8453 and plans as evm");
  const heldReasons = Object.keys(p.held).join("|");
  ok(/no sender\/key for solana/.test(heldReasons),
    `a short-name solana row normalizes and is held for the REAL reason - no sender - not "unsupported network" (got ${heldReasons})`);
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
  // Distinct payers on purpose: this asserts the RUN cap, and the per-payer
  // cap is a separate control that would otherwise bind first (it did, when
  // these rows all shared one payer - the run-cap assertion then measured the
  // per-payer cap instead).
  const rows = Array.from({ length: 12 }, (_, i) => mk({ id: i + 1, priceUsd: 0.2, payer: `0xP${i}` }));
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


// ---- abuse resistance (the "can someone milk the wallet" review) ----

// 12. PER-PAYER CAP. Gas is sponsored for buyers on EVM, so one wallet can
//     force charged-failures for free while every refund costs US gas. Each
//     debt is real, so the answer is a bound per wallet - not a refusal.
{
  const rows = Array.from({ length: 10 }, (_, i) => mk({ id: i + 1, priceUsd: 0.1, payer: "0xGRIEFER" }));
  const p = planRefunds(rows, { senders: SENDERS, maxPerPayerUsd: 0.5, maxTotalUsd: 100 });
  ok(p.send.length === 5, `one wallet is capped per run (sent ${p.send.length}/10)`);
  ok(Object.keys(p.held).some((k) => /per-payer cap/.test(k)), "the rest are held under a named per-payer reason");
}

// 13. The per-payer cap is PER WALLET, not global - one abuser must not block
//     everyone else's refunds.
{
  const rows = [
    mk({ id: 1, priceUsd: 0.5, payer: "0xGRIEFER" }),
    mk({ id: 2, priceUsd: 0.5, payer: "0xGRIEFER" }),
    mk({ id: 3, priceUsd: 0.1, payer: "0xHONEST" }),
  ];
  const p = planRefunds(rows, { senders: SENDERS, maxPerPayerUsd: 0.5, maxTotalUsd: 100, maxEachUsd: 1 });
  ok(p.send.some((r) => r.payer === "0xHONEST"), "an innocent payer still gets refunded while another is capped");
  ok(p.send.filter((r) => r.payer === "0xGRIEFER").length === 1, "the capped wallet gets exactly its allowance");
}

// 14. Dust floor is OFF by default - a real debt is owed however small, and
//     silently withholding one is the failure mode this pipeline prevents.
{
  const p = planRefunds([mk({ priceUsd: 0.001 })], { senders: SENDERS });
  ok(p.send.length === 1, "a $0.001 debt is repaid by default");
  const p2 = planRefunds([mk({ priceUsd: 0.001 })], { senders: SENDERS, minRefundUsd: 0.01 });
  ok(p2.send.length === 0 && Object.keys(p2.held).some((k) => /dust floor/.test(k)),
    "an explicit floor holds it, loudly, rather than dropping it");
}


// 15. THE MINT GUARD. A debt requires positive proof of settlement. The alarm
//     may stay loud on ambiguity; money may not. An unreadable or legacy
//     receipt reaching the debt path would create refundable rows for calls
//     nobody paid for - and with no tx to key on, one per slug per minute.
{
  ok(receiptProvesCharge({ success: true }) === true, "explicit success:true proves the charge");
  ok(receiptProvesCharge({ success: false }) === false, "a rejected settle is not a debt (the buyer kept their money)");
  ok(receiptProvesCharge(null) === false, "an UNREADABLE receipt never mints a debt");
  ok(receiptProvesCharge({}) === false, "a receipt with no success field never mints a debt");
  ok(receiptProvesCharge({ success: "true" }) === false, "a truthy STRING is not proof - strict true only");
  ok(receiptProvesCharge({ success: 1 }) === false, "a truthy number is not proof either");
  ok(receiptProvesCharge("success") === false && receiptProvesCharge(undefined) === false,
    "non-objects are never proof");
}


// 16. THE DOUBLE-REFUND WINDOW. Verification proves we were PAID; it can never
//     prove we have not already refunded, and it stays true forever. So a row
//     whose money left but whose mark-paid failed would be re-sent by the next
//     run. Claiming before broadcast turns that into a stuck row for a human.
{
  __resetRefunds();
  recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0xC", priceUsd: 0.001, tx: "0xclaimtest" });
  const r = listRefunds().find((x) => x.evidence === "0xclaimtest");
  ok(claimRefundForSend(r.id) === true, "an owed row can be claimed for sending");
  ok(claimRefundForSend(r.id) === false, "a claimed row cannot be claimed again (no second sender)");
  ok(listRefunds({ status: "owed" }).some((x) => x.id === r.id) === false,
    "a claimed row leaves the owed queue, so the next run will not re-send it");
  ok(listRefunds({ status: "sending" }).some((x) => x.id === r.id) === true,
    "it is visible as sending - stuck, not lost");
  ok(markRefundPaid(r.id, "0xoutbound") === true, "the sender can complete it to paid");
  ok(refundTotals().paid.n === 1, "and it counts as paid");
}

// 17. A claim cannot resurrect a resolved debt.
{
  __resetRefunds();
  recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0xD", priceUsd: 0.001, tx: "0xdone" });
  const r = listRefunds().find((x) => x.evidence === "0xdone");
  markRefundVoid(r.id, "written off in test");
  ok(claimRefundForSend(r.id) === false, "a voided row can never be claimed for sending");
}


// 18. THE PUBLIC-LOG RULE. This repo is public, so Actions logs are
//     world-readable, and the project's standing rule is "counts only, never
//     addresses - a per-day roster of who pays us is a customer list". The
//     refund run must not print one, and it printed the whole plan BEFORE the
//     live check, so even a dry run published it.
{
  const src = readFileSync(new URL("./refund-run.js", import.meta.url), "utf8");
  const logLines = src.split("\n").filter((l) => /console\.(log|warn|error)/.test(l));
  const leaks = logLines.filter((l) => /\$\{(r|row)\.payer\}|\$\{(r|row)\.evidence\}|\$\{tx\}|proof\.tx/.test(l));
  ok(leaks.length === 0, `no log line prints a raw payer, evidence or tx (${leaks.length} found)`);
  // A thrown Error reaches the same public log through the catch-all, so the
  // THROW sites matter as much as the console lines - one of them printed the
  // address verbatim.
  const throwLeaks = src.split("\n").filter((l) => /throw new Error/.test(l) && /\$\{row\.payer\}/.test(l));
  ok(throwLeaks.length === 0, `no thrown error interpolates a raw payer (${throwLeaks.length} found)`);
  ok(/createHmac\(/.test(src), "the log tag is KEYED - an unsalted digest over an enumerable buyer set is confirmable, not private");
  ok(/createHash\(/.test(src) && /payer:\$\{/.test(src.replace(/\\/g, "")) === false || /tag\(/.test(src),
    "addresses are logged through a non-reversible tag");
}


// 19. CAPS MUST FAIL CLOSED. They come from free-text workflow inputs, and
//     Number("$2") is NaN - every `x > NaN` is false, so a malformed cap did
//     not clamp, it DISAPPEARED. Measured before the fix: a "$2" run cap sent
//     40 refunds totalling $10 where "2" sent 8 totalling $2. That is the one
//     direction this pipeline must never fail, reachable by a single typo.
{
  const rows = Array.from({ length: 40 }, (_, i) => mk({ id: i + 1, priceUsd: 0.25, payer: `0xP${i}` }));
  const nan = planRefunds(rows, { senders: SENDERS, maxEachUsd: Number("$0.25"), maxTotalUsd: Number("$2") });
  ok(nan.send.length === 0, `a NaN cap holds every row instead of sending (${nan.send.length})`);
  // Each cap is asserted ALONE. With several NaN at once every guard covers
  // the others, so a mutation of any single comparison survives - the caps
  // must each fail closed on their own.
  const onlyEach = planRefunds(rows, { senders: SENDERS, maxEachUsd: Number("$0.25"), maxTotalUsd: 1e9, maxPerPayerUsd: 1e9 });
  ok(onlyEach.send.length === 0, `a NaN per-refund cap alone holds everything (${onlyEach.send.length})`);
  const onlyTotal = planRefunds(rows, { senders: SENDERS, maxEachUsd: 1e9, maxTotalUsd: Number("$2"), maxPerPayerUsd: 1e9 });
  ok(onlyTotal.send.length === 0, `a NaN run cap alone holds everything (${onlyTotal.send.length})`);
  const onlyPayer = planRefunds(rows, { senders: SENDERS, maxEachUsd: 1e9, maxTotalUsd: 1e9, maxPerPayerUsd: Number("x") });
  ok(onlyPayer.send.length === 0, `a NaN per-payer cap alone holds everything (${onlyPayer.send.length})`);
  const good = planRefunds(rows, { senders: SENDERS, maxEachUsd: 0.25, maxTotalUsd: 2 });
  ok(good.send.length === 8 && good.totalUsd === 2, `a valid cap still works (${good.send.length} rows, $${good.totalUsd})`);
  const nanPayer = planRefunds(rows, { senders: SENDERS, maxPerPayerUsd: Number("abc") });
  ok(nanPayer.send.length === 0, "a NaN per-payer cap holds too");
}


// 20. A PLACEHOLDER IS NOT EVIDENCE. A sender reading the wrong field off an
//     SDK response yields the STRING "undefined", which passes a non-empty
//     check while proving nothing - in the one column the ledger treats as
//     proof of repayment. (The Algorand sender did exactly this: algosdk v3
//     returns `txid`, the code read `txId`.)
{
  __resetRefunds();
  recordRefundOwed({ slug: "hash", network: "algorand:x", payer: "AAA", priceUsd: 0.001, tx: "algo-placeholder" });
  const r = listRefunds().find((x) => x.evidence === "algo-placeholder");
  for (const junk of ["undefined", "null", "NaN", "false", "0", "  undefined  "]) {
    ok(markRefundPaid(r.id, junk) === false, `"${junk.trim()}" is refused as a refund tx`);
  }
  ok(markRefundPaid(r.id, "REALTXID123") === true, "a real tx id still resolves the row");
}


// 21. THE PAYTO SET MUST NOT FOLD CASE OFF EVM. This is the caller-path
//     function the verifier tests never touch - they pass payToSetFor
//     directly - and the first version lowercased EVERY address. Correct for
//     EVM, fatal for base32/base58: the Algorand indexer returns
//     C7IIHG7SPL...OY2XIE and a folded copy never matches, so every Algorand
//     and Solana debt would have been held forever. Same rule stated in
//     src/payer.js and src/revenue-ledger.js.
{
  const ALGO = "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE";
  const SOL = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const EVM = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
  const s = ourPayToSet({
    "eip155:8453": { payTo: EVM },
    "algorand:x": { payTo: ALGO },
    "solana:y": { payTo: SOL },
  }, {});
  ok([...s.get("algorand:x")].includes(ALGO), "Algorand base32 payTo is preserved verbatim");
  ok([...s.get("solana:y")].includes(SOL), "Solana base58 payTo is preserved verbatim");
  ok([...s.get("eip155:8453")].includes(EVM.toLowerCase()), "EVM payTo IS folded (case-insensitive by spec)");

  // The spending wallets from env follow the same rule.
  const s2 = ourPayToSet(
    { "eip155:8453": { payTo: EVM }, "algorand:x": { payTo: ALGO } },
    { X402_UPSTREAM_BUYER_ADDRESS: "0x7706D81E18AD403BCD6E9A0616B288E16744121A",
      ALGORAND_UPSTREAM_BUYER_ADDRESS: "W4GZHN36AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  );
  ok([...s2.get("algorand:x")].includes("W4GZHN36AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "the AVM spending wallet keeps its case too");
  ok([...s2.get("eip155:8453")].includes("0x7706d81e18ad403bcd6e9a0616b288e16744121a"),
    "the EVM spending wallet is folded");
  ok(s2.get("eip155:8453").size === 2, "both EVM wallets are accepted, not one replacing the other");
}

__resetRefunds();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
