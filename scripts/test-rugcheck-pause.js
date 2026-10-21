// RugCheck-backed tools pause themselves while RugCheck is not answering
// (src/rugcheck-pause.js). Offline: a stub clock and an in-process express app.
//
//   node scripts/test-rugcheck-pause.js
import express from "express";
import { createRugcheckPause, isRugcheckOutage, rugcheckPauseMiddleware } from "../src/rugcheck-pause.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- the state machine -------------------------------------------------------
{
  let t = 1_000_000;
  const logs = [];
  const p = createRugcheckPause({ now: () => t, env: {}, log: (m) => logs.push(m) });
  p.noteFailure("deadline"); p.noteFailure("deadline");
  ok(!p.state().paused, "two consecutive failures do not pause");
  p.noteSuccess(); p.noteFailure("deadline"); p.noteFailure("deadline");
  ok(!p.state().paused, "a success in between resets the count");
  p.noteFailure("deadline");
  const s = p.state();
  ok(s.paused && s.retryAfterSeconds === 300, `three consecutive failures pause for 5 minutes (${s.retryAfterSeconds} s)`);
  ok(logs.length === 1 && /paused for 300 s/.test(logs[0]), "the pause is logged once");
  t += 120_000;
  ok(p.state().paused && p.state().retryAfterSeconds === 180, "the Retry-After counts down");
  t += 180_001;
  ok(!p.state().paused, "after the cool-down the tools are offered again (fail open)");
  p.noteFailure("deadline");
  ok(p.state().paused, "one failure on the first read after a cool-down pauses again");
  t += 300_001;
  ok(!p.state().paused, "the second cool-down ends");
  p.noteSuccess(); p.noteFailure("deadline");
  ok(!p.state().paused && p.failures() === 1, "a success after a cool-down clears probation");
}
{
  let t = 0;
  const p = createRugcheckPause({ now: () => t, env: { RUGCHECK_PAUSE_AFTER: "2", RUGCHECK_PAUSE_MS: "60000" }, log: () => {} });
  p.noteFailure(); p.noteFailure();
  ok(p.state().paused && p.state().retryAfterSeconds === 60, "RUGCHECK_PAUSE_AFTER and RUGCHECK_PAUSE_MS size the pause");
  const off = createRugcheckPause({ now: () => t, env: { RUGCHECK_PAUSE: "off" }, log: () => {} });
  for (let i = 0; i < 10; i++) off.noteFailure();
  ok(!off.state().paused, "RUGCHECK_PAUSE=off never pauses");
}

// --- what counts as an outage ------------------------------------------------
ok(isRugcheckOutage({ statusCode: 503, upstreamFailure: "deadline" }), "a deadline is an outage");
ok(isRugcheckOutage({ statusCode: 503, upstreamFailure: "unreachable" }), "an unreachable host is an outage");
ok(isRugcheckOutage({ statusCode: 502 }), "a RugCheck 5xx is an outage");
ok(!isRugcheckOutage({ statusCode: 422 }), "a refusal of the input is an answer, not an outage");

// --- the middleware answers before any payment gate ----------------------------
{
  let t = 0;
  const p = createRugcheckPause({ now: () => t, env: {}, log: () => {} });
  const app = express();
  let reachedGate = 0;
  app.use(rugcheckPauseMiddleware(["POST /api/sol-token-report", "POST /api/sol-token-holders"], p));
  app.use((req, res) => { reachedGate++; res.status(402).json({ error: "payment required" }); });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (path, method = "POST") => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });

  let r = await call("/api/sol-token-report");
  ok(r.status === 402 && reachedGate === 1, "not paused: the call reaches the payment gate");
  p.noteFailure(); p.noteFailure(); p.noteFailure();
  r = await call("/api/sol-token-report");
  const body = await r.json();
  ok(r.status === 503 && reachedGate === 1, "paused: the call answers 503 before the payment gate");
  ok(r.headers.get("retry-after") === "300" && body.retryAfterSeconds === 300, `the 503 carries Retry-After (${r.headers.get("retry-after")})`);
  ok(/Not charged - retry in about 300 s/.test(body.error) && body.attribution === "upstream", `the 503 says not charged and when to retry (${body.error})`);
  r = await call("/api/sol-token-holders", "GET");
  ok(r.status === 503, "the GET twin of a POST tool is paused too");
  r = await call("/api/sol-price");
  ok(r.status === 402 && reachedGate === 2, "a tool that does not read RugCheck is never paused");
  t += 300_001;
  r = await call("/api/sol-token-report");
  ok(r.status === 402, "after the cool-down the tool is offered again");
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
