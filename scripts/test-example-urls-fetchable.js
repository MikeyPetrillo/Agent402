// A published example whose tool fetches a URL must name a page that exists:
// a reserved example.* host answers only its root, so any path on it is a
// 404 (or a crawl refusal upstream) and the example can never be served.
// Offline: reads every kit's discovery input, fetches nothing.
//
//   node scripts/test-example-urls-fetchable.js
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Keys whose value the tool fetches (top level of the example input).
const FETCHED_KEYS = new Set(["url", "urls", "pageUrl", "audioUrl", "imageUrl", "feedUrl"]);
// Tools that only inspect the URL string and never fetch it.
const NO_FETCH = new Set(["action-gate"]);
const RESERVED = /^https?:\/\/([a-z0-9-]+\.)*example\.(com|org|net)(\/[^?#]*[^/?#])/i;

const seen = new Set();
const dir = join(ROOT, "src/tools");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
  let mod;
  try { mod = await import(join(dir, f)); } catch { continue; }
  for (const v of Object.values(mod)) {
    if (!Array.isArray(v)) continue;
    for (const t of v) {
      if (!t?.slug || !t.discovery || seen.has(t.slug)) continue;
      seen.add(t.slug);
      if (NO_FETCH.has(t.slug)) continue;
      const input = t.discovery.input || t.discovery.example || {};
      for (const [k, val] of Object.entries(input)) {
        if (!FETCHED_KEYS.has(k)) continue;
        for (const u of [].concat(val)) {
          if (typeof u === "string" && RESERVED.test(u)) ok(false, `${t.slug}: example ${k} ${u} is a path on a reserved example host`);
        }
      }
    }
  }
}
ok(seen.size >= 400, `read the discovery input of ${seen.size} tools`);

// The same rule for code samples in the docs that call a fetching route.
for (const rel of ["README.md", "client/README.md", "wiki/Paying-with-x402.md", "wiki/STT.md", "docs/base-mcp-plugin.md"]) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const bad = (text.match(/https?:\/\/(?:[a-z0-9-]+\.)*example\.(?:com|org|net)\/[^\s"'`)]*\.(?:mp3|wav|html?)|https?:\/\/example\.com\/(?:article|blog\/[^\s"'`)]*)/gi) || []);
  ok(bad.length === 0, `${rel}: no fetched example on a reserved example host${bad.length ? ` (${bad.join(", ")})` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
