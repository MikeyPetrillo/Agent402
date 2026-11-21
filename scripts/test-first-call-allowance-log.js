// The first-call allowance's log lines (src/first-call-allowance.js): a served
// grant names its payer only as a salted hash prefix (stable per wallet, so a
// review can count wallets and returns from the logs), with the route's list
// price; refusals are written out per day, by reason, when the day turns and
// at most hourly in between, so a deploy never loses a day's counts.
// Offline: no store, no chain read (every refusal here is decided before both).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

process.env.FIRST_CALL_ALLOWANCE = "on";
process.env.FIRST_CALL_ALLOWANCE_SLUGS = "render,search";
process.env.TRAFFIC_HASH_SALT = "salt-one";
const fca = await import("../src/first-call-allowance.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const lines = [];
const realLog = console.log;
const capture = async (fn) => { lines.length = 0; console.log = (...a) => { lines.push(a.join(" ")); }; try { await fn(); } finally { console.log = realLog; } return [...lines]; };

// --- the grant line ---------------------------------------------------------------
const W1 = "0x" + "1a".repeat(20), W2 = "0x" + "2b".repeat(20);
ok(typeof fca.allowancePayerHash === "function" && typeof fca.allowanceGrantLogLine === "function", "the grant line and its payer hash are exported");
const h1 = fca.allowancePayerHash?.(W1), h2 = fca.allowancePayerHash?.(W2);
ok(/^[0-9a-f]{12}$/.test(h1 || "") && /^[0-9a-f]{12}$/.test(h2 || "") && h1 !== h2, `a payer hash is 12 hex digits, one per wallet (${h1}, ${h2})`);
ok(fca.allowancePayerHash?.(W1.toUpperCase().replace("0X", "0x")) === h1, "an EVM address hashes the same in any case");
process.env.TRAFFIC_HASH_SALT = "salt-two";
ok(fca.allowancePayerHash?.(W1) !== h1, "the hash is salted: another salt, another hash");
process.env.TRAFFIC_HASH_SALT = "salt-one";
ok(fca.allowancePayerHash?.(null) === "?" && fca.allowancePayerHash?.("") === "?", "no payer hashes to a placeholder");
const line = fca.allowanceGrantLogLine?.({ slug: "render", network: "eip155:8453", payer: W1, micro: 4000 }) || "";
ok(line === `[allowance] first-call grant served on render (eip155:8453) payer=${h1} list=$0.004; settlement skipped, nothing charged`, `the grant line carries the route, the network, the payer hash and the list price (${line})`);
ok(!/0x[0-9a-f]{40}/i.test(line) && !line.includes(W1.slice(2, 12)), "and never the wallet");
{
  const src = readFileSync(new URL("../src/first-call-allowance.js", import.meta.url), "utf8");
  ok(/console\.log\(allowanceGrantLogLine\(a\)\);/.test(src), "a served grant is logged through that line");
}

// --- refusals per day ---------------------------------------------------------------
const DAY1 = Date.parse("2026-11-20T10:00:00Z");
const req = () => ({ headers: {}, body: {} });
const deny = (slug, now) => fca.claimFirstCallAllowance(req(), {}, { slug, price: "$0.004" }, { now });
fca._resetFirstCallAllowance();
{
  const first = await capture(async () => { await deny("hash", DAY1); await deny("hash", DAY1 + 1000); await deny("render", DAY1 + 2000); });
  ok(first.filter((l) => l.startsWith("[allowance] refusals")).length === 0, `inside the first hour nothing is written (${first.join(" | ")})`);
  const hour = await capture(async () => { await deny("hash", DAY1 + 61 * 60_000); });
  const so = hour.find((l) => l.startsWith("[allowance] refusals so far 2026-11-20:")) || "";
  ok(/route not eligible=3/.test(so) && /rail=1/.test(so), `after an hour the day's counts so far are written, by reason (${so})`);
  const quiet = await capture(async () => { await deny("hash", DAY1 + 62 * 60_000); });
  ok(quiet.filter((l) => l.startsWith("[allowance] refusals")).length === 0, "and not again inside the next hour");
  const turn = await capture(async () => { await deny("hash", DAY1 + 20 * 3600_000); });
  const total = turn.find((l) => l.startsWith("[allowance] refusals 2026-11-20:")) || "";
  ok(/route not eligible=4/.test(total) && /rail=1/.test(total) && !/so far/.test(total), `when the day turns the finished day's totals are written once (${total})`);
  ok(turn.filter((l) => l.startsWith("[allowance] refusals")).length === 1, "one line for the finished day, none yet for the new one");
  const again = await capture(async () => { await deny("hash", DAY1 + 20 * 3600_000 + 1000); });
  ok(again.filter((l) => l.startsWith("[allowance] refusals")).length === 0, "the finished day is not written twice");
  const st = await fca.firstCallAllowanceStatus({ now: DAY1 + 20 * 3600_000 + 2000 });
  ok(st.deniedToday["route not eligible"] === 2, `the operator view still counts the new day alone (${JSON.stringify(st.deniedToday)})`);
  ok([first, hour, quiet, turn, again].flat().every((l) => !/0x[0-9a-f]{40}/i.test(l)), "no refusal line names a wallet");
}
// A day with no refusal writes nothing when it turns.
fca._resetFirstCallAllowance();
{
  const none = await capture(async () => { await fca.firstCallAllowanceStatus({ now: DAY1 }); });
  ok(none.filter((l) => l.startsWith("[allowance] refusals")).length === 0, "a process with no refusal writes no refusal line");
  ok(typeof fca.allowanceRefusalLogLine === "function" && fca.allowanceRefusalLogLine({ day: "2026-11-20", byReason: {} }, { day: "2026-11-20", byReason: {}, unclassified: {} }) === null, "an empty day has no line");
}

console.log(`\ntest-first-call-allowance-log: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
