// Idempotency binding on the proof-of-work path, driven through the real
// middleware in the order src/server.js mounts it: createIdempotency, then a
// PoW gate stand-in that accepts a solution and sets X-Pow-Accepted, then the
// handler. The cache key is computed before the PoW gate runs, so a payment
// header riding beside a valid solution is unverified text. Proves: an answer
// served on PoW is never stored under that payment header (a third party
// presenting the same header, key and body runs fresh instead of replaying),
// while a call carrying only its solution still replays as documented.
import express from "express";
import { createIdempotency } from "../src/idempotency.js";
import { createLocalIdempotencyStore } from "../src/idempotency-store.js";

let pass = 0, fail = 0;
setTimeout(() => { console.log("NOT OK - timed out"); process.exit(1); }, 15000).unref();
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const store = createLocalIdempotencyStore({ ttlMs: 60_000 });
let runs = 0;
const app = express();
app.use(express.json());
app.use(createIdempotency({ isCatalogRoute: (req) => req.path === "/api/tool", freeMode: false, store }));
// PoW gate stand-in: a solution named "valid" is accepted; anything else 402s.
app.use((req, res, next) => {
  const sol = req.header("x-pow-solution");
  if (sol === "valid") { res.setHeader("X-Pow-Accepted", "true"); return next(); }
  if (req.header("x-payment")) return res.status(402).json({ error: "payment_invalid" });
  return res.status(402).json({ error: "payment_required" });
});
app.post("/api/tool", (req, res) => { runs++; res.json({ run: runs, echo: req.body?.text ?? null }); });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
const call = (headers, body = { text: "a" }) => fetch(`${B}/api/tool`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": "k-1", ...headers },
  body: JSON.stringify(body),
});
const settle = () => new Promise((r) => setTimeout(r, 30));

try {
  // 1. A valid solution plus an arbitrary, unverified X-Payment string.
  const seed = await call({ "x-pow-solution": "valid", "x-payment": "made-up-header" });
  ok(seed.status === 200 && seed.headers.get("x-pow-accepted") === "true", "the PoW call itself is served");
  await settle();
  // 2. Anyone presenting only that X-Payment string, key and body.
  const replay = await call({ "x-payment": "made-up-header" });
  ok(replay.status === 402 && replay.headers.get("x-idempotent-replay") !== "true",
    `a PoW answer is not replayable under an unverified payment header (got ${replay.status})`);

  // 3. Documented PoW idempotency is kept: solution-only retry replays.
  const first = await call({ "x-pow-solution": "valid" }, { text: "b" });
  const firstBody = await first.json();
  await settle();
  const retry = await call({ "x-pow-solution": "valid" }, { text: "b" });
  const retryBody = await retry.json();
  ok(retry.status === 200 && retry.headers.get("x-idempotent-replay") === "true" && retryBody.run === firstBody.run,
    "a solution-only retry with the same key and body replays the stored answer");
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
