#!/usr/bin/env node
// The referral settlement book's sweep and write queue (src/referral-book.js),
// offline against a memory document and a stub chain:
//   - the refused entries' share of a pass's reads, its spread and its cap;
//   - dropped records read in turn (least recently read first) when reads are slow,
//     and when passes come faster than the clock moves;
//   - a dropped record is given up only on reads the chain ANSWERED (a nonce
//     read as unused, or spent with its receipt read or its search complete);
//   - an expired dropped record pushed out at the cap is logged;
//   - charged entries' proof reads stop at their share of the pass's chain budget,
//     counted from the start the caller gives;
//   - one sweep at a time in a process, with no lease;
//   - one failed write never fails the rest of its batch.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";

const bookMod = await import("../src/referral-book.js");
const { createReferralBook, oneAtATime, startReferralBookSweep } = bookMod;
const { createJsonDocument } = await import("../src/json-document.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${randomBytes(n).toString("hex")}`;
const lines = [];
const log = { error: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), log: () => {} };
let seq = 0;
const newBook = (o = {}) => createReferralBook({ doc: createJsonDocument({ name: `referral-book-sweep-${process.pid}-${++seq}`, log: () => {} }), log, ...o });
const PAY_TO = hex(20);
const nowS = () => Math.floor(Date.now() / 1000);
const entry = (tag, i, validBefore = nowS() + 900) => ({ key: `referral:${tag}-${i}`, slug: "echo", payer: `0x${tag === "D" ? "d" : tag === "R" ? "e" : "f"}${String(i).padStart(39, "0")}`, nonce: hex(32), amount: "30000", validBefore });

// ---- the refused entries' share of the reads, spread and cap (referral-book.js sweep: `due`) ----
{
  const order = async (doubtful, refused, max) => {
    const b = newBook({ maxEntries: 1000 });
    for (let i = 0; i < doubtful; i++) { const e = entry("D", i); await b.intent(e); await b.resolve(e.key, { state: "in-doubt", at: 1000 + i }); }
    for (let i = 0; i < refused; i++) { const e = entry("R", i); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 1000 + i }); }
    const asked = [];
    const chain = { state: async ({ from }) => { asked.push(String(from)[2] === "d" ? "D" : "R"); return { used: false, paid: false, transaction: null, complete: true }; } };
    await b.sweep({ chain, bookSale: async () => true, payTo: PAY_TO, max });
    return asked.join("");
  };
  const a = await order(20, 20, 10);
  ok(a === "DDDDRDDDDR", `a fifth of a pass's reads go to refused entries, one after every four others (20 in doubt, 20 refused, 10 reads: ${a})`);
  const b = await order(20, 1, 10);
  ok(b === "DDDDRDDDDD", `the refused share is capped at the refused entries there are, and the reads it does not use go to the others (one refused: ${b})`);
  const c = await order(0, 20, 10);
  ok(c === "RRRRRRRRRR", `with nothing in doubt the whole pass reads refused entries (${c})`);
  const d = await order(3, 20, 10);
  ok(d === "DDDRRRRRRR", `reads the entries in doubt leave unused go to refused ones (${d})`);
}

// ---- dropped records: read in turn when reads are slow; given up only on answered reads ----
{
  // Four refused entries, three of them dropped at capacity (maxEntries 1), none expired; each read takes 30 ms and the budget allows one a pass.
  const b = newBook({ maxEntries: 1, maxDropped: 10 });
  const made = [];
  for (let i = 0; i < 4; i++) { const e = entry("G", i, nowS() + 600 + i * 60); made.push(e); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 100 + i }); }
  const dropped = new Set(b.droppedRefused().records.map((r) => r.nonce));
  const read = [];
  const chain = { state: async ({ nonce }) => { await wait(30); if (dropped.has(nonce)) read.push(nonce); return { used: false, paid: false, transaction: null, complete: true }; } };
  for (let i = 0; i < 3; i++) { await b.sweep({ chain, bookSale: async () => true, payTo: PAY_TO, chainBudgetMs: 1 }); await wait(5); }
  ok(dropped.size === 3 && read.length === 3 && new Set(read).size === 3, `with one read a pass, three unexpired dropped records are each read once in three passes, not the earliest-expiring one three times (${new Set(read).size} distinct of ${read.length} reads)`);
}
{
  // Forty dropped records, 25 read a pass, every pass in the same millisecond (a frozen clock): each is read in turn.
  const frozen = Date.now() + 30 * 60_000;
  const b = newBook({ maxEntries: 1, maxDropped: 100, now: () => frozen });
  for (let i = 0; i < 41; i++) { const e = entry("T", i, nowS() + 600 - i * 10); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 100 + i }); }
  const reads = new Map();
  const chain = { state: async ({ nonce }) => { reads.set(nonce, (reads.get(nonce) || 0) + 1); return { used: null, paid: null, transaction: null, complete: false }; } };
  const nonces = b.droppedRefused().records.map((r) => r.nonce);
  for (let i = 0; i < 8; i++) await b.sweep({ chain, bookSale: async () => true, payTo: PAY_TO });
  const counts = nonces.map((n) => reads.get(n) || 0);
  ok(nonces.length === 40 && Math.min(...counts) === 5 && Math.max(...counts) === 5, `forty dropped records read 25 a pass, eight passes in one millisecond: each is read five times, by the book's own read order, not the clock (fewest ${Math.min(...counts)}, most ${Math.max(...counts)})`);
}
{
  let skew = 0;
  const b = newBook({ maxEntries: 1, maxDropped: 10, now: () => Date.now() + skew });
  for (let i = 0; i < 3; i++) { const e = entry("U", i, nowS() + 60); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 100 + i }); }
  let mode = "throw";
  const chain = { state: async () => {
    if (mode === "throw") throw new Error("rpc down");
    if (mode === "silent") return { used: null, paid: null, transaction: null, complete: false };
    // Spent, but its log search or its receipt read failed: where the payment went is not known.
    if (mode === "spentUnread") return { used: true, paid: null, transaction: null, complete: false };
    if (mode === "spentReceiptFailed") return { used: true, paid: null, transaction: hex(32), complete: false, receiptRead: false };
    // Spent, its receipt read in full and not recognized: an answered read.
    return { used: true, paid: null, transaction: hex(32), complete: false, receiptRead: true };
  } };
  const sweep = () => b.sweep({ chain, bookSale: async () => true, payTo: PAY_TO });
  skew = 10 * 60_000;
  for (let i = 0; i < 6; i++) await sweep();
  mode = "silent";
  for (let i = 0; i < 6; i++) await sweep();
  skew = bookMod.DROPPED_GIVE_UP_MS + 3 * 3600_000; // nine hours past expiry, twelve passes of a chain that never answered
  for (let i = 0; i < 6; i++) await sweep();
  mode = "spentUnread";
  for (let i = 0; i < 6; i++) await sweep();
  mode = "spentReceiptFailed";
  for (let i = 0; i < 6; i++) await sweep();
  const kept = b.droppedRefused();
  mode = "answered";
  for (let i = 0; i < 6; i++) await sweep();
  const after = b.droppedRefused();
  ok(kept.count === 2 && kept.unresolved === 0 && after.count === 0 && after.unresolved === 2, `a chain outage longer than six hours, or a nonce read as spent whose search or receipt read failed, gives up no dropped record (only reads the chain answered count): ${kept.count} kept after 30 such passes; given up after five answered reads with no verdict: ${after.unresolved}`);
}
{
  // A dropped record whose receipt, read in full, shows the buyer's own transfer into the split contract (`moved`),
  // or the contract's routed event naming this merchant (`routedToUs`), and is no proof: never given up. It goes
  // back to the book as an open entry naming the transaction, and is handed to the caller (onHeld) like an open one.
  for (const shape of ["moved", "routedToUs"]) {
    let skew = 0;
    const b = newBook({ maxEntries: 1, maxDropped: 10, now: () => Date.now() + skew });
    const made = [];
    for (let i = 0; i < 3; i++) { const e = entry("H", i, nowS() + 60); made.push(e); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 100 + i }); }
    const droppedKeys = b.droppedRefused().records.map((r) => r.key);
    const txOfNonce = new Map(made.map((e) => [e.nonce, hex(32)]));
    const chain = { state: async ({ nonce }) => ({ used: true, paid: null, transaction: txOfNonce.get(nonce), complete: false, receiptRead: true, [shape]: true, why: "no payout to this merchant" }) };
    const held = [];
    const before = lines.length;
    const sweep = () => b.sweep({ chain, bookSale: async () => true, payTo: PAY_TO, onHeld: (e, st) => held.push({ key: e.key, tx: st.transaction, flag: st[shape] === true }) });
    skew = bookMod.DROPPED_GIVE_UP_MS + 3 * 3600_000; // nine hours past expiry
    await sweep();
    // (Handed on by the pass that wrote it back, not only by a later pass's read of the open entry.)
    const handedAtOnce = droppedKeys.every((k) => held.some((h) => h.key === k));
    for (let i = 0; i < 7; i++) await sweep();
    const after = b.droppedRefused();
    const back = droppedKeys.map((k) => b.get(k));
    const nonceOf = new Map(made.map((e) => [e.key, e.nonce]));
    ok(droppedKeys.length === 2 && after.count === 0 && after.unresolved === 0 && !lines.slice(before).some((l) => /its record is given up/.test(l)) && b.resolvedByHand().every((r) => r.key !== "dropped:unresolved"), `a dropped record whose receipt shows ${shape} is never given up, however many answered reads and hours pass (${after.count} records left, ${after.unresolved} given up)`);
    ok(back.every((e) => e && e.state === "in-doubt" && e.seenTx === txOfNonce.get(nonceOf.get(e.key)).toLowerCase() && e.amount === "30000" && e.slug === "echo" && e.nonce === nonceOf.get(e.key) && (shape !== "routedToUs" || e.routedToUs === true)), `it is written back as an open entry in doubt that names the transaction (${back.map((e) => `${e?.state}/${String(e?.seenTx).slice(0, 6)}`).join(", ")})`);
    ok(handedAtOnce && droppedKeys.every((k) => held.some((h) => h.key === k && h.flag && h.tx === txOfNonce.get(nonceOf.get(k)))) && lines.slice(before).filter((l) => /dropped at capacity .* written back as an open entry/.test(l)).length === 2, `and handed to the caller with its reading by the pass that wrote it back, with a line that names it (at once: ${handedAtOnce}; ${held.length} handed on)`);
  }
}
{
  // An expired record pushed out at the cap leaves a line.
  const b = newBook({ maxEntries: 1, maxDropped: 1 });
  const before = lines.length;
  for (let i = 0; i < 4; i++) { const e = entry("X", i, nowS() - 3600); await b.intent(e); await b.resolve(e.key, { state: "refused", at: 100 + i }); }
  const said = lines.slice(before).filter((l) => /pushed out at the cap \(more than 1 at once\) after their authorization expired/.test(l));
  ok(said.length === 2 && b.droppedRefused().unresolved === 2, `an expired dropped record pushed out at the cap is logged (${said.length} lines, ${b.droppedRefused().unresolved} counted)`);
}

// ---- charged entries' reads stay inside their share of the pass's chain budget ----
{
  const b = newBook({ maxEntries: 1000 });
  for (let i = 0; i < 20; i++) { const e = entry("C", i); await b.intent(e); await b.resolve(e.key, { state: "charged-undelivered", tx: hex(32), landedAt: 1000 + i }); }
  let calls = 0;
  const t0 = Date.now();
  const out = await b.sweep({ chain: { state: async () => ({ used: false }) }, bookSale: async () => true, payTo: PAY_TO, chainBudgetMs: 400, onCharged: async () => { calls++; await wait(60); } });
  const took = Date.now() - t0;
  ok(bookMod.SWEEP_CHARGED_BUDGET_SHARE === 0.5 && calls >= 1 && calls <= 5 && out.chargedLeft >= 15 && took < 400 + 200, `charged entries against a slow proof read start none past half the pass's chain budget (${calls} handed on, ${out.chargedLeft} left for the next pass, ${took} ms for a 400 ms budget)`);
  let late = 0;
  const out2 = await b.sweep({ chain: { state: async () => ({ used: false }) }, bookSale: async () => true, payTo: PAY_TO, chainBudgetMs: 400, startedAt: Date.now() - 300, onCharged: async () => { late++; } });
  ok(late === 0 && out2.chargedLeft === 20, `the budget counts from the start the caller gives (its own proof reads spent part of it): none handed on (${late}, ${out2.chargedLeft} left)`);
  // A send never confirmed reads its receipt too (onSendUnconfirmed): the same share.
  const s = newBook({ maxEntries: 1000 });
  for (let i = 0; i < 20; i++) { const e = entry("S", i); await s.intent(e); await s.resolve(e.key, { state: "charged-undelivered", tx: hex(32), delivered: true, sendingUntil: 1, landedAt: 1000 + i }); }
  let sends = 0;
  await s.sweep({ chain: { state: async () => ({ used: false }) }, bookSale: async () => true, payTo: PAY_TO, chainBudgetMs: 400, onSendUnconfirmed: async () => { sends++; await wait(60); return true; } });
  ok(sends >= 1 && sends <= 5 && s.size() === 20, `sends never confirmed are read inside the same share (${sends} of 20, the rest kept)`);
}

// ---- one sweep at a time in a process ----
{
  let running = 0, most = 0, runs = 0;
  const slow = oneAtATime(async () => { running++; most = Math.max(most, running); runs++; await wait(80); running--; return "done"; });
  const [x, y] = await Promise.all([slow(), slow()]);
  ok(x === "done" && y?.skipped === "running" && most === 1, `a sweep asked for while one runs answers skipped at once (${JSON.stringify(y)})`);
  // The timer with no state database (no lease taken): a pass longer than the interval never overlaps another.
  running = 0; most = 0; runs = 0;
  await startReferralBookSweep({ sweepOnce: async () => { running++; most = Math.max(most, running); runs++; await wait(120); running--; }, intervalMs: 20 });
  await wait(700);
  ok(runs >= 2 && most === 1, `the sweep's timer with no lease never runs two passes at once (${runs} passes, at most ${most} at a time)`);
}

// ---- one failed write never fails its whole batch ----
{
  const doc = createJsonDocument({ name: `referral-book-sweep-${process.pid}-solo`, log: () => {} });
  const real = doc.update.bind(doc);
  let n = 0;
  doc.update = async (m, o) => { const k = ++n; if (k === 1) { await wait(150); return real(m, o); } if (k === 2) { await wait(200); return { ok: false, error: "one failed write" }; } return real(m, o); };
  const b = createReferralBook({ doc, log, maxEntries: 1000 });
  const slow = b.resolveNote({ slug: "echo", outcome: "noted", note: "a slow write the others wait behind" });
  await wait(20);
  const es = [entry("Q", 1), entry("Q", 2), entry("Q", 3)];
  const late = entry("Q", 4);
  const results = Promise.all([...es.map((e) => b.intent(e)), b.intent({ ...late, deadlineMs: 250 }), b.noteShort("echo", { expected: "1", received: "0", gross: "1", tx: hex(32) })]);
  await slow;
  const r = await results;
  await b.ping();
  ok(r.slice(0, 3).every((x) => x === true) && r[4] === true && r[3] === false && es.every((e) => b.get(e.key)?.state === "intent") && !b.get(late.key) && b.writeStats().failed === 1, `a failed write that carried five changes: each is written again on its own and stands, except the intent whose deadline passed meanwhile, which answered false and is never written (${r.join(" ")}; ${b.writeStats().failed} failed write)`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
