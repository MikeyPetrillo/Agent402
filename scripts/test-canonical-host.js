// One host for every self-reference: the host BASE_URL names is the one that
// answers 200, the www twin 301s to it, and every canonical link, og:url,
// JSON-LD url/@id/item, sitemap <loc>, robots Sitemap line and the MCP server
// card name that host and no other. Also: /about is a 301 to /company, /press
// is served and listed, and the server card matches what /mcp reports.
//
// Boots FREE_MODE with BASE_URL on a test host and sends that Host header, so
// the apex/www logic runs exactly as it does in production.
//
//   node scripts/test-canonical-host.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { mcpShortDescription } from "../src/mcp-flagship.js";
import { SERVER_CARD_SCHEMA } from "../src/mcp-http.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Static: no served module writes a URL on the www host, so nothing links it.
const WWW_URL = /https?:\/\/www\.agent402\.tools/i;
const www = readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".js") && WWW_URL.test(readFileSync(join(ROOT, "src", f), "utf8")));
ok(www.length === 0, `no src module writes a URL on the www host${www.length ? `: ${www.join(", ")}` : ""}`);
ok(WWW_URL.test(`canonical: "https://www.agent402.tools/"`) && !WWW_URL.test(`new Set(["www.agent402.tools"])`), "control: a www URL is caught and a bare host name is not");

const HOST = "agent402.test";
const BASE = `http://${HOST}`;
const get = (path, host = HOST) => new Promise((resolve, reject) => {
  const r = httpRequest({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: host, Accept: "*/*" } }, (res) => {
    let body = ""; res.setEncoding("utf8"); res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, type: String(res.headers["content-type"] || ""), body }));
  });
  r.on("error", reject); r.setTimeout(30000, () => r.destroy(new Error("timeout"))); r.end();
});

/** Every absolute self-reference a page makes: canonical, og:url, JSON-LD url/@id/item. */
function selfRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<link rel="canonical" href="([^"]*)"/g)) refs.push(["canonical", m[1]]);
  for (const m of html.matchAll(/<meta property="og:url" content="([^"]*)"/g)) refs.push(["og:url", m[1]]);
  const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); for (const [k, v] of Object.entries(x)) { if (["url", "@id", "item"].includes(k) && typeof v === "string") refs.push([`ld ${k}`, v]); walk(v); } };
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { walk(JSON.parse(m[1])); } catch { refs.push(["ld", "unparsed"]); } }
  return refs;
}
/** A reference that points at this site but not at BASE (another host of ours, or the www twin). */
const offHost = (refs) => refs.filter(([, u]) => /agent402/i.test(u) && /^https?:/i.test(u) && !u.startsWith(`${BASE}/`) && u !== BASE).map(([k, u]) => `${k} ${u}`);

let srv = null, PORT = 0;
const done = async (code) => { try { await srv?.stop(); } catch { /* */ } process.exit(code); };
try {
  srv = await bootServer({ env: { FREE_MODE: "true", BASE_URL: BASE, X402_SYNC_ON_START: "false" }, stores: "canonical-host" });
  PORT = srv.port;
  ok(true, "server booted");

  // The host that answers, and the one that redirects to it.
  const apex = await get("/");
  ok(apex.status === 200, `the BASE_URL host answers 200 (got ${apex.status})`);
  const twin = await get("/press?x=1", `www.${HOST}`);
  ok(twin.status === 301 && twin.location === `${BASE}/press?x=1`, `the www twin 301s to the BASE_URL host (got ${twin.status} ${twin.location})`);

  // Sitemaps and robots.
  const index = await get("/sitemapindex.xml");
  const subs = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(subs.length > 0 && subs.every((u) => u.startsWith(`${BASE}/`)), `every sitemap in the index is on ${BASE} (${subs.length})`);
  let locs = [];
  for (const path of ["/sitemap.xml", ...subs.map((u) => u.slice(BASE.length))]) {
    const x = await get(path);
    locs = locs.concat([...x.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  const bad = locs.filter((u) => !(u === BASE || u.startsWith(`${BASE}/`)));
  ok(locs.length > 400 && bad.length === 0, `every sitemap <loc> is on ${BASE} (${locs.length} read${bad.length ? `; off host: ${bad.slice(0, 3).join(", ")}` : ""})`);
  ok(locs.includes(`${BASE}/press`) && !locs.includes(`${BASE}/about`), "/press is in the sitemap and /about is not");
  const robots = await get("/robots.txt");
  const maps = [...robots.body.matchAll(/^Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  ok(maps.length > 0 && maps.every((u) => u.startsWith(`${BASE}/`)), `robots.txt Sitemap lines are on ${BASE}`);

  // Pages: canonical, og:url and JSON-LD references.
  const pricing = JSON.parse((await get("/api/pricing")).body);
  const slug = (pricing.tools || pricing.items || []).map((t) => t.slug).find(Boolean) || "uuid";
  for (const path of ["/", "/press", "/company", "/pricing", "/docs", "/security", "/101", `/tools/${slug}`]) {
    const r = await get(path);
    const refs = selfRefs(r.body);
    const canon = refs.find(([k]) => k === "canonical")?.[1];
    const off = offHost(refs);
    ok(r.status === 200 && canon && canon.startsWith(BASE) && off.length === 0, `${path}: canonical ${canon}, every self-reference on ${BASE}${off.length ? ` (off host: ${off.slice(0, 3).join(", ")})` : ""}`);
  }

  // /about answers at the entity page; /press is the press kit.
  const about = await get("/about?ref=x");
  ok(about.status === 301 && /\/company\?ref=x$/.test(String(about.location)), `/about 301s to /company with the query kept (got ${about.status} ${about.location})`);
  const press = await get("/press");
  ok(press.status === 200 && /Havok Holdings LLC/.test(press.body) && /mailto:help@agent402\.tools/.test(press.body) && /href="\/logo\.svg"/.test(press.body), "/press names the company, the press mailbox and the logo files");

  // The MCP server card: one document at the reserved path and the well-known alias.
  const card = await get("/mcp/server-card");
  const alias = await get("/.well-known/mcp/server-card.json");
  ok(card.status === 200 && /^application\/mcp-server-card\+json/.test(card.type) && alias.status === 200 && /^application\/json/.test(alias.type), "the server card answers at /mcp/server-card and /.well-known/mcp/server-card.json");
  const c = JSON.parse(card.body);
  ok(alias.body === card.body, "both locations serve the same card");
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const r = httpRequest({ host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { Host: HOST, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body) } }, (res) => { let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => { try { resolve(JSON.parse(b.slice(b.indexOf("{"))).result); } catch (e) { reject(e); } }); });
    r.on("error", reject); r.end(body);
  });
  const info = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "canonical-host", version: "1" } }))?.serverInfo || {};
  const described = JSON.parse((await rpc("tools/call", { name: "server.describe", arguments: {} }))?.content?.[0]?.text || "{}");
  ok(c.version === info.version && c.title === info.title && c.name.endsWith(`/${info.name}`), `the card's name, version and title are the ones /mcp reports (${c.name} ${c.version})`);
  ok(c.remotes?.length === 1 && c.remotes[0].type === "streamable-http" && c.remotes[0].url === `${BASE}/mcp` && c.websiteUrl === BASE, "the card's one remote is streamable-http at /mcp on the canonical host");
  const versions = c.remotes?.[0]?.supportedProtocolVersions || [];
  ok(versions.includes("2026-07-28") && versions.includes("2025-06-18") && new Set(versions).size === versions.length, `the card lists the per-request revision and the initialize-negotiated ones /mcp serves (${versions.join(", ")})`);
  // The extension's own constraints (ext-server-card schema.ts), and the
  // registry entry and the card describing the server in the same words.
  const registry = JSON.parse(readFileSync(join(ROOT, "mcp", "server.json"), "utf8"));
  ok(c.$schema === SERVER_CARD_SCHEMA && /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/.test(c.$schema), "the card names the v1 server-card schema");
  ok(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(c.name) && c.name.length <= 200 && c.title.length <= 100 && c.description.length >= 1 && c.description.length <= 100 && c.version.length <= 255, "the card's name is reverse-DNS and its fields fit the schema's lengths");
  ok(mcpShortDescription({ mpp: true }) === registry.description && c.name === registry.name, "the card and mcp/server.json carry the same name and description (MPP on)");
  const n = c._meta?.["tools.agent402/catalog"]?.tools;
  ok(Number.isInteger(n) && n === described.tools, `the card's tool count is the one server.describe reports (${n} vs ${described.tools})`);
} catch (e) {
  ok(false, `unexpected: ${e.stack || e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
await done(fail ? 1 : 0);
