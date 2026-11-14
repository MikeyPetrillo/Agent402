#!/usr/bin/env node
// Offline test for scripts/index402-sync.js: which 402 Index listings get
// repriced, and which are left alone.
// Then the script itself, run against a stub index on a port the OS picks:
// a request that gets no answer is named and asked once more, a write is read
// back, and a write the index does not hold fails the run.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { microUsd, livePrices, quotedPaths, planUpdates, rewrittenByImporter, holdsPrice, waitNamedBy, plain, DEFAULT_RUN_BUDGET_MS } from "./index402-sync.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

ok(microUsd("$0.08") === 80000 && microUsd(0.001) === 1000 && microUsd("0.010") === 10000, "prices parse to micro-dollars from $-strings and numbers");
ok(microUsd(null) === null && microUsd("") === null && microUsd("abc") === null && microUsd(-1) === null, "absent, junk and negative prices read as no price");
// The 2026-10-03 defect: base units listed as dollars.
ok(microUsd(80000) === 80000 * 1e6, "a base-unit figure listed as dollars reads as the huge number it is (so it differs and gets corrected)");

const prices = livePrices({ endpoints: [
  { path: "/api/answer", price: "$0.08" },
  { path: "/api/hash", price: "$0.001" },
  { path: "/api/search", price: "$0.01" },
  { path: "/api/broken" },
] });
ok(prices.get("/api/answer") === 80000 && prices.size === 3, "livePrices keeps priced routes only");

const D = "agent402.tools";
const { updates, unknown } = planUpdates([
  { id: "a", url: "https://agent402.tools/api/answer", protocol: "MPP", price_usd: 80000 },
  { id: "b", url: "https://agent402.tools/api/hash", protocol: "MPP", price_usd: 0.001 },
  { id: "c", url: "https://agent402.tools/api/search", protocol: "x402", price_usd: null },
  { id: "d", url: "https://agent402.tools/api/retired-thing", protocol: "MPP", price_usd: 0.05 },
  { id: "e", url: "https://evil.example/api/answer", protocol: "MPP", price_usd: 9 },
  { id: "f", url: "https://agent402.tools.evil.example/api/answer", protocol: "MPP", price_usd: 9 },
  { id: "g", url: "not a url", protocol: "MPP", price_usd: 1 },
  { id: "h", url: "https://agent402.tools/api/search?q=x", protocol: "MPP", price_usd: 0.02 },
], prices, D);
ok(updates.length === 2 && updates.some((u) => u.id === "a" && u.to === 0.08) && updates.some((u) => u.id === "h" && u.to === 0.01), "a wrong price on our host is corrected to the live price (query string ignored)");
ok(!updates.some((u) => u.id === "b"), "a listing already at the live price is not touched");
ok(!updates.some((u) => u.id === "c"), "a listing with no price is left alone");
ok(unknown.length === 1 && unknown[0].id === "d" && !updates.some((u) => u.id === "d"), "a priced listing on a route we no longer sell is reported, never repriced");
ok(!updates.some((u) => ["e", "f", "g"].includes(u.id)), "listings on other hosts (including a lookalike suffix) and junk urls are never touched");

// Quoted routes on listings the index imports itself.
const pricingQ = { endpoints: [
  { path: "/api/tts", price: "$0.005", quoted: true },
  { path: "/v1/metered/messages", price: "$0.001", quoted: true },
  { path: "/api/x-user-tweets", price: "$0.09" },
] };
ok(quotedPaths({ endpoints: [{ path: "/v1/chat/completions", price: "$0.1", pricedByModel: true }, { path: "/api/x", price: "$0.1", pricedByModel: false }] }).size === 1, "a route priced by the model its request names counts as priced per request");
ok(waitNamedBy({ "retry-after": "7" }) === 7000 && waitNamedBy({ ratelimit: "limit=100, remaining=0, reset=31" }) === 31000 && waitNamedBy({ "retry-after": "600" }) === 65000 && waitNamedBy({}) === null && waitNamedBy(new Headers({ "retry-after": "3" })) === 3000, "a 429's wait is read from Retry-After or the window reset, bounded at 65 s");
ok(plain("x402\n::error::boom\r\u2028y") === "x402 ::error::boom y" && plain(null) === "" && plain("a".repeat(900)).length === 300, "a listing field prints as one bounded line");
const quoted = quotedPaths(pricingQ);
ok(quoted.size === 2 && quoted.has("/api/tts") && !quoted.has("/api/x-user-tweets"), "quotedPaths keeps only routes priced per request");
const q = planUpdates([
  { id: "q1", url: "https://agent402.tools/api/tts", protocol: "x402", source: "bazaar", price_usd: 0.007 },
  { id: "q2", url: "https://agent402.tools/v1/metered/messages", protocol: "x402", source: "bazaar", price_usd: 0.0005 },
  { id: "q3", url: "https://agent402.tools/api/tts", protocol: "MPP", source: "self-registered", price_usd: 0.007 },
  { id: "q4", url: "https://agent402.tools/api/x-user-tweets", protocol: "x402", source: "bazaar", price_usd: 0.08 },
  { id: "q5", url: "https://agent402.tools/api/tts", protocol: "x402", source: "bazaar", price_usd: 0.005 },
], livePrices(pricingQ), D, quoted);
ok(q.updates.length === 4 && ["q1", "q2", "q3", "q4"].every((id) => q.updates.some((u) => u.id === id)) && !q.updates.some((u) => u.id === "q5"), "every drifted listing is corrected, quoted or not, imported or not; one at the catalog price is not touched");
ok(q.updates.find((u) => u.id === "q1").imported && q.updates.find((u) => u.id === "q1").quoted && !q.updates.find((u) => u.id === "q3").imported && !q.updates.find((u) => u.id === "q4").quoted, "each update says whether the listing is imported and whether the route is quoted");
const rw = rewrittenByImporter(q.updates);
ok(rw.length === 1 && rw[0].id === "q4", "only an imported listing of a fixed-price route counts as written back by the importer");
ok(planUpdates([{ id: "q4", url: "https://agent402.tools/api/x-user-tweets", source: "bazaar", price_usd: 0.08 }], livePrices(pricingQ), D).updates[0].quoted === false, "without the quoted set no route reads as quoted");
ok(holdsPrice({ price_usd: 0.09 }, 0.09) && holdsPrice({ price_usd: "0.090" }, 0.09) && !holdsPrice({ price_usd: 0.08 }, 0.09) && !holdsPrice({ price_usd: null }, 0.09) && !holdsPrice(undefined, 0.09), "holdsPrice compares the listing read back with the price we set");

// ---- the script against a stub index ----
const SCRIPT = fileURLToPath(new URL("./index402-sync.js", import.meta.url));
const endpoints = [];
for (let i = 0; i < 120; i++) endpoints.push({ path: `/api/t${i}`, price: "$0.001" });
endpoints.push({ path: "/api/tts", price: "$0.005", quoted: true }, { path: "/api/x-user-tweets", price: "$0.09" }, { path: "/api/hold-me", price: "$0.02" });

/** opts (also: echoPad, redirectWriteTo, pages): { hangFirstList, hangAllLists, stallFirstListBody, ignoreWriteFor: Set<id>, failList: status, failListOnce: status, echoWriteAs: status } */
async function stubIndex(opts = {}) {
  const store = new Map([
    ["a1", { id: "a1", url: "https://agent402.tools/api/x-user-tweets", protocol: "x402", source: "bazaar", price_usd: 0.08 }],
    ["a2", { id: "a2", url: "https://agent402.tools/api/tts", protocol: "x402", source: "bazaar", price_usd: 0.007 }],
    ["a3", { id: "a3", url: "https://agent402.tools/api/hold-me", protocol: "MPP", source: "self-registered", price_usd: 0.03 }],
  ]);
  const seen = { lists: 0, patches: [], reads: [], hung: [] };
  const api = {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/api/pricing") return json(200, { endpoints });
    if (u.pathname === "/v1/services" && req.method === "GET") {
      seen.lists++;
      if (opts.hangAllLists || (opts.hangFirstList && seen.lists === 1)) { seen.hung.push(res); return; }
      if (opts.stallFirstListBody && seen.lists === 1) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"services":['); seen.hung.push(res); return; }
      if (opts.failListOnce && seen.lists === 1) { seen.at429 = Date.now(); res.writeHead(opts.failListOnce, { "content-type": "application/json", ...(opts.retryAfter ? { "retry-after": String(opts.retryAfter) } : {}) }); return res.end('{"error":"slow down"}'); }
      if (seen.at429 && !seen.afterWait) seen.afterWait = Date.now() - seen.at429;
      if (opts.failList) return json(opts.failList, { error: "nope" });
      if (opts.pages && seen.lists < opts.pages) return json(200, { services: Array.from({ length: 200 }, (_, i) => ({ id: `f${seen.lists}x${i}`, url: `https://agent402.tools/api/t${i % 120}`, protocol: "x402", source: "bazaar", price_usd: 0.001 })) });
      return json(200, { services: [...store.values()] });
    }
    const m = /^\/v1\/services\/([a-z0-9]+)$/.exec(u.pathname);
    if (m && req.method === "PATCH") {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        const body = JSON.parse(b);
        seen.patches.push({ id: m[1], ...body });
        if (api.slowFirstPatchMs && seen.patches.length === 1) { setTimeout(() => { store.get(m[1]).price_usd = body.price_usd; json(200, { ok: true }); }, api.slowFirstPatchMs); return; }
        if (opts.redirectWriteTo) { res.writeHead(307, { location: opts.redirectWriteTo }); return res.end(); }
        if (opts.echoWriteAs) return json(opts.echoWriteAs, { error: "refused", pad: "p".repeat(opts.echoPad || 0), received: body });
        if (!opts.ignoreWriteFor?.has(m[1])) store.get(m[1]).price_usd = body.price_usd;
        json(200, { ok: true });
      });
      return;
    }
    if (m && req.method === "GET") { seen.reads.push(m[1]); return json(200, store.get(m[1]) || {}); }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const close = () => new Promise((r) => { for (const h of seen.hung) h.destroy(); server.closeAllConnections?.(); server.close(r); });
  api.port = port; api.seen = seen; api.store = store; api.close = close;
  return api;
}

function runSync(port, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, INDEX402_DOMAIN: D, INDEX402_API: `http://127.0.0.1:${port}/v1`, PRICING_URL: `http://127.0.0.1:${port}/api/pricing`, INDEX402_TOKEN: "test-token-value", INDEX402_TIMEOUT_MS: "400", DRY_RUN: "0", ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

{ // A clean run: three writes, each read back.
  const s = await stubIndex();
  const r = await runSync(s.port);
  ok(r.code === 0, `a run whose writes hold exits 0 (${r.code}) ${r.err.trim()}`);
  ok(s.seen.patches.length === 3 && s.seen.patches.every((p) => p.domain === D && p.verification_token === "test-token-value"), "it writes the three drifted listings with the domain and token");
  ok(s.seen.patches.some((p) => p.id === "a1" && p.price_usd === 0.09) && s.seen.patches.some((p) => p.id === "a3" && p.price_usd === 0.02) && s.seen.patches.some((p) => p.id === "a2" && p.price_usd === 0.005), "fixed-price, self-registered and quoted listings are all set to the catalog price");
  ok(["a1", "a2", "a3"].every((id) => s.seen.reads.includes(id)) && s.seen.reads.length === 3, "every write is read back");
  ok(/3 to correct/.test(r.out) && !/REWRITTEN/.test(r.err), "without the daily switch nothing is flagged as written back");
  ok(!(r.out + r.err).includes("test-token-value"), "the token is never printed");
  await s.close();
}
{ // A write the index answers 200 to but does not hold.
  const s = await stubIndex({ ignoreWriteFor: new Set(["a1"]) });
  const r = await runSync(s.port);
  ok(r.code === 1, `a write that does not hold fails the run (${r.code})`);
  ok(/NOT HELD https:\/\/agent402\.tools\/api\/x-user-tweets: set \$0\.09, the index reads \$0\.08/.test(r.err), "the listing and both prices are named");
  ok(s.seen.patches.some((p) => p.id === "a3") && s.store.get("a3").price_usd === 0.02, "the other listing is still corrected");
  await s.close();
}
{ // The first list read gets no answer: named, asked once more, the run goes on.
  const s = await stubIndex({ hangFirstList: true });
  const r = await runSync(s.port);
  ok(r.code === 0, `a read that answers on the second ask does not fail the run (${r.code}) ${r.err.trim().slice(0, 200)}`);
  ok(new RegExp(`retrying once: GET http://127\\.0\\.0\\.1:${s.port}/v1/services\\?q=agent402\\.tools&limit=200&offset=0 -> no answer within 400 ms`).test(r.err), "the request that got no answer is named with its limit");
  ok(s.seen.lists === 2 && s.seen.patches.length === 3, "it asked the list twice and then wrote");
  await s.close();
}
{ // No answer twice: the run fails and says which request.
  const s = await stubIndex({ hangAllLists: true });
  const r = await runSync(s.port);
  ok(r.code === 1 && s.seen.lists === 2 && s.seen.patches.length === 0, `no answer on both asks fails the run with nothing written (${r.code}, ${s.seen.lists} asks)`);
  ok(/\/v1\/services\?q=agent402\.tools&limit=200&offset=0 -> no answer within 400 ms\s*$/.test(r.err), "the last line names the request");
  await s.close();
}
{ // An answer that sends its headers and then stalls is no answer: named, asked once more.
  const s = await stubIndex({ stallFirstListBody: true });
  const r = await runSync(s.port);
  ok(r.code === 0 && s.seen.lists === 2 && s.seen.patches.length === 3, `a body that stalls is asked once more and the run goes on (${r.code}, ${s.seen.lists} asks) ${r.err.trim().slice(0, 160)}`);
  ok(/retrying once: GET .*\/v1\/services\?q=agent402\.tools&limit=200&offset=0 -> no answer within 400 ms/.test(r.err), "the stalled request is named");
  await s.close();
}
{ // A 429 is asked once more.
  const s = await stubIndex({ failListOnce: 429 });
  const r = await runSync(s.port);
  ok(r.code === 0 && s.seen.lists === 2 && /retrying once: GET .* -> 429/.test(r.err), `a 429 is asked once more and the run goes on (${r.code}, ${s.seen.lists} asks)`);
  await s.close();
}
{ // A 429 that names its wait is asked again only after it (scaled down here).
  const s = await stubIndex({ failListOnce: 429, retryAfter: 10 });
  const r = await runSync(s.port, { INDEX402_WAIT_SCALE: "0.1" });
  ok(r.code === 0 && s.seen.lists === 2 && s.seen.afterWait >= 900 && s.seen.afterWait < 5000, `a 429 naming 10 s is asked again after that wait (scaled to 1 s; waited ${s.seen.afterWait} ms)`);
  await s.close();
}
{ // Past the run budget no further write starts; what is left is counted and the run fails.
  const s = await stubIndex();
  s.slowFirstPatchMs = 700;
  const r = await runSync(s.port, { INDEX402_RUN_BUDGET_MS: "500", INDEX402_TIMEOUT_MS: "3000" });
  ok(r.code === 1 && s.seen.patches.length === 1 && /run budget of 500 ms spent: 2 correction\(s\) left for the next run/.test(r.err), `past the run budget no further write starts and what is left is named (${r.code}, ${s.seen.patches.length} writes) ${r.err.trim().slice(0, 160)}`);
  await s.close();
}
{ // An answer that echoes the write back never puts the token in the log.
  const s = await stubIndex({ echoWriteAs: 500 });
  const r = await runSync(s.port);
  ok(r.code === 1 && /FAILED .* -> 500 /.test(r.err) && /\[token\]/.test(r.err), `a refused write that echoes its body fails the run (${r.code})`);
  ok(!(r.out + r.err).includes("test-token-value"), "the echoed token is not printed");
  await s.close();
}
{ // The token is removed before the echoed body is cut: no cut leaves part of it in the log.
  let leaked = 0;
  for (let pad = 100; pad <= 190; pad += 3) {
    const s = await stubIndex({ echoWriteAs: 400, echoPad: pad });
    const r = await runSync(s.port, { INDEX402_TOKEN: "tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789" });
    if (/tok-ABCD|WXYZ-0123|[A-Z]{6,}/.test((r.out + r.err).replace(/NOT HELD|FAILED|PATCH|REWRITTEN/g, ""))) leaked++;
    await s.close();
  }
  ok(leaked === 0, `an echoed token that straddles the cut is never printed in part (${leaked} of 31 paddings leaked)`);
}
{ // A redirected write is refused: the body is never sent on to another host.
  let reached = 0;
  const other = http.createServer((req, res) => { reached++; res.end("{}"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const s = await stubIndex({ redirectWriteTo: `http://127.0.0.1:${other.address().port}/take` });
  const r = await runSync(s.port);
  ok(r.code === 1 && reached === 0 && /FAILED /.test(r.err), `a write answered with a redirect fails and is not followed (${r.code}, other host reached ${reached} times)`);
  await s.close(); await new Promise((r) => other.close(r));
}
{ // The run budget covers the listing reads too.
  const s = await stubIndex({ pages: 5 });
  const r = await runSync(s.port, { INDEX402_RUN_BUDGET_MS: "1" });
  ok(r.code === 1 && s.seen.lists <= 1 && s.seen.patches.length === 0 && /run budget of 1 ms spent while reading listings/.test(r.err), `a spent budget stops the listing reads (${r.code}, ${s.seen.lists} page reads)`);
  await s.close();
}
{ // A refusal is not asked again; a 5xx is.
  const s4 = await stubIndex({ failList: 403 });
  const r4 = await runSync(s4.port);
  ok(r4.code === 1 && s4.seen.lists === 1 && /-> 403/.test(r4.err), "a 403 fails at once, asked a single time");
  await s4.close();
  const s5 = await stubIndex({ failList: 503 });
  const r5 = await runSync(s5.port);
  ok(r5.code === 1 && s5.seen.lists === 2 && /-> 503/.test(r5.err), "a 503 is asked once more, then fails");
  await s5.close();
}
{ // The daily run: an imported fixed-price listing off the catalog price is corrected, named, and fails the run.
  const s = await stubIndex();
  const r = await runSync(s.port, { INDEX402_FLAG_REWRITTEN: "1" });
  ok(r.code === 3 && s.seen.patches.length === 3 && s.store.get("a1").price_usd === 0.09, `the daily run corrects everything and exits 3 on a listing written back (${r.code})`);
  ok(/REWRITTEN https:\/\/agent402\.tools\/api\/x-user-tweets: the index's own source carries \$0\.08, the catalog price is \$0\.09/.test(r.err), "the listing written back is named with both prices");
  ok(!/REWRITTEN .*\/api\/tts/.test(r.err) && !/REWRITTEN .*hold-me/.test(r.err) && /^1 imported listing/m.test(r.err), "a quoted route and a listing we registered are never flagged");
  await s.close();
  // With nothing imported off the catalog price the daily run passes.
  const s2 = await stubIndex();
  s2.store.get("a1").price_usd = 0.09;
  const r2 = await runSync(s2.port, { INDEX402_FLAG_REWRITTEN: "1" });
  ok(r2.code === 0 && s2.seen.patches.length === 2 && !/REWRITTEN/.test(r2.err), `the daily run passes when only quoted and self-registered listings drifted (${r2.code})`);
  await s2.close();
}
{ // A failed write outranks a listing written back: exit 1, both named.
  const s = await stubIndex({ ignoreWriteFor: new Set(["a3"]) });
  const r = await runSync(s.port, { INDEX402_FLAG_REWRITTEN: "1" });
  ok(r.code === 1 && /NOT HELD .*hold-me/.test(r.err) && /REWRITTEN .*x-user-tweets/.test(r.err), `a write that does not hold beside a listing written back exits 1 with both named (${r.code})`);
  await s.close();
}

// ---- the workflow's page step, run with a stub gh ----
{
  const { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const wf = readFileSync(new URL("../.github/workflows/index402-sync.yml", import.meta.url), "utf8");
  ok(/id: sync\n/.test(wf) && /echo "code=\$code" >> "\$GITHUB_OUTPUT"/.test(wf) && /CODE: \$\{\{ steps\.sync\.outputs\.code \}\}/.test(wf), "the sync step hands its exit code to the page step");
  ok(/INDEX402_FLAG_REWRITTEN: \$\{\{ github\.event_name == 'schedule' && '1' \|\| '0' \}\}/.test(wf), "only the daily run flags a listing written back");
  const lines = wf.split("\n");
  const at = lines.findIndex((l) => /- name: Page on failure \/ recover on success/.test(l));
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
  const script = body.join("\n");
  ok(at > 0 && script.includes("gh issue create") && script.length > 500, "the page step's script is read from the workflow");
  const FAIL = "402 Index price sync FAILING", BACK = "402 Index listing written back at an old price";
  const dir = mkdtempSync(join(tmpdir(), "idx-page-"));
  // The stub answers list and view from STATE and appends every write to LOG.
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const st = JSON.parse(process.env.GH_STUB_STATE);
if (a[0] === "issue" && a[1] === "list") { const q = a[a.indexOf("--search") + 1]; fs.appendFileSync(process.env.GH_STUB_LOG + ".q", q + "\\n"); process.stdout.write(JSON.stringify(st.open.filter((i) => q.includes(i.title)).map((i) => ({ author: { login: "app/github-actions" }, ...i })))); }
else if (a[0] === "issue" && a[1] === "view") { process.stdout.write(JSON.stringify({ comments: (st.comments || []).map((c) => ({ author: { login: "github-actions" }, ...c })) })); }
else fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(a) + "\\n");
`);
  chmodSync(join(dir, "gh"), 0o755);
  const page = (code, state) => {
    const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
    writeFileSync(log, "");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", RUN_URL: "https://run.example/1", GH_TOKEN: "x", ...(code === null ? {} : { CODE: String(code) }), GH_STUB_STATE: JSON.stringify(state), GH_STUB_LOG: log } });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { status: r.status, err: r.stderr, calls, did: (verb, title) => calls.some((c) => c[1] === verb && (title === undefined || c.includes(title))) };
  };
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const none = { open: [] }, failOpen = { open: [{ number: 7, title: FAIL }] };
  const backOpen = (comments = []) => ({ open: [{ number: 9, title: BACK }], comments });
  let p = page(0, none);
  ok(p.status === 0 && p.calls.length === 0, `a clean run with nothing open writes nothing (${p.status}) ${p.err.slice(0, 120)}`);
  p = page(1, none);
  ok(p.did("create", FAIL) && !p.did("create", BACK), "a failed sync opens the sync issue only");
  p = page(null, none);
  ok(p.did("create", FAIL), "a run that left no exit code opens the sync issue");
  p = page(1, failOpen);
  ok(p.calls.length === 0, "a failed sync with its issue open writes nothing more");
  p = page(3, none);
  ok(p.did("create", BACK) && !p.did("create", FAIL) && p.calls.some((c) => c.join(" ").includes("stale_days=0")), "a listing written back opens its own issue, naming stale_days=0 in the remedy");
  p = page(3, failOpen);
  ok(p.did("close") && p.calls.some((c) => c[1] === "close" && c[2] === "7") && p.did("create", BACK), "exit 3 means the sync worked: the sync issue closes and the written-back issue opens");
  p = page(1, backOpen());
  ok(p.did("create", FAIL) && !p.did("close"), "a failed sync beside an open written-back issue opens the sync issue and leaves the other");
  p = page(0, backOpen());
  ok(!p.did("close") && p.calls.some((c) => c[1] === "comment" && c.join(" ").includes("Clean daily run")), "the first clean daily run leaves the written-back issue open with a marker");
  p = page(0, backOpen([{ body: "Clean daily run at x: one more in a row closes this.", createdAt: ago(24) }]));
  ok(p.calls.some((c) => c[1] === "close" && c[2] === "9"), "the second clean daily run in a row closes it");
  p = page(0, backOpen([{ body: "Clean daily run at x", createdAt: ago(24 * 5) }]));
  ok(!p.did("close") && p.did("comment"), "a clean marker older than a day and a half does not count as in a row");
  p = page(0, backOpen([{ body: "Clean daily run at x", createdAt: ago(48) }, { body: "Written back again at y", createdAt: ago(24) }]));
  ok(!p.did("close") && p.calls.some((c) => c.join(" ").includes("Clean daily run")), "a written-back run between two clean ones starts the count again");
  p = page(0, backOpen([{ body: "Clean daily run at x", createdAt: ago(30) }, { body: "Written back again at y", createdAt: ago(10) }]));
  ok(!p.did("close") && p.did("comment"), "a recent clean marker with a written-back one after it does not close");
  p = page(3, backOpen([{ body: "Clean daily run at x", createdAt: ago(24) }]));
  ok(p.calls.length === 1 && p.calls[0][1] === "comment" && p.calls[0].join(" ").includes("Written back again"), "written back after a clean run is marked once");
  p = page(3, backOpen([{ body: "Written back again at y", createdAt: ago(24) }]));
  ok(p.calls.length === 0, "written back day after day adds no comment");
  // Only this workflow's own issues and comments count.
  p = page(0, backOpen([{ body: "Clean daily run at x", createdAt: ago(24), author: { login: "someone-else" } }]));
  ok(!p.did("close") && p.did("comment"), "a clean marker written by another account does not count toward the close");
  p = page(0, backOpen([{ body: "Clean daily run at x", createdAt: ago(24) }, { body: "Written back again at y", createdAt: ago(2), author: { login: "someone-else" } }]));
  ok(p.calls.some((c) => c[1] === "close" && c[2] === "9"), "a written-back marker from another account does not hold the issue open");
  p = page(3, { open: [{ number: 4, title: BACK, author: { login: "someone-else" } }] });
  ok(p.did("create", BACK), "an issue with the same title opened by another account is not taken for ours");
  ok(/author:app\/github-actions/.test(script), "the issue search asks for this workflow's own issues");
  // The job's own limits.
  const limitMin = Number((wf.match(/timeout-minutes:\s*(\d+)/) || [])[1]);
  ok(DEFAULT_RUN_BUDGET_MS <= 13 * 60_000 && limitMin * 60_000 >= DEFAULT_RUN_BUDGET_MS + 6 * 60_000, `the job limit (${limitMin} min) leaves six minutes past the run budget (${DEFAULT_RUN_BUDGET_MS} ms) for a write already started`);
  ok(/node scripts\/index402-sync\.js\n\s+code=\$\?\n\s+echo "code=\$code" >> "\$GITHUB_OUTPUT"\n\s+exit "\$code"/.test(wf), "the sync step ends with the script's own exit code, so a failed run reads failed");
  rmSync(dir, { recursive: true, force: true });
}
{ // A dry run writes and reads back nothing.
  const s = await stubIndex();
  const r = await runSync(s.port, { DRY_RUN: "1", INDEX402_TOKEN: "" });
  ok(r.code === 0 && s.seen.patches.length === 0 && s.seen.reads.length === 0 && /would set x402 .*x-user-tweets: \$0\.08 -> \$0\.09/.test(r.out), "a dry run prints the plan and sends no write");
  await s.close();
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
