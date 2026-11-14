#!/usr/bin/env node
// Offline test for scripts/index402-sync.js: which 402 Index listings get
// repriced, and which are left alone.
// Then the script itself, run against a stub index on a port the OS picks:
// a request that gets no answer is named and asked once more, a write is read
// back, and a write the index does not hold fails the run.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { microUsd, livePrices, quotedPaths, planUpdates, rewrittenByImporter, holdsPrice } from "./index402-sync.js";

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

/** opts: { hangFirstList, hangAllLists, stallFirstListBody, ignoreWriteFor: Set<id>, failList: status, failListOnce: status, echoWriteAs: status } */
async function stubIndex(opts = {}) {
  const store = new Map([
    ["a1", { id: "a1", url: "https://agent402.tools/api/x-user-tweets", protocol: "x402", source: "bazaar", price_usd: 0.08 }],
    ["a2", { id: "a2", url: "https://agent402.tools/api/tts", protocol: "x402", source: "bazaar", price_usd: 0.007 }],
    ["a3", { id: "a3", url: "https://agent402.tools/api/hold-me", protocol: "MPP", source: "self-registered", price_usd: 0.03 }],
  ]);
  const seen = { lists: 0, patches: [], reads: [], hung: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/api/pricing") return json(200, { endpoints });
    if (u.pathname === "/v1/services" && req.method === "GET") {
      seen.lists++;
      if (opts.hangAllLists || (opts.hangFirstList && seen.lists === 1)) { seen.hung.push(res); return; }
      if (opts.stallFirstListBody && seen.lists === 1) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"services":['); seen.hung.push(res); return; }
      if (opts.failListOnce && seen.lists === 1) return json(opts.failListOnce, { error: "slow down" });
      if (opts.failList) return json(opts.failList, { error: "nope" });
      return json(200, { services: [...store.values()] });
    }
    const m = /^\/v1\/services\/([a-z0-9]+)$/.exec(u.pathname);
    if (m && req.method === "PATCH") {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        const body = JSON.parse(b);
        seen.patches.push({ id: m[1], ...body });
        if (opts.echoWriteAs) return json(opts.echoWriteAs, { error: "refused", received: body });
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
  return { port, seen, store, close };
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
{ // An answer that echoes the write back never puts the token in the log.
  const s = await stubIndex({ echoWriteAs: 500 });
  const r = await runSync(s.port);
  ok(r.code === 1 && /FAILED .* -> 500 /.test(r.err) && /\[token\]/.test(r.err), `a refused write that echoes its body fails the run (${r.code})`);
  ok(!(r.out + r.err).includes("test-token-value"), "the echoed token is not printed");
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
  ok(r.code === 1 && s.seen.patches.length === 3 && s.store.get("a1").price_usd === 0.09, `the daily run corrects everything and still fails on a listing written back (${r.code})`);
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
{ // A dry run writes and reads back nothing.
  const s = await stubIndex();
  const r = await runSync(s.port, { DRY_RUN: "1", INDEX402_TOKEN: "" });
  ok(r.code === 0 && s.seen.patches.length === 0 && s.seen.reads.length === 0 && /would set x402 .*x-user-tweets: \$0\.08 -> \$0\.09/.test(r.out), "a dry run prints the plan and sends no write");
  await s.close();
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
