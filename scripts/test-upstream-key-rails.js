// A buyer's own upstream key (src/upstream-key.js) on the x402 rails whose
// books do not read a signed amount: Solana, Stellar and Algorand. One
// PAID-mode server (scripts/lib/paid-wires-rig.js) on stub chains, the
// upstream answered by the rig's stub:
//   - the 402 with the header quotes the own-key price on each of those rails;
//   - a paid call with the header settles the own-key price and is booked in
//     the sales ledger at the own-key price, never the list price;
//   - control: the same call without the header is booked at the list price;
//   - a buyer who leaves during the settle call is charged, and the charge is
//     booked as owed in the refund ledger at the own-key price;
//   - the cool-down after refused keys holds a Solana payer at the gate: the
//     payer is read from the payment header the request carries, on a new
//     client address each time, so only the payer's own count can hold it.
//
//   node scripts/test-upstream-key-rails.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires, sleep, SOL } from "./lib/paid-wires-rig.js";

let pass = 0, fail = 0, rig = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const KEY = "ghp_" + "k".repeat(36);
const BODY = { owner: "expressjs", repo: "express" };
const KEYED = { method: "POST", path: "/api/github-repo", body: BODY, headers: { "X-Agent402-Upstream-Key": KEY } };
const PLAIN = { method: "POST", path: "/api/github-repo", body: BODY };
const until = async (pred, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v || Date.now() - t0 > ms) return v; await sleep(50); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
try {
  rig = await bootPaidWires({ label: "upstream-key-rails", env: { UPSTREAM_KEY: "on", TRUST_PROXY_HOPS: "1", UPSTREAM_STUB_HOSTS: "api.github.com", GITHUB_TOKEN: "ghp_" + "o".repeat(36), HANGUP_FORGIVE: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000" } });
  const seenAuth = [];
  let refuseBuyerKey = false;
  rig.st.upHook = async ({ host, path, req, reply }) => {
    if (host !== "api.github.com") return false;
    seenAuth.push(String(req.headers.authorization || ""));
    if (refuseBuyerKey && req.headers.authorization === `Bearer ${KEY}`) { reply(401, { message: "Bad credentials" }); return true; }
    if (path.endsWith("/languages")) { reply(200, { JavaScript: 900, HTML: 100 }); return true; }
    reply(200, { full_name: "expressjs/express", description: "web framework", stargazers_count: 10, forks_count: 2, subscribers_count: 1, open_issues_count: 0, license: { spdx_id: "MIT" }, topics: [], language: "JavaScript", private: false, html_url: "https://github.com/expressjs/express" });
    return true;
  };
  const pricing = await fetch(`${rig.url}/api/pricing`).then((r) => r.json());
  const rows = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  const usd = (p) => Number(String(p).replace(/^\$/, ""));
  const LIST = usd(rows.find((t) => t.slug === "github-repo")?.price);
  const FEE = Math.min(...rows.filter((t) => typeof t.price === "string" && /^\$\d+(\.\d+)?$/.test(t.price) && !t.quoted && !t.pricedByModel).map((t) => usd(t.price)));
  ok(FEE > 0 && FEE < LIST, `the own-key price (${FEE}) is under github-repo's list price (${LIST})`);
  const ghSales = async () => (((await rig.operator("/__operator/sales.json")) || {}).recentExternal || []).filter((r) => r.slug === "github-repo");
  const owed = async () => (((await rig.operator("/__operator/refunds.json?status=all")) || {}).refunds || []).filter((r) => r.slug === "github-repo");
  const priceOf = (r) => r.priceUsd;

  for (const wire of ["svm", "stellar", "avm"]) {
    const w = await rig.wallet(wire);
    const fee = await rig.priceOf(w, KEYED), list = await rig.priceOf(w, PLAIN);
    ok(fee < list, `${wire}: the 402 with the header quotes less than the list price (${fee} of ${list})`);
    const n0 = (await ghSales()).length, a0 = seenAuth.length;
    const r = await rig.pay(w, KEYED);
    ok(r.status === 200 && rig.outcomesOf(w).settled === 1 && seenAuth.slice(a0).length > 0 && seenAuth.slice(a0).every((a) => a === `Bearer ${KEY}`), `${wire}: the keyed call is served, settled once, with the buyer's key (${r.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
    const booked = await until(async () => { const s = await ghSales(); return s.length > n0 ? s : null; }, 8000);
    ok(!!booked && booked.length === n0 + 1 && booked.every((x) => near(priceOf(x), FEE)) && new Set(booked.map((x) => x.network)).size === n0 + 1, `${wire}: the sale is booked at the own-key price, not the list price (booked ${JSON.stringify((booked || []).map((x) => [x.network, priceOf(x)]))}, fee ${FEE}, list ${LIST})`);
  }
  // Control: without the header the same route books its list price.
  {
    const w = await rig.wallet("svm");
    const before = await ghSales();
    const r = await rig.pay(w, PLAIN);
    const after = await until(async () => { const s = await ghSales(); return s.length > before.length ? s : null; }, 8000);
    const prices = (after || []).map(priceOf);
    ok(r.status === 200 && !!after && prices.filter((p) => near(p, LIST)).length === 1 && prices.filter((p) => near(p, FEE)).length === 3, `control: without the header the sale is booked at the list price (${JSON.stringify(prices)})`);
  }
  // A buyer who leaves during the settle call: charged, and owed at the own-key price.
  {
    const w = await rig.wallet("svm");
    rig.st.settleDelayMs = 2500;
    const headers = await rig.credentialFor(w, KEYED);
    const e0 = rig.st.events.filter((e) => e.t === "settle").length;
    const ac = new AbortController();
    const sent = rig.send(KEYED, headers, { signal: ac.signal }).catch((e) => ({ status: `error:${e?.name}` }));
    const reached = await until(() => rig.st.events.filter((e) => e.t === "settle").length > e0, 15_000);
    await sleep(150);
    ac.abort();
    const res = await sent;
    rig.st.settleDelayMs = 250;
    ok(reached && String(res.status).startsWith("error:"), `the buyer left while the settle call was in flight (${res.status})`);
    ok(await until(() => rig.outcomesOf(w).settled === 1, 15_000), `the settle went on: charged once (${JSON.stringify(rig.outcomesOf(w))})`);
    const rowsOwed = await until(async () => { const o = await owed(); return o.length ? o : null; }, 15_000);
    const amt = (r) => r.amountUsd ?? r.priceUsd ?? r.amount ?? r.usd;
    ok(Array.isArray(rowsOwed) && rowsOwed.length === 1 && rowsOwed[0].status === "owed" && near(amt(rowsOwed[0]), FEE), `the undelivered charge is owed at the own-key price, not the list price (${JSON.stringify((rowsOwed || []).map((r) => [r.status, amt(r)]))}, fee ${FEE}, list ${LIST})`);
  }
  // The cool-down, through the real gate, for a payer that is not an EVM
  // address. Each request names a client address of its own (the server
  // trusts one proxy hop here), so the address count never reaches the bound
  // and only the payer's can hold the next request.
  {
    const { UPSTREAM_KEY_REFUSED_MAX: MAX } = await import("../src/upstream-key.js");
    const from = (n) => ({ ...KEYED, headers: { ...KEYED.headers, "X-Forwarded-For": `198.51.100.${n}` } });
    const w = await rig.wallet("svm");
    refuseBuyerKey = true;
    let last = null;
    for (let i = 0; i < MAX; i++) last = await rig.pay(w, from(10 + i));
    refuseBuyerKey = false;
    ok(last?.status === 401 && last.json?.reason === "upstream_key_refused" && rig.outcomesOf(w).settled === 0, `svm: ${MAX} keys the provider refused, each from another address, are answered 401 and not charged (${last?.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
    const cred = await rig.credentialFor(w, from(90));
    const a0 = seenAuth.length;
    const cold = await rig.send(from(90), cred);
    ok(cold.status === 429 && cold.json?.reason === "upstream_key_cooldown" && cold.json?.charged === false && /^\d+$/.test(cold.headers.get("retry-after") || "") && cold.headers.get("cache-control") === "no-store" && seenAuth.length === a0 && rig.outcomesOf(w).settled === 0, `svm: the same payer's next keyed request, from an address never seen, is 429 upstream_key_cooldown before any read or settlement (${cold.status}, ${cold.json?.reason})`);
    const other = await rig.wallet("svm");
    const fine = await rig.pay(other, from(91));
    ok(fine.status === 200 && rig.outcomesOf(other).settled === 1, `control: another Solana payer from another new address is served with its key (${fine.status})`);
    const plain = await rig.pay(w, { ...PLAIN, headers: { "X-Forwarded-For": "198.51.100.92" } });
    ok(plain.status === 200, `and the held payer's call without the header is still sold (${plain.status})`);
  }
  ok(!rig.log().includes(KEY), "the key is in no log line");
} catch (e) {
  fail++;
  console.error(`FAIL - ${e?.stack || e}`);
  for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300));
} finally {
  try { await rig?.stop(); } catch (e) { fail++; console.error(`FAIL - ${e?.message || e}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
