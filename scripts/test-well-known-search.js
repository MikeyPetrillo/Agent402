#!/usr/bin/env node
// The site search endpoint, /.well-known/search (src/well-known-search.js),
// against a booted free-mode server on port 0 with its own stores:
//   - GET ?q= ranks the same top tool as /api/find for agent queries
//   - QUERY with a text/plain body and with a JSON body answer the same rows
//   - Accept: text/markdown is a Markdown list of the same rows, tool text escaped
//   - an empty task is 400 with usage, PUT is 405 with Allow, the preflight names QUERY
//   - an oversized body is 413 before it is read (a stated length, no body sent)
//     and 413 inside the parser when it arrives without a length
//   - a miss records a wish exactly as /api/find does; the operator token records none
//   - the per-client uncached search limit is the one /api/find spends
//   - the page head advertises the endpoint (never an operator page), and
//     /llms.txt and /.well-known/x402 name it
//
//   node scripts/test-well-known-search.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import net from "node:net";
import { bootServer } from "./lib/boot-server.js";
import { ledgerShell } from "../src/ledger-chrome.js";
import { mdText, mdCode, searchMarkdownOf } from "../src/well-known-search.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Offline: the page shell and the Markdown escaping.
{
  const page = ledgerShell({ title: "T", description: "D", canonical: "https://agent402.tools/x", baseUrl: "https://agent402.tools", body: "" });
  ok(page.includes('<meta name="agent:search" content="https://agent402.tools/.well-known/search">'), "the shared page head names the search endpoint");
  ok(page.includes('<meta name="agent:search-method" content="GET, QUERY">'), "the shared page head names its methods");
  const op = ledgerShell({ title: "Operator", description: "D", canonical: "https://agent402.tools/__operator", baseUrl: "https://agent402.tools", body: "" });
  ok(!op.includes("agent:search"), "an operator page carries no search tags");
  ok(mdText("a *b* [c](d) <e>\n# f") === "a \\*b\\* \\[c\\]\\(d\\) \\<e\\> \\# f", `tool text is escaped and kept on one line (${mdText("a *b* [c](d) <e>\n# f")})`);
  ok(mdCode("x`y``z") === "```x`y``z```" && mdCode("`a") === "`` `a ``", "a code span's fence outruns every backtick inside it");
  const md = searchMarkdownOf({ query: "q", results: [{ name: "N\n- injected", slug: "s", price: "$1", route: "GET /x", description: "**bold**", callExample: null }], returned: 1, matched: 1, truncated: false });
  ok(md.split("\n").filter((l) => /^\s*-\s/.test(l)).length === 0 && md.includes("\\*\\*bold\\*\\*"), "a row's text cannot open a list item or emphasis");
}

const TOKEN = "well-known-search-operator-token-0123456789";
const srv = await bootServer({ stores: "well-known-search", env: { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, WISH_CALLER_SALT: "well-known-search-suite-salt", DISCOVERY_COMPUTE_PER_MIN: "6", DISCOVERY_COMPUTE_PER_HOUR: "600", TRUST_PROXY_HOPS: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
const base = srv.url;
const S = `${base}/.well-known/search`;
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { __text: t }; } };
const raw = (bytes, waitMs = 5000) => new Promise((resolve) => {
  const s = net.connect(srv.port, "127.0.0.1", () => s.write(bytes));
  let out = "";
  const t = setTimeout(() => { s.destroy(); resolve(out); }, waitMs);
  s.on("data", (d) => { out += d; if (/\r\n\r\n/.test(out)) { clearTimeout(t); s.destroy(); resolve(out); } });
  s.on("error", () => { /* the answer was read or the wait ends */ });
});

try {
  // Same top tool as /api/find.
  for (const [q, want] of [["readclean", "extract"], ["convert timezone", "timezone-convert"], ["hash a string", "hash"], ["parse a cron expression", null], ["base64 encode text", null]]) {
    const f = await json(await fetch(`${base}/api/find?q=${encodeURIComponent(q)}`));
    const r = await fetch(`${S}?q=${encodeURIComponent(q)}`);
    const s = await json(r);
    const top = s.results?.[0];
    ok(r.status === 200 && top && top.slug === f.results?.[0]?.slug && (!want || top.slug === want), `"${q}": top slug ${top?.slug} equals /api/find's ${f.results?.[0]?.slug}${want ? ` (${want})` : ""}`);
    ok(top && ["slug", "name", "description", "price", "route", "callExample", "score"].every((k) => k in top), `"${q}": a row carries slug, name, description, price, route, callExample and score`);
    ok(typeof s.returned === "number" && typeof s.matched === "number" && typeof s.complete === "boolean" && typeof s.truncated === "boolean" && s.returned === f.returned && s.matched === f.matched, `"${q}": the partial-answer fields match /api/find's (${s.returned} of ${s.matched})`);
    ok(r.headers.get("access-control-allow-origin") === "*" && /x-operator-token/i.test(r.headers.get("vary") || "") && /accept/i.test(r.headers.get("vary") || ""), `"${q}": readable cross-origin and varies on the operator header and Accept`);
  }

  // QUERY: text body and JSON body give the GET rows.
  {
    const g = await json(await fetch(`${S}?q=convert%20timezone&limit=3`));
    const t = await fetch(S, { method: "QUERY", headers: { "content-type": "text/plain" }, body: "convert timezone" });
    const tb = await json(t);
    const j = await fetch(S, { method: "QUERY", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "convert timezone", limit: 3 }) });
    const jb = await json(j);
    const slugs = (b) => (b.results || []).map((x) => x.slug).join(",");
    ok(t.status === 200 && tb.results?.[0]?.slug === g.results?.[0]?.slug, `QUERY with a text body answers the GET top row (${t.status}, ${tb.results?.[0]?.slug})`);
    ok(j.status === 200 && slugs(jb) === slugs(g) && jb.returned === 3, `QUERY with a JSON body and a limit answers the GET rows (${slugs(jb)})`);
    // `top` and `k`, the names /api/find and /api/route take, on every find surface.
    {
      const n = async (r) => { const b = await json(await r); return b.returned ?? b.count; };
      const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const counts = [
        await n(fetch(`${base}/api/find?q=convert%20timezone&top=2`)), await n(fetch(`${base}/api/find?q=convert%20timezone&k=2`)),
        await n(post("/api/find", { q: "convert timezone", top: 2 })), await n(post("/api/find", { q: "convert timezone", k: 2 })),
        await n(fetch(`${S}?q=convert%20timezone&top=2`)), await n(fetch(`${S}?q=convert%20timezone&k=2`)),
        await n(fetch(S, { method: "QUERY", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "convert timezone", top: 2 }) })),
      ];
      const dflt = await n(fetch(`${base}/api/find?q=convert%20timezone`));
      ok(counts.every((c) => c === 2) && dflt > 2, `top and k are read on GET and POST /api/find and on GET and QUERY search, never the default (${counts.join(",")}; default ${dflt})`);
    }
    const over = await json(await fetch(`${S}?q=convert%20timezone&limit=99`));
    ok(over.requestedExceededMax === true && /limit=99/.test(over.maxNote || "") && over.returned === over.topMax, "a limit past the maximum is clamped and says so under its own name");
  }

  // Markdown.
  {
    const r = await fetch(`${S}?q=hash%20a%20string&limit=2`, { headers: { accept: "text/markdown" } });
    const text = await r.text();
    ok(r.status === 200 && /^text\/markdown/.test(r.headers.get("content-type") || ""), `Accept: text/markdown answers Markdown (${r.headers.get("content-type")})`);
    ok(/^# Tool search: hash a string/m.test(text) && /^1\. \*\*Hash\*\* \(`hash`\)/m.test(text) && /^2\. /m.test(text) && !/<[a-z]/i.test(text), "the Markdown lists the same rows, with no HTML");
    const q = await fetch(S, { method: "QUERY", headers: { "content-type": "text/plain", accept: "text/markdown" }, body: "hash a string" });
    ok(q.status === 200 && /^text\/markdown/.test(q.headers.get("content-type") || ""), "QUERY negotiates Markdown too");
    const d = await fetch(`${S}?q=hash`, { headers: { accept: "*/*" } });
    ok(/application\/json/.test(d.headers.get("content-type") || ""), "JSON is the default");
  }

  // Refusals.
  {
    const e = await fetch(S);
    const eb = await json(e);
    ok(e.status === 400 && eb.error === "missing-query" && Array.isArray(eb.usage), `no task is 400 with usage (${e.status})`);
    const blank = await fetch(S, { method: "QUERY", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "   " }) });
    ok(blank.status === 400, `a blank task in the body is 400 (${blank.status})`);
    const obj = await fetch(S, { method: "QUERY", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: { toString: 1 }, limit: { a: 1 } }) });
    ok(obj.status === 400, `a task that is not text is 400 (${obj.status})`);
    const put = await fetch(S, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    ok(put.status === 405 && /QUERY/.test(put.headers.get("allow") || "") && /GET/.test(put.headers.get("allow") || ""), `PUT is 405 with Allow (${put.status}, ${put.headers.get("allow")})`);
    const post = await fetch(S, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "hash" }) });
    ok(post.status === 405, `POST is 405 (${post.status})`);
    const pre = await fetch(S, { method: "OPTIONS", headers: { origin: "https://agent.example", "access-control-request-method": "QUERY" } });
    ok(pre.status === 204 && /QUERY/.test(pre.headers.get("access-control-allow-methods") || ""), `the preflight allows QUERY (${pre.headers.get("access-control-allow-methods")})`);
    const xml = await fetch(S, { method: "QUERY", headers: { "content-type": "application/xml" }, body: "<q>hash</q>" });
    ok(xml.status === 415, `a body of another type is 415 (${xml.status})`);
    const bad = await fetch(S, { method: "QUERY", headers: { "content-type": "application/json" }, body: "{not json" });
    ok(bad.status === 400, `an unreadable JSON body is 400 (${bad.status})`);
    // A stated length past the bound is refused with no byte of the body sent.
    const head = await raw(`QUERY /.well-known/search HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\n`);
    ok(/^HTTP\/1\.1 413/.test(head), `a stated length past the bound is 413 before the body is read (${head.split("\r\n")[0] || "no answer"})`);
    const chunked = await fetch(S, { method: "QUERY", headers: { "content-type": "text/plain" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("a".repeat(5000))); c.close(); } }), duplex: "half" });
    ok(chunked.status === 413, `a body with no length stops at the bound (${chunked.status})`);
  }

  // Misses and wishes, as /api/find records them.
  {
    let rows = [];
    const clusters = async () => {
      const r = await fetch(`${base}/__operator/wishes.json?limit=500`, { headers: { "X-Operator-Token": TOKEN } });
      rows = (await r.json()).clusters || [];
      return new Set(rows.map((c) => c.text));
    };
    const MISS = { post: "wax my wooden canoe hull", find: "repaint my garden fence", search: "tune my violin strings", query: "groom my poodle tomorrow", op: "knit me a woolen scarf" };
    const f = await json(await fetch(`${base}/api/find?q=${encodeURIComponent(MISS.find)}`));
    const s = await json(await fetch(`${S}?q=${encodeURIComponent(MISS.search)}`));
    await (await fetch(S, { method: "QUERY", headers: { "content-type": "text/plain" }, body: MISS.query })).text();
    const o = await fetch(`${S}?q=${encodeURIComponent(MISS.op)}`, { headers: { "X-Operator-Token": TOKEN } });
    await o.text();
    ok(Boolean(f.hint) && s.hint === f.hint, `a search miss carries /api/find's hint ("${s.hint}")`);
    ok(/private/.test(o.headers.get("cache-control") || "") && /no-store/.test(o.headers.get("cache-control") || ""), "the operator's search answer is private, no-store");
    await (await fetch(`${base}/api/find`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: MISS.post }) })).text();
    const seen = await clusters();
    // The caller's address reaches the miss rule on every surface: a miss
    // with no address is recorded with no caller credited (callers 0).
    const callersOf = (text) => rows.find((c) => c.text === text)?.callers;
    ok([MISS.find, MISS.post, MISS.search, MISS.query].every((t) => callersOf(t) === 1), `each surface's miss credits its caller: GET and POST /api/find, GET and QUERY search (${[MISS.find, MISS.post, MISS.search, MISS.query].map(callersOf)})`);
    ok(seen.has(MISS.find), "control: a /api/find miss records a wish");
    ok(seen.has(MISS.search), "a GET search miss records a wish");
    ok(seen.has(MISS.query), "a QUERY search miss records a wish");
    ok(!seen.has(MISS.op), "a search miss with the operator token records none");
  }

  // One per-client search limit: a forwarded request is an outside client.
  {
    const XFF = { "x-forwarded-for": "203.0.113.9" };
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${S}?q=${encodeURIComponent(`limit probe search ${i} sha256`)}`, { headers: XFF })).status);
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${base}/api/find?q=${encodeURIComponent(`limit probe find ${i} sha256`)}`, { headers: XFF })).status);
    ok(statuses.every((x) => x === 200), `six uncached searches across both paths are served (${statuses.join(",")})`);
    const f = await fetch(`${base}/api/find?q=${encodeURIComponent("limit probe find seventh sha256")}`, { headers: XFF });
    const fb = await json(f);
    ok(f.status === 429 && fb.reason === "discovery-client-rate", `the seventh, on /api/find, is refused: search spent the same budget (${f.status})`);
    const s = await fetch(`${S}?q=${encodeURIComponent("limit probe search eighth sha256")}`, { headers: XFF });
    const sb = await json(s);
    ok(s.status === 429 && sb.reason === "discovery-client-rate" && s.headers.get("retry-after") === "60", `search is refused by the same limit, the refusal passed through (${s.status})`);
  }

  // Discovery surfaces name it.
  {
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    // The server's own BASE_URL (on a port-0 boot it is not the bound port).
    const ORIGIN = "https?://[^\\s\"/]+";
    ok(llms.includes("also at `/.well-known/search` (GET or QUERY)"), "/llms.txt names the search endpoint and its methods");
    const full = await (await fetch(`${base}/llms-full.txt`)).text();
    ok(new RegExp(`\\[/\\.well-known/search\\]\\(${ORIGIN}/\\.well-known/search\\): GET`).test(full), "/llms-full.txt links it with both methods");
    const x = await json(await fetch(`${base}/.well-known/x402`));
    ok(new RegExp(`^${ORIGIN}/\\.well-known/search\\?q=\\{task\\}$`).test(x.machineReadable?.siteSearch || ""), `/.well-known/x402 names it (${x.machineReadable?.siteSearch})`);
    const home = await (await fetch(`${base}/`)).text();
    ok(new RegExp(`<meta name="agent:search" content="${ORIGIN}/\\.well-known/search">`).test(home) && home.includes('<meta name="agent:search-method" content="GET, QUERY">'), "the home page head advertises it");
  }
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
