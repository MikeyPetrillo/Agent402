// /sitemap.xml and the sub-sitemaps are built from separate hand lists, and
// /docs and /transparency sat in sitemap-pages.xml but not in sitemap.xml
// (truth audit 2026-10-02). Every URL a sub-sitemap lists must be in the main one.
import { sitemapXml, sitemapPages, sitemapGuides, sitemapLearn, sitemapReports, sitemapSkills, sitemapTools, sitemapCategories } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const B = "https://agent402.tools";
const locs = (x) => new Set([...String(x).matchAll(/<loc>([^<]+)<\/loc>/g)].map((a) => a[1]));
const main = locs(sitemapXml(B, {}));
ok(main.size > 100, `main sitemap lists ${main.size} URLs`);
for (const [name, fn] of Object.entries({ sitemapPages, sitemapGuides, sitemapLearn, sitemapReports, sitemapSkills, sitemapTools, sitemapCategories })) {
  const missing = [...locs(fn(B, {}))].filter((u) => !main.has(u));
  ok(missing.length === 0, `${name}: every URL is in sitemap.xml${missing.length ? ` - missing ${missing.slice(0, 5).join(", ")}` : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
