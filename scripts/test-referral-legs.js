// The split legs of each proven /ref sale, kept for the operator's books
// (src/referral-legs.js): the stored shape, the per-recipient yearly totals,
// one row per payment in the database (a rewrite replaces it), memory without
// one, and a failed write counted, never thrown. The gate's caller path (a
// paid /ref call recording its receipt's split) is in scripts/test-referral-gate.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

const { createReferralLegs, legsRow, totalsByRecipient, LEGS_COLLECTION } = await import("../src/referral-legs.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const at2026 = Date.UTC(2026, 5, 1), at2025 = Date.UTC(2025, 5, 1);
const split = (to1, a1, to2, a2) => ({ gross: "5000", legs: ["100", "200", "300", "150"], merchant: "4250", recipients: [{ to: to1.toUpperCase().replace("0X", "0x"), amount: a1 }, { to: to2, amount: a2 }] });

const row = legsRow({ key: "referral:k1", slug: "echo", payer: "0xP", tx: "0xT", split: split(A, "4250", B, "750"), at: at2026 });
ok(row && row.gross === "5000" && row.merchant === "4250" && row.legs.join(",") === "100,200,300,150" && row.recipients[0].to === A && row.recipients[1].amount === "750", `a proven split is stored with its gross, legs, merchant amount and lower-cased recipients (${JSON.stringify(row)})`);
ok(legsRow({ key: "k", split: null }) === null && legsRow({ key: "", split: split(A, "1", B, "1") }) === null, "no split or no key stores nothing");
ok(legsRow({ key: "k", split: { recipients: [{ to: "nope", amount: "1" }, { to: A, amount: "-1" }, { to: B, amount: "7" }] } }).recipients.length === 1, "a recipient that is not an address or an amount that is not units is left out");

const rows = [
  legsRow({ key: "1", split: split(A, "4250", B, "750"), at: at2026 }),
  legsRow({ key: "2", split: split(A, "4250", B, "750"), at: at2026 }),
  legsRow({ key: "3", split: split(A, "999", B, "1"), at: at2025 }),
];
const t = totalsByRecipient(rows, 2026);
ok(t.length === 2 && t[0].to === A && t[0].units === "8500" && t[0].transfers === 2 && t[1].to === B && t[1].units === "1500", `totals per recipient for one UTC year, largest first (${JSON.stringify(t)})`);
ok(totalsByRecipient(rows, 2025)[0].units === "999", "another year counts only its own rows");

{ // Database: one row per payment, by its key.
  const puts = new Map();
  const store = { put: async (c, id, body) => { puts.set(`${c}/${id}`, body); return true; }, list: async (c) => [...puts.entries()].filter(([k]) => k.startsWith(`${c}/`)).map(([k, body]) => ({ id: k.slice(c.length + 1), body })) };
  const legs = createReferralLegs({ db: true, store, log: { warn() {} } });
  await legs.record({ key: "referral:k1", slug: "echo", payer: "0xp", tx: "0xt", split: split(A, "4250", B, "750"), at: at2026 });
  await legs.record({ key: "referral:k1", slug: "echo", payer: "0xp", tx: "0xt", split: split(A, "4250", B, "750"), at: at2026 });
  ok(puts.size === 1 && puts.has(`${LEGS_COLLECTION}/referral:k1`), "with a database a payment is one records row by its key; a second write replaces it");
  const tot = await legs.totals(2026);
  ok(tot.year === 2026 && tot.byRecipient[0].units === "4250", `the totals read the database rows (${JSON.stringify(tot)})`);
  ok(legs.view().store === "database" && legs.view().recorded === 2 && legs.view().recent.length === 2, "the view names the store, the count and the latest rows");
  const broken = createReferralLegs({ db: true, store: { put: async () => { throw new Error("down"); } }, log: { warn() {} } });
  ok((await broken.record({ key: "k", split: split(A, "1", B, "1"), at: at2026 })) === false && broken.view().failures === 1, "a failed write is counted and never thrown");
}
{ // No database: memory.
  const legs = createReferralLegs({ db: false });
  await legs.record({ key: "m1", split: split(A, "10", B, "5"), at: at2026 });
  ok(legs.view().store === "memory" && (await legs.totals(2026)).byRecipient[0].units === "10", "without a database the rows are kept in this process");
}
{ // Wiring: the server hands the gate the recorder and lists it on the operator view.
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/recordSplitLegs: \(row\) => REFERRAL_LEGS\?\.record\(row\)/.test(src) && /splitLegs: REFERRAL_LEGS \? REFERRAL_LEGS\.view\(\) : null/.test(src) && /app\.get\("\/__operator\/referral-legs\.json", async \(req, res\) => \{\s*if \(!operatorAuthed\(req\)\) return operatorNotFound\(req, res\);/.test(src), "server.js records each proven split and serves it on operator routes only");
}

console.log(`\ntest-referral-legs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
