#!/usr/bin/env node
// Offline proof of the catalog buy's capture (scripts/catalog-buy-capture.js),
// the captured-example merge rule (src/tool-output-examples.js) and the
// examples script (scripts/catalog-buy-examples.js), against synthetic
// captures. No network, no wallet, no money.
//
//   node scripts/test-catalog-buy-examples.js
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trimExample, trimToBudget, hasHandWrittenExample, keyMismatch, loadCapturedExamples, applyCapturedExamples, captureNote, TRIM } from "../src/tool-output-examples.js";
import { redactBody, foreignHosts, foreignAddresses, inputHosts, boundBody, captureRecord, isCaptureDenied, REDACTED, CAPTURE_MAX_BYTES } from "./catalog-buy-capture.js";
import { planExamples, rankFindings, findingsFor, markdownReport, serializeExamples, namesThirdParty, MIN_MODEL_TEXT_CHARS } from "./catalog-buy-examples.js";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const J = (x) => JSON.stringify(x);

// ---- trimming -------------------------------------------------------------
{
  const long = "x".repeat(1000);
  const v = { n: 1.5, b: true, z: null, s: long, rows: [1, 2, 3, 4, 5], deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } };
  const t = trimExample(v);
  eq(t.rows, [1, 2, 3], `arrays keep their first ${TRIM.arrayItems} items`);
  ok(t.s.length === TRIM.stringChars + 1 && t.s.endsWith("…"), `strings are cut to ${TRIM.stringChars} chars plus an ellipsis`);
  ok(t.n === 1.5 && t.b === true && t.z === null, "numbers, booleans and null are kept as they are");
  eq(t.deep.a.b.c.d, {}, "a container past the depth bound becomes an empty container of the same type");
  eq(trimExample({ a: [[[[[[1]]]]]] }).a[0][0][0][0], [], "an array past the depth bound becomes []");
  eq(Object.keys(trimExample({ k1: 1, k2: "a", k3: [1] })), ["k1", "k2", "k3"], "top-level keys are never dropped");
  eq(J(trimExample(v)), J(trimExample(JSON.parse(J(v)))), "trimming is deterministic");
  const big = { rows: Array.from({ length: 50 }, (_, i) => ({ i, text: "y".repeat(2000) })) };
  const { example, fits } = trimToBudget(big, 2000);
  ok(fits && J(example).length <= 2000 && Array.isArray(example.rows), "trimToBudget tightens until the example fits its byte budget");
}

// ---- redaction ------------------------------------------------------------
{
  const payer = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  const tx = "0x" + "ab".repeat(32), namedTx = "0x" + "cd".repeat(32);
  const body = { result: 42, payer, note: `paid by ${payer.toLowerCase()} in ${tx}`, echo: namedTx, receipt: { transaction: tx }, requestId: "req_123", nested: [{ payment_response: "abc" }] };
  const r = redactBody(body, { payer, input: { hash: namedTx } });
  ok(r.payer === REDACTED && r.receipt === REDACTED && r.requestId === REDACTED && r.nested[0].payment_response === REDACTED, "payer, receipt, request id and payment response values are blanked");
  eq(Object.keys(r), Object.keys(body), "redaction keeps the key set (so it stays comparable with the example)");
  ok(!J(r).toLowerCase().includes(payer.toLowerCase()), "the payer's address is replaced wherever it appears, in any case");
  ok(!J(r).includes(tx), "a tx hash the example input did not name is replaced");
  ok(r.echo === namedTx, "a tx hash the example input named is kept (it is the tool's own subject)");
  ok(r.result === 42, "the answer itself is untouched");
}

// ---- host and address guards ------------------------------------------------
{
  eq([...inputHosts({ url: "https://www.Site.example/page", domain: "docs.sample.example", n: 3 })].sort(), ["docs.sample.example", "site.example"], "the example input's hosts: URL hosts and bare domains, lowercased, www stripped");
  const input = { url: "https://site.example/a" };
  eq(foreignHosts({ links: ["https://site.example/b", "https://cdn.site.example/x.png", "https://agent402.tools/tools/x"] }, input), [], "our host, the input's host and its subdomains pass");
  eq(foreignHosts({ links: ["https://other.example/b"] }, input), ["other.example"], "any other URL host is foreign");
  eq(foreignHosts({ "https://other.example/k": 1 }, input), ["other.example"], "a host in a key is caught too");
  const addr = "0x" + "12".repeat(20), other = "0x" + "34".repeat(20);
  eq(foreignAddresses({ token: addr }, { address: addr }), [], "an address the example input names passes");
  eq(foreignAddresses({ holder: other }, { address: addr }), [other], "an address the input does not name is foreign");
  eq(foreignAddresses({ hash: "0x" + "ab".repeat(32) }, {}), [], "a 32-byte hash is not read as an address");
}

// ---- bounding and the capture record ------------------------------------------
{
  const small = { a: 1 };
  eq(boundBody(small), { body: small, bytes: 7, truncated: false }, "a body under the bound is kept as is");
  const huge = { rows: Array.from({ length: 400 }, (_, i) => ({ i, t: "z".repeat(500) })) };
  const b = boundBody(huge);
  ok(b.truncated && J(b.body).length <= CAPTURE_MAX_BYTES && b.bytes > CAPTURE_MAX_BYTES, `a body over ${CAPTURE_MAX_BYTES} B is trimmed under it and records its real size`);

  const op = (example) => ({ responses: { 200: { content: { "application/json": { example } } } } });
  const row = { slug: "tool-a", path: "/api/tool-a", method: "post", usd: 0.001, modelBacked: false, op: op({ rows: [1], n: 1 }), example: { kind: "json", body: { url: "https://site.example" } } };
  const graded = { status: 200, grade: "ok", pass: true, ms: 120 };
  const rec = captureRecord(row, graded, { status: 200, paid: true, body: { rows: [1, 2], n: 2, src: "https://site.example/p" } }, { payer: "0x" + "99".repeat(20) });
  ok(rec.captured && rec.captured.body.n === 2 && rec.dropped === null, "a passing paid 200 is captured");
  eq(rec.documented, { source: "hand-written", keys: ["rows", "n"], populatedArrays: ["rows"], bytes: J({ rows: [1], n: 1 }).length }, "the documented example's shape is recorded, not the example");
  eq(captureRecord(row, graded, { status: 200, paid: true, body: { link: "https://elsewhere.example" } }).dropped, "foreign-host", "an answer naming another host is dropped");
  ok(!J(captureRecord(row, graded, { status: 200, paid: true, body: { link: "https://elsewhere.example" } })).includes("elsewhere"), "a dropped answer records only the reason, never the host");
  eq(captureRecord(row, graded, { status: 200, paid: true, body: { w: "0x" + "56".repeat(20) } }).dropped, "foreign-address", "an answer naming an outside wallet is dropped");
  eq(captureRecord({ ...row, slug: "seller-dossier" }, graded, { status: 200, paid: true, body: { a: 1 } }).dropped, "denylist", "a seller tool is denied by the list");
  ok(isCaptureDenied("route-execute-ultra") && isCaptureDenied("x402-anything") && isCaptureDenied("memory-new") && !isCaptureDenied("hash"), "denied families match by prefix; an ordinary tool is not denied");
  eq(captureRecord(row, graded, { status: 200, paid: false, body: { a: 1 } }).dropped, "no-paid-200", "an unpaid 200 is never captured");
  eq(captureRecord({ ...row, op: op({}) }, graded, { status: 200, paid: true, body: { a: 1 } }).documented.source, "none", "an empty documented example reads as none");
  const capOp = { responses: { 200: { content: { "application/json": { example: { a: 1 }, "x-example-source": { kind: "captured-paid-answer" } } } } } };
  eq(captureRecord({ ...row, op: capOp }, graded, { status: 200, paid: true, body: { a: 1 } }).documented.source, "captured", "an example the server marks captured reads as captured, not hand-written");
}

// ---- merge rule: a hand-written example is never overwritten -------------------
{
  const hand = { slug: "hand", discovery: { output: { example: { written: true } } } };
  const bare = { slug: "bare", discovery: { input: { q: 1 } } };
  const emptyObj = { slug: "empty", discovery: { output: { example: {} } } };
  const binary = { slug: "bin", binaryTypes: ["image/png"], discovery: {} };
  const shared = { input: { q: 1 } };
  const twinA = { slug: "twin", discovery: shared }, other = { slug: "other", discovery: shared };
  const captured = {
    hand: { capturedAt: "2026-10-12", example: { real: 1 }, modelBacked: false },
    bare: { capturedAt: "2026-10-12", example: { real: 2 }, modelBacked: true },
    empty: { capturedAt: "2026-10-12", example: { real: 3 }, modelBacked: false },
    bin: { capturedAt: "2026-10-12", example: { real: 4 }, modelBacked: false },
    twin: { capturedAt: "2026-10-12", example: { real: 5 }, modelBacked: false },
  };
  const res = applyCapturedExamples([hand, bare, emptyObj, binary, twinA, other], captured);
  eq(hand.discovery.output.example, { written: true }, "a hand-written example is never overwritten");
  eq(res.kept, ["hand"], "and the tool is reported as kept");
  eq(bare.discovery.output.example, { real: 2 }, "a tool with no example gets the captured one");
  eq(bare.discovery.output.captured, { capturedAt: "2026-10-12", modelBacked: true }, "with its provenance");
  eq(bare.discovery.input, { q: 1 }, "the rest of its discovery is kept");
  eq(emptyObj.discovery.output.example, { real: 3 }, "an empty-object example counts as none");
  ok(binary.discovery.output === undefined, "a binary tool is never given a JSON example");
  ok(other.discovery.output === undefined && shared.output === undefined, "a discovery object shared by reference is not mutated for another tool");
  ok(hasHandWrittenExample(hand) && !hasHandWrittenExample(bare), "a captured example is not mistaken for a hand-written one on a second pass");
  applyCapturedExamples([bare], { bare: { capturedAt: "2026-10-19", example: { newer: 1 }, modelBacked: false } });
  eq(bare.discovery.output.example, { newer: 1 }, "a newer captured example replaces an older captured one");
  eq(captureNote({ capturedAt: "2026-10-12", modelBacked: false }), "This example is a real paid answer captured on 2026-10-12.", "the provenance sentence names the date");
  ok(/model-generated, so a call with the same input varies/.test(captureNote({ capturedAt: "2026-10-12", modelBacked: true })), "and says model-generated and varies for a model-backed tool");
  const dir = mkdtempSync(join(tmpdir(), "examples-"));
  const f = join(dir, "x.json");
  writeFileSync(f, J({ _note: "n", good: captured.bare, badDate: { capturedAt: "yesterday", example: { a: 1 } }, empty: { capturedAt: "2026-10-12", example: {} } }));
  eq(Object.keys(loadCapturedExamples(f)), ["good"], "loading skips the header, an undated entry and an empty example");
  eq(loadCapturedExamples(join(dir, "missing.json")), {}, "a missing file loads as no examples");
  const shipped = loadCapturedExamples(fileURLToPath(new URL("../src/tool-output-examples.json", import.meta.url)));
  ok(Object.values(shipped).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.capturedAt)), "every shipped captured example carries a date");
}

// ---- key mismatch, findings and ranking ------------------------------------------
{
  eq(keyMismatch({ a: 1, b: 2 }, { a: 1, c: 3 }), { missing: ["b"], extra: ["c"] }, "keyMismatch names documented keys missing and real keys the example lacks");
  eq(keyMismatch({ a: 1 }, { a: 2 }), null, "matching key sets are no mismatch");
  const base = { path: "/api/x", usd: 0.001, status: 200, grade: "ok", pass: true, ms: 200, modelBacked: false, dropped: null };
  const caps = [
    { ...base, slug: "broken", status: 500, grade: "http-500", pass: false, captured: null, documented: { source: "hand-written", keys: ["a"], populatedArrays: [], bytes: 10 } },
    { ...base, slug: "drift", captured: { bytes: 30, body: { a: 1, extra: 2 } }, documented: { source: "hand-written", keys: ["a", "gone"], populatedArrays: [], bytes: 30 } },
    { ...base, slug: "tiny", captured: { bytes: 50, body: { a: 1 } }, documented: { source: "hand-written", keys: ["a"], populatedArrays: [], bytes: 2000 } },
    { ...base, slug: "terse", modelBacked: true, captured: { bytes: 40, body: { answer: "ok" } }, documented: { source: "none", keys: [], populatedArrays: [], bytes: 0 } },
    { ...base, slug: "slow", ms: 95_000, captured: { bytes: 10, body: { a: 1 } }, documented: { source: "none", keys: [], populatedArrays: [], bytes: 0 } },
    { ...base, slug: "hollow", captured: { bytes: 10, body: { rows: [] } }, documented: { source: "hand-written", keys: ["rows"], populatedArrays: ["rows"], bytes: 20 } },
    { ...base, slug: "fine", captured: { bytes: 10, body: { a: 1 } }, documented: { source: "hand-written", keys: ["a"], populatedArrays: [], bytes: 12 } },
  ];
  const f = rankFindings(caps);
  eq(f.map((x) => `${x.slug}:${x.kind}`), ["broken:failing", "drift:example-keys-missing", "hollow:thin-empty", "terse:thin-model-text", "tiny:thin-small", "slow:slow", "drift:example-keys-extra"], "findings are ranked by severity: failing, keys missing, empty, thin, slow, extra keys");
  ok(findingsFor(caps.find((c) => c.slug === "fine")).length === 0, "a healthy tool has no finding");
  ok(f.find((x) => x.slug === "slow").detail === "95.0 s", "a slow call reports its latency");
  ok(f.find((x) => x.slug === "terse").detail.includes(String(MIN_MODEL_TEXT_CHARS)), "short model text names the threshold");

  // ---- examples plan: preview, never over a hand-written example ----------------
  const plan = planExamples({ _note: "n", drift: { capturedAt: "2026-10-01", example: { stale: 1 }, modelBacked: false }, slow: { capturedAt: "2026-10-01", example: { a: 9 }, modelBacked: false } }, caps, { capturedAt: "2026-10-12T11:47:00Z", namesCheck: () => false });
  eq(plan.added.sort(), ["terse"], "a passing tool with no hand-written example is added");
  eq(plan.kept, ["slow"], "an existing captured entry with the same key set is kept (no churn)");
  eq(plan.removed.sort(), ["drift"], "an entry shadowed by a hand-written example is removed");
  ok(!plan.next.hollow && !plan.next.fine && !plan.next.tiny, "no entry is created for a tool with a hand-written example");
  const failing = planExamples({}, [{ ...base, slug: "bad", grade: "empty:rows", pass: false, captured: { bytes: 10, body: { rows: [] } }, documented: { source: "none", keys: [], populatedArrays: [], bytes: 0 } }], { capturedAt: "2026-10-12", namesCheck: () => false });
  ok(!plan.next.broken && !failing.next.bad && failing.skipped.some((s) => s.slug === "bad" && /empty:rows/.test(s.reason)), "a failing answer never seeds an example, even with its body captured");
  eq(plan.next.terse, { capturedAt: "2026-10-12", example: { answer: "ok" }, modelBacked: true }, "the entry is { capturedAt (date), example, modelBacked }");
  const refreshed = planExamples({ slow: { capturedAt: "2026-10-01", example: { a: 9 }, modelBacked: false } }, caps, { capturedAt: "2026-10-12", refresh: true, namesCheck: () => false });
  eq(refreshed.refreshed, ["slow"], "--refresh replaces a captured entry even with the same keys");
  const named = planExamples({}, caps, { capturedAt: "2026-10-12", namesCheck: (t) => t.includes("answer") });
  ok(!named.next.terse && named.skipped.some((s) => s.slug === "terse" && /third party/.test(s.reason)), "an example the names guard flags is left out");
  const zz = createHash("sha256").update("zzcounterparty").digest("hex").slice(0, 20);
  ok(namesThirdParty("talked to Zzcounterparty", { hosts: new Set(), names: new Set([zz]), vendors: new Set() }) && !namesThirdParty("a plain answer", { hosts: new Set(), names: new Set([zz]), vendors: new Set() }), "the names guard catches a listed name and passes plain text (control)");
  ok(namesThirdParty("https://agent402.tools/x") === false, "the shipped lists do not flag our own host");
  ok(serializeExamples({ b: 1, _note: "n", a: 2 }).startsWith('{\n  "_note": "n",\n  "a": 2,\n  "b": 1'), "the examples file serializes deterministically, header first");

  const md = markdownReport({ capturedAt: "2026-10-12T11:47:00Z", tier: "all", captures: caps }, f, plan, { top: 3 });
  ok(md.includes("top 3 shown") && md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length === 3, "the summary table is cut to the top n");
  ok(!/—/.test(md), "the report carries no em dash");
}

// ---- the CLI against a synthetic artifact: preview writes nothing, --write does ---
{
  const dir = mkdtempSync(join(tmpdir(), "examples-cli-"));
  const art = join(dir, "catalog-buy-outputs.json"), ex = join(dir, "ex.json"), rep = join(dir, "report.md");
  writeFileSync(art, J({ version: 1, tier: "all", capturedAt: "2026-10-12T11:47:00Z", captures: [
    { slug: "plain", path: "/api/plain", usd: 0.001, status: 200, grade: "ok", pass: true, ms: 100, modelBacked: false, dropped: null, captured: { bytes: 20, truncated: false, body: { value: 7, rows: [1, 2, 3, 4] } }, documented: { source: "none", keys: [], populatedArrays: [], bytes: 0 } },
    { slug: "written", path: "/api/written", usd: 0.001, status: 200, grade: "ok", pass: true, ms: 100, modelBacked: false, dropped: null, captured: { bytes: 20, truncated: false, body: { a: 1, b: 2 } }, documented: { source: "hand-written", keys: ["a", "c"], populatedArrays: [], bytes: 20 } },
  ] }));
  writeFileSync(ex, "{}\n");
  const run = (...a) => execFileSync(process.execPath, [fileURLToPath(new URL("./catalog-buy-examples.js", import.meta.url)), "--file", art, "--examples", ex, ...a], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  const preview = run("--report", rep);
  ok(/preview only/.test(preview) && readFileSync(ex, "utf8") === "{}\n", "the default is a preview: the examples file is untouched");
  const md = readFileSync(rep, "utf8");
  ok(md.includes("written") && md.includes("example-keys-missing") && md.includes("example-keys-extra"), "the markdown report flags the hand-written example's key mismatch");
  run("--write");
  const written = JSON.parse(readFileSync(ex, "utf8"));
  eq(Object.keys(written), ["plain"], "--write adds the tool without a hand-written example and nothing else");
  eq(written.plain.example.rows, [1, 2, 3], "the written example is trimmed");
  ok(written.plain.capturedAt === "2026-10-12", "and dated from the run");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
