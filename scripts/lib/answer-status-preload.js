// Test preload (never loaded in production): a catalog answer the route
// binder sends with res.json is sent with the status the request names in
// X-Test-Answer-Status (a 2xx other than 200), so a suite can drive a paid
// route that answers 201 or 204 through every gate. Loaded into a booted
// server through NODE_OPTIONS="--import=./scripts/lib/answer-status-preload.js".
import express from "express";

const original = express.response.json;
express.response.json = function answerStatusJson(body) {
  const want = Number(this.req?.headers?.["x-test-answer-status"]);
  if (this.statusCode === 200 && Number.isInteger(want) && want > 200 && want < 300) this.statusCode = want;
  return original.call(this, body);
};
