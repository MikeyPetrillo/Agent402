// Every eth_getLogs reader narrows its range on a node's result-size refusal.
// Nodes word that cap differently; each wording seen from a public node is
// pinned here against every reader's pattern, so a new wording is one line.
import { EVENT_LOGS_SIZE_ERR } from "../src/tools/chain-kit.js";
import { RANGE_ERR } from "../src/revenue-ledger.js";
import { RANGE_RE } from "../src/evm-logs-rpc.js";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FAIL"} - ${m}`); if (!c) fails++; };
const CAP_WORDINGS = [
  "query returned more than 10000 results",
  "Node error: query exceeds max results 20000, retry with the range 52983781-52983872",
];
const READERS = { "event-logs": EVENT_LOGS_SIZE_ERR, "revenue ledger": RANGE_ERR, "evm logs reader": RANGE_RE };
for (const [name, re] of Object.entries(READERS)) {
  for (const w of CAP_WORDINGS) ok(re.test(w), `${name} narrows on "${w.slice(0, 48)}"`);
  ok(!re.test("rate limit exceeded") || name === "event-logs", `${name} does not read a rate limit as a size cap`);
}
console.log(fails ? `\n${fails} failed` : "\nPASS - logs cap wording");
process.exit(fails ? 1 : 0);
