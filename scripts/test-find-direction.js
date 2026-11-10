// /api/find and a stated conversion direction.
//
// "convert markdown to pdf" shares every word with pdf-to-markdown, which does
// the opposite. The scorer reads the source and the target around "to",
// "into" and "from" (src/find.js conversionPairs); a tool whose own name
// states the pair reversed ranks below every tool that does not, and when no
// tool states it forwards and the top result does not mention both ends, the
// answer says so (`direction.served: false`) and takes the existing miss
// path: rows marked weak, the wish hint, the need recorded.
//
// Three parts: the rule on a small catalog (offline, pure); the live catalog
// on a FREE_MODE boot (the reversed query, its control, the MCP connector);
// and the queries that worked before the rule, pinned to the top result the
// batch base returned for each, plus every tool's own description and name.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { findTools, conversionPairs, _statedDirectionReads } from "../src/find.js";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- 1. the rule, on a small catalog ---------------------------------------------
{
  const tool = (slug, name, description, extra = {}) => ({ route: `POST /api/${slug}`, slug, name, description, category: "data", price: "$0.001", tags: [], ...extra });
  const C = Object.fromEntries([
    tool("pdf-to-markdown", "PDF to Markdown", "Convert a PDF to clean markdown."),
    tool("pdf", "PDF to text", "Fetch a PDF and extract its text."),
    tool("markdown-to-html", "Markdown to HTML", "Render markdown to HTML."),
    tool("html-to-markdown", "HTML to Markdown", "Convert HTML into markdown."),
    tool("tts", "Text-to-speech", "Convert text to speech audio."),
    tool("transcribe", "Transcribe", "Speech audio in, text out.", { aliases: ["speech-to-text"] }),
    tool("unit-convert", "Unit convert", "Convert a value between units: celsius, fahrenheit, miles, kilometers."),
    tool("fahrenheit-to-celsius", "Fahrenheit to Celsius", "Convert fahrenheit to celsius."),
  ].map((t) => [t.route, t]));
  const top = (q) => findTools(C, q, { k: 25 });

  const pairs = (q) => conversionPairs(q, q.toLowerCase().split(/\W+/).filter((t) => t.length > 1 && !["to", "into", "from", "a", "the", "how"].includes(t)));
  ok(JSON.stringify(pairs("convert markdown to pdf")) === JSON.stringify([{ from: ["markdown", "convert"], to: ["pdf"] }]), "pairs: X to Y reads the source before and the target after");
  ok(JSON.stringify(pairs("pdf from markdown")) === JSON.stringify([{ from: ["markdown"], to: ["pdf"] }]), "pairs: Y from X reads the other way round");
  ok(JSON.stringify(pairs("convert from markdown to pdf")) === JSON.stringify([{ from: ["markdown"], to: ["pdf"] }]), "pairs: from X to Y is one pair, not two");
  ok(pairs("turn markdown into pdf")[0]?.to[0] === "pdf" && pairs("turn markdown into pdf")[0]?.from[0] === "markdown", "pairs: X into Y");
  ok(pairs("render markdown. Convert to pdf").every((p) => !p.from.includes("markdown")), "pairs: a pair never spans a sentence");
  ok(pairs("extract an article").length === 0 && pairs("to").length === 0, "pairs: no direction word, or nothing either side, is no pair");

  for (const q of ["convert markdown to pdf", "markdown to pdf", "turn markdown into pdf", "pdf from markdown", "convert from markdown to pdf", "how to convert a markdown file to a pdf"]) {
    const r = top(q);
    const slugs = r.results.map((x) => x.slug);
    ok(slugs[0] !== "pdf-to-markdown" && slugs.indexOf("pdf-to-markdown") === slugs.length - 1, `"${q}": the reversed tool ranks last, not first (${slugs.join(",")})`);
    ok(r.direction?.served === false && r.direction.from === "markdown" && r.direction.to === "pdf" && r.direction.reversed.includes("pdf-to-markdown"), `"${q}": the answer names the direction and says no tool serves it (${JSON.stringify(r.direction)})`);
    ok(r.rarestTermCovered === false, `"${q}": it reads as a miss on the switch every caller already reads`);
    ok(r.results.find((x) => x.slug === "pdf-to-markdown")?.reversed === true && r.results.filter((x) => x.reversed).length === 1, `"${q}": only the reversed row carries reversed: true`);
  }
  // Controls: the same catalog, the direction the tool does serve.
  for (const q of ["pdf to markdown", "convert pdf to markdown", "markdown from pdf", "pdf into markdown"]) {
    const r = top(q);
    ok(r.results[0]?.slug === "pdf-to-markdown" && !r.direction && r.rarestTermCovered !== false && !r.results.some((x) => x.reversed), `control "${q}": pdf-to-markdown first, no direction field, not a miss`);
  }
  // A forward tool beside its mirror: served, the mirror demoted.
  {
    const r = top("convert markdown to html");
    const slugs = r.results.map((x) => x.slug);
    ok(slugs[0] === "markdown-to-html" && slugs.indexOf("html-to-markdown") > slugs.indexOf("pdf-to-markdown") && r.direction?.served === true && r.rarestTermCovered !== false, `a mirrored pair: the forward tool first, the mirror below the rest, served (${slugs.join(",")})`);
    const back = top("html to markdown");
    ok(back.results[0]?.slug === "html-to-markdown" && back.direction?.served === true, "and the mirror's own direction finds the mirror");
  }
  // A hyphenated name and an alias state a direction too.
  {
    const r = top("text to speech");
    ok(r.results[0]?.slug === "tts" && r.direction?.served === true && r.direction.reversed.includes("transcribe"), `a name like Text-to-speech counts as forward and an alias as reversed (${r.results.map((x) => x.slug).join(",")}; ${JSON.stringify(r.direction)})`);
    ok(top("speech to text").results[0]?.slug === "transcribe", "and the alias's own direction finds its tool");
  }
  // A general converter that mentions both ends is never marked a miss.
  {
    const r = top("convert celsius to fahrenheit");
    ok(r.results[0]?.slug === "unit-convert" && r.direction?.served === true && r.rarestTermCovered !== false, `a general tool that mentions both ends serves the direction (${r.results.map((x) => x.slug).join(",")}; ${JSON.stringify(r.direction)})`);
  }
  // A query that names no direction is untouched: no field, no flag.
  {
    const r = top("extract text from a pdf");
    ok(!r.direction && !r.results.some((x) => x.reversed), "a query no tool states backwards carries no direction field");
  }
  // Bounded on a hostile string.
  {
    const t0 = Date.now();
    findTools(C, "to from into ".repeat(200) + "a to b ".repeat(200), { k: 5 });
    ok(Date.now() - t0 < 500, `a query of direction words is bounded (${Date.now() - t0} ms)`);
  }
  // A tool's names are read for their directions once per catalog entry, not
  // once per scored tool per query; an entry that changes is read again.
  {
    const q = "convert markdown to pdf";
    const first = JSON.stringify(top(q));
    const before = _statedDirectionReads();
    const again = JSON.stringify(top(q));
    ok(again === first && _statedDirectionReads() === before, `a second query over the same catalog reads no tool's names again (${_statedDirectionReads() - before} reads)`);
    const fresh = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, { ...v }]));
    ok(JSON.stringify(findTools(fresh, q, { k: 25 })) === first && _statedDirectionReads() > before, "control: a catalog of new entry objects is read, and answers the same");
    // Aliases edited in place: the reversed tool gains a name that states the pair forwards.
    const pdfTool = C["POST /api/pdf-to-markdown"];
    ok(top(q).direction?.served === false, "control: before the edit no tool states markdown to pdf forwards");
    pdfTool.aliases = ["md-export"];
    ok(top(q).direction?.served === false, "an alias that states no direction changes nothing");
    // With a forward name the tool serves the pair: first, not reversed, no direction field.
    const forward = (r) => !r.direction && r.results[0]?.slug === "pdf-to-markdown" && !r.results.some((x) => x.reversed);
    const backward = (r) => r.direction?.served === false && r.results.find((x) => x.slug === "pdf-to-markdown")?.reversed === true;
    pdfTool.aliases.push("markdown-to-pdf");
    ok(forward(top(q)), `an alias pushed onto the same array is read on the next query (${JSON.stringify(top(q).direction)})`);
    pdfTool.aliases[1] = "markdown-export";
    ok(backward(top(q)), "an alias replaced at the same index is read on the next query");
    pdfTool.aliases = ["markdown-to-pdf"];
    ok(forward(top(q)), "a replaced alias array is read on the next query");
    delete pdfTool.aliases;
    ok(JSON.stringify(top(q)) === first, "with the aliases removed the answer is the first one again");
    // A renamed entry.
    pdfTool.name = "Markdown to PDF";
    ok(forward(top(q)), "a renamed entry is read on the next query");
    pdfTool.name = "PDF to Markdown";
    ok(JSON.stringify(top(q)) === first, "and named back, it answers as before");
  }
}

// ---- 2 and 3. the live catalog -----------------------------------------------------
// The top result the batch base returned for each query (a FREE_MODE boot of
// the base, k=5), from scripts/test-find.js, scripts/test-find-ranking.js and
// their neighbors. The rule must change none of them.
const PINNED = [
  ["extract", "extract"],
  ["convert miles to kilometers", "unit-convert"],
  ["current time in a timezone", "timezone-convert"],
  ["make a qr code for a url", "qr"],
  ["sha256 checksum", "checksum"],
  ["i would like to extract an article from the web", "extract"],
  ["barcode", "barcode-decode"],
  ["convert hash qr extract", "qr"],
  ["check if a website is up", "http-check"],
  ["store data between sessions", "memory-write"],
  ["check", "spf-check"],
  ["website check", "http-check"],
  ["decode jwt token and extract claims", "jwt-decode"],
  ["excel data jobs", "xlsx-create"],
  ["l2beat", "l2-tvl"],
  ["rollup tvs", "l2-tvl"],
  ["rollup risk tvs", "token-risk"],
  ["layer 2 updates", "l2-tvl"],
  ["layer-2 gas costs", "l2-gas-comparison"],
  ["layer of encryption", "pdf-info"],
  ["osi model layer", "github-repo"],
  ["compare l2 gas fees across chains", "l2-gas-comparison"],
  ["total value locked on rollups", "l2-tvl"],
  ["search the web for x402 adoption", "search"],
  ["answer this question with citations: what is x402?", "answer"],
  ["latest news about the Federal Reserve", "search-news"],
  ["chat completions pro tier", "v1-chat-pro"],
  ["website history", "archive-snapshot"],
  ["is my website up", "http-check"],
  ["page speed", "page-speed"],
  ["extract article from URL", "extract"],
  ["make a qr code", "qr"],
  ["block number", "block-number"],
  ["latest block", "block-number"],
  ["event logs", "event-logs"],
  ["nft owner", "erc721-owner"],
  ["extract text from image", "image-ocr"],
  ["token balance", "wallet-balance"],
  ["ens lookup", "ens-resolve"],
  ["lookup whois for a domain", "whois"],
  ["geocode an address", "geocode"],
  ["validate an email address", "email-validate"],
  ["stock price for AAPL", "stock-quote"],
  ["current weather forecast", "weather-forecast"],
  ["decode a JWT token", "jwt-decode"],
  ["OCR an image", "image-ocr"],
  ["generate a UUID", "uuid"],
  ["convert HTML to markdown", "html-to-markdown"],
  ["PDF metadata info", "pdf-info"],
  ["check SPF record", "spf-check"],
  ["hash some text with sha256", "hash"],
  ["compute HMAC signature", "hmac"],
  ["current price of bitcoin", "crypto-price"],
  ["earthquake feed", "earthquakes"],
  ["convert kilometers to miles", "unit-convert"],
  ["convert stones to kg", "unit-convert"],
  ["solidity auditor", "solidity-scan"],
  ["solidity", "solidity-scan"],
  ["render contract", "html-frames"],
  ["renderAt", "html-frames"],
  ["contact sheet", "html-frames"],
  ["motion design frame check", "html-frames"],
  ["freeze frames of my animation", "html-frames"],
  ["smart contract", "contract-abi"],
  ["audit a contract", "skill-contract-audit"],
  ["scrape a website", "skill-structured-scrape"],
  ["decode a JWT", "jwt-decode"],
  ["convert anything to markdown", "html-to-markdown"],
  ["trip planning", "skill-trip-planner"],
  ["investment decision", "skill-macro-context"], // the pack that cites it; scripts/test-find-ranking.js pins the same
  ["site status snapshot", "skill-status-snapshot"],
  ["qr code", "qr"],
  ["whois lookup", "whois"],
  ["geocode address", "geocode"],
  ["validate email", "email-validate"],
  ["stock quote", "stock-quote"],
  ["weather forecast", "weather-forecast"],
  ["jwt decode", "jwt-decode"],
  ["image ocr", "image-ocr"],
  ["generate uuid", "uuid"],
  ["spf check", "spf-check"],
  ["earthquakes", "earthquakes"],
  ["pdf metadata", "pdf"],
  ["html to markdown", "html-to-markdown"],
  ["markdown to html", "markdown-to-html"],
  ["ocr image", "image-ocr"],
  ["sha256 hash", "hash"],
  ["extract article", "extract"],
];
// Tools whose own description did not rank them first at the batch base.
const SELF_FIND_KNOWN = new Set(["time", "skill-yield-dashboard"]);

const srv = await bootServer({ env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false" }, stores: "find-direction" });
try {
  const find = async (q, k = 5) => {
    const r = await fetch(`${srv.url}/api/find?k=${k}&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`/api/find ${r.status} for "${q.slice(0, 60)}"`);
    return r.json();
  };
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const tools = pricing.endpoints || [];
  const has = (slug) => tools.some((t) => t.slug === slug);
  ok(tools.length > 400, `live catalog loaded (${tools.length})`);

  // The reported query.
  const md = await find("convert markdown to pdf");
  const mdSlugs = md.results.map((x) => x.slug);
  if (has("markdown-to-pdf")) {
    ok(mdSlugs[0] === "markdown-to-pdf" && md.direction?.served !== false, `the catalog has a markdown-to-pdf tool and it ranks first (${mdSlugs.join(",")})`);
  } else {
    ok(has("pdf-to-markdown"), "control: the reversed tool is in the catalog");
    ok(mdSlugs[0] !== "pdf-to-markdown" && !mdSlugs.includes("pdf-to-markdown"), `"convert markdown to pdf" no longer ranks pdf-to-markdown first (${mdSlugs.join(",")})`);
    ok(md.direction?.served === false && md.direction.from === "markdown" && md.direction.to === "pdf" && md.direction.reversed.includes("pdf-to-markdown"), `the answer says no tool converts markdown to pdf (${JSON.stringify(md.direction)})`);
    ok(md.weakMatches === true && md.results.length > 0 && md.results.every((x) => x.weak === true), "every row is marked weak");
    ok(/none of these results does this task/.test(md.hint || "") || md.routeAcross, `and the hint says so (${md.hint})`);
    const all = await find("convert markdown to pdf", 25);
    ok(all.matched === md.matched && all.matched > 5, `the reversed tool is still counted among the matches (${all.matched})`);
  }
  // Its control: the direction the catalog serves.
  const back = await find("pdf to markdown");
  ok(back.results[0]?.slug === "pdf-to-markdown" && !back.weakMatches && !back.direction && !back.results.some((x) => x.weak || x.reversed), `control: "pdf to markdown" still ranks pdf-to-markdown first, not weak (${back.results.map((x) => x.slug).join(",")})`);

  // The connector's catalog.find reads the same answer.
  {
    const res = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.find", arguments: { task: "convert markdown to pdf" } } }),
    });
    const text = await res.text();
    const rpc = JSON.parse((res.headers.get("content-type") || "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text);
    const body = JSON.parse(rpc.result?.content?.[0]?.text || "{}");
    if (!has("markdown-to-pdf")) ok(body.direction?.served === false && body.results?.[0]?.slug !== "pdf-to-markdown" && typeof body.hint === "string", `MCP catalog.find carries the direction and the hint (${JSON.stringify(body.direction)}; top ${body.results?.[0]?.slug})`);
    const res2 = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "catalog.find", arguments: { task: "pdf to markdown" } } }),
    });
    const text2 = await res2.text();
    const rpc2 = JSON.parse((res2.headers.get("content-type") || "").includes("text/event-stream") ? text2.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text2);
    const body2 = JSON.parse(rpc2.result?.content?.[0]?.text || "{}");
    ok(body2.results?.[0]?.slug === "pdf-to-markdown" && !body2.direction && !body2.hint, `control: MCP catalog.find for "pdf to markdown" is unchanged (top ${body2.results?.[0]?.slug})`);
  }

  // The pinned queries.
  let same = 0;
  const moved = [];
  for (const [q, expected] of PINNED) {
    if (!has(expected)) continue; // a tool this boot does not carry (a key-gated kit)
    const got = (await find(q)).results[0]?.slug;
    if (got === expected) same++; else moved.push(`"${q}": ${expected} -> ${got}`);
  }
  ok(PINNED.length >= 40, `the pinned set holds at least 40 queries (${PINNED.length})`);
  ok(moved.length === 0 && same >= 40, `${same} pinned queries return the batch base's top result (${moved.join("; ") || "none moved"})`);

  // Every tool by its own description, and by its own name.
  const missed = [];
  for (const t of tools) {
    const got = (await find(String(t.description).slice(0, 480), 1)).results[0]?.slug;
    if (got !== t.slug) missed.push(t.slug);
  }
  const fresh = missed.filter((s) => !SELF_FIND_KNOWN.has(s));
  ok(fresh.length === 0, `every tool that found itself by its own description still does: ${tools.length - missed.length} of ${tools.length} (new misses: ${fresh.join(",") || "none"})`);
  const names = new Map();
  for (const t of tools) names.set(t.name, (names.get(t.name) || 0) + 1);
  let reversedTop = 0;
  for (const t of tools) {
    if (names.get(t.name) > 1) continue;
    const r = await find(t.name, 1);
    // A tool's own name never reads as a direction no tool serves.
    if (r.direction && r.direction.served === false) reversedTop++;
  }
  ok(reversedTop === 0, `no tool's own name is answered as an unserved direction (${reversedTop})`);
} finally {
  await srv.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
