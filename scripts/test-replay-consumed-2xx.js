#!/usr/bin/env node
// The x402 replay guard (src/server.js, the paywall block) marks a payment
// CONSUMED when its call was granted, and releases it otherwise so the
// buyer's retry of a refused call can run. @x402/express settles every
// handler answer under 400, so "granted" is any 2xx, not only a 200: a paid
// route that answered 201 or 204 was settled and then released here, and the
// same authorization ran the handler again (its second settle is the chain's
// to refuse). The async front's 202 (Prefer: respond-async, answered before
// every gate with Preference-Applied) is the one 2xx that grants nothing.
//   a. a paid call answered 201: settled once; the same payment sent again is
//      refused as used (409, X-Payment-Replay consumed) and nothing runs;
//   b. control: a refused call (a 4xx from the handler) is released, so the
//      same payment then buys one run;
//   c. control: a 200 is consumed as before (the resend runs nothing more).
// One PAID-mode server (scripts/lib/paid-wires-rig.js) with a test preload
// that sends the route's answer with the status the request names
// (scripts/lib/answer-status-preload.js).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { bootPaidWires } = await import("./lib/paid-wires-rig.js");

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter((x) => /replay|settle|error/i.test(x)).slice(-15)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const SQL = { method: "POST", path: "/api/sql-guard", body: { sql: "select 1" } };
const BAD = { method: "POST", path: "/api/sql-guard", body: {} };

rig = await bootPaidWires({
  label: "replay-consumed-2xx",
  env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=./scripts/lib/answer-status-preload.js`.trim() },
});
try {
  // a. a 201 is a granted, settled call: its payment is consumed.
  {
    const w = await rig.wallet("evm");
    const headers = { ...(await rig.credentialFor(w, SQL)), "x-test-answer-status": "201" };
    const r = await rig.send(SQL, headers);
    await ok(r.status === 201 && rig.outcomesOf(w).settled === 1, `a. a paid call answered 201 is settled (${r.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
    const again = await rig.send(SQL, headers);
    await ok(again.status === 409 && again.headers.get("x-payment-replay") === "consumed", `a. the same payment sent again is refused as used (${again.status}, ${again.headers.get("x-payment-replay")})`);
    await ok(rig.outcomesOf(w).attempts === 1 && rig.outcomesOf(w).settled === 1, `a. nothing ran or settled a second time (${JSON.stringify(rig.outcomesOf(w))})`);
  }
  // b. a refused call is released: the same payment then buys one run.
  {
    const w = await rig.wallet("evm");
    const headers = await rig.credentialFor(w, BAD);
    const r = await rig.send(BAD, headers);
    await ok(r.status === 400 && rig.outcomesOf(w).attempts === 0, `b. a call the handler refuses (400) is not settled (${r.status})`);
    const retry = await rig.send(SQL, headers);
    await ok(retry.status === 200 && rig.outcomesOf(w).settled === 1, `b. the same payment then buys one run: it was released (${retry.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
  }
  // c. a 200 is consumed as it always was.
  {
    const w = await rig.wallet("evm");
    const headers = await rig.credentialFor(w, SQL);
    const r = await rig.send(SQL, headers);
    const again = await rig.send(SQL, headers);
    await ok(r.status === 200 && rig.outcomesOf(w).attempts === 1 && rig.outcomesOf(w).settled === 1 && (again.status === 409 || again.headers.get("x-replayed-answer") === "1"), `c. a 200's payment sent again runs nothing more (${again.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
  }
} catch (e) {
  await fail(`unexpected error: ${e?.stack || e}`);
}
await rig.stop();
console.log(`\n${pass} passed, 0 failed`);
