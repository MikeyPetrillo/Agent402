// The payment refusal record (src/payment-refusals.js) for the gates that
// answer on their own, ahead of the x402 paywall, through one PAID-mode server
// (scripts/lib/paid-wires-rig.js) on stub chains:
//   - a Tempo credential its gate refuses (an empty wallet) is recorded once,
//     on the mpp rail, under the gate's own code (never "unclassified"), with
//     no payer;
//   - a credits key the credits gate refuses is recorded under its reason;
//   - an x402 payment that does not settle is recorded with its verified payer;
//   - one refused request is one count; a clean paid call records nothing.
// (The settle-first resend limit's refusal is read in
// scripts/test-settle-first-routes.js, whose rig runs that route.)
//
//   node scripts/test-payment-refusals-gates.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";

let pass = 0, fail = 0, rig = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROUTE = { method: "POST", path: "/api/hash", body: { text: "hello" } };
try {
  rig = await bootPaidWires({ label: "refusal-gates", env: { STRIPE_SECRET_KEY: "sk_test_refusal_gates_stub", STRIPE_PROFILE_ID: "", UPSTREAM_KEY: "on", UPSTREAM_STUB_HOSTS: "api.github.com" } });
  const view = async (qs = "") => (await rig.operator(`/__operator/refusals.json${qs}`)) || {};
  const total = (v) => (v.summary?.byDay || []).reduce((t, d) => t + d.total, 0);
  const settle = () => sleep(200);

  // A clean paid call first: served, nothing recorded.
  const clean = await rig.wallet("evm");
  const served = await rig.pay(clean, ROUTE);
  await settle();
  const v0 = await view();
  ok(served.status === 200 && v0.matched === 0 && total(v0) === 0, `control: a clean paid call is served and records nothing (${served.status}, ${v0.matched} rows)`);

  // A Tempo credential from an empty wallet: refused by the Tempo gate itself.
  const tw = await rig.wallet("tempo");
  rig.fund(tw, 0n);
  const t = await rig.pay(tw, ROUTE);
  await settle();
  const v1 = await view();
  const mpp = (v1.rows || []).filter((r) => r.rail === "mpp");
  ok(t.status === 402 && mpp.length === 1 && mpp[0].count === 1 && mpp[0].payer === null && mpp[0].network === "tempo" && /^mpp-/.test(mpp[0].reason) && mpp[0].slug === "hash", `a Tempo credential its gate refuses is one record on the mpp rail under the gate's code, no payer (${t.status}; ${JSON.stringify(mpp.map((r) => [r.reason, r.count, r.network, r.payer]))})`);
  ok(total(v1) === 1, `one refused request is one count (${total(v1)})`);

  // A credits key the credits gate does not know.
  const c = await rig.send(ROUTE, { Authorization: `Bearer a402_${"q".repeat(40)}` });
  await settle();
  const v2 = await view();
  const credits = (v2.rows || []).filter((r) => r.rail === "credits");
  ok(c.status === 402 && credits.length === 1 && credits[0].reason === "unknown" && credits[0].count === 1 && credits[0].payer === null, `a credits key the credits gate refuses is recorded under its reason (${c.status}; ${JSON.stringify(credits.map((r) => [r.reason, r.count]))})`);

  // An x402 payment that verifies and does not settle: its verified payer is kept.
  const poor = await rig.wallet("evm");
  rig.fund(poor, 0n);
  const p = await rig.pay(poor, ROUTE);
  await settle();
  const v3 = await view();
  const x = (v3.rows || []).filter((r) => r.rail === "x402");
  ok(p.status === 402 && x.length === 1 && x[0].payer === poor.address.toLowerCase() && x[0].reason !== "unclassified", `an x402 payment refused at settlement is recorded with its verified payer and a code (${p.status}; ${JSON.stringify(x.map((r) => [r.reason, r.payer]))})`);
  ok(total(v3) === 3 && v3.matched === 3, `three refused requests, three counts in three rows (${total(v3)}, ${v3.matched})`);

  // A Tempo credential sent again after it paid: the Tempo gate answers the
  // replay itself, before any later hook, and it is recorded under its code.
  const tok = await rig.wallet("tempo");
  const tcred = await rig.credentialFor(tok, ROUTE);
  const tPaid = await rig.send(ROUTE, tcred);
  await settle();
  const tAgain = await rig.send(ROUTE, tcred);
  await settle();
  const v5 = await view();
  const replay = (v5.rows || []).filter((r) => r.rail === "mpp" && r.reason !== mpp[0]?.reason);
  ok(tPaid.status === 200 && tAgain.status >= 400 && tAgain.status < 500 && replay.length === 1 && replay[0].count === 1 && /^mpp-/.test(replay[0].reason) && total(v5) === 4, `a Tempo credential sent again is refused by the Tempo gate and recorded once under its code (${tPaid.status}/${tAgain.status}; ${JSON.stringify(replay.map((r) => [r.reason, r.status, r.count]))})`);

  // The clean wallet pays again: still nothing recorded for it.
  const again = await rig.pay(clean, ROUTE);
  await settle();
  const v4 = await view();
  ok(again.status === 200 && total(v4) === 4 && !JSON.stringify(v4.rows).includes(clean.address.toLowerCase()), `control: a second clean paid call adds nothing (${again.status}, ${total(v4)})`);

  // A Tempo credential with a buyer's upstream key (src/upstream-key.js), on
  // the route that takes one: the real Tempo gate accepts the credential, the
  // key gate refuses the request, and nothing is broadcast, read or booked.
  const GH = { method: "POST", path: "/api/github-repo", body: { owner: "expressjs", repo: "express" } };
  const kw = await rig.wallet("tempo");
  const kcred = await rig.credentialFor(kw, GH);
  const sold = async () => (await fetch(`${rig.url}/api/stats`).then((r) => r.json()).catch(() => ({})));
  const before = JSON.stringify((await sold())?.tools?.["github-repo"] ?? (await sold())?.byTool?.["github-repo"] ?? null);
  const ups = rig.st.events.filter((e) => e.t === "upstream").length;
  const keyed = await rig.send(GH, { ...kcred, "X-Agent402-Upstream-Key": "ghp_" + "k".repeat(36) });
  await settle();
  const after = JSON.stringify((await sold())?.tools?.["github-repo"] ?? (await sold())?.byTool?.["github-repo"] ?? null);
  ok(keyed.status === 400 && keyed.json?.reason === "upstream_key_rail_unsupported" && keyed.json?.charged === false, `a Tempo credential with an upstream key is refused 400 by the key gate (${keyed.status}, ${keyed.json?.reason})`);
  ok(rig.outcomesOf(kw).attempts === 0 && rig.st.events.filter((e) => e.t === "upstream").length === ups && before === after && !keyed.headers.get("payment-receipt"), `and nothing was broadcast, read upstream or booked (${JSON.stringify(rig.outcomesOf(kw))})`);

  // An MPP refusal that FALLS THROUGH to the x402 paywall's 402 (the gate
  // marks the request and calls next, src/mpp-problem.js markMppProblem): a
  // Tempo credential minted for one route and sent to another. It is
  // recorded under the gate's own code, mpp-<kind>.<reason>, never the
  // paywall's word for a request with no x402 payment.
  {
    const fw = await rig.wallet("tempo");
    const elsewhere = await rig.credentialFor(fw, ROUTE);
    const b0 = await view();
    const r = await rig.send(GH, elsewhere);
    await settle();
    const b1 = await view();
    const key = (x) => `${x.rail}|${x.reason}|${x.slug}`;
    const had = new Map((b0.rows || []).map((x) => [key(x), x.count]));
    const added = (b1.rows || []).filter((x) => x.count > (had.get(key(x)) || 0));
    ok(r.status === 402 && /problem\+json/.test(r.headers.get("content-type") || "") && total(b1) === total(b0) + 1 && added.length === 1, `a Tempo credential bound to another route falls through to the paywall's 402 as a problem document, one record (${r.status}, ${total(b1) - total(b0)})`);
    ok(added.length === 1 && added[0].rail === "mpp" && added[0].slug === "github-repo" && /^mpp-[a-z-]+\.[a-z][a-z0-9_-]*$/.test(added[0].reason) && added[0].payer === null, `recorded under the gate's own code with its reason, no payer (${JSON.stringify(added.map((x) => [x.reason, x.slug, x.network]))})`);
    ok(rig.outcomesOf(fw).attempts === 0, "and nothing was broadcast for it");
  }

  // A Tempo PUSH credential names a transfer already on chain, and its gate
  // claims it before the handler. With a buyer's upstream key the request is
  // refused BEFORE that claim: the transfer is booked as owed, the same
  // credential without the header is then served, and the debt is voided.
  // The same holds for the key's cool-down answer.
  {
    const KEY = "ghp_" + "p".repeat(36);
    let refuseBuyerKey = false;
    const upstream = () => rig.st.events.filter((e) => e.t === "upstream").length;
    const prevHook = rig.st.upHook;
    rig.st.upHook = async ({ host, path, req, reply }) => {
      if (host !== "api.github.com") return false;
      if (refuseBuyerKey && req.headers.authorization === `Bearer ${KEY}`) { reply(401, { message: "Bad credentials" }); return true; }
      if (path.endsWith("/languages")) { reply(200, { JavaScript: 900 }); return true; }
      reply(200, { full_name: "expressjs/express", stargazers_count: 10, private: false, html_url: "https://github.com/expressjs/express" });
      return true;
    };
    const { randomBytes } = await import("node:crypto");
    const offer = await rig.offerOf(GH);
    const seen = offer.challenges.find((c) => c.method === "tempo" && c.intent === "charge");
    const PAID = Number(seen.request.amount) / 1e6;
    let seq = 0;
    const push = () => {
      const hash = "0x" + randomBytes(32).toString("hex");
      const ch = rig.Challenge.from({ realm: seen.realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 90_000 + (seq++)), request: { amount: seen.request.amount, currency: seen.request.currency, decimals: 6, recipient: seen.request.recipient, methodDetails: { chainId: 4217 } }, secretKey: rig.secret });
      return { hash, headers: { Authorization: rig.Credential.serialize({ challenge: ch, payload: { hash, type: "hash" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" }) } };
    };
    const rowOf = async (hash) => fetch(`${rig.url}/api/refunds?tx=${hash}`).then((r) => r.json()).catch(() => null);
    const until = async (pred, ms = 10_000) => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v || Date.now() - t0 > ms) return v; await sleep(100); } };
    const rowIs = (hash, status) => until(async () => { const r = await rowOf(hash); return r?.found === true && r.status === status ? r : null; });

    // Live control: a push credential with no header is claimed and served.
    const a = push();
    const ra = await rig.send(GH, a.headers);
    ok(ra.status === 200 && ra.json?.fullName === "expressjs/express" && (await rowOf(a.hash))?.found === false, `control: a push credential without the header is served, and no debt is booked (${ra.status})`);

    // The header on a push credential.
    const c = push();
    const u0 = upstream();
    const rc = await rig.send(GH, { ...c.headers, "X-Agent402-Upstream-Key": KEY });
    ok(rc.status === 400 && rc.json?.reason === "upstream_key_rail_unsupported" && rc.json?.charged === false && rc.json?.transferClaimed === false && rc.headers.get("cache-control") === "no-store" && upstream() === u0, `a push credential with an upstream key is refused 400 with the transfer not claimed (${rc.status}, ${rc.json?.reason}, transferClaimed ${rc.json?.transferClaimed})`);
    const owedC = await rowIs(c.hash, "owed");
    ok(!!owedC && Math.abs(Number(owedC.amountUsd) - PAID) < 1e-9, `and the transfer is booked as owed at the amount paid (${JSON.stringify(owedC && [owedC.status, owedC.amountUsd])}, paid ${PAID})`);
    const rc2 = await rig.send(GH, c.headers);
    ok(rc2.status === 200 && rc2.json?.fullName === "expressjs/express", `the same credential without the header is then served (${rc2.status})`);
    ok(!!(await rowIs(c.hash, "void")), "and its debt is voided: served once, owed nothing");

    // The cool-down answer on a push credential: refused keys first (x402,
    // the provider answers 401, nothing is charged), then the header is held.
    const { UPSTREAM_KEY_REFUSED_MAX: MAX } = await import("../src/upstream-key.js");
    const xw = await rig.wallet("evm");
    refuseBuyerKey = true;
    let last = null;
    for (let i = 0; i < MAX; i++) last = await rig.pay(xw, { ...GH, headers: { "X-Agent402-Upstream-Key": KEY } });
    refuseBuyerKey = false;
    ok(last?.status === 401 && last.json?.reason === "upstream_key_refused" && rig.outcomesOf(xw).settled === 0, `${MAX} keys the provider refused are answered 401 and not charged (${last?.status})`);
    const d = push();
    const u1 = upstream();
    const rd = await rig.send(GH, { ...d.headers, "X-Agent402-Upstream-Key": KEY });
    ok(rd.status === 429 && rd.json?.reason === "upstream_key_cooldown" && rd.json?.charged === false && rd.json?.transferClaimed === false && /^\d+$/.test(rd.headers.get("retry-after") || "") && rd.headers.get("cache-control") === "no-store" && upstream() === u1, `in the cool-down, a push credential with the header is answered 429 with the transfer not claimed (${rd.status}, ${rd.json?.reason}, transferClaimed ${rd.json?.transferClaimed})`);
    const owedD = await rowIs(d.hash, "owed");
    ok(!!owedD && Math.abs(Number(owedD.amountUsd) - PAID) < 1e-9, `and that transfer is booked as owed at the amount paid (${JSON.stringify(owedD && [owedD.status, owedD.amountUsd])})`);
    const rd2 = await rig.send(GH, d.headers);
    ok(rd2.status === 200 && !!(await rowIs(d.hash, "void")), `the same credential without the header is served and its debt voided (${rd2.status})`);
    ok(!rig.log().includes(KEY), "the key is in no log line");
    rig.st.upHook = prevHook;
  }
} catch (e) {
  fail++;
  console.error(`FAIL - ${e?.stack || e}`);
  for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300));
} finally {
  try { await rig?.stop(); } catch (e) { fail++; console.error(`FAIL - ${e?.message || e}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
