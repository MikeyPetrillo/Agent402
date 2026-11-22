// The operator's own searches are not demand (2026-11-22). A /api/find or
// connector catalog.find that carries a valid X-Operator-Token records no
// find-miss wish; the same miss without it (or with a wrong token) records
// one. On this public surface the header is the only operator credential
// read, every answer varies on it, and the operator's answer is private,
// no-store (operatorView; a wrong token gets the public answer). Booted free-mode server, port 0, its own stores.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const TOKEN = "operator-quiet-test-token-0123456789";
const srv = await bootServer({ stores: "find-operator-quiet", env: { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
const base = srv.url;
const clusters = async () => {
  const r = await fetch(`${base}/__operator/wishes.json?limit=500`, { headers: { "X-Operator-Token": TOKEN } });
  return new Set(((await r.json()).clusters || []).map((c) => c.text));
};
const find = (q, headers = {}) => fetch(`${base}/api/find?q=${encodeURIComponent(q)}`, { headers });
const mcpFind = async (task, headers = {}) => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.find", arguments: { task } } }),
  });
  await r.text();
  return r;
};
// Each query is a distinct capability gap, so no cache hit stands in for a computation.
const MISS = { tok: "knit me a woolen scarf", none: "repaint my garden fence", wrong: "tune my violin strings", mcpTok: "paint my kitchen cabinets", mcpNone: "groom my poodle tomorrow" };
try {
  const vary = (r) => (r.headers.get("vary") || "").toLowerCase().includes("x-operator-token");
  const noStore = (r) => /private/.test(r.headers.get("cache-control") || "") && /no-store/.test(r.headers.get("cache-control") || "");

  const a = await find(MISS.tok, { "X-Operator-Token": TOKEN });
  const aBody = await a.json();
  ok(a.status === 200 && (aBody.weakMatches === true || aBody.count === 0 || aBody.rarestTermCovered === false), `the operator's query is still answered as a miss (status ${a.status})`);
  ok(vary(a) && noStore(a), `with the token the answer varies on the header and is private, no-store (vary "${a.headers.get("vary")}", cache-control "${a.headers.get("cache-control")}")`);

  const b = await find(MISS.none);
  await b.json();
  ok(vary(b) && !noStore(b), `without the header the answer still varies on it and keeps its public caching (cache-control "${b.headers.get("cache-control")}")`);

  const c = await find(MISS.wrong, { "X-Operator-Token": "not-the-token" });
  await c.json();
  ok(vary(c) && !noStore(c), "a wrong token gets the public answer (keyed on the header, shared caching)");

  await mcpFind(MISS.mcpTok, { "X-Operator-Token": TOKEN });
  const d = await mcpFind(MISS.mcpNone);
  ok(vary(d), "the connector's answer varies on the operator header");

  const seen = await clusters();
  ok(!seen.has(MISS.tok), "a /api/find miss with the operator token records no wish");
  ok(seen.has(MISS.none), "the same kind of miss without the header records one");
  ok(seen.has(MISS.wrong), "a wrong token is not the operator: its miss records one");
  ok(!seen.has(MISS.mcpTok), "a catalog.find miss with the operator token records no wish");
  ok(seen.has(MISS.mcpNone), "a catalog.find miss without it records one");
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
