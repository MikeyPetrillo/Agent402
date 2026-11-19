#!/usr/bin/env node
// Paying wallets resolved to operators on public evidence only
// (src/payer-operators.js), offline with stub chain clients.
//
//   node scripts/test-payer-operators.js
//
// The ENS and Base lookups keep a name only when the name's own address record
// is the same wallet; a payTo maps only when exactly one origin advertises it
// and it is not a listed shared wallet; nothing else groups wallets. A lookup
// that fails is retried later, never cached as "no name"; the answer waits at
// most its deadline and counts the rest as pending; the cache is bounded.
import "./lib/offline-stores.js";
import { namehash } from "viem";
import { defaultNameLookups, createOperatorResolver, payToOperatorOf, BASE_L2_RESOLVER } from "../src/payer-operators.js";
import { summarizeOperators } from "../src/scoreboard.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL: ${m}`); } };
const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;

// ---- forward-checked name lookups (stub clients) ------------------------------------
{
  const ensNames = { [A(1)]: "alice.eth", [A(2)]: "bob.eth", [A(3)]: "Mallory.eth", [A(4)]: "x​.eth" };
  const ensAddr = { "alice.eth": A(1), "bob.eth": A(99) }; // bob's name points elsewhere
  const eth = {
    getEnsName: async ({ address }) => ensNames[address.toLowerCase()] ?? null,
    getEnsAddress: async ({ name }) => ensAddr[name] ?? null,
  };
  const baseNames = { [namehash(`${A(5).slice(2)}.80002105.reverse`)]: "carol.base.eth", [namehash(`${A(6).slice(2)}.80002105.reverse`)]: "dave.eth" };
  const baseAddr = { [namehash("carol.base.eth")]: A(5) };
  const calls = [];
  const base = {
    readContract: async ({ address, functionName, args }) => {
      calls.push(address);
      return functionName === "name" ? (baseNames[args[0]] ?? "") : (baseAddr[args[0]] ?? "0x0000000000000000000000000000000000000000");
    },
  };
  const l = defaultNameLookups({ clients: { eth, base } });
  ok(await l.ens(A(1)) === "alice.eth", "an ENS name whose address record is the wallet is kept");
  ok(await l.ens(A(2)) === null, "an ENS reverse name whose address record is another wallet is dropped");
  ok(await l.ens(A(3)) === null, "a name that is not in normalized form is dropped");
  ok(await l.ens(A(4)) === null, "a name with a hidden character is dropped");
  ok(await l.basename(A(5)) === "carol.base.eth", "a Base primary name checked forward is kept");
  ok(await l.basename(A(6)) === null, "a Base reverse record that is not a .base.eth name is dropped");
  ok(await l.basename(A(7)) === null, "no Base reverse record reads null");
  ok(calls.every((a) => a === BASE_L2_RESOLVER), "the Base reads go to the L2 resolver only");
}

// ---- payTo registry ----------------------------------------------------------------
{
  const map = new Map([[A(10), new Set(["https://one.example"])], [A(11), new Set(["https://a.example", "https://b.example"])], [A(12), new Set(["https://shared.example"])]]);
  ok(payToOperatorOf(A(10), map)?.host === "one.example", "a wallet one origin advertises maps to that origin's host");
  ok(payToOperatorOf(A(11), map) === null, "a wallet two origins advertise maps to nothing");
  ok(payToOperatorOf(A(12), map, new Set([A(12)])) === null, "a listed shared wallet maps to nothing");
  ok(payToOperatorOf(A(13), map) === null, "an unlisted wallet maps to nothing");
}

// ---- the resolver ------------------------------------------------------------------
{
  let ensCalls = 0;
  let t = 1_000_000;
  const lookups = {
    ens: async (a) => { ensCalls++; if (a === A(20)) return "ops.eth"; if (a === A(21)) return "ops.eth"; if (a === A(22)) throw new Error("rpc down"); if (a === A(23)) return new Promise(() => {}); return null; },
    basename: async () => null,
  };
  const r = createOperatorResolver({ lookups, payTo: (a) => (a === A(24) ? { host: "seller.example", origin: "https://seller.example" } : null), now: () => t, perLookupMs: 200, concurrency: 2 });
  const res = await r.resolveAll([A(20), A(21), A(22), A(23), A(24), A(25), "So1anaPayer1111111111111111111111111111111"], { deadlineMs: 2000 });
  ok(res.get(A(20)).mapping?.operator === "ops.eth" && res.get(A(20)).mapping.source === "ens" && /address record is this wallet/.test(res.get(A(20)).mapping.evidence) && res.get(A(20)).mapping.checkedAt, "a resolved wallet carries its provenance");
  ok(res.get(A(24)).mapping?.source === "payTo" && /payTo of https:\/\/seller\.example/.test(res.get(A(24)).mapping.evidence), "the registry source names the origin as evidence");
  ok(res.get(A(22)).unreadable === true && res.get(A(23)).unreadable === true, "a failed or hung lookup reads unreadable, not as no name");
  ok(res.get(A(25)).mapping === null, "a wallet with no evidence maps to nothing");
  const sum = await r.operatorsOf([A(20), A(21), A(24), A(25), "So1anaPayer1111111111111111111111111111111"], { deadlineMs: 2000 });
  ok(sum.operators === 4 && sum.resolvedWallets === 3 && sum.bySource.ens === 2 && sum.bySource.payTo === 1 && sum.nonEvmWallets === 1 && sum.upperBound === true, `two wallets with the same name are one operator; the rest count alone (${JSON.stringify(sum)})`);
  const before = ensCalls;
  await r.resolveAll([A(20), A(25)], { deadlineMs: 2000 });
  ok(ensCalls === before, "a fresh hit and a fresh miss are served from the cache");
  await r.resolveAll([A(22)], { deadlineMs: 2000 });
  ok(ensCalls === before + 1, "a failed lookup is tried again on the next read");
  t += 2 * 86_400_000;
  await r.resolveAll([A(25)], { deadlineMs: 2000 });
  ok(ensCalls === before + 2, "a miss is looked up again after its shorter age");
}
{
  // The deadline: the answer comes back with the rest pending.
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = createOperatorResolver({ lookups: { ens: async () => { await gate; return null; }, basename: async () => null }, perLookupMs: 60_000 });
  const t0 = Date.now();
  const sum = await r.operatorsOf([A(30), A(31)], { deadlineMs: 150 });
  ok(Date.now() - t0 < 2000 && sum.pendingWallets === 2 && sum.operators === 2, `the answer waits at most its deadline and counts the rest pending (${JSON.stringify(sum)})`);
  release();
}
{
  // Concurrency and the cache cap.
  let live = 0, peak = 0;
  const r = createOperatorResolver({ lookups: { ens: async () => { live++; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 5)); live--; return null; }, basename: async () => null }, concurrency: 3, cap: 10 });
  await r.resolveAll(Array.from({ length: 30 }, (_, i) => A(100 + i)), { deadlineMs: 5000 });
  ok(peak <= 3, `lookups run at most the concurrency at once (peak ${peak})`);
  ok(r.size() <= 10, `the cache is capped (${r.size()})`);
}

// ---- operators for the scoreboard --------------------------------------------------
{
  const week = [{ payer: A(1), usd: 6, days: 1 }, { payer: A(2), usd: 2, days: 3 }, { payer: A(3), usd: 2, days: 1 }];
  const resolved = new Map([[A(1), { mapping: { operator: "ops.eth", source: "ens" } }], [A(2), { mapping: { operator: "ops.eth", source: "ens" } }], [A(3), { pending: true }]]);
  const s = summarizeOperators(week, resolved);
  ok(s.wallets === 3 && s.operators === 2 && s.repeatShare === 0.5 && s.topOperatorShare === 0.8 && s.pendingWallets === 1 && s.bySource.ens === 2, `operators group only on the same resolved key (${JSON.stringify(s)})`);
  ok(!/0x[0-9a-f]{40}|ops\.eth/i.test(JSON.stringify(s)), "the summary carries no address and no name");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
