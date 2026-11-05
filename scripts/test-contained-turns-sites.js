#!/usr/bin/env node
// Every scheduled callback (setImmediate, setTimeout, setInterval) in the index
// module and the server either runs under contained() (src/contained-turn.js),
// so a throw inside it is counted and never reaches the fatal uncaughtException
// handler, or sits on the allowlist below with the reason it may stay bare: a
// callback that touches only this process's own state (a counter sweep, a
// boot timer, the shutdown deadline), never data another party wrote.
//
// Excluded by rule, not by the list: a promise resolver (`setImmediate(r)`,
// `(r) => setImmediate(r)`, `setTimeout(() => r(x), ms)`, `setTimeout(resolve, ms)`)
// does no work of its own. A `.setTimeout(` member call (a socket's, a
// server's) is not a scheduled callback.
//
// A stale allowlist entry (one that matches no site) fails too, so the list
// never outlives the code it excuses.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const FILES = ["src/x402-index.js", "src/server.js"];
const RESOLVERS = new Set(["r", "res", "resolve", "ok", "done"]);
// Each entry: the file, the start of the callback's text (whitespace folded)
// and why it may run bare. Match is by prefix on the folded argument text.
const ALLOW = [
  { file: "src/x402-index.js", arg: "crawlLanePump", reason: "hands the next waiting crawl slice its turn: a queue of this module's own resolvers; the slice itself runs as a promise continuation, whose throw is a rejection" },
  { file: "src/server.js", arg: "revenueTick", reason: "revenue snapshot of our own wallets, run through runAsJob with its rejection caught" },
  { file: "src/server.js", arg: "() => { _mppSubs.sweepStaleCanaries()", reason: "our own subscription canaries; an async sweep whose rejection is caught" },
  { file: "src/server.js", arg: "() => { probeOxAlphaAvailability()", reason: "reads the upstream model catalog for our own tier; async, rejection caught" },
  { file: "src/server.js", arg: "() => { _humanCheckout.recoverAbandoned()", reason: "our own card checkout claims; async, rejection caught" },
  { file: "src/server.js", arg: "() => { const now = Date.now(); for (const [sid, s] of operatorSessions)", reason: "sweeps our own operator session map" },
  { file: "src/server.js", arg: "() => { try { resetShedCounters(); }", reason: "resets our own shed counters inside its own try" },
  { file: "src/server.js", arg: "() => { regLimiter.sweep(); }", reason: "sweeps our own registration limiter map" },
  { file: "src/server.js", arg: "() => { mppRegLimiter.sweep(); }", reason: "sweeps our own MPP registration limiter map" },
  { file: "src/server.js", arg: "() => { const cutoff = Date.now() - 60000; for (const [ip, ts] of powChallengeHits)", reason: "sweeps our own proof-of-work challenge counters" },
  { file: "src/server.js", arg: "() => { warmLazyDeps()", reason: "loads our own packages ahead of their first caller; async, rejection caught" },
  { file: "src/server.js", arg: "() => { const now = performance.now(), drift = now - last - 100;", reason: "boot loop-lag sampler over its own numbers" },
  { file: "src/server.js", arg: "() => { clearInterval(lag);", reason: "boot loop-lag report over its own numbers" },
  { file: "src/server.js", arg: "() => httpServer.closeIdleConnections()", reason: "shutdown: closes our own idle sockets" },
  { file: "src/server.js", arg: "finish", reason: "shutdown: the drain's own finish step" },
  { file: "src/server.js", arg: "() => process.exit(code)", reason: "shutdown: the hard exit deadline" },
];

// The first argument of a call whose opening paren sits at `open`: scanned
// with brackets balanced and strings, templates and comments skipped, to the
// comma or close paren at depth zero.
function firstArg(text, open) {
  let i = open + 1, depth = 0;
  const start = i;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(text, i); continue; }
    if (c === "`") { i = skipTemplate(text, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return text.slice(start, i); depth--; }
    else if (c === "," && depth === 0) return text.slice(start, i);
    i++;
  }
  return text.slice(start);
}
function skipString(text, i) {
  const q = text[i++];
  while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; }
  return i + 1;
}
function skipTemplate(text, i) {
  i++;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "$" && text[i + 1] === "{") {
      i += 2;
      let d = 1;
      while (i < text.length && d) {
        if (text[i] === '"' || text[i] === "'") { i = skipString(text, i); continue; }
        if (text[i] === "`") { i = skipTemplate(text, i); continue; }
        if (text[i] === "{") d++; else if (text[i] === "}") d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}
const fold = (s) => s.replace(/\s+/g, " ").trim();
const IDENT = /^[A-Za-z_$][\w$]*$/;
// `() => r(x)`, `(a) => resolve(fallback())`, `function () { r(); }`: one call
// to a resolver and nothing else.
function isResolverLiteral(arg) {
  const m = arg.match(/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/) || arg.match(/^(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*([\s\S]*)$/);
  if (!m) return false;
  let body = m[1].trim();
  if (body.startsWith("{") && body.endsWith("}")) body = body.slice(1, -1).trim().replace(/;$/, "").trim();
  const call = body.match(/^([A-Za-z_$][\w$]*)\(/);
  return !!call && RESOLVERS.has(call[1]) && body.endsWith(")") && firstArgEnds(body, call[1].length);
}
// The resolver call spans the whole body (not `r(a); other()`).
function firstArgEnds(body, open) { let d = 0; for (let i = open; i < body.length; i++) { const c = body[i]; if (c === "(") d++; else if (c === ")") { d--; if (d === 0) return i === body.length - 1; } } return false; }
const isFunctionLiteral = (arg) => /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(arg);

// Every scheduled-callback site in `text`, classified: contained, resolver (by
// rule), allowed (by the list, with the entry used) or bare (a problem).
function audit(text, file, allow = ALLOW) {
  const wrappedNames = new Set([...text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*contained\(/g)].map((m) => m[1]));
  const re = /(^|[^.\w$])(setImmediate|setTimeout|setInterval)\(/g;
  const out = { sites: 0, wrapped: 0, resolvers: 0, allowed: 0, bare: [], used: new Set() };
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    // Inside a comment or a string: skipped by position (the keyword's own).
    if (inCommentOrString(text, m.index + m[1].length)) continue;
    out.sites++;
    const arg = fold(firstArg(text, open));
    const line = text.slice(0, m.index).split("\n").length;
    const where = `${file}:${line} ${m[2]}(${arg.slice(0, 70)}${arg.length > 70 ? "..." : ""})`;
    if (/^contained\(/.test(arg)) { out.wrapped++; continue; }
    if (IDENT.test(arg)) {
      if (RESOLVERS.has(arg)) { out.resolvers++; continue; }
      if (wrappedNames.has(arg)) { out.wrapped++; continue; }
    } else if (isFunctionLiteral(arg) && isResolverLiteral(arg)) { out.resolvers++; continue; }
    const entry = allow.find((a) => a.file === file && arg.startsWith(a.arg));
    if (entry) { out.used.add(entry); out.allowed++; continue; }
    out.bare.push(where);
    if (process.env.CONTAINED_SITES_DEBUG) console.log("bare:", where);
  }
  return out;
}
const used = new Set();
for (const file of FILES) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const a = audit(text, file);
  for (const where of a.bare) ok(false, `${where}: a scheduled callback that is neither contained() nor allowlisted with a reason`);
  for (const e of a.used) used.add(e);
  ok(a.sites > 0 && a.wrapped > 0, `${file}: ${a.sites} scheduled-callback sites read (${a.wrapped} contained, ${a.resolvers} promise resolvers by rule, ${a.allowed} allowlisted with a reason)`);
}
// The rule itself, on text of its own: a bare literal, a bare identifier and an
// unwrapped name fail; the wrapped, resolver and allowlisted forms pass.
{
  const sample = `
const a = contained("a", () => work());
setImmediate(a);
setTimeout(contained("b", function tick() { work(); }), 5);
setInterval(() => { sweep(); }, 10);
await new Promise((r) => setImmediate(r));
await new Promise((resolve) => setTimeout(() => resolve(fallback()), 5));
const p = new Promise((ok) => setTimeout(ok, 1));
setImmediate(function drain() { work(); });
setTimeout(revenueTick, 4);
server.setTimeout(5000);
// setImmediate(() => commented());
const s = "setTimeout(() => inString(), 1)";
`;
  const r = audit(sample, "sample.js", [{ file: "sample.js", arg: "() => { sweep(); }", reason: "own counters" }]);
  ok(r.sites === 8 && r.wrapped === 2 && r.resolvers === 3 && r.allowed === 1 && r.bare.length === 2 && /drain/.test(r.bare[0]) && /revenueTick/.test(r.bare[1]),
    `the rule classifies a sample: ${r.sites} sites, ${r.wrapped} contained, ${r.resolvers} resolvers, ${r.allowed} allowed, bare: ${r.bare.map((w) => w.split(" ").slice(1).join(" ")).join(" | ")}`);
  // The real drain with its wrapper taken off is caught.
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const stripped = index.replace('const drainSlice = contained("route-index-drain", () => {', "const drainSlice = (() => {");
  ok(stripped !== index && audit(stripped, "src/x402-index.js").bare.some((w) => /setImmediate\(drainSlice\)/.test(w)), "the drain's setImmediate(drainSlice) is reported bare once its contained() wrapper is removed");
}
function inCommentOrString(text, at) {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const before = text.slice(lineStart, at);
  if (/^\s*(\/\/|\*|\/\*)/.test(before)) return true;
  // A backtick or quote opened on this line before the site and not closed.
  let q = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "/" && before[i + 1] === "/") return true;
  }
  return q !== null;
}
for (const a of ALLOW) ok(used.has(a), `allowlist entry still names a site: ${a.file} ${a.arg.slice(0, 50)} (${a.reason.slice(0, 40)})`);
ok(ALLOW.every((a) => typeof a.reason === "string" && a.reason.length >= 12), "every allowlist entry carries a reason");
// The wrapper itself: a throw inside is counted, the callback's return is kept, a rejection is counted too.
{
  const { contained, containedTurnsSummary, _resetContainedTurnsForTest, noteContainedThrow } = await import("../src/contained-turn.js");
  const lines = [];
  let now = 1_000_000;
  _resetContainedTurnsForTest({ log: (l) => lines.push(l), now: () => now });
  const f = contained("unit", (a, b) => { if (a === "throw") throw new TypeError("poison " + b); return a + b; });
  ok(f(1, 2) === 3 && f("throw", "x") === undefined && f("throw", "y") === undefined, "a contained callback returns its value, and a throw inside it returns undefined instead of escaping");
  let s = containedTurnsSummary();
  ok(s.total === 2 && s.byName.unit.count === 2 && s.byName.unit.lastMessage === "poison y", `throws are counted by name with the last message (${s.total}, ${s.byName.unit?.lastMessage})`);
  ok(lines.length === 1 && /\[contained-turn\] unit: poison x/.test(lines[0]), `the first throw is logged, the second inside the same minute is not (${lines.length} line)`);
  now += 60_001; f("throw", "z");
  ok(lines.length === 2, "a throw a minute later is logged again");
  const g = contained("async-unit", async () => { throw new Error("later"); });
  const p = g();
  ok(p && typeof p.then === "function", "an async callback's promise is returned");
  await p.catch(() => {});
  await new Promise((r) => setImmediate(r));
  s = containedTurnsSummary();
  ok(s.byName["async-unit"]?.count === 1 && s.byName["async-unit"].lastMessage === "later", "a rejection of the returned promise is counted under the name");
  for (let i = 0; i < 260; i++) noteContainedThrow(`n${i}`, new Error("x"));
  s = containedTurnsSummary();
  ok(s.names <= 200 && s.overflow > 0 && s.total === 2 + 1 + 1 + 260, `the name map is bounded (${s.names} names, ${s.overflow} past the bound, ${s.total} total)`);
  ok(containedTurnsSummary().byName.unit.lastMessage.length <= 160 && (() => { noteContainedThrow("unit", new Error("m".repeat(500))); return containedTurnsSummary().byName.unit.lastMessage.length === 160; })(), "a message is bounded to 160 characters");
  _resetContainedTurnsForTest();
}
// The public word: `repeating` only when one name threw in each of three or
// more consecutive minutes, read at that minute or the one after it.
{
  const { noteContainedThrow, containedTurnsStatus, containedTurnsSummary, _resetContainedTurnsForTest } = await import("../src/contained-turn.js");
  const MIN = 60_000;
  let now = 10 * MIN + 5_000;
  _resetContainedTurnsForTest({ log: () => {}, now: () => now });
  const word = () => containedTurnsStatus().status;
  ok(word() === "ok", "no throws: ok");
  noteContainedThrow("loop", new Error("x"));
  ok(word() === "ok", "a single throw never trips the word");
  for (let i = 0; i < 40; i++) noteContainedThrow("loop", new Error("x"));
  ok(word() === "ok", "forty throws inside one minute are still one minute: ok");
  now += MIN; noteContainedThrow("loop", new Error("x"));
  ok(word() === "ok", "two consecutive minutes: ok");
  now += 2 * MIN; noteContainedThrow("loop", new Error("x")); // minute 13: a gap at 12
  ok(word() === "ok", "two minutes with a gap between them: ok");
  now += MIN; noteContainedThrow("loop", new Error("x")); // 14
  ok(word() === "ok", "minutes 13 and 14 after the gap: still two in a row, ok");
  now += MIN; noteContainedThrow("loop", new Error("x")); // 15
  ok(word() === "repeating" && containedTurnsStatus({ full: true }).repeating.join() === "loop", `three consecutive minutes (13, 14, 15): repeating, naming the turn (${JSON.stringify(containedTurnsStatus({ full: true }))})`);
  ok(containedTurnsSummary().byName.loop.consecutiveMinutes === 3 && containedTurnsSummary().status === "repeating", "the operator summary carries the run length and the word");
  now += MIN - 5_000 + 1_000; // the top of minute 16, before its tick lands
  ok(word() === "repeating", "the word holds through the turn of the minute, before that minute's tick");
  now += 2 * MIN; // minute 18, nothing since 15
  ok(word() === "ok", "two quiet minutes later the word returns to ok");
  noteContainedThrow("other", new Error("y")); now += MIN; noteContainedThrow("other", new Error("y")); now += MIN; noteContainedThrow("loop", new Error("x"));
  ok(word() === "ok", "two names alternating never add up to one repeating name");
  _resetContainedTurnsForTest();
}
console.log(`\ntest-contained-turns-sites: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
