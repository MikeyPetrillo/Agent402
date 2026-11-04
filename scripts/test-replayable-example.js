#!/usr/bin/env node
// A 402's example input is what the paid sweeps (and any buyer) replay. Over
// its byte budget a route's 402 shortens long input strings to a placeholder
// (src/payments.js fitChallenge), and a sweep that posted the placeholder got
// a 400 from html-frames on its own example. This suite pins:
//   1. the placeholder is recognized, and only the placeholder;
//   2. a shortened example is replaced by the full /openapi.json example, and
//      a route with no full example yields null instead of the placeholder;
//   3. every script that buys from a 402's example reads it through
//      resolveReplayableInput (the caller path, not only the helper);
//   4. html-frames' own example fits under the shortening threshold, so its
//      402 carries the working document.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { fitChallenge, isShortenedExampleString } from "../src/payments.js";
import { hasShortenedExample, replayableInput, resolveReplayableInput, openapiReader, openapiOperation } from "./lib/replayable-example.js";
import { openapiRequestBody } from "../src/openapi-request.js";
import { BROWSER_MEASURE_TOOLS, FRAMES_EXAMPLE_HTML, FRAMES_EXAMPLE_MAX_CHARS } from "../src/tools/browser-measure-kit.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`ok - ${msg}`); } else { failed++; console.error(`FAIL - ${msg}`); } };

const declare = (b) => ({ info: { input: { type: "http", method: "POST", bodyType: "json", body: b.input } } });
const longDoc = "<!doctype html>" + "x".repeat(400);
const block = { input: { html: longDoc, times: [0, 1] } };
const fitted = fitChallenge(block, "short", declare, 200);
const shortened = fitted.slim.input;

// 1. recognition
ok(fitted.trimmed.includes("input-example-strings") && isShortenedExampleString(shortened.html), "a budget-shortened input string is recognized as the placeholder");
ok(!isShortenedExampleString(longDoc) && !isShortenedExampleString("<12 characters>") && !isShortenedExampleString(42), "an ordinary string, a look-alike and a number are not the placeholder");
ok(hasShortenedExample({ a: [{ b: shortened.html }] }) && !hasShortenedExample({ a: [{ b: "plain" }] }), "a placeholder nested in arrays and objects is found; none is not invented");

// 2. replacement from /openapi.json
const op = { requestBody: openapiRequestBody({ input: block.input }) };
const input = { type: "http", method: "POST", bodyType: "json", body: shortened };
const replay = replayableInput(input, op);
ok(replay && replay.body.html === longDoc && replay.bodyType === "json", "a shortened body is replaced by the full /openapi.json example, other fields kept");
const untouched = { type: "http", method: "POST", body: { html: "<p>short</p>" } };
ok(replayableInput(untouched, null) === untouched, "an unshortened example is returned as is, with no /openapi.json read");
ok(replayableInput(input, null) === null, "a shortened example with no /openapi.json operation yields null, never the placeholder");
ok(replayableInput(input, { requestBody: openapiRequestBody({ input: shortened }) }) === null, "a /openapi.json example that is itself shortened yields null");
ok(replayableInput({ type: "http", method: "GET", queryParams: { q: shortened.html } }, op) === null, "a shortened query parameter yields null");

let reads = 0;
const doc = { paths: { "/api/html-frames": { post: op } } };
const readOpenapi = openapiReader("http://stub.invalid", { fetchImpl: async () => { reads++; return { ok: true, json: async () => doc }; } });
const viaReader = await resolveReplayableInput(input, { method: "POST", path: "/api/html-frames", readOpenapi });
await resolveReplayableInput(input, { method: "POST", path: "/api/html-frames", readOpenapi });
ok(viaReader?.body?.html === longDoc && reads === 1, "the reader fetches /openapi.json once and resolves by method and path");
ok(openapiOperation(doc, "POST", "/api/other") === null, "an unknown path has no operation");
reads = 0;
await resolveReplayableInput(untouched, { method: "POST", path: "/api/html-frames", readOpenapi });
ok(reads === 0, "an unshortened example never reads /openapi.json");

// 3. every buyer script reads the 402's example through the resolver
const scriptsDir = new URL("./", import.meta.url);
const readers = [];
for (const f of readdirSync(scriptsDir)) {
  if (!f.endsWith(".js") || f.startsWith("test-")) continue;
  const src = readFileSync(new URL(f, scriptsDir), "utf8");
  src.split("\n").forEach((line, i) => {
    if (/extensions\?\.bazaar\?\.info\?\.input\b/.test(line)) readers.push({ f, line: i + 1, through: line.includes("resolveReplayableInput(") });
  });
}
ok(readers.length >= 4, `the buyer scripts that replay a 402 example are found (${readers.length})`);
for (const r of readers) ok(r.through, `${r.f}:${r.line} reads the 402's example through resolveReplayableInput`);

// 4. html-frames keeps its document in the 402
const frames = BROWSER_MEASURE_TOOLS.find((t) => t.slug === "html-frames");
ok(frames.discovery.input.html === FRAMES_EXAMPLE_HTML && FRAMES_EXAMPLE_HTML.length <= FRAMES_EXAMPLE_MAX_CHARS, `html-frames' example document is at most ${FRAMES_EXAMPLE_MAX_CHARS} characters (${FRAMES_EXAMPLE_HTML.length})`);
const framesFit = fitChallenge({ input: frames.discovery.input }, "short", declare, 1);
ok(framesFit.slim.input.html === FRAMES_EXAMPLE_HTML, "under any budget, html-frames' 402 example keeps the working document");
ok(/renderAt\s*=/.test(FRAMES_EXAMPLE_HTML), "the example document defines renderAt");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
