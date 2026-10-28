// Operator watch list (src/evidence-watch.js): wallets that clear the router
// floor while their payers pay no other seller, plus one more signal. Review
// only; it changes no verdict. Offline, plus a source check that the route is
// operator-gated and that no verdict code reads the list.
import { readFileSync } from "node:fs";
import { evidenceSignals, evidenceWatchList } from "../src/evidence-watch.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

const row = (over = {}) => ({ wallet: "0x" + "a".repeat(40), name: "s", origins: ["https://s.example"], callsSettled: 60, uniqueBuyers: 3, totalUsd: 0.06, multiSellerPayers: 0, topPayerCallsShare: 0.34, withoutTopPayer: { callsSettled: 40, uniqueBuyers: 2 }, concentration: null, ...over });

ok(evidenceSignals(row()).join() === "lowVolume,isolatedPayers,topPayerCarries", "signals: cheap, isolated payers, floor needs the top payer");
ok(evidenceSignals(row({ totalUsd: 5, multiSellerPayers: 2, withoutTopPayer: { callsSettled: 70, uniqueBuyers: 4 } })).length === 0, "a broad, paid wallet has no signals");

const { clearing, listed } = evidenceWatchList([
  row({ wallet: "0x" + "1".repeat(40) }),                                                        // staged-looking: listed
  row({ wallet: "0x" + "2".repeat(40), multiSellerPayers: 3 }),                                  // cheap + concentrated, but payers buy elsewhere: not listed
  row({ wallet: "0x" + "3".repeat(40), totalUsd: 40, concentration: "single-payer-supermajority", multiSellerPayers: 1 }), // one big integration: not listed
  row({ wallet: "0x" + "4".repeat(40), callsSettled: 10 }),                                      // below the floor: not counted
  row({ wallet: "0x" + "5".repeat(40) }),                                                        // our own wallet: skipped
], { self: new Set(["0x" + "5".repeat(40)]) });
ok(clearing === 3, `counts only wallets that clear the floor, ours excluded (got ${clearing})`);
ok(listed.length === 1 && listed[0].wallet === "0x" + "1".repeat(40), "lists only the wallet whose payers pay no one else and that shows another signal");
ok(!evidenceWatchList([row({ multiSellerPayers: null })]).listed.length, "an unknown payer breadth never lists a wallet");

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const route = server.slice(server.indexOf('app.get("/__operator/evidence-watch.json"'), server.indexOf('app.get("/__operator/seller-verification.json"'));
ok(/if \(!operatorAuthed\(req\)\) return res\.status\(404\)/.test(route), "the route answers 404 without the operator token");
ok((server.match(/evidenceWatchList\(/g) || []).length === 1, "only the operator route calls the watch list (no verdict reads it)");
for (const f of ["../src/dispatch-eligibility.js", "../src/evidence-binding.js"]) {
  ok(!readFileSync(new URL(f, import.meta.url), "utf8").includes("evidence-watch"), `${f.split("/").pop()} does not read the watch list`);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
