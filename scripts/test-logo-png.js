#!/usr/bin/env node
// GET /logo.png serves the brand mark (assets/brand/logo.png, the same art as
// docs/logo-current.png): a 512 by 512 PNG, the size the press kit and the MCP
// icon list state. Only the URL the page head links (the apple-touch-icon,
// /logo.png?v=<LOGO_PNG_VERSION>) is cached as immutable; the bare URL the
// schema.org logo, the MCP icons and the A2A card read keeps a short cache,
// so a new mark reaches them.
// The vector mark (assets/brand/logo.svg, src/brand-mark.js) is the same art:
// glyph outlines as paths and a circle, no raster and no font, in the PNG's own
// colors, its dot where the PNG's is. /logo.svg serves it; /favicon.svg, the
// nav and footer mark and the live view's brand.svg are its crop, and none of
// them is the old light tile. Favicon links carry FAVICON_VERSION and only
// those versioned URLs are immutable. Boots a FREE_MODE server on port 0, offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";
import { PNG } from "pngjs";

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

// --- the vector mark against the PNG ------------------------------------------
const svg = read("assets/brand/logo.svg", "utf8").trim();
const innerOf = (t) => t.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const OLD_TILE = /#F6F7F8|#C9CED3|url\(#(?:milled|bm)|<text|font-family/i;
ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 512 512">/.test(svg), "the vector mark is a 512 by 512 SVG");
ok(!/<image|data:|<text|font-family|@font-face/i.test(svg), "the vector mark holds no raster, no text and no font: shapes only");
ok((svg.match(/<path /g) || []).length === 3 && (svg.match(/<circle /g) || []).length === 1, "three glyph paths and one dot");
{
  const png = PNG.sync.read(art);
  const at = (x, y) => { const i = (y * png.width + x) * 4; return png.data.slice(i, i + 3); };
  const hex = (c) => "#" + [...c].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  const counts = new Map();
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const k = hex(at(x, y)); counts.set(k, (counts.get(k) || 0) + 1); }
  const [bg, ink, dot] = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  ok(svg.includes(`<rect width="512" height="512" fill="${bg}"/>`) && svg.includes(`<g fill="${ink}">`) && new RegExp(`<circle [^>]*fill="${dot}"`).test(svg), `the ground, glyphs and dot use the PNG's own colors (${bg}, ${ink}, ${dot})`);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const c = at(x, y); const w = Math.max(0, (c[0] - c[1]) / 154); if (w > 0.02) { sx += x * w; sy += y * w; n += w; } }
  const [cx, cy, r] = ["cx", "cy", "r"].map((k) => Number(new RegExp(`<circle [^>]*\\b${k}="([0-9.]+)"`).exec(svg)?.[1]));
  const pr = Math.sqrt(n / Math.PI);
  ok(Math.abs(cx - (sx / n + 0.5)) < 1 && Math.abs(cy - (sy / n + 0.5)) < 1 && Math.abs(r - pr) < 1, `the dot sits where the PNG's does (${cx},${cy} r ${r} vs ${(sx / n + 0.5).toFixed(1)},${(sy / n + 0.5).toFixed(1)} r ${pr.toFixed(1)})`);
}
const brandSrc = read("src/brand-mark.js", "utf8");
const markBox = /export const MARK_VIEWBOX = "([0-9 ]+)";/.exec(brandSrc)?.[1];
const favVersion = /export const FAVICON_VERSION = "(\d+)";/.exec(brandSrc)?.[1];
ok(!!markBox && !!favVersion && Number(favVersion) >= 4, `the mark's crop and the favicon version are declared (${markBox}, v${favVersion})`);
const live = read("services/live/public/brand.svg", "utf8").trim();
ok(innerOf(live) === innerOf(svg) && live.includes(`viewBox="${markBox}"`) && !OLD_TILE.test(live), "the live view's brand.svg is the same art, cropped to the mark");

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
  ok(page.includes(`href="/favicon.svg?v=${favVersion}"`) && page.includes(`href="/favicon.ico?v=${favVersion}"`) && !new RegExp(`favicon\\.(svg|ico)\\?v=(?!${favVersion}")`).test(page), `the home page links the favicons at v${favVersion} only`);
  const marks = page.match(new RegExp(`<svg aria-hidden="true" focusable="false" width="\\d+" height="\\d+" viewBox="${markBox}"[^>]*>[\\s\\S]*?<\\/svg>`, "g")) || [];
  ok(marks.length >= 2 && marks.every((m) => innerOf(m) === innerOf(svg)), `the nav and footer draw the mark inline (${marks.length})`);
  ok(!/<svg aria-hidden="true" focusable="false"[^>]*viewBox="0 0 512 512"[^>]*><defs><linearGradient id="bm-/.test(page), "the old light tile is gone from the page chrome");
  const logoSvg = await fetch(`${srv.url}/logo.svg`);
  ok(logoSvg.status === 200 && /image\/svg\+xml/.test(logoSvg.headers.get("content-type") || "") && (await logoSvg.text()).trim() === svg, "GET /logo.svg serves the vector mark");
  const favBare = await fetch(`${srv.url}/favicon.svg`);
  const favText = (await favBare.text()).trim();
  ok(favBare.status === 200 && innerOf(favText) === innerOf(svg) && favText.includes(`viewBox="${markBox}"`) && !OLD_TILE.test(favText), "GET /favicon.svg serves the same art, cropped to the mark");
  ok(!/immutable/.test(favBare.headers.get("cache-control") || ""), `the bare favicon URL is not immutable (${favBare.headers.get("cache-control")})`);
  const favPinned = await fetch(`${srv.url}/favicon.svg?v=${favVersion}`);
  ok(/immutable/.test(favPinned.headers.get("cache-control") || ""), "the versioned favicon URL the page head links is immutable");
  const ico = await fetch(`${srv.url}/favicon.ico`, { redirect: "manual" });
  ok(ico.status === 302 ? ico.headers.get("location") === "/favicon.svg" : ico.status === 200 && !/immutable/.test(ico.headers.get("cache-control") || ""), `GET /favicon.ico is the rasterized mark (bare: not immutable) or a redirect to the SVG where no browser runs (${ico.status})`);
} catch (e) {
  ok(false, `unexpected: ${e?.stack || e}`);
} finally {
  if (fail && srv) console.error(`--- server output (tail) ---\n${srv.log().slice(-2000)}`);
  await srv?.stop().catch(() => {});
}
console.log(`\ntest-logo-png: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
