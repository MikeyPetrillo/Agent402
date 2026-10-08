// Idempotency in-flight guard, driven through the real middleware in the order
// src/server.js mounts it: the credits gate, then createIdempotency, then the
// handler. A prepaid credits key is reusable, so before the guard two copies of
// one keyed call sent while the first was still running both ran and were both
// debited. Proves: the overlapping copy gets 409 and is not charged, the first
// is debited once, a retry after it finishes replays without a second debit,
// and calls with no key, a different key or a different body are untouched.
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredits } from "../src/credits.js";
import { createIdempotency } from "../src/idempotency.js";

let pass = 0, fail = 0;
// A regression here tends to hang (a duplicate that reaches the handler parks on the
// held first call), so a stuck run fails loudly instead of stalling the lane.
setTimeout(() => { console.log("NOT OK - timed out: a keyed duplicate reached the handler or never finished"); process.exit(1); }, 15000).unref();
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const DIR = mkdtempSync(join(tmpdir(), "test-idem-inflight-"));
const sessions = { cs_paid: { id: "cs_paid", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "c@x.com" }, metadata: { credits_pack: "credits-20" } } };
const stripe = { checkout: { sessions: { create: async () => ({ id: "x", url: "https://example.test" }), retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("no"); return s; } } } };
const debits = [];
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, onDebit: (d) => debits.push(d), onLoad: () => {}, log: () => {} });
const KEY = (await cr.claim("cs_paid")).key;

const PRICE = 0.01;
let runs = 0;
let failNext = false;
let releaseFirst;
const app = express();
app.use(express.json());
app.use(cr.gate((method, path) => (path === "/api/slow" ? { priceUsd: PRICE, slug: "slow" } : null)));
app.use(createIdempotency({ isCatalogRoute: (req) => req.path === "/api/slow", freeMode: false }));
app.post("/api/slow", async (req, res) => {
  runs++;
  if (req.body?.hold) await new Promise((r) => { releaseFirst = r; });
  if (failNext) { failNext = false; return res.status(500).json({ error: "boom" }); }
  res.json({ echo: req.body?.text ?? null, run: runs });
});
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
const call = (body, idem) => fetch(`${B}/api/slow`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...(idem ? { "idempotency-key": idem } : {}) },
  body: JSON.stringify(body),
});
const spent = () => cr.balance(KEY).spentUsd;
const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

try {
  // 1. The first keyed call is still running when its copy arrives.
  const first = call({ text: "a", hold: true }, "k-1");
  await waitFor(() => typeof releaseFirst === "function");
  const dup = await call({ text: "a", hold: true }, "k-1");
  const dupBody = await dup.json();
  ok(dup.status === 409 && dupBody.error === "idempotent_request_in_flight" && dup.headers.get("retry-after") === "2",
    `an overlapping copy of a running keyed call gets 409 in_flight with Retry-After (got ${dup.status})`);
  ok(runs === 1, `the copy never reached the handler (runs ${runs})`);
  releaseFirst();
  const firstRes = await first;
  ok(firstRes.status === 200 && (await firstRes.json()).echo === "a", "the first call completes with its answer");
  await waitFor(() => debits.length >= 1);
  ok(debits.length === 1 && Math.abs(spent() - PRICE) < 1e-9, `one debit for the pair, not two (debits ${debits.length}, spent ${spent()})`);

  // 2. A retry after the first finished replays its answer without a debit.
  const retry = await call({ text: "a", hold: true }, "k-1");
  ok(retry.status === 200 && retry.headers.get("x-idempotent-replay") === "true" && (await retry.json()).run === 1,
    "a retry after the first finished replays the stored answer");
  await new Promise((r) => setTimeout(r, 20));
  ok(debits.length === 1 && runs === 1, `the replay was not debited and did not run (debits ${debits.length}, runs ${runs})`);

  // 3. The guard is scoped to key + credential + body: other calls run normally.
  const diffBody = await call({ text: "b" }, "k-1");
  ok(diffBody.status === 200 && (await diffBody.json()).echo === "b", "same key with a different body is a new call, not refused");
  const noKey = await call({ text: "a" }, null);
  ok(noKey.status === 200, "a call with no Idempotency-Key is unaffected");
  await waitFor(() => debits.length >= 3);
  ok(debits.length === 3 && runs === 3, `each distinct call ran and was debited once (debits ${debits.length}, runs ${runs})`);

  // 4. A call that fails (non-200) clears its mark and is not debited; the retry runs.
  failNext = true;
  const failed = await call({ text: "c" }, "k-2");
  ok(failed.status === 500, `a failing keyed call answers its error (got ${failed.status})`);
  const again = await call({ text: "c" }, "k-2");
  ok(again.status === 200 && again.headers.get("x-idempotent-replay") !== "true", `a retry after a failed call runs fresh, not 409 or a replay (got ${again.status})`);
  await waitFor(() => debits.length >= 4);
  ok(debits.length === 4, `the failed call was not debited, its retry was (debits ${debits.length})`);
} finally {
  server.close();
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
