#!/usr/bin/env node
// GET /logo.png serves the brand mark (assets/brand/logo.png, the same art as
// docs/logo-current.png): a 512 by 512 PNG, the size the press kit and the MCP
// icon list state. Only the URL the page head links (the apple-touch-icon,
// /logo.png?v=<LOGO_PNG_VERSION>) is cached as immutable; the bare URL the
// schema.org logo, the MCP icons and the A2A card read keeps a short cache,
// so a new mark reaches them. Boots a FREE_MODE server on port 0, offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0, srv = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);
const read = (p, enc) => readFileSync(new URL(p, root), enc);

const art = read("assets/brand/logo.png");
const PNG_SIG = "89504e470d0a1a0a";
const dims = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
ok(art.subarray(0, 8).toString("hex") === PNG_SIG && dims(art).w === 512 && dims(art).h === 512, "the committed mark is a 512 by 512 PNG");
ok(art.equals(read("docs/logo-current.png")), "the served mark is the same art as docs/logo-current.png");

const server = read("src/server.js", "utf8");
const version = /const LOGO_PNG_VERSION = "(\d+)";/.exec(server)?.[1];
const head = read("src/ledger-chrome.js", "utf8");
ok(!!version && head.includes(`<link rel="apple-touch-icon" href="/logo.png?v=${version}">`), `the apple-touch-icon link carries the logo's version (?v=${version})`);
const pressRows = read("src/press-page.js", "utf8");
ok(/\["\/logo\.png", "Logo, PNG, 512 by 512"\]/.test(pressRows) && /src: `\$\{site\}\/logo\.png`, mimeType: "image\/png", sizes: \["512x512"\]/.test(read("src/mcp-http.js", "utf8")), "the press kit and the MCP icon list state the size the file has");

try {
  srv = await bootServer({ env: { FREE_MODE: "true", NODE_ENV: "test", STATE_DATABASE_URL: "", REDIS_URL: "" }, stores: "logo-png" });
  const bare = await fetch(`${srv.url}/logo.png`, { redirect: "manual" });
  const body = Buffer.from(await bare.arrayBuffer());
  ok(bare.status === 200 && bare.headers.get("content-type") === "image/png", `GET /logo.png answers 200 image/png (${bare.status} ${bare.headers.get("content-type")})`);
  ok(body.equals(art), "GET /logo.png serves the committed brand mark byte for byte");
  ok(!/immutable/.test(bare.headers.get("cache-control") || "") && /max-age=86400/.test(bare.headers.get("cache-control") || ""), `the bare URL keeps a day's cache, not immutable (${bare.headers.get("cache-control")})`);
  const pinned = await fetch(`${srv.url}/logo.png?v=${version}`);
  ok(pinned.status === 200 && /immutable/.test(pinned.headers.get("cache-control") || "") && Buffer.from(await pinned.arrayBuffer()).equals(art), "the versioned URL the page head links is immutable and serves the same bytes");
  const page = await (await fetch(`${srv.url}/`)).text();
  ok(page.includes(`href="/logo.png?v=${version}"`), "the home page links the versioned logo as its apple-touch-icon");
} catch (e) {
  ok(false, `unexpected: ${e?.stack || e}`);
} finally {
  if (fail && srv) console.error(`--- server output (tail) ---\n${srv.log().slice(-2000)}`);
  await srv?.stop().catch(() => {});
}
console.log(`\ntest-logo-png: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
