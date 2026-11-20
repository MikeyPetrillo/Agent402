#!/usr/bin/env node
// A buyer who leaves while the x402 settle waits on the shared store, after
// the client-gone check passed and before the charge is sent, is charged
// (the settle goes on) and the charge is booked as owed. Its forgiveness
// ticket must then be RELEASED, not recorded as abandoned: an abandoned
// ticket counts a withheld charge against the wallet's, the IP's and the
// service's hang-up budget, and this charge was not withheld. The dispatcher
// used to settle the ticket at the close itself (src/server.js, the hang-up
// forgiveness mount), reading "no settlement sent" while the authorization
// claim (src/settlement-claims.js) was still waiting on Redis; it now settles
// the ticket once the response's outcome is known.
//
// One PAID-mode server (scripts/lib/paid-wires-rig.js) on a real Redis. The
// claim's wait is made with CLIENT PAUSE WRITE, issued while the model stub
// holds the handler's upstream call: the claim's SET is the first write the
// settle path waits on after the client-gone check.
//   a. control: a connected buyer is served and charged; nothing owed, no
//      budget spent;
//   b. a close during the claim's store wait: charged once, owed once, and
//      no forgiveness budget spent (abandoned count unchanged, nothing left
//      in flight);
//   c. control: a close while the handler runs (no store wait): nothing
//      settles, nothing is owed, and the run is recorded as abandoned.
// Requires REDIS_URL (under CI a missing one fails).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";

const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-hangup-claim-wait: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '') and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
const { bootPaidWires, sleep } = await import("./lib/paid-wires-rig.js");
const { createClient } = await import("redis");

let pass = 0, rig = null, admin = null;
const fail = async (m) => {
  console.error(`FAIL - ${m}`);
  for (const l of (rig?.log() || "").split("\n").filter((x) => /hangup|settle|claim|error/i.test(x)).slice(-25)) console.error("  server:", l.slice(0, 300));
  try { await admin?.sendCommand(["CLIENT", "UNPAUSE"]); } catch { /* best effort */ }
  await rig?.stop().catch(() => {});
  await admin?.quit().catch(() => {});
  process.exit(1);
};
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const CHAT = { method: "POST", path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "hi" }] } };
const doc = async () => (await rig.operator("/__operator/refunds.json?status=all")) || {};
const until = async (pred, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v || Date.now() - t0 > ms) return v; await sleep(50); } };
// Waits for the model stub to have received `n` calls in all.
const stubSaw = (n, ms = 20_000) => until(() => rig.st.completions >= n, ms);

admin = createClient({ url: REDIS });
admin.on("error", () => {});
await admin.connect();
rig = await bootPaidWires({
  label: "hangup-claim-wait",
  env: {
    REDIS_URL: REDIS,
    // A run of its own on a shared Redis: every key this server writes is
    // scoped, so a previous run's claims and budgets are never read.
    SHARED_LIMITS_PREFIX: `hcw-${randomBytes(6).toString("hex")}:`,
    // The claim waits for the paused store instead of giving up at its
    // 250 ms deadline (the claim is then made in this process).
    SETTLE_CLAIM_DEADLINE_MS: "6000",
    HANGUP_FORGIVE: "", HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "2", HANGUP_FORGIVE_WINDOW_MS: "86400000",
    LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000",
  },
});
try {
  const owedRows = async () => ((await doc()).refunds || []).filter((r) => r.status === "owed");
  const budget = async () => (await doc()).hangupForgiveness || {};

  // a. Control: connected, served, charged, nothing owed.
  {
    const w = await rig.wallet("evm");
    const r = await rig.pay(w, CHAT);
    await ok(r.status === 200 && rig.outcomesOf(w).settled === 1, `a. a connected buyer is served and charged (${r.status}, ${JSON.stringify(rig.outcomesOf(w))})`);
    const b = await budget();
    await ok((await owedRows()).length === 0 && b.abandonedInWindow === 0 && b.inflightUsd === 0, `a. nothing owed, no budget spent (${JSON.stringify({ abandoned: b.abandonedInWindow, inflight: b.inflightUsd })})`);
  }

  // b. The close lands while the authorization claim waits on the store.
  {
    const w = await rig.wallet("evm");
    const seen0 = rig.st.completions;
    rig.st.llmDelayMs = 400;
    const headers = await rig.credentialFor(w, CHAT);
    const ac = new AbortController();
    const sent = rig.send(CHAT, headers, { signal: ac.signal }).catch((e) => ({ status: `error:${e?.name}` }));
    await ok(await stubSaw(seen0 + 1), "b. the handler's upstream call reached the model stub");
    // Writes wait from here; the stub answers 400 ms after the call arrived,
    // the handler returns, the client-gone check passes, and the claim's SET
    // waits for the pause to end.
    await admin.sendCommand(["CLIENT", "PAUSE", "1800", "WRITE"]);
    await sleep(400 + 350);
    ac.abort();
    const res = await sent;
    await ok(String(res.status).startsWith("error:"), `b. the buyer left before any answer (${res.status})`);
    await ok(await until(() => rig.outcomesOf(w).settled === 1), `b. the settle went on after the store answered: charged once (${JSON.stringify(rig.outcomesOf(w))})`);
    const owed = await until(async () => { const rows = await owedRows(); return rows.length === 1 ? rows : null; });
    await ok(Array.isArray(owed) && owed.length === 1, `b. the undelivered charge is booked as owed, once (${JSON.stringify((owed || []).map((r) => ({ slug: r.slug, status: r.status })))})`);
    const b = await until(async () => { const x = await budget(); return x.inflightUsd === 0 ? x : null; });
    await ok(b && b.abandonedInWindow === 0, `b. no forgiveness budget is spent for a charge that was sent (abandoned ${b?.abandonedInWindow}, in flight ${b?.inflightUsd})`);
  }

  // c. Control: a close while the handler runs, with no store wait.
  {
    await sleep(2000); // the pause above has ended
    const w = await rig.wallet("evm");
    const seen0 = rig.st.completions;
    rig.st.llmDelayMs = 1200;
    const headers = await rig.credentialFor(w, CHAT);
    const ac = new AbortController();
    const sent = rig.send(CHAT, headers, { signal: ac.signal }).catch((e) => ({ status: `error:${e?.name}` }));
    await ok(await stubSaw(seen0 + 1), "c. the handler's upstream call reached the model stub");
    await sleep(200);
    ac.abort();
    await sent;
    const b = await until(async () => { const x = await budget(); return x.abandonedInWindow === 1 && x.inflightUsd === 0 ? x : null; });
    await ok(b && b.abandonedInWindow === 1, `c. a close before the settle is a withheld charge: recorded as abandoned (${JSON.stringify(b)})`);
    await sleep(1500);
    await ok(rig.outcomesOf(w).attempts === 0 && (await owedRows()).length === 1, `c. nothing settles and nothing more is owed (${JSON.stringify(rig.outcomesOf(w))})`);
  }
} catch (e) {
  await fail(`unexpected error: ${e?.stack || e}`);
}
await rig.stop();
await admin.quit().catch(() => {});
console.log(`\n${pass} passed, 0 failed`);
