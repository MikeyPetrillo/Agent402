// Test-only preload (node --import): holds a successful JSON answer for a
// request that asks for it, so a booted test can close the connection AFTER a
// fast handler has done its work and BEFORE the first byte - and therefore
// before any payment gate settles. scripts/test-hangup-settlement.js uses it
// to show which routes a hang-up is forgiven on: a memory write or a stored
// verdict finishes in a millisecond, which no client timing can land inside.
//
// A request opts in with `x-test-hold-json-ms: <ms>`; only a response whose
// status is still 2xx when the handler calls res.json is held, once, and the
// preload logs one line naming the request so the test knows when to close.
// Everything else (the paywall's 402s, errors, requests without the header)
// passes straight through.
//
// It refuses to load unless HANGUP_TEST_HOLD_JSON=1, so it can never ride a
// real boot by accident.
import express from "express";

if (process.env.HANGUP_TEST_HOLD_JSON !== "1") {
  throw new Error("hold-json preload: refusing to load outside the hang-up test (set HANGUP_TEST_HOLD_JSON=1)");
}

const realJson = express.response.json;
express.response.json = function heldJson(body) {
  const ms = Number(this.req?.headers?.["x-test-hold-json-ms"]);
  if (!(ms > 0) || ms > 10_000 || this.statusCode < 200 || this.statusCode >= 300 || Object.hasOwn(this, "__a402TestHeld")) return realJson.call(this, body);
  Object.defineProperty(this, "__a402TestHeld", { value: true });
  process.stderr.write(`[hold-json] holding ${this.req.method} ${this.req.path} for ${ms} ms\n`);
  setTimeout(() => { try { realJson.call(this, body); } catch { /* the socket is gone; the gate still runs */ } }, ms);
  return this;
};
