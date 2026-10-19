// Static asset caching on a booted server: a /js URL carrying the current
// build (?v=, as the page shell writes it) is cached immutable, the same file
// without it or with another version keeps the short cache, and self-hosted
// fonts are immutable woff2 behind a strict name allowlist.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-static-asset-cache.js
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const cc = (r) => r.headers.get("cache-control") || "";
const IMMUTABLE = /max-age=31536000/.test.bind(/max-age=31536000/);

const html = await (await fetch(`${BASE}/`)).text();
const m = /\/js\/([a-z][a-z0-9-]{2,60}\.js)\?v=([^"'&\s>]+)/.exec(html);
ok(!!m, "the home page references a versioned /js URL");
if (m) {
  const [, file, v] = m;
  const exact = await fetch(`${BASE}/js/${file}?v=${v}`);
  ok(exact.status === 200 && IMMUTABLE(cc(exact)) && /immutable/.test(cc(exact)), `the page's own versioned URL is immutable (${cc(exact)})`);
  const bare = await fetch(`${BASE}/js/${file}`);
  ok(bare.status === 200 && /max-age=300\b/.test(cc(bare)) && !/immutable/.test(cc(bare)), `the bare URL keeps the short cache (${cc(bare)})`);
  const other = await fetch(`${BASE}/js/${file}?v=not-this-build`);
  ok(other.status === 200 && /max-age=300\b/.test(cc(other)) && !/immutable/.test(cc(other)), `another version keeps the short cache (${cc(other)})`);
  ok(/javascript/.test(exact.headers.get("content-type") || ""), "served as JavaScript");
}
ok((await fetch(`${BASE}/js/..%2Fpackage.json`)).status === 404, "a /js name outside the allowlist is 404");

const fm = /\/fonts\/([a-z0-9-]+\.woff2)/.exec(html);
const font = fm ? fm[1] : "geist-500-latin.woff2";
const f = await fetch(`${BASE}/fonts/${font}`);
const buf = Buffer.from(await f.arrayBuffer());
ok(f.status === 200 && /font\/woff2/.test(f.headers.get("content-type") || "") && buf.subarray(0, 4).toString("latin1") === "wOF2", `${font} is served as woff2 bytes`);
ok(IMMUTABLE(cc(f)) && /immutable/.test(cc(f)), `fonts are immutable (${cc(f)})`);
ok((await fetch(`${BASE}/fonts/not-a-font.woff2`)).status === 404, "a font name outside the allowlist is 404");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
